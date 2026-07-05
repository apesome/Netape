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
pub struct Note {
    pub id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub is_folder: bool,
    pub sort: i64,
    pub create_date: i64,
    pub update_date: i64,
}

#[tauri::command]
pub fn note_list(state: State<'_, AppState>) -> Result<Vec<Note>, String> {
    state
        .store
        .list::<Note>(DataType::Note, Some(&state.owner.id))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn note_save(mut note: Note, state: State<'_, AppState>) -> Result<(), String> {
    if note.id.is_empty() {
        note.id = new_id();
        note.create_date = now_ms();
    }
    note.update_date = now_ms();
    state
        .store
        .save_object(&note.id, &state.owner, DataType::Note, &note)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn note_remove(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.store.delete(&id, true).map_err(|e| e.to_string())
}
