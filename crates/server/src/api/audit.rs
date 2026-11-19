//! Administration › Audit log.
//!
//! - `GET admin/audit`: entries, newest first, with filters `cat`, `q`,
//!   `from`, `to` and paging via `before` and `limit`, plus the hit count per
//!   category.
//! - `POST admin/audit/export`: the same filters as CSV, all hits; is itself
//!   recorded in the audit log.
//! - `GET`/`PUT admin/audit/retention`: retention of 30, 90 or 365 days.
//!
//! Texts are built here (`texts`), not in the web app: the search has to
//! match what is shown, and the export has to deliver the same columns.

mod texts;

use axum::{
    Json, Router,
    extract::{Query, State, rejection::QueryRejection},
    http::header,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use self::texts::Shown;
use super::{ApiError, FieldErrors, JsonBody, servers::audit_entry};
use crate::{
    app::AppState,
    auth::AdminUser,
    client_ip::ClientIp,
    db::{
        self,
        repo::audit_log::{self, Category, Range, Row},
    },
    mailer::system_mail::timestamp,
    settings::{self, Language},
};

/// Entries per page without `limit`.
const DEFAULT_LIMIT: usize = 100;
/// Largest page.
const MAX_LIMIT: usize = 500;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/admin/audit", get(list))
        .route("/admin/audit/export", post(export))
        .route(
            "/admin/audit/retention",
            get(show_retention).put(update_retention),
        )
}

/// Filters of list and export.
#[derive(Debug, Default, Deserialize)]
struct FilterQuery {
    /// Category like `AUDIT_CATS`: `login`, `users`, `settings`, `system`;
    /// without it all of them.
    cat: Option<String>,
    /// Search in person, action, details and category.
    q: Option<String>,
    /// From this point in time (RFC 3339, inclusive).
    from: Option<String>,
    /// Before this point in time (RFC 3339).
    to: Option<String>,
}

#[derive(Debug)]
struct Filter {
    category: Option<Category>,
    /// Lowercase; empty = no search.
    needle: String,
    range: Range,
}

impl FilterQuery {
    fn parse(self) -> Result<Filter, ApiError> {
        let category = self
            .cat
            .filter(|cat| !cat.is_empty())
            .map(|cat| {
                Category::parse(&cat).ok_or_else(|| ApiError::BadRequest("unknown category".into()))
            })
            .transpose()?;
        Ok(Filter {
            category,
            needle: self.q.unwrap_or_default().trim().to_lowercase(),
            range: Range {
                from: instant(self.from)?,
                to: instant(self.to)?,
            },
        })
    }
}

/// Point in time of the request in the format of the `at` column.
fn instant(value: Option<String>) -> Result<Option<String>, ApiError> {
    value
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .parse::<Timestamp>()
                .map(timestamp)
                .map_err(|_| ApiError::BadRequest("invalid point in time".into()))
        })
        .transpose()
}

impl Filter {
    /// Does the search match the entry? The category does not count: the
    /// numbers on the filters apply to all categories.
    fn found(&self, row: &Row, shown: &Shown, lang: Language) -> bool {
        self.needle.is_empty()
            || shown
                .searchable(row.category, lang)
                .to_lowercase()
                .contains(&self.needle)
    }

    fn in_category(&self, row: &Row) -> bool {
        self.category
            .is_none_or(|category| category == row.category)
    }
}

#[derive(Debug, Deserialize)]
struct PageQuery {
    /// `next` of the previous page.
    before: Option<i64>,
    limit: Option<usize>,
}

/// An entry like `AUDIT0`, `at` in UTC.
#[derive(Debug, Serialize)]
struct Item {
    id: i64,
    at: String,
    cat: &'static str,
    icon: &'static str,
    who: String,
    act: String,
    meta: String,
    warn: bool,
}

/// Hit counts of the category filters.
#[derive(Debug, Default, Serialize)]
struct Counts {
    all: u64,
    login: u64,
    users: u64,
    settings: u64,
    system: u64,
}

impl Counts {
    fn add(&mut self, category: Category, n: u64) {
        self.all += n;
        *match category {
            Category::Login => &mut self.login,
            Category::Users => &mut self.users,
            Category::Settings => &mut self.settings,
            Category::System => &mut self.system,
        } += n;
    }
}

impl Item {
    fn new(row: Row, shown: Shown) -> Self {
        Self {
            id: row.id,
            at: row.at,
            cat: row.category.as_str(),
            icon: shown.icon,
            who: shown.who,
            act: shown.act,
            meta: shown.meta,
            warn: shown.warn,
        }
    }
}

#[derive(Debug, Serialize)]
struct Page {
    entries: Vec<Item>,
    counts: Counts,
    /// For `before` of the next page; `null` on the last one.
    next: Option<i64>,
}

fn bad_query(rejection: QueryRejection) -> ApiError {
    ApiError::BadRequest(rejection.body_text())
}

async fn list(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    filter: Result<Query<FilterQuery>, QueryRejection>,
    page: Result<Query<PageQuery>, QueryRejection>,
) -> Result<Json<Page>, ApiError> {
    let filter = filter.map_err(bad_query)?.0.parse()?;
    let Query(page) = page.map_err(bad_query)?;
    let limit = page.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let reply = db::call(&state.db, move |conn| {
        let lang = settings::lang_of(conn, &user.id)?;
        let keep = audit_log::keep_days(conn)?;
        // One row more than the page shows whether there is more.
        let mut entries = Vec::new();
        let mut counts = Counts::default();
        if filter.needle.is_empty() {
            for (category, n) in audit_log::counts(conn, keep, &filter.range)? {
                counts.add(category, n);
            }
            let rows = audit_log::page(
                conn,
                keep,
                &filter.range,
                filter.category,
                page.before,
                limit + 1,
            )?;
            for row in rows {
                let shown = texts::render(&row, lang);
                entries.push(Item::new(row, shown));
            }
        } else {
            audit_log::scan(conn, keep, &filter.range, |row| {
                let shown = texts::render(&row, lang);
                if !filter.found(&row, &shown, lang) {
                    return;
                }
                counts.add(row.category, 1);
                let on_page = filter.in_category(&row)
                    && page.before.is_none_or(|before| row.id < before)
                    && entries.len() <= limit;
                if on_page {
                    entries.push(Item::new(row, shown));
                }
            })?;
        }
        let more = entries.len() > limit;
        entries.truncate(limit);
        let next = entries.last().filter(|_| more).map(|item| item.id);
        Ok(Page {
            entries,
            counts,
            next,
        })
    })
    .await?;
    Ok(Json(reply))
}

/// All hits as CSV: semicolon, quotation marks, CRLF, BOM for
/// Excel. The export is itself recorded in the audit log because it carries
/// names and places out of the house; hence `POST` (CSRF check).
async fn export(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    filter: Result<Query<FilterQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let filter = filter.map_err(bad_query)?.0.parse()?;
    let csv = db::call(&state.db, move |conn| {
        let lang = settings::lang_of(conn, &user.id)?;
        let keep = audit_log::keep_days(conn)?;
        let mut csv = String::from("\u{feff}");
        csv_line(&mut csv, texts::csv_head(lang));
        let mut count = 0_u64;
        audit_log::scan(conn, keep, &filter.range, |row| {
            let shown = texts::render(&row, lang);
            if filter.found(&row, &shown, lang) && filter.in_category(&row) {
                count += 1;
                csv_line(
                    &mut csv,
                    [
                        &row.at,
                        texts::label(row.category, lang),
                        &shown.who,
                        shown.act.trim_start_matches([':', ' ']),
                        &shown.meta,
                    ],
                );
            }
        })?;
        audit_log::insert(
            conn,
            &audit_entry(Category::System, "audit.export", &user, ip)
                .details(json!({ "count": count })),
        )?;
        Ok(csv)
    })
    .await?;
    let name = Timestamp::now().strftime("protokoll-%Y-%m-%d.csv");
    Ok((
        [
            (header::CONTENT_TYPE, "text/csv; charset=utf-8".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
            (header::CACHE_CONTROL, "no-store".to_owned()),
        ],
        csv,
    )
        .into_response())
}

fn csv_line<const N: usize>(csv: &mut String, fields: [&str; N]) {
    for (i, field) in fields.into_iter().enumerate() {
        if i > 0 {
            csv.push(';');
        }
        csv_field(csv, field);
    }
    csv.push_str("\r\n");
}

/// A field in quotation marks. Names and titles come from users; whatever
/// starts like a formula gets a `'` in front, otherwise the spreadsheet would
/// execute it on opening.
fn csv_field(csv: &mut String, field: &str) {
    csv.push('"');
    if field.starts_with(['\t', '\r']) || field.trim_start().starts_with(['=', '+', '-', '@']) {
        csv.push('\'');
    }
    csv.push_str(&field.replace('"', "\"\""));
    csv.push('"');
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RetentionBody {
    days: u32,
}

async fn show_retention(
    State(state): State<AppState>,
    _: AdminUser,
) -> Result<Json<Value>, ApiError> {
    let days = db::call(&state.db, |conn| audit_log::keep_days(conn)).await?;
    Ok(Json(json!({ "days": days })))
}

/// Changes the retention period. Deletion only happens on the next run of
/// `audit_retention`; an accidentally shorter period can be undone until
/// then.
async fn update_retention(
    State(state): State<AppState>,
    AdminUser(user): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<RetentionBody>,
) -> Result<Json<Value>, ApiError> {
    if !audit_log::KEEP_CHOICES.contains(&body.days) {
        let mut errors = FieldErrors::default();
        errors.code("days", "invalid");
        return Err(errors.into_error());
    }
    let days = body.days;
    db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let previous = audit_log::keep_days(&tx)?;
        if previous != days {
            audit_log::set_keep_days(&tx, days)?;
            audit_log::insert(
                &tx,
                &audit_entry(Category::Settings, "audit.retention", &user, ip)
                    .details(json!({ "days": days, "previous": previous })),
            )?;
            tx.commit()?;
        }
        Ok(())
    })
    .await?;
    Ok(Json(json!({ "days": days })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(value: &str) -> String {
        let mut csv = String::new();
        csv_field(&mut csv, value);
        csv
    }

    #[test]
    fn csv_quotes_and_defuses_formulas() {
        assert_eq!(field("Anna Becker"), r#""Anna Becker""#);
        assert_eq!(field(r#"Say "Hello""#), r#""Say ""Hello""""#);
        assert_eq!(field("a;b"), r#""a;b""#);
        for formula in ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1", " =1+1"] {
            assert_eq!(field(formula), format!("\"'{formula}\""));
        }
        assert_eq!(field("a=1"), r#""a=1""#);
    }

    #[test]
    fn csv_line_joins_with_semicolon_and_crlf() {
        let mut csv = String::new();
        csv_line(&mut csv, ["a", "b"]);
        assert_eq!(csv, "\"a\";\"b\"\r\n");
    }

    #[test]
    fn filter_rejects_unknown_category_and_time() {
        let parse = |cat: Option<&str>, from: Option<&str>| {
            FilterQuery {
                cat: cat.map(str::to_owned),
                from: from.map(str::to_owned),
                ..FilterQuery::default()
            }
            .parse()
        };
        assert!(parse(Some("Sign-in"), None).is_err());
        assert!(parse(None, Some("yesterday")).is_err());
        let filter = parse(Some(""), Some("2026-11-05T10:00:00+01:00")).unwrap();
        assert_eq!(filter.category, None);
        assert_eq!(
            filter.range.from.as_deref(),
            Some("2026-11-05T09:00:00.000Z")
        );
    }
}
