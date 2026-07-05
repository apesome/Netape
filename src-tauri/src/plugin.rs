//! Plugin host: discovery of installed plugins and a JSON-RPC client for
//! talking to plugin sidecar processes over stdio.
//!
//! A plugin lives in `~/.netape/plugins/<id>/` as a folder containing a
//! `plugin.json` manifest and a sidecar executable. Instead of loading plugin
//! code into the app process, the sidecar runs out-of-process and speaks a
//! line-delimited JSON-RPC protocol (see `crates/netape-ftp`).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

/// `~/.netape/plugins`
pub fn plugins_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".netape").join("plugins")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Extension kind, e.g. "transfer".
    pub kind: String,
    /// Protocol contributed, e.g. "FTP".
    #[serde(default)]
    pub protocol: String,
    /// Sidecar executable filename, relative to the plugin folder.
    pub bin: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

// ── Discovery ───────────────────────────────────────────────────────────────

#[derive(Clone)]
struct LoadedPlugin {
    manifest: PluginManifest,
    dir: PathBuf,
}

#[derive(Default)]
pub struct PluginManager {
    inner: Mutex<Vec<LoadedPlugin>>,
}

impl PluginManager {
    /// (Re)scan the plugins directory and refresh the loaded set.
    pub fn rescan(&self) {
        let mut list = Vec::new();
        if let Ok(entries) = std::fs::read_dir(plugins_dir()) {
            for e in entries.flatten() {
                let dir = e.path();
                if !dir.is_dir() {
                    continue;
                }
                // A plugin marked for removal that's no longer locked: clean it up.
                if dir.join("uninstalled").exists() {
                    let _ = std::fs::remove_dir_all(&dir);
                    continue;
                }
                if let Ok(txt) = std::fs::read_to_string(dir.join("plugin.json")) {
                    if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&txt) {
                        list.push(LoadedPlugin { manifest, dir });
                    }
                }
            }
        }
        *self.inner.lock().unwrap() = list;
    }

    pub fn list(&self) -> Vec<PluginManifest> {
        self.inner.lock().unwrap().iter().map(|p| p.manifest.clone()).collect()
    }

    /// Find a transfer plugin contributing `protocol` and return its manifest +
    /// resolved sidecar binary path.
    pub fn find_transfer(&self, protocol: &str) -> Option<(PluginManifest, PathBuf)> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .find(|p| p.manifest.kind == "transfer" && p.manifest.protocol.eq_ignore_ascii_case(protocol))
            .map(|p| (p.manifest.clone(), bin_path(&p.manifest, &p.dir)))
    }
}

fn bin_path(manifest: &PluginManifest, dir: &Path) -> PathBuf {
    let mut name = manifest.bin.clone();
    if cfg!(windows) && !name.to_ascii_lowercase().ends_with(".exe") {
        name.push_str(".exe");
    }
    dir.join(name)
}

// ── Sidecar RPC session ─────────────────────────────────────────────────────

/// A running plugin sidecar process and its JSON-RPC channel.
pub struct PluginSession {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    next_id: AtomicU64,
}

impl PluginSession {
    /// Spawn the sidecar. `event_prefix` (e.g. "ftp://") is used to forward
    /// progress notifications and the exit signal to the frontend.
    pub fn spawn(
        bin: &Path,
        app: AppHandle,
        event_prefix: String,
        session_id: String,
    ) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new(bin);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("failed to start plugin: {e}"))?;
        let stdin = child.stdin.take().ok_or("plugin has no stdin")?;
        let stdout = child.stdout.take().ok_or("plugin has no stdout")?;

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_r = Arc::clone(&pending);

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(id) = v.get("id").and_then(Value::as_u64) {
                    let res = if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                        Ok(v.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(v.get("error").and_then(Value::as_str).unwrap_or("plugin error").to_string())
                    };
                    if let Some(tx) = pending_r.lock().unwrap().remove(&id) {
                        let _ = tx.send(res);
                    }
                } else if v.get("method").and_then(Value::as_str) == Some("progress") {
                    if let Some(params) = v.get("params") {
                        let tid = params.get("transferId").and_then(Value::as_str).unwrap_or("");
                        let _ = app.emit(&format!("{event_prefix}progress/{tid}"), params.clone());
                    }
                }
            }
            // Sidecar exited (stdout closed): fail any in-flight calls and signal.
            for (_, tx) in pending_r.lock().unwrap().drain() {
                let _ = tx.send(Err("plugin process exited".into()));
            }
            let _ = app.emit(&format!("{event_prefix}exit/{session_id}"), ());
        });

        Ok(Arc::new(PluginSession {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
        }))
    }

    /// Send a request and await its response.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);

        let req = serde_json::to_string(&json!({ "id": id, "method": method, "params": params }))
            .map_err(|e| e.to_string())?;
        {
            let mut stdin = self.stdin.lock().unwrap();
            writeln!(stdin, "{req}").map_err(|e| e.to_string())?;
            stdin.flush().map_err(|e| e.to_string())?;
        }
        rx.await.map_err(|_| "plugin channel closed".to_string())?
    }

    /// Politely ask the sidecar to close, then make sure the process is gone.
    pub fn shutdown(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = writeln!(stdin, "{}", json!({ "id": 0, "method": "close" }));
            let _ = stdin.flush();
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

/// Active plugin sessions, keyed by session id.
#[derive(Default)]
pub struct PluginRuntime {
    sessions: Mutex<HashMap<String, Arc<PluginSession>>>,
}

impl PluginRuntime {
    pub fn insert(&self, id: String, session: Arc<PluginSession>) {
        self.sessions.lock().unwrap().insert(id, session);
    }
    pub fn get(&self, id: &str) -> Option<Arc<PluginSession>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }
    pub fn remove(&self, id: &str) -> Option<Arc<PluginSession>> {
        self.sessions.lock().unwrap().remove(id)
    }
}

// ── Commands ────────────────────────────────────────────────────────────────

/// List installed plugins (rescans first).
#[tauri::command]
pub fn plugins_list(mgr: State<'_, PluginManager>) -> Vec<PluginManifest> {
    mgr.rescan();
    mgr.list()
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

/// Copy a plugin folder (plugin.json + sidecar) into the plugins directory.
fn install_from_dir(mgr: &PluginManager, src: &Path) -> Result<PluginManifest, String> {
    let manifest_txt = std::fs::read_to_string(src.join("plugin.json"))
        .map_err(|_| "Selected directory is not a valid plugin (missing plugin.json)".to_string())?;
    let manifest: PluginManifest =
        serde_json::from_str(&manifest_txt).map_err(|e| format!("Failed to parse plugin.json: {e}"))?;

    let dst = plugins_dir().join(&manifest.id);
    let _ = std::fs::remove_dir_all(&dst);
    copy_dir_all(src, &dst).map_err(|e| format!("Install failed: {e}"))?;
    mgr.rescan();
    Ok(manifest)
}

/// Install a plugin from a local folder chosen by the user.
#[tauri::command]
pub fn plugins_install(mgr: State<'_, PluginManager>, src_dir: String) -> Result<PluginManifest, String> {
    install_from_dir(&mgr, &PathBuf::from(&src_dir))
}

/// Resolve the plugin marketplace catalog directory. This is the offline
/// "store": a directory of available plugin folders. Resolution order:
/// `$NETAPE_PLUGIN_CATALOG`, then `<exe>/plugins-dist` (bundled), then the
/// project's `plugins-dist` (dev).
fn catalog_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("NETAPE_PLUGIN_CATALOG") {
        let pb = PathBuf::from(p);
        if pb.is_dir() {
            return Some(pb);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(p) = exe.parent().map(|d| d.join("plugins-dist")) {
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("plugins-dist"))
        .filter(|p| p.is_dir())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketEntry {
    #[serde(flatten)]
    manifest: PluginManifest,
    installed: bool,
    installed_version: Option<String>,
}

/// List plugins available in the marketplace catalog, each flagged with whether
/// it is already installed.
#[tauri::command]
pub fn plugins_marketplace(mgr: State<'_, PluginManager>) -> Vec<MarketEntry> {
    mgr.rescan();
    let installed = mgr.list();
    let mut out = Vec::new();
    if let Some(dir) = catalog_dir() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let d = e.path();
                if !d.is_dir() {
                    continue;
                }
                if let Ok(txt) = std::fs::read_to_string(d.join("plugin.json")) {
                    if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&txt) {
                        let inst = installed.iter().find(|i| i.id == manifest.id);
                        out.push(MarketEntry {
                            installed: inst.is_some(),
                            installed_version: inst.map(|i| i.version.clone()),
                            manifest,
                        });
                    }
                }
            }
        }
    }
    out
}

/// Install a plugin from the marketplace catalog by id.
#[tauri::command]
pub fn plugins_install_market(mgr: State<'_, PluginManager>, id: String) -> Result<PluginManifest, String> {
    let dir = catalog_dir().ok_or_else(|| "Plugin marketplace is unavailable".to_string())?;
    let src = dir.join(&id);
    if !src.join("plugin.json").exists() {
        return Err("Plugin not found in marketplace".to_string());
    }
    install_from_dir(&mgr, &src)
}

/// Uninstall a plugin. Removes its folder, falling back to an `uninstalled`
/// marker (cleaned up on next scan) if the binary is currently locked.
#[tauri::command]
pub fn plugins_uninstall(mgr: State<'_, PluginManager>, id: String) -> Result<(), String> {
    let dir = plugins_dir().join(&id);
    if dir.exists() && std::fs::remove_dir_all(&dir).is_err() {
        let _ = std::fs::write(dir.join("uninstalled"), b"");
    }
    mgr.rescan();
    Ok(())
}

pub fn init(app: &AppHandle) {
    let mgr = PluginManager::default();
    mgr.rescan();
    app.manage(mgr);
    app.manage(PluginRuntime::default());
}
