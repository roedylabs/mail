//! Tables `tags` and `tag_links`: the users' tags and their mailboxes per
//! mail account. Input is validated by `api::tags`; this module only reads and
//! writes.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension as _, Row};
use serde::Serialize;

/// A row of `tags`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tag {
    pub id: String,
    /// Parent tag, `None` = top level.
    pub parent_id: Option<String>,
    pub name: String,
    /// Index into the account colours, `None` = color of the parent tag.
    pub color: Option<i64>,
    /// Order among the siblings, starting at 0.
    pub position: i64,
    pub created_at: String,
}

/// Mailbox of a tag in a mail account; same shape in the API responses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Link {
    pub mail_account_id: String,
    pub mailbox_id: String,
}

/// A new tag for [`insert`].
pub struct NewTag<'a> {
    pub id: &'a str,
    pub user_id: &'a str,
    pub parent_id: Option<&'a str>,
    pub name: &'a str,
    pub color: Option<i64>,
}

/// New values of a tag for [`update`].
pub struct Change<'a> {
    pub name: &'a str,
    pub color: Option<i64>,
    pub parent_id: Option<&'a str>,
    /// Position among the siblings (too large = at the end). `None` keeps the
    /// position on the same level and appends at the end of a new one.
    pub position: Option<usize>,
}

const COLUMNS: &str = "id, parent_id, name, color, position, created_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        name: row.get(2)?,
        color: row.get(3)?,
        position: row.get(4)?,
        created_at: row.get(5)?,
    })
}

/// Tags of a user, in their order per level.
pub fn list(conn: &Connection, user_id: &str) -> rusqlite::Result<Vec<Tag>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM tags WHERE user_id = ?1 ORDER BY position, id"
    ))?;
    stmt.query_map([user_id], from_row)?.collect()
}

pub fn get(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<Option<Tag>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM tags WHERE id = ?1 AND user_id = ?2"),
        (id, user_id),
        from_row,
    )
    .optional()
}

/// Creates a tag at the end of its level.
pub fn insert(conn: &Connection, tag: &NewTag<'_>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO tags (id, user_id, parent_id, name, color, position) \
         VALUES (?1, ?2, ?3, ?4, ?5, \
         (SELECT COUNT(*) FROM tags WHERE user_id = ?2 AND parent_id IS ?3))",
        (tag.id, tag.user_id, tag.parent_id, tag.name, tag.color),
    )?;
    Ok(())
}

/// Changes name, color and level of `current` in one statement (otherwise an
/// intermediate state would hit the uniqueness of names) and renumbers the
/// affected levels.
pub fn update(
    conn: &Connection,
    user_id: &str,
    current: &Tag,
    change: &Change<'_>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE tags SET name = ?3, color = ?4, parent_id = ?5 WHERE id = ?1 AND user_id = ?2",
        (
            &current.id,
            user_id,
            change.name,
            change.color,
            change.parent_id,
        ),
    )?;
    let moved = current.parent_id.as_deref() != change.parent_id;
    if !moved && change.position.is_none() {
        return Ok(());
    }
    let mut order = sibling_ids(conn, user_id, change.parent_id)?;
    order.retain(|id| *id != current.id);
    let at = change.position.map_or(order.len(), |p| p.min(order.len()));
    order.insert(at, current.id.clone());
    renumber(conn, &order)?;
    if moved {
        renumber(
            conn,
            &sibling_ids(conn, user_id, current.parent_id.as_deref())?,
        )?;
    }
    Ok(())
}

/// Deletes a tag with its subtags and all links (foreign keys) and closes the
/// gap in its level.
pub fn delete(conn: &Connection, user_id: &str, id: &str) -> rusqlite::Result<bool> {
    let Some(tag) = get(conn, user_id, id)? else {
        return Ok(false);
    };
    conn.execute(
        "DELETE FROM tags WHERE id = ?1 AND user_id = ?2",
        (id, user_id),
    )?;
    renumber(conn, &sibling_ids(conn, user_id, tag.parent_id.as_deref())?)?;
    Ok(true)
}

fn sibling_ids(
    conn: &Connection,
    user_id: &str,
    parent_id: Option<&str>,
) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM tags WHERE user_id = ?1 AND parent_id IS ?2 ORDER BY position, id",
    )?;
    stmt.query_map((user_id, parent_id), |r| r.get(0))?
        .collect()
}

fn renumber(conn: &Connection, order: &[String]) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("UPDATE tags SET position = ?2 WHERE id = ?1")?;
    for (position, id) in order.iter().enumerate() {
        stmt.execute((id, i64::try_from(position).unwrap_or(i64::MAX)))?;
    }
    Ok(())
}

/// Links of all tags of a user per tag, ordered by mail account.
pub fn links(conn: &Connection, user_id: &str) -> rusqlite::Result<HashMap<String, Vec<Link>>> {
    let mut stmt = conn.prepare(
        "SELECT l.tag_id, l.mail_account_id, l.mailbox_id FROM tag_links l \
         JOIN tags t ON t.id = l.tag_id WHERE t.user_id = ?1 \
         ORDER BY l.mail_account_id",
    )?;
    let mut links: HashMap<String, Vec<Link>> = HashMap::new();
    for row in stmt.query_map([user_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            Link {
                mail_account_id: r.get(1)?,
                mailbox_id: r.get(2)?,
            },
        ))
    })? {
        let (tag_id, link) = row?;
        links.entry(tag_id).or_default().push(link);
    }
    Ok(links)
}

/// Links of a tag, ordered by mail account.
pub fn links_of(conn: &Connection, tag_id: &str) -> rusqlite::Result<Vec<Link>> {
    let mut stmt = conn.prepare(
        "SELECT mail_account_id, mailbox_id FROM tag_links WHERE tag_id = ?1 \
         ORDER BY mail_account_id",
    )?;
    stmt.query_map([tag_id], |r| {
        Ok(Link {
            mail_account_id: r.get(0)?,
            mailbox_id: r.get(1)?,
        })
    })?
    .collect()
}

/// Replaces the links of a tag.
pub fn set_links(conn: &Connection, tag_id: &str, links: &[Link]) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM tag_links WHERE tag_id = ?1", [tag_id])?;
    let mut stmt = conn.prepare(
        "INSERT INTO tag_links (tag_id, mail_account_id, mailbox_id) VALUES (?1, ?2, ?3)",
    )?;
    for link in links {
        stmt.execute((tag_id, &link.mail_account_id, &link.mailbox_id))?;
    }
    Ok(())
}

/// Tag that a mailbox of a mail account is linked to.
pub fn linked_tag(
    conn: &Connection,
    mail_account_id: &str,
    mailbox_id: &str,
) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT tag_id FROM tag_links WHERE mail_account_id = ?1 AND mailbox_id = ?2",
        (mail_account_id, mailbox_id),
        |r| r.get(0),
    )
    .optional()
}
