use netape_domain::keymgr::{KeyManager, KeyPair};
use netape_protocol::keygen;
use tauri::State;

use crate::app_state::AppState;

#[tauri::command]
pub fn key_list(state: State<'_, AppState>) -> Result<Vec<KeyPair>, String> {
    KeyManager::new(&state.store, &state.owner)
        .key_pairs()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn key_generate(
    name: String,
    key_type: String,
    state: State<'_, AppState>,
) -> Result<KeyPair, String> {
    let upper = key_type.to_uppercase();
    let (public_key, private_key, bits) = if upper == "RSA" {
        let (pub_key, priv_key) = keygen::generate_rsa().map_err(|e| e.to_string())?;
        (pub_key, priv_key, 4096u32)
    } else {
        let (pub_key, priv_key) = keygen::generate_ed25519().map_err(|e| e.to_string())?;
        (pub_key, priv_key, 0u32)
    };
    let kp = KeyPair::new(name, upper, public_key, private_key, bits);
    KeyManager::new(&state.store, &state.owner)
        .add(&kp)
        .map_err(|e| e.to_string())?;
    Ok(kp)
}

#[tauri::command]
pub fn key_import(
    name: String,
    private_key: String,
    state: State<'_, AppState>,
) -> Result<KeyPair, String> {
    let (public_key, priv_pem, key_type, bits) =
        keygen::import_private_key(&private_key).map_err(|e| e.to_string())?;
    let kp = KeyPair::new(name, key_type, public_key, priv_pem, bits);
    KeyManager::new(&state.store, &state.owner)
        .add(&kp)
        .map_err(|e| e.to_string())?;
    Ok(kp)
}

#[tauri::command]
pub fn key_remove(id: String, state: State<'_, AppState>) -> Result<(), String> {
    KeyManager::new(&state.store, &state.owner)
        .remove(&id)
        .map_err(|e| e.to_string())
}
