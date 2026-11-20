//! Terminal keyword highlighting rules.

use netape_store::{db::Store, model::{new_id, AccountOwner, DataType}};
use serde::{Deserialize, Serialize};

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Whether the rule highlights matching lines or filters them out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum HighlightType {
    #[default]
    Highlight,
    Filter,
}

/// A single keyword-highlight / filter rule.
///
/// Colours are stored as ARGB integers (0 means "use default theme colour").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeywordHighlight {
    #[serde(default = "new_id")]
    pub id: String,
    /// The rule set this entry belongs to (default "0" = ungrouped).
    #[serde(default = "default_parent_id")]
    pub parent_id: String,
    #[serde(default)]
    pub highlight_type: HighlightType,
    pub keyword: String,
    #[serde(default)]
    pub description: String,
    /// `true` = case-sensitive match.
    #[serde(default)]
    pub match_case: bool,
    /// `true` = treat `keyword` as a regex.
    #[serde(default)]
    pub regex: bool,
    /// Foreground colour (ARGB). 0 = theme default.
    #[serde(default)]
    pub text_color: u32,
    /// Background colour (ARGB). 0 = theme default.
    #[serde(default)]
    pub background_color: u32,
    #[serde(default)]
    pub bold: bool,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub line_through: bool,
    #[serde(default)]
    pub underline: bool,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub sort: i64,
    #[serde(default)]
    pub update_date: i64,
}

fn default_parent_id() -> String {
    "0".into()
}
fn default_enabled() -> bool {
    true
}

impl KeywordHighlight {
    pub fn new(keyword: impl Into<String>) -> Self {
        let now = now_ms();
        KeywordHighlight {
            id: new_id(),
            parent_id: "0".into(),
            highlight_type: HighlightType::Highlight,
            keyword: keyword.into(),
            description: String::new(),
            match_case: false,
            regex: false,
            text_color: 0,
            background_color: 0,
            bold: false,
            italic: false,
            line_through: false,
            underline: false,
            enabled: true,
            sort: now,
            update_date: now,
        }
    }
}

/// CRUD facade for [`KeywordHighlight`] rules.
pub struct HighlightManager<'a> {
    store: &'a Store,
    owner: &'a AccountOwner,
}

impl<'a> HighlightManager<'a> {
    pub fn new(store: &'a Store, owner: &'a AccountOwner) -> Self {
        HighlightManager { store, owner }
    }

    pub fn add(&self, rule: &KeywordHighlight) -> anyhow::Result<()> {
        self.store
            .save_object(&rule.id, self.owner, DataType::KeywordHighlight, rule)?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        let is_local = self.owner.id == netape_store::model::LOCAL_OWNER_ID;
        self.store.delete(id, is_local)?;
        Ok(())
    }

    /// All enabled highlight rules sorted by `sort`.
    pub fn highlights(&self) -> anyhow::Result<Vec<KeywordHighlight>> {
        let mut list: Vec<KeywordHighlight> =
            self.store.list(DataType::KeywordHighlight, Some(&self.owner.id))?;
        list.sort_by_key(|h| h.sort);
        Ok(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use netape_store::{db::Store, model::local_owner};

    #[test]
    fn add_and_list() {
        let store = Store::open_in_memory().unwrap();
        let owner = local_owner();
        let mgr = HighlightManager::new(&store, &owner);
        let mut rule = KeywordHighlight::new("ERROR");
        rule.bold = true;
        rule.text_color = 0xFFFF0000;
        mgr.add(&rule).unwrap();
        let list = mgr.highlights().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].keyword, "ERROR");
        assert!(list[0].bold);
    }
}
