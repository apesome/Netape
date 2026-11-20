//! SQLite-backed store.
//!
//! All public methods take `&self` because the connection is protected by an
//! internal `Mutex<Connection>`.  The lock is held only for the duration of
//! each SQL statement — never across application-level operations — so
//! contention is minimal.

use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;
use tracing::{debug, warn};

use crate::error::{StoreError, StoreResult};
use crate::model::{AccountOwner, Data, DataType, OwnerType};
use crate::settings::Settings;

/// The central store. Clone-cheap: backed by `Arc`.
#[derive(Clone)]
pub struct Store {
    inner: Arc<Inner>,
}

struct Inner {
    conn: Mutex<Connection>,
}

impl Store {
    /// Open (or create) the SQLite database at `path`.
    pub fn open(path: impl AsRef<Path>) -> StoreResult<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| StoreError::Other(e.to_string()))?;
        }

        let conn = Connection::open(path)?;
        // WAL mode: readers don't block writers and vice-versa.
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        let store = Store {
            inner: Arc::new(Inner {
                conn: Mutex::new(conn),
            }),
        };

        store.migrate()?;
        Ok(store)
    }

    /// Open an in-memory database (useful for tests).
    pub fn open_in_memory() -> StoreResult<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        let store = Store {
            inner: Arc::new(Inner {
                conn: Mutex::new(conn),
            }),
        };
        store.migrate()?;
        Ok(store)
    }

    // -----------------------------------------------------------------------
    // Schema migrations
    // -----------------------------------------------------------------------

    fn migrate(&self) -> StoreResult<()> {
        let conn = self.inner.conn.lock();

        // user_version is a SQLite PRAGMA we use as a schema version counter.
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

        if version < 1 {
            conn.execute_batch(
                "
                CREATE TABLE IF NOT EXISTS data (
                    id         TEXT PRIMARY KEY NOT NULL,
                    owner_id   TEXT NOT NULL,
                    owner_type TEXT NOT NULL,
                    data_type  TEXT NOT NULL,
                    data       TEXT NOT NULL DEFAULT '',
                    version    INTEGER NOT NULL DEFAULT 0,
                    synced     INTEGER NOT NULL DEFAULT 0,
                    deleted    INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS settings (
                    id    INTEGER PRIMARY KEY AUTOINCREMENT,
                    name  TEXT NOT NULL UNIQUE,
                    value TEXT NOT NULL
                );

                PRAGMA user_version = 1;
                ",
            )?;
            debug!("database migrated to schema v1");
        }

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Data CRUD
    // -----------------------------------------------------------------------

    /// Insert or update a row (upsert).  Returns the final [`Data`].
    pub fn save(&self, data: &Data) -> StoreResult<()> {
        let conn = self.inner.conn.lock();
        conn.execute(
            "INSERT INTO data (id, owner_id, owner_type, data_type, data, version, synced, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
               data       = excluded.data,
               version    = excluded.version,
               synced     = excluded.synced,
               deleted    = excluded.deleted",
            params![
                &data.id,
                &data.owner_id,
                &data.owner_type,
                &data.data_type,
                &data.data,
                data.version,
                data.synced as i64,
                data.deleted as i64,
            ],
        )?;
        Ok(())
    }

    /// Upsert a domain object as JSON.
    /// Convenience wrapper: serialises `value`, then calls [`save`].
    pub fn save_object<T: Serialize>(
        &self,
        id: &str,
        owner: &AccountOwner,
        data_type: DataType,
        value: &T,
    ) -> StoreResult<()> {
        let json = serde_json::to_string(value)?;
        let existing_version = self.version(id).unwrap_or(0);
        let row = Data {
            id: id.to_string(),
            owner_id: owner.id.clone(),
            owner_type: owner.owner_type.to_string(),
            data_type: data_type.to_string(),
            data: json,
            version: existing_version + 1,
            synced: false,
            deleted: false,
        };
        self.save(&row)
    }

    /// Update only sort fields in one transaction, preserving all other object data.
    pub fn reorder_objects(&self, ids: &[String], owner: &AccountOwner, data_type: DataType) -> StoreResult<()> {
        self.reorder_and_move_objects(ids, None, owner, data_type)
    }

    /// Patch a parent and the destination order atomically without replacing credentials or options.
    pub fn reorder_and_move_objects(&self, ids: &[String], moved: Option<(&str, &str)>, owner: &AccountOwner, data_type: DataType) -> StoreResult<()> {
        let mut conn = self.inner.conn.lock();
        let tx = conn.transaction()?;
        for (index, id) in ids.iter().enumerate() {
            let data: String = tx.query_row(
                "SELECT data FROM data WHERE id = ?1 AND owner_id = ?2 AND owner_type = ?3 AND data_type = ?4 AND deleted = 0",
                params![id, &owner.id, owner.owner_type.to_string(), data_type.to_string()],
                |row| row.get(0),
            )?;
            let mut value: serde_json::Value = serde_json::from_str(&data)?;
            value["sort"] = (index as i64).into();
            if let Some((moved_id, parent_id)) = moved {
                if id == moved_id { value["parentId"] = parent_id.into(); }
            }
            tx.execute("UPDATE data SET data = ?1, version = version + 1, synced = 0 WHERE id = ?2",
                params![serde_json::to_string(&value)?, id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Insert, incrementing the existing version if the row already exists.
    pub fn save_and_increment(&self, data: &Data) -> StoreResult<()> {
        if let Some(existing) = self.get_raw(data.id.as_str())? {
            if existing.deleted {
                return Ok(());
            }
            let conn = self.inner.conn.lock();
            conn.execute(
                "UPDATE data SET data = ?1, version = ?2, synced = 0 WHERE id = ?3",
                params![&data.data, existing.version + 1, &data.id],
            )?;
        } else {
            self.save(data)?;
        }
        Ok(())
    }

    /// Soft-delete a row and mark it unsynced (unless local owner).
    pub fn delete(&self, id: &str, is_local: bool) -> StoreResult<()> {
        let conn = self.inner.conn.lock();
        conn.execute(
            "UPDATE data SET deleted = 1, synced = ?1, data = '' WHERE id = ?2",
            params![is_local as i64, id],
        )?;
        Ok(())
    }

    /// Fetch a single raw [`Data`] row by id (including deleted rows).
    pub fn get_raw(&self, id: &str) -> StoreResult<Option<Data>> {
        let conn = self.inner.conn.lock();
        conn.query_row(
            "SELECT id, owner_id, owner_type, data_type, data, version, synced, deleted
             FROM data WHERE id = ?1",
            params![id],
            row_to_data,
        )
        .optional()
        .map_err(StoreError::Db)
    }

    /// List all non-deleted rows of a given type, optionally filtered by owner.
    pub fn list_raw(
        &self,
        data_type: DataType,
        owner_id: Option<&str>,
    ) -> StoreResult<Vec<Data>> {
        let conn = self.inner.conn.lock();
        let type_str = data_type.to_string();
        let mut stmt = conn.prepare(
            "SELECT id, owner_id, owner_type, data_type, data, version, synced, deleted
             FROM data
             WHERE data_type = ?1 AND deleted = 0",
        )?;

        let rows = stmt.query_map(params![&type_str], row_to_data)?;
        let mut result = Vec::new();
        for row in rows {
            match row {
                Ok(d) => {
                    if let Some(oid) = owner_id {
                        if d.owner_id == oid {
                            result.push(d);
                        }
                    } else {
                        result.push(d);
                    }
                }
                Err(e) => warn!("skipping malformed row: {e}"),
            }
        }
        Ok(result)
    }

    /// Deserialise all non-deleted rows of `data_type` into `T`.
    pub fn list<T: DeserializeOwned>(
        &self,
        data_type: DataType,
        owner_id: Option<&str>,
    ) -> StoreResult<Vec<T>> {
        let rows = self.list_raw(data_type, owner_id)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            match serde_json::from_str::<T>(&row.data) {
                Ok(v) => out.push(v),
                Err(e) => warn!("skipping un-parseable row {}: {e}", row.id),
            }
        }
        Ok(out)
    }

    /// The current version of a row, or 0 if it doesn't exist.
    pub fn version(&self, id: &str) -> StoreResult<i64> {
        let conn = self.inner.conn.lock();
        conn.query_row(
            "SELECT version FROM data WHERE id = ?1 AND deleted = 0",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map(|v| v.unwrap_or(0))
        .map_err(StoreError::Db)
    }

    /// All rows not yet synced to the cloud.
    pub fn unsynced(&self) -> StoreResult<Vec<Data>> {
        let conn = self.inner.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, owner_id, owner_type, data_type, data, version, synced, deleted
             FROM data WHERE synced = 0",
        )?;
        let rows = stmt.query_map([], row_to_data)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(StoreError::Db)
    }

    /// Hard-delete all rows owned by a user or team id.
    pub fn purge_owner(&self, owner_id: &str, owner_type: OwnerType) -> StoreResult<()> {
        let conn = self.inner.conn.lock();
        conn.execute(
            "DELETE FROM data WHERE owner_id = ?1 AND owner_type = ?2",
            params![owner_id, owner_type.as_str()],
        )?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    /// Read a single setting value.
    pub fn get_setting(&self, name: &str) -> StoreResult<Option<String>> {
        let conn = self.inner.conn.lock();
        conn.query_row(
            "SELECT value FROM settings WHERE name = ?1",
            params![name],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(StoreError::Db)
    }

    /// Write (upsert) a single setting value.
    pub fn set_setting(&self, name: &str, value: &str) -> StoreResult<()> {
        let conn = self.inner.conn.lock();
        conn.execute(
            "INSERT INTO settings (name, value) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET value = excluded.value",
            params![name, value],
        )?;
        Ok(())
    }

    /// Snapshot of all settings as a `HashMap`.
    pub fn all_settings(&self) -> StoreResult<std::collections::HashMap<String, String>> {
        let conn = self.inner.conn.lock();
        let mut stmt = conn.prepare("SELECT name, value FROM settings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<Result<_, _>>().map_err(StoreError::Db)
    }

    // -----------------------------------------------------------------------
    // Typed settings facades
    // -----------------------------------------------------------------------

    /// Access terminal display settings.
    pub fn terminal_settings(&self) -> Settings<'_> {
        Settings::new(self, "Setting.Terminal")
    }

    /// Access appearance (theme, language, …) settings.
    pub fn appearance_settings(&self) -> Settings<'_> {
        Settings::new(self, "Setting.Appearance")
    }

    /// Access SFTP settings.
    pub fn sftp_settings(&self) -> Settings<'_> {
        Settings::new(self, "Setting.SFTP")
    }

    /// General-purpose property bag (arbitrary key-value).
    pub fn properties(&self) -> Settings<'_> {
        Settings::new(self, "Setting.Properties")
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn row_to_data(row: &rusqlite::Row<'_>) -> rusqlite::Result<Data> {
    Ok(Data {
        id: row.get(0)?,
        owner_id: row.get(1)?,
        owner_type: row.get(2)?,
        data_type: row.get(3)?,
        data: row.get(4)?,
        version: row.get(5)?,
        synced: row.get::<_, i64>(6)? != 0,
        deleted: row.get::<_, i64>(7)? != 0,
    })
}

// ---------------------------------------------------------------------------
// Convenience: make a Store for the default app data directory
// ---------------------------------------------------------------------------

/// Open the production store at `<app_data_dir>/config/netape.db`.
pub fn open_default() -> StoreResult<Store> {
    let base = dirs::data_local_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("Netape");
    Store::open(base.join("config").join("netape.db"))
}

/// Return a [`Store`] for use when no cloud account is signed in.
pub fn with_local_owner(store: &Store) -> (Store, AccountOwner) {
    (store.clone(), crate::model::local_owner())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{new_id, DataType, LOCAL_OWNER_ID};
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Serialize, Deserialize, PartialEq)]
    struct Host {
        name: String,
        address: String,
    }

    fn local() -> AccountOwner {
        AccountOwner::user(LOCAL_OWNER_ID, "local")
    }

    #[test]
    fn roundtrip_object() {
        let store = Store::open_in_memory().unwrap();
        let owner = local();
        let id = new_id();
        let host = Host {
            name: "prod".into(),
            address: "10.0.0.1".into(),
        };
        store.save_object(&id, &owner, DataType::Host, &host).unwrap();

        let loaded: Vec<Host> = store.list(DataType::Host, None).unwrap();
        assert_eq!(loaded, vec![host]);
    }

    #[test]
    fn soft_delete() {
        let store = Store::open_in_memory().unwrap();
        let owner = local();
        let id = new_id();
        let host = Host { name: "x".into(), address: "y".into() };
        store.save_object(&id, &owner, DataType::Host, &host).unwrap();
        store.delete(&id, true).unwrap();

        let loaded: Vec<Host> = store.list(DataType::Host, None).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn settings_roundtrip() {
        let store = Store::open_in_memory().unwrap();
        store.set_setting("Setting.Terminal.fontSize", "16").unwrap();
        let v = store.get_setting("Setting.Terminal.fontSize").unwrap();
        assert_eq!(v.as_deref(), Some("16"));
    }

    #[test]
    fn version_increments() {
        let store = Store::open_in_memory().unwrap();
        let owner = local();
        let id = new_id();
        let h1 = Host { name: "a".into(), address: "b".into() };
        let h2 = Host { name: "a2".into(), address: "b2".into() };
        store.save_object(&id, &owner, DataType::Host, &h1).unwrap();
        store.save_object(&id, &owner, DataType::Host, &h2).unwrap();
        assert_eq!(store.version(&id).unwrap(), 2);
    }
}
