//! `GET directory`: name and email address of all active users for the
//! contact search while composing, for every session. Locked and invited users are left out.

use axum::{Json, Router, extract::State, routing::get};
use serde_json::{Value, json};

use super::ApiError;
use crate::{app::AppState, auth::CurrentUser, db, db::repo::users};

pub fn routes() -> Router<AppState> {
    Router::new().route("/directory", get(list))
}

async fn list(State(state): State<AppState>, _: CurrentUser) -> Result<Json<Value>, ApiError> {
    let entries = db::call(&state.db, |conn| Ok(users::directory(conn)?)).await?;
    let users: Vec<Value> = entries
        .into_iter()
        .map(|(name, email)| json!({ "name": name, "email": email }))
        .collect();
    Ok(Json(json!({ "users": users })))
}
