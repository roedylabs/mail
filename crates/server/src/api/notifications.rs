//! Notifications at the bell.
//!
//! - `GET notifications`: the newest (at most
//!   [`notifications::MAX_PER_USER`]) with icon, title, text and target in
//!   the person's language (`events::texts`), plus `unread` (the unread ones
//!   among them).
//! - `POST notifications/read`: `{"ids": […]}` marks those, `{"all":
//!   true}` all as read; responds with `unread`.
//! - `DELETE notifications/:id`: removes one. "Undo" in the page's toast
//!   waits in the client before it sends the request.
//!
//! Team and system notifications are visible only to administrators
//! (the backend sends them only to administrators); after a
//! demotion the entries stay hidden instead of deleted.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{ApiError, FieldErrors, JsonBody};
use crate::{
    app::AppState,
    auth::CurrentUser,
    db::{
        self,
        repo::{
            notifications::{self, Notification},
            users::Role,
        },
    },
    events::texts::{self, Context},
    settings,
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/notifications", get(list))
        .route("/notifications/read", post(mark_read))
        .route("/notifications/{id}", delete(remove))
}

/// One bell entry: stored fields and the texts rendered from them. Without
/// `params`: whatever the person should see of them is in the text.
fn notification_json(n: &Notification, cx: &Context<'_>) -> Value {
    let shown = texts::render(&n.topic, &n.kind, &n.params, cx);
    json!({
        "id": n.id,
        "topic": n.topic,
        "kind": n.kind,
        "icon": shown.icon,
        "title": shown.title,
        "text": shown.text,
        "target": shown.target.as_ref().map(texts::Target::to_json),
        "created_at": n.created_at,
        "read_at": n.read_at,
    })
}

async fn list(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Value>, ApiError> {
    let admin = user.role == Role::Admin;
    let (lang, listed, unread) = db::call(&state.db, move |conn| {
        let lang = settings::load(conn, &user.id)?.settings.lang;
        let listed = notifications::visible(conn, &user.id, admin, notifications::MAX_PER_USER)?;
        let unread = notifications::unread(conn, &user.id, admin, notifications::MAX_PER_USER)?;
        Ok((lang, listed, unread))
    })
    .await?;
    let brand = state.brand();
    let cx = Context {
        lang,
        app: &brand.app,
    };
    let items: Vec<Value> = listed.iter().map(|n| notification_json(n, &cx)).collect();
    Ok(Json(json!({ "notifications": items, "unread": unread })))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadBody {
    #[serde(default)]
    ids: Option<Vec<String>>,
    #[serde(default)]
    all: bool,
}

/// "Read": single ones on opening, all via "Mark all as read". The request
/// skips foreign, hidden and unknown IDs.
async fn mark_read(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    JsonBody(body): JsonBody<ReadBody>,
) -> Result<Json<Value>, ApiError> {
    let mut errors = FieldErrors::default();
    match (&body.ids, body.all) {
        (Some(_), true) => errors.code("all", "conflict"),
        (None, false) => errors.code("ids", "required"),
        (Some(ids), false) if ids.len() > notifications::MAX_PER_USER => {
            errors.code("ids", "too_many");
        }
        _ => {}
    }
    if !errors.is_empty() {
        return Err(errors.into_error());
    }
    let admin = user.role == Role::Admin;
    let unread = db::call(&state.db, move |conn| {
        notifications::mark_read(conn, &user.id, admin, body.ids.as_deref())?;
        Ok(notifications::unread(
            conn,
            &user.id,
            admin,
            notifications::MAX_PER_USER,
        )?)
    })
    .await?;
    Ok(Json(json!({ "unread": unread })))
}

/// "Remove" one entry; a foreign, hidden or already removed one does not
/// exist (404).
async fn remove(
    State(state): State<AppState>,
    CurrentUser(user): CurrentUser,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let admin = user.role == Role::Admin;
    let deleted = db::call(&state.db, move |conn| {
        Ok(notifications::delete(conn, &user.id, admin, &id)?)
    })
    .await?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}
