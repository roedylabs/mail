//! Administration › Users.
//!
//! - `GET users`: active, locked and invited users in one list (`status`),
//!   with `mfa` and `last_seen_at`.
//! - `PATCH users/:id` (`{role}`), `POST users/:id/lock|unlock`,
//!   `POST users/:id/reset-mfa`, `DELETE users/:id`: not for the own account
//!   (422 `own_account`); invitations via `invites/:id`.
//! - `POST users/bulk` (`{action, ids, role?}`): role, lock, unlock or remove
//!   for the selection of the list – users and invitations mixed; whatever
//!   does not fit (such as "lock" for a locked account or the own one) stays
//!   as it is. The response names the changed IDs.
//!
//! Every change checks in its transaction whether the acting administrator is
//! still signed in and an administrator ([`admin_holds`]): otherwise two
//! admins taking each other's role at the same time would leave nobody.
//! Locking ends all sessions and discards open links from mails; role changed
//! and user locked are reported to the other administrators (`events::team`).
//! Removing then revokes the grants of the mail accounts like
//! `DELETE auth/me`. "Reset multi-factor"
//! removes authenticator apps and recovery codes like `reset-admin`, without
//! a new password and without ending the sessions, and sends the person the
//! security notice `security_mfa_reset`.

use std::{collections::BTreeSet, net::IpAddr};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    ApiError, FieldErrors, JsonBody, invites,
    mail_accounts::{self, Grant},
    mfa::mfa_disabled,
};
use crate::{
    app::AppState,
    auth::{AdminUser, AuthUser},
    client_ip::ClientIp,
    db::{
        self,
        repo::{
            self,
            audit_log::{self, Category, Entry},
            invitations::{self, Invitation},
            recovery_codes, sessions, totp_devices,
            users::{self, Listed, Profile, Role},
        },
    },
    events::{self, Outbox, Security, Team},
};

/// At most this many IDs per bulk action.
const MAX_BULK: usize = 500;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/users", get(list))
        .route("/users/bulk", post(bulk))
        .route("/users/{id}", delete(remove).patch(update))
        .route("/users/{id}/lock", post(lock))
        .route("/users/{id}/unlock", post(unlock))
        .route("/users/{id}/reset-mfa", post(reset_mfa))
}

/// 422 `own_account`: the own account is changed under Account › Profile.
fn own_account() -> ApiError {
    ApiError::rejected(StatusCode::UNPROCESSABLE_ENTITY, "own_account")
}

/// Whether the acting administrator may still act: their session exists, the
/// account is active and has the administrator role (otherwise 401 or 403
/// like before the request).
pub(crate) fn admin_holds(
    conn: &Connection,
    admin: &AuthUser,
) -> rusqlite::Result<Result<(), ApiError>> {
    if !sessions::is_valid(conn, &admin.id, &admin.session_id)? {
        return Ok(Err(ApiError::Unauthorized));
    }
    Ok(match users::credentials_by_id(conn, &admin.id)? {
        Some(now) if now.active && now.user.role == Role::Admin => Ok(()),
        Some(now) if now.active => Err(ApiError::Forbidden),
        _ => Err(ApiError::Unauthorized),
    })
}

/// List entry for a user.
fn user_json(user: &Listed) -> Value {
    let p = &user.profile;
    json!({
        "id": p.id,
        "status": if user.active { "active" } else { "locked" },
        "name": p.display_name,
        "email": p.email,
        "username": p.username,
        "role": p.role.as_str(),
        "mfa": user.mfa,
        "last_seen_at": user.last_seen_at,
        "created_at": user.created_at,
    })
}

/// List entry for an invitation: name only if it was in the form;
/// `mail_sent_at` empty = "Not sent".
pub(super) fn invite_json(invite: &Invitation) -> Value {
    json!({
        "id": invite.id,
        "status": "invited",
        "name": invite.name,
        "email": invite.email,
        "role": invite.role.as_str(),
        "mfa": false,
        "created_at": invite.created_at,
        "invited_by": invite.invited_by.as_ref().map(|id| json!({
            "id": id,
            "name": invite.inviter,
        })),
        "mail_sent_at": invite.mail_sent_at,
        "expires_at": invite.expires_at,
        "expired": invite.expired,
    })
}

async fn list(State(state): State<AppState>, _: AdminUser) -> Result<Json<Value>, ApiError> {
    let (users, invites) = db::call(&state.db, |conn| {
        Ok((users::list(conn)?, invitations::list(conn)?))
    })
    .await?;
    let rows: Vec<Value> = users
        .iter()
        .map(user_json)
        .chain(invites.iter().map(invite_json))
        .collect();
    Ok(Json(json!({ "users": rows })))
}

/// Who acts: for audit log and events.
pub(super) struct Actor<'a> {
    pub admin: &'a AuthUser,
    pub ip: IpAddr,
}

impl Actor<'_> {
    pub fn entry(&self, action: &'static str, target: &str, details: Value) -> Entry {
        Entry::new(Category::Users, action)
            .actor(self.admin)
            .ip(self.ip)
            .target(target)
            .details(details)
    }
}

fn names(user: &Profile) -> Value {
    json!({ "name": user.display_name, "email": user.email })
}

/// New role with audit log entry and event; `false` if it already applied.
fn change_role(
    conn: &Connection,
    actor: &Actor<'_>,
    user: &Profile,
    role: Role,
) -> anyhow::Result<bool> {
    if !users::set_role(conn, &user.id, role)? {
        return Ok(false);
    }
    let mut details = names(user);
    details["role"] = json!(role.as_str());
    details["previous"] = json!(user.role.as_str());
    audit_log::insert(conn, &actor.entry("users.role", &user.id, details))?;
    let event = Team::RoleChanged {
        user_id: &user.id,
        name: &user.display_name,
        role: role.as_str(),
    };
    events::team(conn, event, Some(&actor.admin.id))?;
    Ok(true)
}

/// Locks: sessions end, open links from mails no longer work; `false` if the
/// account was already locked.
fn lock_user(conn: &Connection, actor: &Actor<'_>, user: &Profile) -> anyhow::Result<bool> {
    if !users::lock(conn, &user.id)? {
        return Ok(false);
    }
    let ended = sessions::delete_for_user(conn, &user.id, None)?;
    repo::discard_links(conn, &user.id)?;
    let mut details = names(user);
    details["sessions_ended"] = json!(ended);
    audit_log::insert(conn, &actor.entry("users.lock", &user.id, details))?;
    let event = Team::UserLocked {
        user_id: &user.id,
        name: &user.display_name,
    };
    events::team(conn, event, Some(&actor.admin.id))?;
    Ok(true)
}

fn unlock_user(conn: &Connection, actor: &Actor<'_>, user: &Profile) -> anyhow::Result<bool> {
    if !users::unlock(conn, &user.id)? {
        return Ok(false);
    }
    audit_log::insert(conn, &actor.entry("users.unlock", &user.id, names(user)))?;
    Ok(true)
}

/// Removes with everything attached to the account; the grants of its mail
/// accounts go to `grants` and are revoked after the commit
/// ([`mail_accounts::revoke_grants`]).
fn remove_user(
    conn: &Connection,
    actor: &Actor<'_>,
    user: &Profile,
    grants: &mut Vec<Grant>,
) -> anyhow::Result<bool> {
    let found = mail_accounts::grants(conn, &user.id)?;
    if !users::delete(conn, &user.id)? {
        return Ok(false);
    }
    grants.extend(found);
    let mut details = names(user);
    details["role"] = json!(user.role.as_str());
    audit_log::insert(conn, &actor.entry("users.remove", &user.id, details))?;
    Ok(true)
}

/// A change by an administrator in one transaction: first [`admin_holds`],
/// then `apply`; if `apply` returns an API error, nothing is stored.
pub(super) async fn admin_change<T: Send + 'static>(
    state: &AppState,
    admin: AuthUser,
    ip: ClientIp,
    apply: impl FnOnce(&Connection, &Actor<'_>) -> anyhow::Result<Result<T, ApiError>> + Send + 'static,
) -> Result<T, ApiError> {
    db::call(&state.db, move |conn| {
        let tx = conn.transaction()?;
        if let Err(error) = admin_holds(&tx, &admin)? {
            return Ok(Err(error));
        }
        let actor = Actor {
            admin: &admin,
            ip: ip.0,
        };
        let result = apply(&tx, &actor)?;
        if result.is_ok() {
            tx.commit()?;
        }
        Ok(result)
    })
    .await?
}

/// Common flow of the endpoints for one user: not the own account,
/// [`admin_change`], then the row of the list (`None` after removal). Locked
/// and removed accounts lose their pending sign-in steps.
async fn one_user(
    state: &AppState,
    admin: AuthUser,
    ip: ClientIp,
    id: String,
    apply: impl FnOnce(&Connection, &Actor<'_>, &Profile) -> anyhow::Result<bool> + Send + 'static,
) -> Result<Option<Value>, ApiError> {
    if id == admin.id {
        return Err(own_account());
    }
    let target = id.clone();
    let row = admin_change(state, admin, ip, move |tx, actor| {
        let Some(user) = users::credentials_by_id(tx, &target)?.map(|c| c.user) else {
            return Ok(Err(ApiError::NotFound));
        };
        apply(tx, actor, &user)?;
        Ok(Ok(
            users::get_listed(tx, &target)?.map(|row| user_json(&row))
        ))
    })
    .await?;
    if row.as_ref().is_none_or(|row| row["status"] != "active") {
        state.challenges.discard_user(&id);
    }
    Ok(row)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RoleBody {
    pub role: Role,
}

/// "Role" in the expanded row.
async fn update(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
    JsonBody(body): JsonBody<RoleBody>,
) -> Result<Json<Value>, ApiError> {
    let row = one_user(&state, admin, ip, id, move |conn, actor, user| {
        change_role(conn, actor, user, body.role)
    })
    .await?;
    Ok(Json(json!({ "user": row })))
}

async fn lock(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let row = one_user(&state, admin, ip, id, lock_user).await?;
    Ok(Json(json!({ "user": row })))
}

async fn unlock(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let row = one_user(&state, admin, ip, id, unlock_user).await?;
    Ok(Json(json!({ "user": row })))
}

/// "Remove" after confirmation (the web app sends it once the toast with
/// "Undo" has expired); afterwards the token broker revokes the grants of
/// the mail accounts.
async fn remove(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    if id == admin.id {
        return Err(own_account());
    }
    let locks = mail_accounts::lock_owners(&state, [id.clone()]).await?;
    let target = id.clone();
    let removed = admin_change(&state, admin, ip, move |tx, actor| {
        let Some(user) = users::credentials_by_id(tx, &target)?.map(|c| c.user) else {
            return Ok(Err(ApiError::NotFound));
        };
        let mut grants = Vec::new();
        remove_user(tx, actor, &user, &mut grants)?;
        Ok(Ok(grants))
    })
    .await;
    drop(locks);
    let grants = removed?;
    state.challenges.discard_user(&id);
    mail_accounts::revoke_grants(&state, grants);
    Ok(StatusCode::NO_CONTENT)
}

/// "Reset multi-factor": also for administrators and locked accounts,
/// not for the own one, and without a confirmed app 409 `mfa_disabled`. The
/// mail is not part of the transaction: the reset applies even without system
/// mail or on a sending error.
async fn reset_mfa(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    ip: ClientIp,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if id == admin.id {
        return Err(own_account());
    }
    let target = id.clone();
    let (row, outbox) = admin_change(&state, admin, ip, move |tx, actor| {
        let Some(user) = users::credentials_by_id(tx, &target)?.map(|c| c.user) else {
            return Ok(Err(ApiError::NotFound));
        };
        if !totp_devices::has_confirmed(tx, &user.id)? {
            return Ok(Err(mfa_disabled()));
        }
        let devices = totp_devices::list(tx, &user.id)?.len();
        totp_devices::delete_all(tx, &user.id)?;
        recovery_codes::delete_all(tx, &user.id)?;
        let mut outbox = Outbox::default();
        let event = Security::MfaReset {
            by: &actor.admin.display_name,
        };
        events::security(tx, &mut outbox, (&user).into(), event)?;
        let mut details = names(&user);
        details["devices"] = json!(devices);
        audit_log::insert(tx, &actor.entry("users.mfa_reset", &user.id, details))?;
        let row = users::get_listed(tx, &user.id)?.map(|row| user_json(&row));
        Ok(Ok((row, outbox)))
    })
    .await?;
    // Otherwise a pending sign-in step would apply again as soon as the person
    // confirms a new app within the five minutes.
    state.challenges.discard_user(&id);
    outbox.send(&state);
    Ok(Json(json!({ "user": row })))
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Action {
    Role,
    Lock,
    Unlock,
    Remove,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BulkBody {
    action: Action,
    ids: Vec<String>,
    #[serde(default)]
    role: Option<Role>,
}

/// Bulk actions on the selection: role for users and invitations, lock only
/// active ones, unlock only locked ones, remove deletes users and withdraws
/// invitations – all in one transaction. The own account, like everything
/// that does not fit, stays unchanged (the list does not let it be selected
/// anyway).
async fn bulk(
    State(state): State<AppState>,
    AdminUser(admin): AdminUser,
    ip: ClientIp,
    JsonBody(body): JsonBody<BulkBody>,
) -> Result<Json<Value>, ApiError> {
    let mut errors = FieldErrors::default();
    if body.ids.is_empty() {
        errors.code("ids", "required");
    } else if body.ids.len() > MAX_BULK {
        errors.code("ids", "too_many");
    }
    let role = match (body.action, body.role) {
        (Action::Role, None) => {
            errors.code("role", "required");
            None
        }
        (_, role) => role,
    };
    if !errors.is_empty() {
        return Err(errors.into_error());
    }
    let mut ids: BTreeSet<String> = body.ids.into_iter().collect();
    ids.remove(&admin.id);
    let action = body.action;
    let locks = if action == Action::Remove {
        mail_accounts::lock_owners(&state, ids.iter().cloned()).await?
    } else {
        Vec::new()
    };
    let result = admin_change(&state, admin, ip, move |tx, actor| {
        let (mut changed, mut gone, mut grants) = (Vec::new(), Vec::new(), Vec::new());
        for id in &ids {
            let done = if let Some(user) = users::credentials_by_id(tx, id)?.map(|c| c.user) {
                let done = match action {
                    Action::Role => change_role(tx, actor, &user, role.unwrap_or(user.role))?,
                    Action::Lock => lock_user(tx, actor, &user)?,
                    Action::Unlock => unlock_user(tx, actor, &user)?,
                    Action::Remove => remove_user(tx, actor, &user, &mut grants)?,
                };
                if done && matches!(action, Action::Lock | Action::Remove) {
                    gone.push(id.clone());
                }
                done
            } else if let Some(invite) = invitations::get(tx, id)? {
                match action {
                    Action::Role => {
                        invites::change_role(tx, actor, &invite, role.unwrap_or(invite.role))?
                    }
                    Action::Remove => invites::revoke(tx, actor, &invite)?,
                    Action::Lock | Action::Unlock => false,
                }
            } else {
                false
            };
            if done {
                changed.push(id.clone());
            }
        }
        Ok(Ok((changed, gone, grants)))
    })
    .await;
    drop(locks);
    let (changed, gone, grants) = result?;
    for id in &gone {
        state.challenges.discard_user(id);
    }
    mail_accounts::revoke_grants(&state, grants);
    Ok(Json(json!({ "changed": changed })))
}
