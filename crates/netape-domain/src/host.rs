//! SSH host / connection model.
//!
//! A [`Host`] is a JSON-serialised blob stored in the `data` table under
//! type `DataType::Host`.  [`HostManager`] is the thin CRUD layer over the
//! [`Store`].

use netape_store::{
    db::Store,
    model::{new_id, AccountOwner, DataType},
};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Sub-types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "PascalCase")]
pub enum AuthenticationType {
    #[default]
    No,
    Password,
    PublicKey,
    SshAgent,
    KeyboardInteractive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "UPPERCASE")]
pub enum ProxyType {
    #[default]
    No,
    Http,
    Socks5,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Authentication {
    #[serde(rename = "type")]
    pub auth_type: AuthenticationType,
    pub password: String,
}

impl Default for Authentication {
    fn default() -> Self {
        Authentication {
            auth_type: AuthenticationType::No,
            password: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proxy {
    #[serde(rename = "type")]
    pub proxy_type: ProxyType,
    pub host: String,
    pub port: u16,
    pub authentication_type: AuthenticationType,
    pub username: String,
    pub password: String,
}

impl Default for Proxy {
    fn default() -> Self {
        Proxy {
            proxy_type: ProxyType::No,
            host: String::new(),
            port: 7890,
            authentication_type: AuthenticationType::No,
            username: String::new(),
            password: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "PascalCase")]
pub enum SerialParity {
    #[default]
    None,
    Even,
    Odd,
    Mark,
    Space,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SerialFlowControl {
    #[default]
    None,
    RtsCts,
    XonXoff,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialComm {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: String,
    pub parity: SerialParity,
    pub flow_control: SerialFlowControl,
}

impl Default for SerialComm {
    fn default() -> Self {
        SerialComm {
            port: String::new(),
            baud_rate: 9600,
            data_bits: 8,
            stop_bits: "1".into(),
            parity: SerialParity::None,
            flow_control: SerialFlowControl::None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginScript {
    pub expect: String,
    pub send: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub match_case: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    #[serde(default)]
    pub jump_hosts: Vec<String>,
    #[serde(default)]
    pub login_scripts: Vec<LoginScript>,
    #[serde(default = "default_encoding")]
    pub encoding: String,
    #[serde(default)]
    pub env: String,
    #[serde(default)]
    pub startup_command: String,
    #[serde(default = "default_heartbeat")]
    pub heartbeat_interval: u32,
    #[serde(default)]
    pub serial_comm: SerialComm,
    #[serde(default)]
    pub sftp_default_directory: String,
    #[serde(default)]
    pub enable_x11_forwarding: bool,
    #[serde(default)]
    pub x11_forwarding: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub extras: std::collections::HashMap<String, String>,
}

fn default_encoding() -> String {
    "UTF-8".into()
}
fn default_heartbeat() -> u32 {
    5
}

impl Options {
    /// Parse `env` field into a `HashMap`.
    pub fn env_map(&self) -> std::collections::HashMap<String, String> {
        let mut map = std::collections::HashMap::new();
        for line in self.env.lines() {
            if let Some((k, v)) = line.split_once('=') {
                map.insert(k.to_string(), v.to_string());
            }
        }
        map
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "PascalCase")]
pub enum TunnelingType {
    #[default]
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tunneling {
    pub name: String,
    #[serde(rename = "type")]
    pub tunneling_type: TunnelingType,
    pub source_host: String,
    pub source_port: u16,
    pub destination_host: String,
    pub destination_port: u16,
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/// An SSH / terminal connection entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    #[serde(default = "new_id")]
    pub id: String,
    pub name: String,
    /// Protocol identifier: "SSH", "Telnet", "Local", "WSL", "Folder", …
    pub protocol: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub remark: String,
    #[serde(default)]
    pub authentication: Authentication,
    #[serde(default)]
    pub proxy: Proxy,
    #[serde(default)]
    pub options: Options,
    #[serde(default)]
    pub tunnelings: Vec<Tunneling>,
    #[serde(default)]
    pub sort: i64,
    #[serde(default = "default_parent_id")]
    pub parent_id: String,
    #[serde(default = "default_owner_id")]
    pub owner_id: String,
    #[serde(default = "default_owner_id")]
    pub creator_id: String,
    #[serde(default)]
    pub owner_type: String,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub create_date: i64,
    #[serde(default)]
    pub update_date: i64,
}

fn default_parent_id() -> String {
    "0".into()
}
fn default_owner_id() -> String {
    "0".into()
}

impl Host {
    pub fn is_folder(&self) -> bool {
        self.protocol.eq_ignore_ascii_case("Folder")
    }

    pub fn is_temporary(&self) -> bool {
        self.options.extras.contains_key("Temporary")
    }
}

// ---------------------------------------------------------------------------
// HostManager
// ---------------------------------------------------------------------------

/// CRUD facade for [`Host`] records.
pub struct HostManager<'a> {
    store: &'a Store,
    owner: &'a AccountOwner,
}

impl<'a> HostManager<'a> {
    pub fn new(store: &'a Store, owner: &'a AccountOwner) -> Self {
        HostManager { store, owner }
    }

    /// Insert or update a host.
    ///
    /// If `host.id` is empty, a new UUID is generated before saving so that
    /// multiple "create" calls never collide on the same empty-string key.
    pub fn add(&self, host: &Host) -> anyhow::Result<()> {
        if host.is_temporary() {
            anyhow::bail!("temporary host cannot be persisted");
        }
        if host.id.is_empty() {
            let mut owned = host.clone();
            owned.id = new_id();
            self.store
                .save_object(&owned.id, self.owner, DataType::Host, &owned)?;
        } else {
            self.store
                .save_object(&host.id, self.owner, DataType::Host, host)?;
        }
        Ok(())
    }

    /// Soft-delete a host by id.
    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let is_local = self.owner.id == netape_store::model::LOCAL_OWNER_ID;
        self.store.delete(id, is_local)?;
        Ok(())
    }

    /// All non-deleted hosts, folders first, then sorted by `sort`.
    pub fn hosts(&self) -> anyhow::Result<Vec<Host>> {
        let mut hosts: Vec<Host> = self.store.list(DataType::Host, None)?;
        hosts.sort_by(|a, b| {
            let fa = a.is_folder() as u8;
            let fb = b.is_folder() as u8;
            fb.cmp(&fa).then(a.sort.cmp(&b.sort))
        });
        Ok(hosts)
    }

    /// Persist a complete order for siblings of one protocol and node kind.
    pub fn reorder(&self, ids: &[String]) -> anyhow::Result<()> {
        use std::collections::HashSet;
        anyhow::ensure!(!ids.is_empty(), "empty host order");
        let hosts = self.hosts()?;
        let first = hosts.iter().find(|host| host.id == ids[0])
            .ok_or_else(|| anyhow::anyhow!("host not found"))?;
        let protocol = |host: &Host| {
            if host.is_folder() {
                if host.owner_type.is_empty() { "SSH".to_string() } else { host.owner_type.clone() }
            } else { host.protocol.clone() }
        };
        let siblings: HashSet<&str> = hosts.iter().filter(|host| {
            host.parent_id == first.parent_id && host.is_folder() == first.is_folder()
                && protocol(host) == protocol(first)
        }).map(|host| host.id.as_str()).collect();
        let requested: HashSet<&str> = ids.iter().map(String::as_str).collect();
        anyhow::ensure!(requested.len() == ids.len() && requested == siblings,
            "host order changed; refresh and retry");
        self.store.reorder_objects(ids, self.owner, DataType::Host)?;
        Ok(())
    }

    /// Move a node and persist the complete destination sibling order atomically.
    pub fn move_to(&self, id: &str, parent_id: &str, ids: &[String]) -> anyhow::Result<()> {
        use std::collections::HashSet;
        let hosts = self.hosts()?;
        let source = hosts.iter().find(|host| host.id == id)
            .ok_or_else(|| anyhow::anyhow!("host not found"))?;
        let protocol = |host: &Host| if host.is_folder() {
            if host.owner_type.is_empty() { "SSH" } else { host.owner_type.as_str() }.to_string()
        } else { host.protocol.clone() };
        let mut ancestor = parent_id;
        let mut seen = HashSet::new();
        while ancestor != "0" {
            anyhow::ensure!(ancestor != id && seen.insert(ancestor), "cannot move a folder into itself or its descendants");
            let folder = hosts.iter().find(|host| host.id == ancestor && host.is_folder())
                .ok_or_else(|| anyhow::anyhow!("destination folder not found"))?;
            anyhow::ensure!(protocol(folder) == protocol(source), "cannot move between protocols");
            ancestor = if folder.parent_id.is_empty() { "0" } else { &folder.parent_id };
        }
        let mut siblings: HashSet<&str> = hosts.iter().filter(|host| {
            let parent = if host.parent_id.is_empty() { "0" } else { &host.parent_id };
            parent == parent_id && host.is_folder() == source.is_folder() && protocol(host) == protocol(source)
        }).map(|host| host.id.as_str()).collect();
        siblings.insert(id);
        let requested: HashSet<&str> = ids.iter().map(String::as_str).collect();
        anyhow::ensure!(requested.len() == ids.len() && requested == siblings,
            "host order changed; refresh and retry");
        self.store.reorder_and_move_objects(ids, Some((id, parent_id)), self.owner, DataType::Host)?;
        Ok(())
    }

    /// Fetch a single host.
    pub fn get(&self, id: &str) -> anyhow::Result<Option<Host>> {
        let raw = self.store.get_raw(id)?;
        match raw {
            Some(d) if d.data_type == DataType::Host.to_string() && !d.deleted => {
                Ok(Some(serde_json::from_str(&d.data)?))
            }
            _ => Ok(None),
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use netape_store::{db::Store, model::local_owner};

    fn store() -> (Store, AccountOwner) {
        let s = Store::open_in_memory().unwrap();
        let o = local_owner();
        (s, o)
    }

    #[test]
    fn add_and_list() {
        let (store, owner) = store();
        let mgr = HostManager::new(&store, &owner);
        let host = Host {
            id: new_id(),
            name: "prod".into(),
            protocol: "SSH".into(),
            host: "10.0.0.1".into(),
            port: 22,
            ..Default::default()
        };
        mgr.add(&host).unwrap();
        let list = mgr.hosts().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "prod");
    }

    #[test]
    fn folder_sorts_first() {
        let (store, owner) = store();
        let mgr = HostManager::new(&store, &owner);
        let ssh = Host { id: new_id(), name: "server".into(), protocol: "SSH".into(), sort: 1, ..Default::default() };
        let folder = Host { id: new_id(), name: "group".into(), protocol: "Folder".into(), sort: 2, ..Default::default() };
        mgr.add(&ssh).unwrap();
        mgr.add(&folder).unwrap();
        let list = mgr.hosts().unwrap();
        assert!(list[0].is_folder());
    }

    #[test]
    fn remove_soft_deletes() {
        let (store, owner) = store();
        let mgr = HostManager::new(&store, &owner);
        let host = Host { id: new_id(), name: "temp".into(), protocol: "SSH".into(), ..Default::default() };
        let id = host.id.clone();
        mgr.add(&host).unwrap();
        mgr.remove(&id).unwrap();
        assert!(mgr.hosts().unwrap().is_empty());
    }

    #[test]
    fn move_preserves_data_and_rejects_cycles_protocols_and_stale_orders() {
        let (store, owner) = store();
        let mgr = HostManager::new(&store, &owner);
        let folder = |id: &str, parent: &str, protocol: &str| Host { id: id.into(), protocol: "Folder".into(),
            owner_type: protocol.into(), parent_id: parent.into(), ..Default::default() };
        let a = Host { id: "a".into(), protocol: "SSH".into(), parent_id: "work".into(), host: "example.test".into(),
            authentication: Authentication { auth_type: AuthenticationType::Password, password: "preserved".into() }, ..Default::default() };
        let x = Host { id: "x".into(), protocol: "SSH".into(), parent_id: "dest".into(), sort: 8, ..Default::default() };
        for host in [folder("work","0","SSH"),folder("dest","0","SSH"),folder("child","work","SSH"),
            folder("ftp","0","FTP"),a,x] { mgr.add(&host).unwrap(); }
        assert!(mgr.move_to("a","dest",&["a".into()]).is_err());
        assert!(mgr.move_to("a","ftp",&["a".into()]).is_err());
        assert!(mgr.move_to("a","missing",&["a".into()]).is_err());
        assert!(mgr.move_to("work","child",&["work".into()]).is_err());
        assert!(mgr.move_to("work","work",&["work".into(),"child".into()]).is_err());
        mgr.move_to("a","dest",&["a".into(),"x".into()]).unwrap();
        let moved = mgr.get("a").unwrap().unwrap();
        assert_eq!(moved.parent_id,"dest");
        assert_eq!(moved.sort,0);
        assert_eq!(moved.authentication.password,"preserved");
        assert_eq!(moved.host,"example.test");
        assert_eq!(mgr.get("x").unwrap().unwrap().sort,1);
        assert!(store.reorder_and_move_objects(&["a".into(),"missing".into()],Some(("a","0")),&owner,DataType::Host).is_err());
        assert_eq!(mgr.get("a").unwrap().unwrap().parent_id,"dest");
        mgr.move_to("a","0",&["a".into()]).unwrap();
        assert_eq!(mgr.get("a").unwrap().unwrap().parent_id,"0");
        mgr.move_to("work","dest",&["work".into()]).unwrap();
        assert_eq!(mgr.get("child").unwrap().unwrap().parent_id,"work");
    }

    #[test]
    fn reorder_preserves_host_data_and_rejects_invalid_groups() {
        let (store, owner) = store();
        let mgr = HostManager::new(&store, &owner);
        let first = Host { id: "a".into(), name: "first".into(), protocol: "SSH".into(),
            parent_id: "work".into(), host: "example.test".into(),
            authentication: Authentication { auth_type: AuthenticationType::Password, password: "unchanged".into() },
            ..Default::default() };
        let second = Host { id: "b".into(), name: "second".into(), protocol: "SSH".into(), parent_id: "work".into(), ..Default::default() };
        let other = Host { id: "ftp".into(), protocol: "FTP".into(), parent_id: "work".into(), sort: 77, ..Default::default() };
        for host in [&first, &second, &other] { mgr.add(host).unwrap(); }
        mgr.reorder(&["b".into(), "a".into()]).unwrap();
        let updated = mgr.get("a").unwrap().unwrap();
        assert_eq!(updated.sort, 1);
        assert_eq!(updated.parent_id, "work");
        assert_eq!(updated.authentication.password, "unchanged");
        assert_eq!(updated.host, "example.test");
        assert_eq!(mgr.get("b").unwrap().unwrap().sort, 0);
        assert_eq!(mgr.get("ftp").unwrap().unwrap().sort, 77);
        for ids in [vec!["a".into()], vec!["a".into(), "a".into()], vec!["a".into(), "ftp".into()]] {
            assert!(mgr.reorder(&ids).is_err());
        }
        assert_eq!(mgr.get("a").unwrap().unwrap().sort, 1);
        // A missing row halfway through the storage batch rolls back earlier updates.
        assert!(store.reorder_objects(&["a".into(), "missing".into()], &owner, DataType::Host).is_err());
        assert_eq!(mgr.get("a").unwrap().unwrap().sort, 1);
    }
}

impl Default for Host {
    fn default() -> Self {
        Host {
            id: new_id(),
            name: String::new(),
            protocol: String::new(),
            host: String::new(),
            port: 0,
            username: String::new(),
            remark: String::new(),
            authentication: Authentication::default(),
            proxy: Proxy::default(),
            options: Options::default(),
            tunnelings: Vec::new(),
            sort: 0,
            parent_id: "0".into(),
            owner_id: "0".into(),
            creator_id: "0".into(),
            owner_type: String::new(),
            deleted: false,
            create_date: 0,
            update_date: 0,
        }
    }
}
