use netape_store::{
    db::Store,
    model::{local_owner, AccountOwner},
};
use std::fs;
use tauri::AppHandle;

pub struct AppState {
    pub store: Store,
    pub owner: AccountOwner,
}

impl AppState {
    pub fn init(_app: &AppHandle) -> Result<Self, String> {
        let home = dirs::home_dir()
            .ok_or_else(|| "cannot locate home directory".to_string())?;
        let data_dir = home.join(".netape");
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        let db_path = data_dir.join("netape.db");
        let store = Store::open(db_path).map_err(|e| e.to_string())?;
        let owner = local_owner();
        Ok(AppState { store, owner })
    }
}
