use netape_domain::host::{Host, HostManager};
use tauri::State;

use crate::app_state::AppState;

#[tauri::command]
pub fn host_list(state: State<'_, AppState>) -> Result<Vec<Host>, String> {
    HostManager::new(&state.store, &state.owner)
        .hosts()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn host_save(host: Host, state: State<'_, AppState>) -> Result<(), String> {
    HostManager::new(&state.store, &state.owner)
        .add(&host)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn host_remove(id: String, state: State<'_, AppState>) -> Result<(), String> {
    HostManager::new(&state.store, &state.owner)
        .remove(&id)
        .map_err(|e| e.to_string())
}
