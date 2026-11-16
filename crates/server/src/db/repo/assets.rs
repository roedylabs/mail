//! Table `assets`: the uploaded branding logo.

use rusqlite::{Connection, OptionalExtension as _};

use crate::logo::{Format, Image};

/// Inserts the image; the same image (same ID) stays as it is.
pub fn insert(conn: &Connection, image: &Image) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO assets (id, mime, data) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING",
        (&image.id, image.format.mime(), image.data.as_ref()),
    )?;
    Ok(())
}

/// The image with the ID `id`, if it exists.
pub fn get(conn: &Connection, id: &str) -> anyhow::Result<Option<Image>> {
    let row: Option<(String, Vec<u8>)> = conn
        .query_row("SELECT mime, data FROM assets WHERE id = ?1", [id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    Ok(row.and_then(|(mime, data)| {
        Format::of_mime(&mime).map(|format| Image {
            id: id.to_owned(),
            format,
            data: data.into(),
        })
    }))
}

/// Space used by all images in bytes.
pub fn size(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COALESCE(SUM(LENGTH(data)), 0) FROM assets",
        [],
        |row| row.get(0),
    )
}

/// Deletes all images except `keep`.
pub fn delete_except(conn: &Connection, keep: Option<&str>) -> anyhow::Result<usize> {
    Ok(conn.execute("DELETE FROM assets WHERE id IS NOT ?1", [keep])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    #[test]
    fn insert_get_and_keep_only_one() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrations::run(&mut conn).unwrap();
        let a = Image::new(Format::Png, &b"a"[..]);
        let b = Image::new(Format::Svg, &b"<svg/>"[..]);
        insert(&conn, &a).unwrap();
        insert(&conn, &a).unwrap();
        insert(&conn, &b).unwrap();
        assert_eq!(size(&conn).unwrap(), 7);
        assert_eq!(get(&conn, &a.id).unwrap(), Some(a.clone()));
        assert_eq!(get(&conn, &b.id).unwrap().unwrap().format, Format::Svg);
        assert_eq!(get(&conn, "missing").unwrap(), None);
        assert_eq!(delete_except(&conn, Some(&b.id)).unwrap(), 1);
        assert_eq!(get(&conn, &a.id).unwrap(), None);
        assert_eq!(delete_except(&conn, None).unwrap(), 1);
        assert_eq!(get(&conn, &b.id).unwrap(), None);
        assert_eq!(size(&conn).unwrap(), 0);
    }
}
