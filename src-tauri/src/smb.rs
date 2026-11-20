//! SMB transfer proxy commands.
//!
//! These mirror the FTP plugin bridge but speak to the installed SMB plugin
//! sidecar. The current plugin implementation uses Windows UNC paths plus the
//! system SMB session (`net use`) for authentication.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::plugin::{PluginManager, PluginRuntime, PluginSession};
use crate::sftp::FileEntry;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmbOpenParams {
    host: String,
    share: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    domain: Option<String>,
    #[serde(default)]
    default_dir: Option<String>,
}

#[derive(Serialize)]
pub struct SmbOpenResult {
    sftp_id: String,
    home_dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmbDiscoverParams {
    host: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    domain: Option<String>,
}

fn basename(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

fn join_path(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

fn to_file_entry(e: &Value, dir: &str) -> FileEntry {
    let name = e.get("name").and_then(Value::as_str).unwrap_or("").to_string();
    let is_dir = e.get("isDir").and_then(Value::as_bool).unwrap_or(false);
    let path = join_path(dir, &name);
    FileEntry {
        name,
        path,
        is_dir,
        is_file: !is_dir,
        is_symlink: e.get("isSymlink").and_then(Value::as_bool).unwrap_or(false),
        size: e.get("size").and_then(Value::as_u64).unwrap_or(0),
        modified: e.get("modified").and_then(Value::as_u64).unwrap_or(0),
        permissions: String::new(),
        owner: String::new(),
    }
}

#[tauri::command]
pub async fn smb_open_host(
    app: AppHandle,
    mgr: State<'_, PluginManager>,
    runtime: State<'_, PluginRuntime>,
    params: SmbOpenParams,
) -> Result<SmbOpenResult, String> {
    let session_id = Uuid::new_v4().to_string();
    let session = mgr.spawn_transfer("SMB", app, "smb://".to_string(), session_id.clone())?;
    let res = match session.call("connect", json!({
        "host": params.host,
        "share": params.share,
        "username": params.username,
        "password": params.password,
        "domain": params.domain,
    })).await {
        Ok(v) => v,
        Err(e) => {
            session.shutdown();
            return Err(e);
        }
    };
    let mut home = res.get("cwd").and_then(Value::as_str).unwrap_or("/").to_string();
    if let Some(d) = params.default_dir {
        if !d.is_empty() {
            home = d;
        }
    }
    runtime.insert(session_id.clone(), session);
    Ok(SmbOpenResult { sftp_id: session_id, home_dir: home })
}

#[tauri::command]
pub async fn smb_list_shares(
    app: AppHandle,
    mgr: State<'_, PluginManager>,
    params: SmbDiscoverParams,
) -> Result<Vec<String>, String> {
    let session_id = Uuid::new_v4().to_string();
    let session = mgr.spawn_transfer("SMB", app, "smb://".to_string(), session_id)?;
    let res = session
        .call("list_shares", json!({
            "host": params.host,
            "username": params.username,
            "password": params.password,
            "domain": params.domain,
        }))
        .await;
    session.shutdown();

    let res = res?;
    Ok(res
        .get("shares")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(ToOwned::to_owned))
        .collect())
}

#[tauri::command]
pub async fn smb_list_dir(
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let session = runtime.get(&sftp_id).ok_or("smb session not found")?;
    let res = session.call("list", json!({ "path": path })).await?;
    let entries = res.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(entries.iter().map(|e| to_file_entry(e, &path)).collect())
}

#[tauri::command]
pub async fn smb_stat(
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    path: String,
) -> Result<FileEntry, String> {
    let session = runtime.get(&sftp_id).ok_or("smb session not found")?;
    let res = session.call("stat", json!({ "path": path })).await?;
    let is_dir = res.get("isDir").and_then(Value::as_bool).unwrap_or(false);
    Ok(FileEntry {
        name: res.get("name").and_then(Value::as_str).map(String::from).unwrap_or_else(|| basename(&path)),
        path: path.clone(),
        is_dir,
        is_file: !is_dir,
        is_symlink: false,
        size: res.get("size").and_then(Value::as_u64).unwrap_or(0),
        modified: res.get("modified").and_then(Value::as_u64).unwrap_or(0),
        permissions: String::new(),
        owner: String::new(),
    })
}

#[tauri::command]
pub async fn smb_mkdir(
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    path: String,
) -> Result<(), String> {
    let session = runtime.get(&sftp_id).ok_or("smb session not found")?;
    session.call("mkdir", json!({ "path": path })).await.map(|_| ())
}

#[tauri::command]
pub async fn smb_rename(
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    src: String,
    dst: String,
) -> Result<(), String> {
    let session = runtime.get(&sftp_id).ok_or("smb session not found")?;
    session.call("rename", json!({ "from": src, "to": dst })).await.map(|_| ())
}

#[tauri::command]
pub async fn smb_remove(
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let session = runtime.get(&sftp_id).ok_or("smb session not found")?;
    session.call("remove", json!({ "path": path, "isDir": is_dir })).await.map(|_| ())
}

#[tauri::command]
pub async fn smb_close(
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
) -> Result<(), String> {
    if let Some(session) = runtime.remove(&sftp_id) {
        session.shutdown();
    }
    Ok(())
}

#[tauri::command]
pub async fn smb_download(
    app: AppHandle,
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
) -> Result<String, String> {
    let session = runtime.get(&sftp_id).ok_or("smb session not found")?;
    let tid = transfer_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    spawn_transfer(app, session, "download", tid.clone(), json!({
        "remotePath": remote_path,
        "localPath": local_path,
        "transferId": tid,
    }));
    Ok(tid)
}

#[tauri::command]
pub async fn smb_download_dir(
    app: AppHandle,
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    remote_dir: String,
    local_base: String,
    transfer_id: Option<String>,
) -> Result<String, String> {
    let session = runtime.get(&sftp_id).ok_or("smb session not found")?;
    let tid = transfer_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    spawn_transfer(app, session, "download_dir", tid.clone(), json!({
        "remoteDir": remote_dir,
        "localBase": local_base,
        "transferId": tid,
    }));
    Ok(tid)
}

#[tauri::command]
pub async fn smb_upload(
    app: AppHandle,
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
) -> Result<String, String> {
    let session = runtime.get(&sftp_id).ok_or("smb session not found")?;
    let tid = transfer_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    spawn_transfer(app, session, "upload", tid.clone(), json!({
        "localPath": local_path,
        "remotePath": remote_path,
        "transferId": tid,
    }));
    Ok(tid)
}

#[tauri::command]
pub async fn smb_upload_dir(
    app: AppHandle,
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    local_dir: String,
    remote_base: String,
    transfer_id: Option<String>,
) -> Result<String, String> {
    let session = runtime.get(&sftp_id).ok_or("smb session not found")?;
    let tid = transfer_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    spawn_transfer(app, session, "upload_dir", tid.clone(), json!({
        "localDir": local_dir,
        "remoteBase": remote_base,
        "transferId": tid,
    }));
    Ok(tid)
}

fn spawn_transfer(
    app: AppHandle,
    session: std::sync::Arc<PluginSession>,
    method: &'static str,
    tid: String,
    params: Value,
) {
    tokio::spawn(async move {
        match session.call(method, params).await {
            Ok(v) => { let _ = app.emit(&format!("smb://done/{tid}"), v); }
            Err(e) => { let _ = app.emit(&format!("smb://error/{tid}"), e); }
        }
    });
}
