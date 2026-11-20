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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

pub use netape_plugin_package::Manifest as PluginManifest;
use netape_plugin_package::{
    commit_staged, copy_local, read_manifest, validate_id, validate_package,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

/// `~/.netape/plugins`
pub fn plugins_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".netape")
        .join("plugins")
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
    mutation: Mutex<()>,
    running: Mutex<HashMap<String, Vec<Weak<PluginSession>>>>,
}

impl PluginManager {
    /// (Re)scan the plugins directory and refresh the loaded set.
    pub fn rescan(&self) {
        let mut list = Vec::new();
        if let Ok(entries) = std::fs::read_dir(plugins_dir()) {
            for e in entries.flatten() {
                let dir = e.path();
                if e.file_name().to_string_lossy().starts_with('.')
                    || e.file_type()
                        .map_or(true, |kind| !kind.is_dir() || kind.is_symlink())
                {
                    continue;
                }
                // A plugin marked for removal that's no longer locked: clean it up.
                if dir.join("uninstalled").exists() {
                    let _ = std::fs::remove_dir_all(&dir);
                    continue;
                }
                if let Ok(manifest) = read_manifest(&dir) {
                    if dir.file_name().and_then(|name| name.to_str()) == Some(manifest.id.as_str())
                        && std::fs::symlink_metadata(bin_path(&manifest, &dir))
                            .is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
                    {
                        list.push(LoadedPlugin { manifest, dir });
                    }
                }
            }
        }
        *self.inner.lock().unwrap() = list;
    }

    pub fn list(&self) -> Vec<PluginManifest> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .map(|p| p.manifest.clone())
            .collect()
    }

    fn ensure_idle(&self, id: &str) -> Result<(), String> {
        let mut running = self.running.lock().unwrap();
        let sessions = running.entry(id.to_string()).or_default();
        sessions.retain(|session| {
            session
                .upgrade()
                .is_some_and(|session| session.is_running())
        });
        if sessions.is_empty() {
            Ok(())
        } else {
            Err("Close this plugin's connections before updating or uninstalling it".into())
        }
    }

    pub fn spawn_transfer(
        &self,
        protocol: &str,
        app: AppHandle,
        prefix: String,
        session_id: String,
    ) -> Result<Arc<PluginSession>, String> {
        let _guard = self.mutation.lock().unwrap();
        let (manifest, bin) = self
            .find_transfer(protocol)
            .ok_or_else(|| format!("{protocol} plugin is not installed"))?;
        let session = PluginSession::spawn(&bin, app, prefix, session_id)?;
        self.running
            .lock()
            .unwrap()
            .entry(manifest.id)
            .or_default()
            .push(Arc::downgrade(&session));
        Ok(session)
    }

    pub(crate) fn replace_staged(
        &self,
        staged: &Path,
        manifest: &PluginManifest,
    ) -> Result<(), String> {
        let _guard = self.mutation.lock().unwrap();
        self.ensure_idle(&manifest.id)?;
        commit_staged(&plugins_dir(), staged, manifest)?;
        self.rescan();
        Ok(())
    }

    /// Find a transfer plugin contributing `protocol` and return its manifest +
    /// resolved sidecar binary path.
    pub fn find_transfer(&self, protocol: &str) -> Option<(PluginManifest, PathBuf)> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .find(|p| {
                p.manifest.kind == "transfer" && p.manifest.protocol.eq_ignore_ascii_case(protocol)
            })
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
    active: Arc<AtomicBool>,
}

impl PluginSession {
    fn is_running(&self) -> bool {
        self.child.lock().map_or(true, |mut child| {
            child.try_wait().map_or(true, |status| status.is_none())
        })
    }

    /// Spawn the sidecar. `event_prefix` (e.g. "ftp://") is used to forward
    /// progress notifications and the exit signal to the frontend.
    pub fn spawn(
        bin: &Path,
        app: AppHandle,
        event_prefix: String,
        session_id: String,
    ) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new(bin);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to start plugin: {e}"))?;
        let stdin = child.stdin.take().ok_or("plugin has no stdin")?;
        let stdout = child.stdout.take().ok_or("plugin has no stdout")?;

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_r = Arc::clone(&pending);
        let active = Arc::new(AtomicBool::new(true));
        let active_reader = active.clone();

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = v.get("id").and_then(Value::as_u64) {
                    let res = if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                        Ok(v.get("result").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(v
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("plugin error")
                            .to_string())
                    };
                    if let Some(tx) = pending_r.lock().unwrap().remove(&id) {
                        let _ = tx.send(res);
                    }
                } else if v.get("method").and_then(Value::as_str) == Some("progress") {
                    if let Some(params) = v.get("params") {
                        let tid = params
                            .get("transferId")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let _ = app.emit(&format!("{event_prefix}progress/{tid}"), params.clone());
                    }
                }
            }
            active_reader.store(false, Ordering::SeqCst);
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
            active,
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
            if child.kill().is_ok() || child.try_wait().ok().flatten().is_some() {
                let _ = child.wait();
                self.active.store(false, Ordering::SeqCst);
            }
        }
    }
}

impl Drop for PluginSession {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
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

/// Install a local folder using the same validation and staging as remote packages.
#[tauri::command]
pub async fn plugins_install(app: AppHandle, src_dir: String) -> Result<PluginManifest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        install_from_dir(&app.state::<PluginManager>(), &PathBuf::from(src_dir))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(crate) fn install_from_dir(mgr: &PluginManager, src: &Path) -> Result<PluginManifest, String> {
    let root = plugins_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let stage = tempfile::Builder::new()
        .prefix(".stage-")
        .tempdir_in(&root)
        .map_err(|e| e.to_string())?;
    copy_local(src, stage.path(), &AtomicBool::new(false))?;
    let manifest = validate_package(stage.path(), None)?;
    mgr.replace_staged(stage.path(), &manifest)?;
    Ok(manifest)
}

pub(crate) fn catalog_dir() -> Option<PathBuf> {
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

#[tauri::command]
pub async fn plugins_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_id(&id)?;
        let mgr = app.state::<PluginManager>();
        let _guard = mgr.mutation.lock().unwrap();
        mgr.ensure_idle(&id)?;
        let dir = plugins_dir().join(&id);
        if let Ok(meta) = std::fs::symlink_metadata(&dir) {
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return Err("Unsafe plugin directory".to_string());
            }
            if std::fs::remove_dir_all(&dir).is_err() {
                std::fs::write(dir.join("uninstalled"), b"").map_err(|e| e.to_string())?;
            }
        }
        mgr.rescan();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn init(app: &AppHandle) {
    // Recover an interrupted rename before exposing plugins or starting sidecars.
    let root = plugins_dir();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if let Some(id) = name.to_str().and_then(|name| name.strip_prefix(".backup-")) {
                if validate_id(id).is_ok()
                    && entry
                        .file_type()
                        .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
                {
                    let destination = root.join(id);
                    if !destination.exists()
                        && read_manifest(&entry.path()).is_ok_and(|manifest| manifest.id == id)
                    {
                        let _ = std::fs::rename(entry.path(), destination);
                    } else if read_manifest(&destination).is_ok_and(|manifest| manifest.id == id) {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        }
    }
    let mgr = PluginManager::default();
    mgr.rescan();
    app.manage(mgr);
    app.manage(PluginRuntime::default());
    app.manage(crate::plugin_market::MarketplaceState::default());
}
