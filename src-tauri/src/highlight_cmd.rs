use netape_store::model::{DataType, new_id};
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::app_state::AppState;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeywordHighlight {
    pub id: String,
    pub keyword: String,
    pub text_color: String,
    pub bg_color: String,
    pub description: String,
    pub enabled: bool,
    pub regex: bool,
    pub match_case: bool,
    pub bold: bool,
    pub sort: i64,
    pub create_date: i64,
    pub update_date: i64,
}

#[tauri::command]
pub fn highlight_list(state: State<'_, AppState>) -> Result<Vec<KeywordHighlight>, String> {
    state
        .store
        .list::<KeywordHighlight>(DataType::KeywordHighlight, Some(&state.owner.id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn highlight_save(
    mut highlight: KeywordHighlight,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if highlight.id.is_empty() {
        highlight.id = new_id();
        highlight.create_date = now_ms();
    }
    highlight.update_date = now_ms();
    state
        .store
        .save_object(
            &highlight.id,
            &state.owner,
            DataType::KeywordHighlight,
            &highlight,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn highlight_remove(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.store.delete(&id, true).map_err(|e| e.to_string())
}
