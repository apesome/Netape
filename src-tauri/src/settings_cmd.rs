use tauri::{AppHandle, State};

use crate::app_state::AppState;

#[tauri::command]
pub fn settings_get(key: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
    state.store.get_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_set(
    key: String,
    value: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state.store.set_setting(&key, &value).map_err(|e| e.to_string())?;
    if key == "Setting.Appearance.backgroundRunning" {
        if let Some(tray) = app.tray_by_id("main-tray") {
            let _ = tray.set_visible(value != "false");
        }
    } else if key == "Setting.Appearance.language" {
        let _ = crate::refresh_tray_menu(&app, &value);
    }
    Ok(())
}
