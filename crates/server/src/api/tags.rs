//! Users' tags.
//!
//! - `GET tags`: all of the user's tags in tree order with their links.
//! - `POST tags`: creates a tag at the end of its level.
//! - `PATCH tags/:id`: name, color, parent tag (move) and position.
//! - `DELETE tags/:id`: deletes the tag with its subtags and links.
//! - `GET/PUT tags/:id/links`: mailbox of the tag per mail account; `PUT`
//!   replaces all, only with the user's own accounts.
//!
//! Names (in NFC) are unique per level (case-insensitive); a tag cannot go
//! under itself or one of its subtags, at most [`MAX_DEPTH`] levels deep, at
//! most [`MAX_TAGS`] per user. The browser creates, renames and deletes the
//! mailboxes via JMAP; the backend only remembers the links. When a mail
//! account goes, its links go too.

use std::collections::{HashMap, HashSet};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch},
};
use icu_normalizer::ComposingNormalizerBorrowed;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{ApiError, FieldErrors, JsonBody, me::check_display_name, nullable};
use crate::{
    app::AppState,
    auth::CurrentUser,
    db::{
        self,
        repo::{
            mail_accounts::{self, COLORS},
            tags::{self, Change, Link, NewTag, Tag},
        },
    },
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/tags", get(list).post(create))
        .route("/tags/{id}", patch(update).delete(remove))
        .route("/tags/{id}/links", get(links).put(set_links))
}

/// Deepest level of a tag (1 = top). With the root "Tags" above, the
/// mailboxes stay within the depth Stalwart allows (default 10); deeper
/// chains would also hit SQLite's limit of nested triggers (1000) on deletion,
/// through which the foreign key deletes subtags.
pub const MAX_DEPTH: usize = 9;

/// Maximum number of tags per user.
pub const MAX_TAGS: usize = 1000;

#[derive(Serialize)]
struct TagView {
    id: String,
    name: String,
    /// `null` = top level.
    parent_id: Option<String>,
    /// Index in `MA_COLORS`, `null` = color of the parent tag.
    color: Option<i64>,
    /// Position among the siblings, from 0.
    position: i64,
    links: Vec<Link>,
    created_at: String,
}

fn view(tag: Tag, links: Vec<Link>) -> TagView {
    TagView {
        id: tag.id,
        name: tag.name,
        parent_id: tag.parent_id,
        color: tag.color,
        position: tag.position,
        links,
        created_at: tag.created_at,
    }
}

/// Tags in tree order: every tag before its subtags, per level in the order
/// of `tags::list`.
fn tree_order(tags: Vec<Tag>) -> Vec<Tag> {
    let mut children: HashMap<Option<String>, Vec<Tag>> = HashMap::new();
    for tag in tags {
        children.entry(tag.parent_id.clone()).or_default().push(tag);
    }
    let mut stack: Vec<Tag> = children.remove(&None).unwrap_or_default();
    stack.reverse();
    let mut ordered = Vec::new();
    while let Some(tag) = stack.pop() {
        if let Some(kids) = children.remove(&Some(tag.id.clone())) {
            stack.extend(kids.into_iter().rev());
        }
        ordered.push(tag);
    }
    ordered
}

async fn list(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Value>, ApiError> {
    let tags = db::call(&state.db, move |conn| {
        let tags = tags::list(conn, &user.id)?;
        let mut links = tags::links(conn, &user.id)?;
        Ok(tree_order(tags)
            .into_iter()
            .map(|tag| {
                let links = links.remove(&tag.id).unwrap_or_default();
                view(tag, links)
            })
            .collect::<Vec<_>>())
    })
    .await?;
    Ok(Json(json!({ "tags": tags })))
}

/// Name without surrounding whitespace, in NFC: mailbox names are Net-Unicode
/// (RFC 8621, 2; RFC 5198), and only this way does the check catch
/// identical-looking names in decomposed and composed form.
fn normalize_name(name: &str) -> String {
    ComposingNormalizerBorrowed::new_nfc()
        .normalize(name.trim())
        .into_owned()
}

/// Level of the tag `id` (1 = top) via its parent tags.
fn level(all: &[Tag], id: &str) -> usize {
    let parents: HashMap<&str, Option<&str>> = all
        .iter()
        .map(|tag| (tag.id.as_str(), tag.parent_id.as_deref()))
        .collect();
    let mut level = 1;
    let mut current = parents.get(id).copied().flatten();
    while let Some(tag) = current
        && level <= all.len()
    {
        level += 1;
        current = parents.get(tag).copied().flatten();
    }
    level
}

/// How many levels the tag `id` spans with its subtags (1 = without
/// subtags, also for a new tag).
fn height(all: &[Tag], id: &str) -> usize {
    let mut height = 1;
    let mut stack = vec![(id, 1)];
    while let Some((tag, depth)) = stack.pop() {
        height = height.max(depth);
        if depth <= all.len() {
            stack.extend(
                all.iter()
                    .filter(|kid| kid.parent_id.as_deref() == Some(tag))
                    .map(|kid| (kid.id.as_str(), depth + 1)),
            );
        }
    }
    height
}

/// Whether `parent` is the tag `id` itself or one of its subtags.
fn creates_cycle(all: &[Tag], id: &str, parent: &str) -> bool {
    let parents: HashMap<&str, Option<&str>> = all
        .iter()
        .map(|tag| (tag.id.as_str(), tag.parent_id.as_deref()))
        .collect();
    let mut current = Some(parent);
    // At most as many steps as there are tags.
    for _ in 0..=all.len() {
        match current {
            None => return false,
            Some(tag) if tag == id => return true,
            Some(tag) => current = parents.get(tag).copied().flatten(),
        }
    }
    true
}

/// Checks name, color and parent tag of the tag `id` against the user's
/// other tags (`all`, a new tag is not in it). Names: at most 100
/// characters, no control or invisible characters.
fn check(
    all: &[Tag],
    id: &str,
    name: &str,
    color: Option<i64>,
    parent: Option<&str>,
) -> FieldErrors {
    let mut errors = FieldErrors::default();
    check_display_name(&mut errors, "name", name);
    if color.is_some_and(|color| !(0..COLORS).contains(&color)) {
        errors.code("color", "invalid");
    }
    if let Some(parent) = parent {
        if !all.iter().any(|tag| tag.id == parent) {
            errors.code("parent_id", "unknown");
        } else if creates_cycle(all, id, parent) {
            errors.code("parent_id", "cycle");
        } else if level(all, parent) + height(all, id) > MAX_DEPTH {
            errors.code("parent_id", "too_deep");
        }
    }
    let key = name.to_lowercase();
    if all.iter().any(|tag| {
        tag.id != id && tag.parent_id.as_deref() == parent && tag.name.to_lowercase() == key
    }) {
        errors.code("name", "taken");
    }
    errors
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateBody {
    name: String,
    /// Parent tag; if missing, top level.
    parent_id: Option<String>,
    /// If missing, the parent tag's applies.
    color: Option<i64>,
}

async fn create(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    JsonBody(body): JsonBody<CreateBody>,
) -> Result<(StatusCode, Json<TagView>), ApiError> {
    let id = db::new_id()?;
    let user_id = user.id.clone();
    let saved = db::call(&state.db, move |conn| {
        let name = normalize_name(&body.name);
        let tx = conn.transaction()?;
        let all = tags::list(&tx, &user_id)?;
        if all.len() >= MAX_TAGS {
            return Ok(Err(ApiError::rejected(
                StatusCode::UNPROCESSABLE_ENTITY,
                "too_many",
            )
            .with("max", MAX_TAGS)));
        }
        let errors = check(&all, &id, &name, body.color, body.parent_id.as_deref());
        if !errors.is_empty() {
            return Ok(Err(errors.into_error()));
        }
        tags::insert(
            &tx,
            &NewTag {
                id: &id,
                user_id: &user_id,
                parent_id: body.parent_id.as_deref(),
                name: &name,
                color: body.color,
            },
        )?;
        let tag = tags::get(&tx, &user_id, &id)?.ok_or_else(|| anyhow::anyhow!("tag missing"))?;
        tx.commit()?;
        Ok(Ok(view(tag, Vec::new())))
    })
    .await?;
    let view = saved?;
    tracing::info!(user = %user.id, tag = %view.id, "tag created");
    Ok((StatusCode::CREATED, Json(view)))
}

/// Partial update; missing fields stay. `parent_id: null` moves to the top
/// level, `color: null` takes the color of the parent tag. Without
/// `position` the position stays; on a new level the tag goes to the end.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateBody {
    name: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    parent_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    color: Option<Option<i64>>,
    position: Option<u32>,
}

async fn update(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<UpdateBody>,
) -> Result<Json<TagView>, ApiError> {
    let saved = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let all = tags::list(&tx, &user.id)?;
        let Some(current) = all.iter().find(|tag| tag.id == id).cloned() else {
            return Ok(Err(ApiError::NotFound));
        };
        let name = body
            .name
            .as_deref()
            .map_or_else(|| current.name.clone(), normalize_name);
        let color = body.color.unwrap_or(current.color);
        let parent = match &body.parent_id {
            None => current.parent_id.as_deref(),
            Some(parent) => parent.as_deref(),
        };
        let errors = check(&all, &id, &name, color, parent);
        if !errors.is_empty() {
            return Ok(Err(errors.into_error()));
        }
        tags::update(
            &tx,
            &user.id,
            &current,
            &Change {
                name: &name,
                color,
                parent_id: parent,
                position: body
                    .position
                    .map(|p| usize::try_from(p).unwrap_or(usize::MAX)),
            },
        )?;
        let tag = tags::get(&tx, &user.id, &id)?.ok_or_else(|| anyhow::anyhow!("tag missing"))?;
        let links = tags::links_of(&tx, &id)?;
        tx.commit()?;
        Ok(Ok(view(tag, links)))
    })
    .await?;
    Ok(Json(saved?))
}

async fn remove(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let user_id = user.id.clone();
    let tag = id.clone();
    let removed = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        let removed = tags::delete(&tx, &user_id, &tag)?;
        tx.commit()?;
        Ok(removed)
    })
    .await?;
    if removed {
        tracing::info!(user = %user.id, tag = %id, "tag deleted");
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

async fn links(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let links = db::call(&state.db, move |conn| {
        if tags::get(conn, &user.id, &id)?.is_none() {
            return Ok(None);
        }
        Ok(Some(tags::links_of(conn, &id)?))
    })
    .await?
    .ok_or(ApiError::NotFound)?;
    Ok(Json(json!({ "links": links })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LinksBody {
    links: Vec<LinkBody>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkBody {
    mail_account_id: String,
    mailbox_id: String,
}

/// Id per RFC 8620, 1.2: 1 to 255 characters from `A–Z a–z 0–9 - _`.
fn is_jmap_id(value: &str) -> bool {
    (1..=255).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Replaces the links of a tag. Field errors per entry under
/// `links.<i>.mail_account_id` (`unknown`: not the user's own account,
/// `duplicate`) and `links.<i>.mailbox_id` (`invalid`, `taken` with the tag
/// the mailbox already belongs to).
async fn set_links(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<LinksBody>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user.id.clone();
    let tag = id.clone();
    let saved = db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        if tags::get(&tx, &user_id, &tag)?.is_none() {
            return Ok(Err(ApiError::NotFound));
        }
        let mut errors = FieldErrors::default();
        let mut seen = HashSet::new();
        for (i, link) in body.links.iter().enumerate() {
            let account_field = format!("links.{i}.mail_account_id");
            let mailbox_field = format!("links.{i}.mailbox_id");
            let own_account = mail_accounts::exists(&tx, &user_id, &link.mail_account_id)?;
            if !own_account {
                errors.code(&account_field, "unknown");
            } else if !seen.insert(link.mail_account_id.as_str()) {
                errors.code(&account_field, "duplicate");
            }
            if !is_jmap_id(&link.mailbox_id) {
                errors.code(&mailbox_field, "invalid");
            } else if own_account
                && let Some(other) = tags::linked_tag(&tx, &link.mail_account_id, &link.mailbox_id)?
                && other != tag
            {
                errors.add(&mailbox_field, json!({ "code": "taken", "tag": other }));
            }
        }
        if !errors.is_empty() {
            return Ok(Err(errors.into_error()));
        }
        let links: Vec<Link> = body
            .links
            .into_iter()
            .map(|link| Link {
                mail_account_id: link.mail_account_id,
                mailbox_id: link.mailbox_id,
            })
            .collect();
        tags::set_links(&tx, &tag, &links)?;
        let stored = tags::links_of(&tx, &tag)?;
        tx.commit()?;
        Ok(Ok(stored))
    })
    .await?;
    let links = saved?;
    tracing::info!(user = %user.id, tag = %id, links = links.len(), "tag links set");
    Ok(Json(json!({ "links": links })))
}
