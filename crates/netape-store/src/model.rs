//! Core data model types shared across the application.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Unique identifier. Newtype keeps UUID semantics without stringly-typing
/// every field.
pub type Id = String;

pub fn new_id() -> Id {
    Uuid::new_v4().to_string()
}

// ---------------------------------------------------------------------------
// OwnerType
// ---------------------------------------------------------------------------

/// Who owns a [`Data`] row — a single user or a shared team.
///
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OwnerType {
    User,
    Team,
}

impl OwnerType {
    pub fn as_str(self) -> &'static str {
        match self {
            OwnerType::User => "User",
            OwnerType::Team => "Team",
        }
    }
}

impl std::fmt::Display for OwnerType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for OwnerType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "User" => Ok(OwnerType::User),
            "Team" => Ok(OwnerType::Team),
            other => Err(format!("unknown OwnerType: {other}")),
        }
    }
}

// ---------------------------------------------------------------------------
// DataType
// ---------------------------------------------------------------------------

/// All supported kinds of JSON-serialised entities stored in the `data` table.
///
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DataType {
    Host,
    Note,
    KeyPair,
    Tag,
    Macro,
    KeywordHighlight,
    Keymap,
}

impl DataType {
    pub fn as_str(self) -> &'static str {
        match self {
            DataType::Host => "Host",
            DataType::Note => "Note",
            DataType::KeyPair => "KeyPair",
            DataType::Tag => "Tag",
            DataType::Macro => "Macro",
            DataType::KeywordHighlight => "KeywordHighlight",
            DataType::Keymap => "Keymap",
        }
    }
}

impl std::fmt::Display for DataType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for DataType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Host" => Ok(DataType::Host),
            "Note" | "Snippet" => Ok(DataType::Note),
            "KeyPair" => Ok(DataType::KeyPair),
            "Tag" => Ok(DataType::Tag),
            "Macro" => Ok(DataType::Macro),
            "KeywordHighlight" => Ok(DataType::KeywordHighlight),
            "Keymap" => Ok(DataType::Keymap),
            other => Err(format!("unknown DataType: {other}")),
        }
    }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/// A single row in the `data` table.
///
/// All domain objects (hosts, snippets, key pairs …) are stored as
/// JSON in the `data` field. This is the universal envelope — callers
/// deserialise `data` into the concrete type they need.
///
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Data {
    /// Primary key — UUIDv4.
    pub id: Id,
    /// ID of the owning user or team.
    pub owner_id: String,
    /// Whether `owner_id` refers to a user or a team.
    pub owner_type: String,
    /// Discriminates the concrete type stored in `data`.
    pub data_type: String,
    /// JSON-serialised domain object.
    pub data: String,
    /// Monotonically increasing version; incremented on every local mutation.
    pub version: i64,
    /// `true` once this row has been pushed to the cloud backend.
    pub synced: bool,
    /// Soft-delete flag — deleted rows are retained for sync purposes.
    pub deleted: bool,
}

impl Data {
    pub fn new(owner_id: impl Into<String>, owner_type: OwnerType, data_type: DataType, data: impl Into<String>) -> Self {
        Data {
            id: new_id(),
            owner_id: owner_id.into(),
            owner_type: owner_type.to_string(),
            data_type: data_type.to_string(),
            data: data.into(),
            version: 0,
            synced: false,
            deleted: false,
        }
    }
}

// ---------------------------------------------------------------------------
// AccountOwner
// ---------------------------------------------------------------------------

/// Identifies who a piece of data belongs to.
///
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountOwner {
    pub id: String,
    pub name: String,
    pub owner_type: OwnerType,
    pub role: String,
}

impl AccountOwner {
    pub fn user(id: impl Into<String>, name: impl Into<String>) -> Self {
        AccountOwner {
            id: id.into(),
            name: name.into(),
            owner_type: OwnerType::User,
            role: String::new(),
        }
    }

    /// Returns `true` if this is a team visitor (read-only role).
    pub fn is_visitor(&self) -> bool {
        self.owner_type == OwnerType::Team && self.role == "Visitor"
    }
}

// ---------------------------------------------------------------------------
// Local "anonymous" owner used when no cloud account is signed in
// ---------------------------------------------------------------------------

/// The well-known owner ID used for the local (offline) user.
/// Well-known owner ID for the local offline user.
pub const LOCAL_OWNER_ID: &str = "locally";

pub fn local_owner() -> AccountOwner {
    AccountOwner::user(LOCAL_OWNER_ID, "locally")
}
