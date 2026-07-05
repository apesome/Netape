//! Notes (quick-text / markdown notes).

use netape_store::{db::Store, model::{new_id, AccountOwner, DataType}};
use serde::{Deserialize, Serialize};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Discriminates between a leaf note and a folder grouping notes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum NoteKind {
    Folder,
    #[default]
    Note,
}

/// A saved note or a folder grouping notes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    #[serde(default = "new_id")]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub parent_id: String,
    #[serde(default)]
    pub kind: NoteKind,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub sort: i64,
    #[serde(default)]
    pub create_date: i64,
    #[serde(default)]
    pub update_date: i64,
}

impl Note {
    pub fn new_note(name: impl Into<String>, body: impl Into<String>) -> Self {
        let now = now_ms();
        Note {
            id: new_id(),
            name: name.into(),
            content: body.into(),
            parent_id: String::new(),
            kind: NoteKind::Note,
            deleted: false,
            sort: now,
            create_date: now,
            update_date: now,
        }
    }

    pub fn new_folder(name: impl Into<String>) -> Self {
        let now = now_ms();
        Note {
            id: new_id(),
            name: name.into(),
            content: String::new(),
            parent_id: String::new(),
            kind: NoteKind::Folder,
            deleted: false,
            sort: now,
            create_date: now,
            update_date: now,
        }
    }

    pub fn is_folder(&self) -> bool {
        self.kind == NoteKind::Folder
    }
}

/// CRUD facade for [`Note`] records.
pub struct NoteManager<'a> {
    store: &'a Store,
    owner: &'a AccountOwner,
}

impl<'a> NoteManager<'a> {
    pub fn new(store: &'a Store, owner: &'a AccountOwner) -> Self {
        NoteManager { store, owner }
    }

    pub fn add(&self, note: &Note) -> anyhow::Result<()> {
        self.store
            .save_object(&note.id, self.owner, DataType::Note, note)?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let is_local = self.owner.id == netape_store::model::LOCAL_OWNER_ID;
        self.store.delete(id, is_local)?;
        Ok(())
    }

    /// All notes, folders first then sorted by `sort`.
    pub fn notes(&self) -> anyhow::Result<Vec<Note>> {
        let mut list: Vec<Note> = self.store.list(DataType::Note, None)?;
        list.sort_by(|a, b| {
            let fa = a.is_folder() as u8;
            let fb = b.is_folder() as u8;
            fb.cmp(&fa).then(a.sort.cmp(&b.sort))
        });
        Ok(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use netape_store::{db::Store, model::local_owner};

    #[test]
    fn notes_sorted() {
        let store = Store::open_in_memory().unwrap();
        let owner = local_owner();
        let mgr = NoteManager::new(&store, &owner);
        let n = Note::new_note("deploy", "kubectl rollout restart deployment/app");
        let f = Note::new_folder("k8s");
        mgr.add(&n).unwrap();
        mgr.add(&f).unwrap();
        let list = mgr.notes().unwrap();
        assert!(list[0].is_folder());
    }
}
