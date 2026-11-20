//! FTP transfer proxy commands.
//!
//! These mirror the core `sftp_*` command + event contract but route to the
//! installed FTP plugin sidecar (see `crate::plugin`). The frontend `SftpView`
//! drives them generically via a `provider` prefix; FTP only implements the
//! core file-browser + single-file transfer surface (the SFTP-only extras —
//! chmod/edit/exec/conflict/pause-resume/recursive — are gated off in the UI).
//!
//! When `jump_host_ids` is non-empty the first entry is used as an SSH tunnel:
//!   SSH-connect to that host → local-port-forward to ftp_host:ftp_port →
//!   FTP sidecar connects to 127.0.0.1:LOCAL_PORT.
//! The SSH session is stored in `FtpTunnelState` and dropped on `ftp_close`.
//!
//! Events: `ftp://progress/<transferId>` (from the sidecar), and
//! `ftp://done/<transferId>` / `ftp://error/<transferId>` emitted on completion.

use std::collections::HashMap;
use std::sync::Mutex;

use netape_domain::host::{AuthenticationType, HostManager};
use netape_domain::keymgr::KeyManager;
use netape_protocol::ssh::{self, SshSession};
use netape_protocol::ssh::config::{AuthMethod, SshConfig, TunnelingKind, TunnelingRule};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

use crate::app_state::AppState;
use crate::plugin::{PluginManager, PluginRuntime, PluginSession};
use crate::sftp::FileEntry;

// ── SSH tunnel state ─────────────────────────────────────────────────────────

/// Keeps SSH sessions alive while an FTP session that tunnels through them is open.
/// Keyed by the same `sftp_id` used for the FTP plugin session.
#[derive(Default)]
pub struct FtpTunnelState {
    sessions: Mutex<HashMap<String, SshSession>>,
}

impl FtpTunnelState {
    fn insert(&self, id: String, s: SshSession) {
        self.sessions.lock().unwrap().insert(id, s);
    }
    fn remove(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }
}

// ── Params / result types ────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FtpOpenParams {
    host: String,
    port: u16,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    passive: Option<bool>,
    #[serde(default)]
    encoding: Option<String>,
    #[serde(default)]
    default_dir: Option<String>,
    /// IDs of SSH hosts to use as a tunnel (only the first entry is used).
    #[serde(default)]
    jump_host_ids: Option<Vec<String>>,
}

#[derive(Serialize)]
pub struct FtpOpenResult {
    sftp_id: String,
    home_dir: String,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
        name, path, is_dir, is_file: !is_dir,
        is_symlink: e.get("isSymlink").and_then(Value::as_bool).unwrap_or(false),
        size: e.get("size").and_then(Value::as_u64).unwrap_or(0),
        modified: e.get("modified").and_then(Value::as_u64).unwrap_or(0),
        permissions: String::new(),
        owner: String::new(),
    }
}

/// SSH-connect to `tunnel_host_id` and start an FTP PASV-aware proxy.
///
/// Returns `(session, proxy_port)`. The FTP sidecar should connect to
/// `127.0.0.1:proxy_port` as if it were the real FTP server. The proxy:
///   • Forwards FTP control traffic through a direct SSH channel.
///   • Intercepts every `227 Entering Passive Mode` response, sets up a new
///     SSH local port forward for that data address, and rewrites the response
///     to point to `127.0.0.1:LOCAL_DATA_PORT` — so PASV data connections also
///     travel through the SSH tunnel rather than directly to the server.
async fn open_ftp_via_tunnel(
    tunnel_host_id: &str,
    ftp_host: &str,
    ftp_port: u16,
    app_state: &AppState,
) -> Result<(SshSession, u16), String> {
    let host_mgr = HostManager::new(&app_state.store, &app_state.owner);
    let key_mgr  = KeyManager::new(&app_state.store, &app_state.owner);

    let host = host_mgr.get(tunnel_host_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("SSH tunnel host not found: {tunnel_host_id}"))?;

    let mut config = SshConfig::from_host(&host, None);
    if host.authentication.auth_type == AuthenticationType::PublicKey {
        config.auth = AuthMethod::PublicKey {
            keys: crate::ssh_auth::resolve_pubkeys(&key_mgr, Some(&host.authentication.password)),
        };
    }

    let session = ssh::connect_with(&config, None)
        .await
        .map_err(|e| format!("SSH tunnel connection failed: {e}"))?;

    let proxy_port = spawn_ftp_proxy(session.clone(), ftp_host.to_string(), ftp_port).await?;
    Ok((session, proxy_port))
}

/// Bind a local TCP listener and spawn the FTP PASV-intercepting proxy task.
async fn spawn_ftp_proxy(
    session: SshSession,
    ftp_host: String,
    ftp_port: u16,
) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").await
        .map_err(|e| format!("FTP proxy bind: {e}"))?;
    let proxy_port = listener.local_addr().map_err(|e| e.to_string())?.port();

    tokio::spawn(async move {
        // Accept exactly one connection: the sidecar's FTP control connection.
        let Ok((client, _)) = listener.accept().await else { return };

        let server = match session.open_direct_tcpip(&ftp_host, ftp_port).await {
            Ok(s) => s,
            Err(e) => { tracing::warn!("FTP proxy: control channel failed: {e}"); return; }
        };
        run_ftp_proxy(client, server, session).await;
    });

    Ok(proxy_port)
}

/// Proxy FTP control traffic bidirectionally, intercepting PASV responses.
async fn run_ftp_proxy<S>(client: TcpStream, server: S, session: SshSession)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static,
{
    let (server_r, mut server_w) = tokio::io::split(server);
    let (mut client_r, mut client_w) = tokio::io::split(client);

    let mut server_lines = BufReader::new(server_r).lines();

    // Client → server: pass FTP commands straight through.
    let c2s = tokio::spawn(async move {
        let _ = tokio::io::copy(&mut client_r, &mut server_w).await;
    });

    // Server → client: intercept "227 Entering Passive Mode" and rewrite.
    let s2c = tokio::spawn(async move {
        while let Ok(Some(line)) = server_lines.next_line().await {
            let line = format!("{line}\r\n");
            let out = match intercept_pasv(&line, &session).await {
                Some(rewritten) => rewritten,
                None            => line,
            };
            if client_w.write_all(out.as_bytes()).await.is_err() { break; }
        }
    });

    tokio::select! { _ = c2s => {}, _ = s2c => {} }
}

/// If `line` is a PASV response, set up an SSH local forward for the data
/// address and return the rewritten response pointing to 127.0.0.1.
async fn intercept_pasv(line: &str, session: &SshSession) -> Option<String> {
    if !line.starts_with("227 ") { return None; }

    // Parse "227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)"
    let start = line.find('(')?;
    let end   = line.find(')')?;
    let nums: Vec<u16> = line[start+1..end]
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    if nums.len() != 6 { return None; }
    let data_host = format!("{}.{}.{}.{}", nums[0], nums[1], nums[2], nums[3]);
    let data_port = (nums[4] << 8) | nums[5];

    let rule = TunnelingRule {
        name: "ftp-data".into(),
        kind: TunnelingKind::Local,
        src_host: "127.0.0.1".into(),
        src_port: 0,
        dst_host: data_host,
        dst_port: data_port,
    };
    let bound = session.start_forwarding(&rule).await.ok()?;
    let local_port = bound.rsplitn(2, ':').next()?.parse::<u16>().ok()?;

    let p1 = local_port >> 8;
    let p2 = local_port & 0xFF;
    Some(format!("227 Entering Passive Mode (127,0,0,1,{p1},{p2})\r\n"))
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ftp_open_host(
    app: AppHandle,
    mgr: State<'_, PluginManager>,
    runtime: State<'_, PluginRuntime>,
    tunnels: State<'_, FtpTunnelState>,
    app_state: State<'_, AppState>,
    params: FtpOpenParams,
) -> Result<FtpOpenResult, String> {
    let session_id = Uuid::new_v4().to_string();

    // ── SSH tunnel + FTP PASV proxy (optional) ───────────────────────────────
    let (connect_host, connect_port) = if let Some(ids) = &params.jump_host_ids {
        if let Some(tunnel_id) = ids.first().filter(|s| !s.is_empty()) {
            let (ssh_session, proxy_port) =
                open_ftp_via_tunnel(tunnel_id, &params.host, params.port, &app_state).await?;
            tunnels.insert(session_id.clone(), ssh_session);
            ("127.0.0.1".to_string(), proxy_port)
        } else {
            (params.host.clone(), params.port)
        }
    } else {
        (params.host.clone(), params.port)
    };

    // ── Launch FTP sidecar ───────────────────────────────────────────────────
    let session = match mgr.spawn_transfer("FTP", app.clone(), "ftp://".to_string(), session_id.clone()) {
        Ok(session) => session,
        Err(error) => { tunnels.remove(&session_id); return Err(error); }
    };

    let res = match session
        .call("connect", json!({
            "host":     connect_host,
            "port":     connect_port,
            "username": params.username,
            "password": params.password,
            "passive":  params.passive.unwrap_or(true),
            "encoding": params.encoding,
        }))
        .await
    {
        Ok(v) => v,
        Err(e) => {
            session.shutdown();
            tunnels.remove(&session_id);
            return Err(e);
        }
    };

    let mut home = res.get("cwd").and_then(Value::as_str).unwrap_or("/").to_string();
    if let Some(d) = params.default_dir {
        if !d.is_empty() { home = d; }
    }
    runtime.insert(session_id.clone(), session);
    Ok(FtpOpenResult { sftp_id: session_id, home_dir: home })
}

#[tauri::command]
pub async fn ftp_list_dir(
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let session = runtime.get(&sftp_id).ok_or("ftp session not found")?;
    let res = session.call("list", json!({ "path": path })).await?;
    let entries = res.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(entries.iter().map(|e| to_file_entry(e, &path)).collect())
}

#[tauri::command]
pub async fn ftp_stat(
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    path: String,
) -> Result<FileEntry, String> {
    let session = runtime.get(&sftp_id).ok_or("ftp session not found")?;
    let res = session.call("stat", json!({ "path": path })).await?;
    let is_dir = res.get("isDir").and_then(Value::as_bool).unwrap_or(false);
    Ok(FileEntry {
        name: res.get("name").and_then(Value::as_str).map(String::from).unwrap_or_else(|| basename(&path)),
        path: path.clone(), is_dir, is_file: !is_dir, is_symlink: false,
        size: res.get("size").and_then(Value::as_u64).unwrap_or(0),
        modified: res.get("modified").and_then(Value::as_u64).unwrap_or(0),
        permissions: String::new(), owner: String::new(),
    })
}

#[tauri::command]
pub async fn ftp_mkdir(
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    path: String,
) -> Result<(), String> {
    let session = runtime.get(&sftp_id).ok_or("ftp session not found")?;
    session.call("mkdir", json!({ "path": path })).await.map(|_| ())
}

#[tauri::command]
pub async fn ftp_rename(
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    src: String,
    dst: String,
) -> Result<(), String> {
    let session = runtime.get(&sftp_id).ok_or("ftp session not found")?;
    session.call("rename", json!({ "from": src, "to": dst })).await.map(|_| ())
}

#[tauri::command]
pub async fn ftp_remove(
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let session = runtime.get(&sftp_id).ok_or("ftp session not found")?;
    session.call("remove", json!({ "path": path, "isDir": is_dir })).await.map(|_| ())
}

#[tauri::command]
pub async fn ftp_close(
    runtime: State<'_, PluginRuntime>,
    tunnels: State<'_, FtpTunnelState>,
    sftp_id: String,
) -> Result<(), String> {
    if let Some(session) = runtime.remove(&sftp_id) {
        session.shutdown();
    }
    // Drop the SSH tunnel session (Arc count goes to 0 → connection closes).
    tunnels.remove(&sftp_id);
    Ok(())
}

#[tauri::command]
pub async fn ftp_download(
    app: AppHandle,
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
) -> Result<String, String> {
    let session = runtime.get(&sftp_id).ok_or("ftp session not found")?;
    let tid = transfer_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    spawn_transfer(app, session, "download", tid.clone(), json!({
        "remotePath": remote_path, "localPath": local_path, "transferId": tid,
    }));
    Ok(tid)
}

#[tauri::command]
pub async fn ftp_upload(
    app: AppHandle,
    runtime: State<'_, PluginRuntime>,
    sftp_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
) -> Result<String, String> {
    let session = runtime.get(&sftp_id).ok_or("ftp session not found")?;
    let tid = transfer_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    spawn_transfer(app, session, "upload", tid.clone(), json!({
        "localPath": local_path, "remotePath": remote_path, "transferId": tid,
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
            Ok(v)  => { let _ = app.emit(&format!("ftp://done/{tid}"),  v); }
            Err(e) => { let _ = app.emit(&format!("ftp://error/{tid}"), e); }
        }
    });
}
