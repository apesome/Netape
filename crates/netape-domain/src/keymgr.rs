//! SSH key pair model and manager.

use netape_store::{db::Store, model::{new_id, AccountOwner, DataType}};
use serde::{Deserialize, Serialize};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// An SSH key pair stored in the database.
///
/// Public and private keys are stored as Base64-encoded bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPair {
    #[serde(default = "new_id")]
    pub id: String,
    /// Base64-encoded public key bytes.
    pub public_key: String,
    /// Base64-encoded private key bytes (may be passphrase-protected).
    pub private_key: String,
    /// "RSA" | "ED25519"
    pub key_type: String,
    pub name: String,
    pub remark: String,
    /// Key length in bits (relevant for RSA).
    pub length: u32,
    pub sort: i64,
    #[serde(default)]
    pub update_date: i64,
}

impl KeyPair {
    pub fn new(
        name: impl Into<String>,
        key_type: impl Into<String>,
        public_key: impl Into<String>,
        private_key: impl Into<String>,
        length: u32,
    ) -> Self {
        KeyPair {
            id: new_id(),
            public_key: public_key.into(),
            private_key: private_key.into(),
            key_type: key_type.into(),
            name: name.into(),
            remark: String::new(),
            length,
            sort: 0,
            update_date: now_ms(),
        }
    }
}

/// CRUD facade for [`KeyPair`] records.
pub struct KeyManager<'a> {
    store: &'a Store,
    owner: &'a AccountOwner,
}

impl<'a> KeyManager<'a> {
    pub fn new(store: &'a Store, owner: &'a AccountOwner) -> Self {
        KeyManager { store, owner }
    }

    pub fn add(&self, kp: &KeyPair) -> anyhow::Result<()> {
        self.store.save_object(&kp.id, self.owner, DataType::KeyPair, kp)?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let is_local = self.owner.id == netape_store::model::LOCAL_OWNER_ID;
        self.store.delete(id, is_local)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> anyhow::Result<Option<KeyPair>> {
        let raw = self.store.get_raw(id)?;
        match raw {
            Some(d) if d.data_type == DataType::KeyPair.to_string() && !d.deleted => {
                Ok(Some(serde_json::from_str(&d.data)?))
            }
            _ => Ok(None),
        }
    }

    /// All key pairs for this owner.
    pub fn key_pairs(&self) -> anyhow::Result<Vec<KeyPair>> {
        Ok(self.store.list(DataType::KeyPair, Some(&self.owner.id))?)
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
        let mgr = KeyManager::new(&store, &owner);
        let kp = KeyPair::new("my-key", "ED25519", "pub_base64", "priv_base64", 0);
        mgr.add(&kp).unwrap();
        let list = mgr.key_pairs().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].key_type, "ED25519");
    }
}
