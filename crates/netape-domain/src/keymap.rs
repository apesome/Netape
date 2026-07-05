//! Keyboard shortcut mappings.
//!
//! Uses a string-based keystroke representation (for example
//! `"ctrl pressed C"`) so persisted shortcut data round-trips without loss.

use std::collections::HashMap;
use netape_store::{db::Store, model::{new_id, AccountOwner, DataType}};
use serde::{Deserialize, Serialize};

/// A single keyboard shortcut → list of action IDs mapping.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeymapShortcut {
    /// KeyStroke string, e.g. `"ctrl pressed C"`.
    pub key_stroke: String,
    pub action_ids: Vec<String>,
}

/// A named keyboard mapping (possibly inheriting from a parent).
///
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keymap {
    #[serde(default = "new_id")]
    pub id: String,
    pub name: String,
    /// If present, unknown shortcuts fall back to the parent keymap.
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub is_readonly: bool,
    #[serde(default)]
    pub update_date: i64,
    /// Map from KeyStroke string to action IDs.
    #[serde(default)]
    pub shortcuts: HashMap<String, Vec<String>>,
}

impl Keymap {
    pub fn new(name: impl Into<String>) -> Self {
        Keymap {
            id: new_id(),
            name: name.into(),
            parent_id: None,
            is_readonly: false,
            update_date: 0,
            shortcuts: HashMap::new(),
        }
    }

    pub fn bind(&mut self, key_stroke: impl Into<String>, action_id: impl Into<String>) {
        self.shortcuts
            .entry(key_stroke.into())
            .or_default()
            .push(action_id.into());
    }

    /// Look up action IDs for a keystroke, optionally resolving via the parent.
    pub fn action_ids<'a>(&'a self, key_stroke: &str) -> Option<&'a Vec<String>> {
        self.shortcuts.get(key_stroke)
    }
}

/// CRUD facade for [`Keymap`] records.
///
pub struct KeymapManager<'a> {
    store: &'a Store,
    owner: &'a AccountOwner,
}

impl<'a> KeymapManager<'a> {
    pub fn new(store: &'a Store, owner: &'a AccountOwner) -> Self {
        KeymapManager { store, owner }
    }

    pub fn add(&self, keymap: &Keymap) -> anyhow::Result<()> {
        self.store
            .save_object(&keymap.id, self.owner, DataType::Keymap, keymap)?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let is_local = self.owner.id == netape_store::model::LOCAL_OWNER_ID;
        self.store.delete(id, is_local)?;
        Ok(())
    }

    pub fn keymaps(&self) -> anyhow::Result<Vec<Keymap>> {
        Ok(self.store.list(DataType::Keymap, None)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use netape_store::{db::Store, model::local_owner};

    #[test]
    fn bind_and_lookup() {
        let mut km = Keymap::new("MyMap");
        km.bind("ctrl pressed C", "EditorCopy");
        km.bind("ctrl pressed V", "EditorPaste");
        assert_eq!(km.action_ids("ctrl pressed C").unwrap(), &["EditorCopy"]);
    }

    #[test]
    fn persist_keymap() {
        let store = Store::open_in_memory().unwrap();
        let owner = local_owner();
        let mgr = KeymapManager::new(&store, &owner);
        let mut km = Keymap::new("Custom");
        km.bind("ctrl pressed T", "NewTab");
        mgr.add(&km).unwrap();
        let list = mgr.keymaps().unwrap();
        assert_eq!(list[0].name, "Custom");
        assert!(list[0].shortcuts.contains_key("ctrl pressed T"));
    }
}
