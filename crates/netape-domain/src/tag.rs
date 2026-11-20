//! Tag model and manager.

use netape_store::{db::Store, model::{new_id, AccountOwner, DataType}};
use serde::{Deserialize, Serialize};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A label that can be attached to hosts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    #[serde(default = "new_id")]
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub create_date: i64,
    #[serde(default)]
    pub update_date: i64,
}

impl Tag {
    pub fn new(text: impl Into<String>) -> Self {
        let now = now_ms();
        Tag {
            id: new_id(),
            text: text.into(),
            create_date: now,
            update_date: now,
        }
    }
}

/// CRUD facade for [`Tag`] records.
pub struct TagManager<'a> {
    store: &'a Store,
    owner: &'a AccountOwner,
}

impl<'a> TagManager<'a> {
    pub fn new(store: &'a Store, owner: &'a AccountOwner) -> Self {
        TagManager { store, owner }
    }

    pub fn add(&self, tag: &Tag) -> anyhow::Result<()> {
        self.store.save_object(&tag.id, self.owner, DataType::Tag, tag)?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let is_local = self.owner.id == netape_store::model::LOCAL_OWNER_ID;
        self.store.delete(id, is_local)?;
        Ok(())
    }

    /// All tags for this owner, sorted by creation date.
    pub fn tags(&self) -> anyhow::Result<Vec<Tag>> {
        let mut tags: Vec<Tag> = self.store.list(DataType::Tag, Some(&self.owner.id))?;
        tags.sort_by_key(|t| t.create_date);
        Ok(tags)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use netape_store::{db::Store, model::local_owner};

    #[test]
    fn roundtrip() {
        let store = Store::open_in_memory().unwrap();
        let owner = local_owner();
        let mgr = TagManager::new(&store, &owner);
        let tag = Tag::new("production");
        mgr.add(&tag).unwrap();
        let tags = mgr.tags().unwrap();
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].text, "production");
    }

    #[test]
    fn remove() {
        let store = Store::open_in_memory().unwrap();
        let owner = local_owner();
        let mgr = TagManager::new(&store, &owner);
        let tag = Tag::new("dev");
        let id = tag.id.clone();
        mgr.add(&tag).unwrap();
        mgr.remove(&id).unwrap();
        assert!(mgr.tags().unwrap().is_empty());
    }
}
