//! Tauri command bridge for SFTP file transfer.
//!
//! # Commands
//! ```text
//! sftp_open     { sessionId }  → sftp_id
//! sftp_list_dir { sftpId, path } → Vec<FileEntry>
//! sftp_stat     { sftpId, path } → FileEntry
//! sftp_mkdir    { sftpId, path }
//! sftp_rename   { sftpId, src, dst }
//! sftp_remove   { sftpId, path }
//! sftp_close    { sftpId }
//! sftp_download { sftpId, remotePath, localPath } → transfer_id
//! sftp_upload   { sftpId, localPath, remotePath } → transfer_id
//!
//! local_home_dir  ()    → String
//! local_list_dir  { path } → Vec<FileEntry>
//!
//! events  sftp://progress/{transfer_id}  → { transferred, total }
//!         sftp://done/{transfer_id}      → null
//!         sftp://error/{transfer_id}     → String
//! ```

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

use base64::Engine;
use netape_domain::host::{AuthenticationType, HostManager};
use netape_domain::keymgr::KeyManager;
use netape_protocol::ssh::{self as ssh_lib, SshConfig};
use netape_protocol::ssh::config::{AuthMethod, ProxyConfig};
use netape_protocol::ssh::sftp::SftpChannel;
use crate::app_state::AppState;
use crate::ssh_terminal::SshTerminalState;

// ---------------------------------------------------------------------------
// Shared data types
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    #[serde(rename = "isFile")]
    pub is_file: bool,
    #[serde(rename = "isSymlink")]
    pub is_symlink: bool,
    pub size: u64,
    pub modified: u64,   // unix timestamp in ms
    pub permissions: String,
    pub owner: String,
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    transferred: u64,
    total: u64,
}

#[derive(Serialize, Clone)]
struct SubFilePayload {
    rel_path: String,  // path relative to the root folder, e.g. "subfolder/file.txt"
    name: String,
    done: bool,
    transferred: u64,
    total: u64,
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ConflictAction { Overwrite, Skip, Resume, Rename }

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConflictPayload {
    request_id:        String,
    rel_path:          String,
    name:              String,
    is_dir:            bool,
    existing_size:     u64,        // bytes of the file/dir that already exists
    incoming_size:     u64,        // bytes of the file being transferred
    can_resume:        bool,       // true only when existing < incoming (partial file)
    existing_modified: Option<i64>, // Unix seconds; None = unavailable
    incoming_modified: Option<i64>,
}

/// Convert std SystemTime → Unix seconds (i64).
#[inline]
fn mtime_secs(t: std::time::SystemTime) -> Option<i64> {
    t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs() as i64)
}

/// Holds pending oneshot senders waiting for the user's conflict choice.
#[derive(Default)]
pub struct ConflictState(std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<ConflictAction>>>);

impl ConflictState {
    fn insert(&self, id: String, tx: tokio::sync::oneshot::Sender<ConflictAction>) {
        self.0.lock().unwrap().insert(id, tx);
    }
    fn take(&self, id: &str) -> Option<tokio::sync::oneshot::Sender<ConflictAction>> {
        self.0.lock().unwrap().remove(id)
    }
}

// ---------------------------------------------------------------------------
// Pause / resume state
// ---------------------------------------------------------------------------

/// Per-transfer pause handle: a flag + a wakeup signal.
#[derive(Default)]
pub struct PauseState(
    Mutex<HashMap<String, (Arc<std::sync::atomic::AtomicBool>, Arc<tokio::sync::Notify>)>>,
);

impl PauseState {
    /// Register a new transfer and return (paused_flag, notify) arcs for use inside the task.
    fn register(&self, tid: &str) -> (Arc<std::sync::atomic::AtomicBool>, Arc<tokio::sync::Notify>) {
        use std::sync::atomic::AtomicBool;
        let paused = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(tokio::sync::Notify::new());
        self.0.lock().unwrap().insert(tid.to_string(), (Arc::clone(&paused), Arc::clone(&notify)));
        (paused, notify)
    }
    fn remove(&self, tid: &str) { self.0.lock().unwrap().remove(tid); }
    fn pause_tid(&self, tid: &str) {
        use std::sync::atomic::Ordering;
        if let Some((f, _)) = self.0.lock().unwrap().get(tid) { f.store(true,  Ordering::Relaxed); }
    }
    fn resume_tid(&self, tid: &str) {
        use std::sync::atomic::Ordering;
        if let Some((f, n)) = self.0.lock().unwrap().get(tid) {
            f.store(false, Ordering::Relaxed);
            n.notify_waiters();
        }
    }
}

/// Suspend the calling async task while the `paused` flag is set.
async fn check_pause(
    paused: &std::sync::atomic::AtomicBool,
    notify: &tokio::sync::Notify,
) {
    use std::sync::atomic::Ordering;
    while paused.load(Ordering::Relaxed) { notify.notified().await; }
}

/// Suspend while EITHER the global transfer flag OR the per-file flag is set.
async fn check_pause_file(
    global:        &std::sync::atomic::AtomicBool,
    global_notify: &tokio::sync::Notify,
    file:          &std::sync::atomic::AtomicBool,
    file_notify:   &tokio::sync::Notify,
) {
    use std::sync::atomic::Ordering;
    while global.load(Ordering::Relaxed) || file.load(Ordering::Relaxed) {
        tokio::select! {
            _ = global_notify.notified() => {}
            _ = file_notify.notified()   => {}
        }
    }
}

// ---------------------------------------------------------------------------

/// Find the first unused path of the form "stem (N).ext" alongside `base`.
fn find_unique_local_path(base: &Path) -> PathBuf {
    if !base.exists() { return base.to_path_buf(); }
    let parent = base.parent().unwrap_or(Path::new("."));
    let stem   = base.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext    = base.extension().and_then(|s| s.to_str());
    for i in 1u32.. {
        let p = parent.join(match ext {
            Some(e) => format!("{stem} ({i}).{e}"),
            None    => format!("{stem} ({i})"),
        });
        if !p.exists() { return p; }
    }
    unreachable!()
}

/// Find the first unused remote path of the form "stem (N).ext" via SFTP stat.
async fn find_unique_remote_path(sftp: &russh_sftp::client::SftpSession, base: &str) -> String {
    if sftp.metadata(base).await.is_err() { return base.to_string(); }
    let (dir, fname) = base.rsplit_once('/').unwrap_or((".", base));
    let stem = fname.rsplit_once('.').map(|(s, _)| s).unwrap_or(fname);
    let ext  = fname.rsplit_once('.').map(|(_, e)| e);
    for i in 1u32.. {
        let name = match ext {
            Some(e) => format!("{stem} ({i}).{e}"),
            None    => format!("{stem} ({i})"),
        };
        let p = format!("{dir}/{name}");
        if sftp.metadata(&p).await.is_err() { return p; }
    }
    base.to_string()
}

#[tauri::command]
pub async fn sftp_resolve_conflict(
    request_id: String,
    action:     ConflictAction,
    cs:         State<'_, Arc<ConflictState>>,
) -> Result<(), String> {
    if let Some(tx) = cs.take(&request_id) { let _ = tx.send(action); }
    Ok(())
}

#[tauri::command]
pub async fn sftp_pause_transfer(
    tid:      String,
    rel_path: Option<String>,
    ps:       State<'_, Arc<PauseState>>,
) -> Result<(), String> {
    let key = match rel_path { None => tid, Some(r) => format!("{tid}:{r}") };
    ps.pause_tid(&key);
    Ok(())
}

#[tauri::command]
pub async fn sftp_resume_transfer(
    tid:      String,
    rel_path: Option<String>,
    ps:       State<'_, Arc<PauseState>>,
) -> Result<(), String> {
    let key = match rel_path { None => tid, Some(r) => format!("{tid}:{r}") };
    ps.resume_tid(&key);
    Ok(())
}

#[derive(Serialize)]
pub struct SftpOpenResult {
    pub sftp_id:  String,
    pub home_dir: String,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

struct ActiveSftp {
    /// The russh-sftp session (needs exclusive access per operation).
    sftp: Arc<AsyncMutex<SftpChannel>>,
    /// SSH session — kept alive to hold the connection, also used to open
    /// additional SFTP channels (e.g., dedicated download channel).
    ssh: netape_protocol::ssh::SshSession,
    /// Background health-checker — aborted when the session is closed.
    watcher: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
pub struct SftpState {
    sessions: Mutex<HashMap<String, ActiveSftp>>,
}

pub fn init(app: &AppHandle) {
    app.manage(SftpState::default());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn get_sftp(state: &SftpState, sftp_id: &str) -> Result<Arc<AsyncMutex<SftpChannel>>, String> {
    state
        .sessions
        .lock()
        .unwrap()
        .get(sftp_id)
        .map(|s| Arc::clone(&s.sftp))
        .ok_or_else(|| format!("sftp session not found: {sftp_id}"))
}

fn get_ssh(state: &SftpState, sftp_id: &str) -> Result<netape_protocol::ssh::SshSession, String> {
    state
        .sessions
        .lock()
        .unwrap()
        .get(sftp_id)
        .map(|a| a.ssh.clone())
        .ok_or_else(|| format!("sftp session not found: {sftp_id}"))
}

/// Spawn a background task that pings the SFTP session every 5 s.
/// Emits `sftp://status/{sftp_id}` → `"disconnected"` once and exits when the
/// connection is gone.  Aborted explicitly by `sftp_close`.
fn spawn_sftp_watcher(
    sftp:    Arc<AsyncMutex<SftpChannel>>,
    app:     AppHandle,
    sftp_id: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let alive = tokio::time::timeout(
                Duration::from_secs(5),
                async { sftp.lock().await.session.canonicalize(".").await },
            )
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false);
            if !alive {
                let _ = app.emit(&format!("sftp://status/{sftp_id}"), "disconnected");
                break;
            }
        }
    })
}

fn unix_ms(t: SystemTime) -> u64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn perms_string(mode: u32) -> String {
    let chars: Vec<char> = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'].to_vec();
    let bits = [8, 7, 6, 5, 4, 3, 2, 1, 0];
    bits.iter()
        .zip(chars.iter())
        .map(|(bit, ch)| if mode & (1 << bit) != 0 { *ch } else { '-' })
        .collect()
}

// ---------------------------------------------------------------------------
// Commands: SFTP session lifecycle
// ---------------------------------------------------------------------------

/// Open an SFTP subsystem channel reusing an existing SSH terminal session.
#[tauri::command]
pub async fn sftp_open(
    session_id: String,
    app:        AppHandle,
    ssh_state:  State<'_, SshTerminalState>,
    sftp_state: State<'_, SftpState>,
) -> Result<String, String> {
    let ssh = ssh_state
        .clone_ssh(&session_id)
        .ok_or_else(|| format!("SSH session not found: {session_id}"))?;

    let sftp_channel = ssh.open_sftp().await.map_err(|e| e.to_string())?;

    let sftp_arc = Arc::new(AsyncMutex::new(sftp_channel));
    let sftp_id  = Uuid::new_v4().to_string();
    let watcher  = spawn_sftp_watcher(Arc::clone(&sftp_arc), app, sftp_id.clone());
    sftp_state.sessions.lock().unwrap().insert(
        sftp_id.clone(),
        ActiveSftp { sftp: sftp_arc, ssh, watcher },
    );

    Ok(sftp_id)
}

#[tauri::command]
pub async fn sftp_close(
    sftp_id: String,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    if let Some(active) = sftp_state.sessions.lock().unwrap().remove(&sftp_id) {
        active.watcher.abort();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands: Remote file operations
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sftp_list_dir(
    sftp_id: String,
    path: String,
    sftp_state: State<'_, SftpState>,
) -> Result<Vec<FileEntry>, String> {
    let sftp = get_sftp(&sftp_state, &sftp_id)?;
    let guard = sftp.lock().await;

    let mut dir = guard
        .session
        .read_dir(&path)
        .await
        .map_err(|e| e.to_string())?;

    let mut entries: Vec<FileEntry> = Vec::new();
    for item in &mut dir {
        let meta = item.metadata();
        let name = item.file_name();
        let full_path = item.path();

        let owner = item.metadata().user.clone()
            .unwrap_or_else(|| item.metadata().uid.map(|u| u.to_string()).unwrap_or_default());
        entries.push(FileEntry {
            name,
            path: full_path,
            is_dir: meta.is_dir(),
            is_file: meta.is_regular(),
            is_symlink: meta.is_symlink(),
            size: meta.size.unwrap_or(0),
            modified: meta.mtime.map(|t| (t as u64) * 1000).unwrap_or(0),
            permissions: meta.permissions.map(perms_string).unwrap_or_default(),
            owner,
        });
    }

    // Folders first, then files; alphabetical within each group
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

#[tauri::command]
pub async fn sftp_stat(
    sftp_id: String,
    path: String,
    sftp_state: State<'_, SftpState>,
) -> Result<FileEntry, String> {
    let sftp = get_sftp(&sftp_state, &sftp_id)?;
    let guard = sftp.lock().await;

    let meta = guard.session.metadata(&path).await.map_err(|e| e.to_string())?;
    let name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let owner = meta.user.clone()
        .unwrap_or_else(|| meta.uid.map(|u| u.to_string()).unwrap_or_default());
    Ok(FileEntry {
        name,
        path,
        is_dir: meta.is_dir(),
        is_file: meta.is_regular(),
        is_symlink: meta.is_symlink(),
        size: meta.size.unwrap_or(0),
        modified: meta.mtime.map(|t| (t as u64) * 1000).unwrap_or(0),
        permissions: meta.permissions.map(perms_string).unwrap_or_default(),
        owner,
    })
}

#[tauri::command]
pub async fn sftp_mkdir(
    sftp_id: String,
    path: String,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_state, &sftp_id)?;
    let guard = sftp.lock().await;
    guard.session.create_dir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_rename(
    sftp_id: String,
    src: String,
    dst: String,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_state, &sftp_id)?;
    let guard = sftp.lock().await;
    guard.session.rename(&src, &dst).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_remove(
    sftp_id: String,
    path: String,
    is_dir: bool,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_state, &sftp_id)?;
    let guard = sftp.lock().await;
    if is_dir {
        guard.session.remove_dir(&path).await.map_err(|e| e.to_string())
    } else {
        guard.session.remove_file(&path).await.map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Commands: Download / upload with progress
// ---------------------------------------------------------------------------

/// Number of concurrent SFTP file handles = number of in-flight READ requests.
/// 8 gives ~4× the throughput of the old 4-worker design while leaving
/// enough bandwidth headroom that other network operations stay responsive.
const PIPELINE:   usize = 8;
/// Size of each read slice — should match one SFTP READ packet (≤ SSH max_packet).
/// At 32 KB per call, read_exact issues exactly one SFTP READ request per chunk.
const READ_SLICE: u64   = 32 * 1024;
/// Per-download speed cap in bytes/sec.  0 = unlimited.
/// Capping at a fraction of the link speed leaves headroom so that directory
/// browsing, new SSH connections, and other tools stay responsive during transfer.
/// Change this constant (or expose it via settings UI) to tune the tradeoff.
const DOWNLOAD_CAP_BPS: u64 = 10 * 1024 * 1024; // 10 MB/s ≈ 80 Mbps

#[tauri::command]
pub async fn sftp_download(
    app:         AppHandle,
    sftp_id:     String,
    remote_path: String,
    local_path:  String,
    sftp_state:  State<'_, SftpState>,
    cs:          State<'_, Arc<ConflictState>>,
    ps:          State<'_, Arc<PauseState>>,
) -> Result<String, String> {
    let ssh = get_ssh(&sftp_state, &sftp_id)?;
    let transfer_id = Uuid::new_v4().to_string();
    let tid = transfer_id.clone();
    let cs  = Arc::clone(&*cs);
    let ps  = Arc::clone(&*ps);

    tokio::spawn(async move {
        let (paused, notify) = ps.register(&tid);
        let result: Result<(u64, u64), String> = async {
            // ── Phase 1: dedicated download channel ──────────────────────────
            let dl = ssh.open_sftp().await
                .map_err(|e| format!("Failed to open download channel: {e}"))?;

            let remote_meta = dl.session.metadata(&remote_path).await
                .map_err(|e| format!("Failed to read remote file info: {e}"))?;
            let total = remote_meta.size.unwrap_or(0);
            let remote_mtime: Option<i64> = remote_meta.mtime.map(|t| t as i64);

            let _ = app.emit(&format!("sftp://progress/{tid}"),
                ProgressPayload { transferred: 0, total });

            if total == 0 { return Ok((0, 0)); }

            // ── Conflict check ───────────────────────────────────────────────
            let local_existing_meta = tokio::fs::metadata(&local_path).await.ok();
            let local_existing = local_existing_meta.as_ref().map(|m| m.len());
            let (effective_lpath, resume_from) = if let Some(existing_size) = local_existing {
                let existing_modified = local_existing_meta.as_ref()
                    .and_then(|m| m.modified().ok()).and_then(mtime_secs);
                let req_id = Uuid::new_v4().to_string();
                let (tx, rx) = tokio::sync::oneshot::channel();
                cs.insert(req_id.clone(), tx);
                let fname = Path::new(&local_path).file_name()
                    .map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let _ = app.emit(&format!("sftp://conflict/{tid}"), ConflictPayload {
                    request_id: req_id, rel_path: local_path.clone(), name: fname,
                    is_dir: false, existing_size, incoming_size: total,
                    can_resume: existing_size < total,
                    existing_modified, incoming_modified: remote_mtime,
                });
                match rx.await.unwrap_or(ConflictAction::Skip) {
                    ConflictAction::Skip     => return Ok((0, total)),
                    ConflictAction::Overwrite => (local_path.clone(), 0u64),
                    ConflictAction::Rename    => {
                        let p = find_unique_local_path(Path::new(&local_path));
                        (p.to_string_lossy().into_owned(), 0u64)
                    }
                    ConflictAction::Resume => (local_path.clone(), existing_size.min(total)),
                }
            } else {
                (local_path.clone(), 0u64)
            };

            // ── Phase 2: open PIPELINE handles concurrently (1 RTT total) ───
            let remaining = total.saturating_sub(resume_from);
            let n_handles = PIPELINE.min(
                ((remaining + READ_SLICE - 1) / READ_SLICE).max(1) as usize
            );
            let sess = &dl.session;
            let handles = futures::future::try_join_all(
                (0..n_handles).map(|i| {
                    let p = remote_path.clone();
                    async move {
                        sess.open(&p).await
                            .map_err(|e| format!("Open file handle #{i}: {e}"))
                    }
                })
            ).await?;

            // ── Phase 3: prepare local file ──────────────────────────────────
            if resume_from == 0 {
                let f = tokio::fs::File::create(&effective_lpath).await
                    .map_err(|e| format!("Failed to create local file: {e}"))?;
                f.set_len(total).await
                    .map_err(|e| format!("Failed to preallocate local file: {e}"))?;
            } else {
                // Resume: extend to full size so workers can seek to any offset.
                let f = tokio::fs::OpenOptions::new().write(true).open(&effective_lpath).await
                    .map_err(|e| format!("Failed to open local file: {e}"))?;
                if f.metadata().await.map(|m| m.len()).unwrap_or(0) < total {
                    f.set_len(total).await.map_err(|e| format!("Failed to extend local file: {e}"))?;
                }
            }

            // ── Phase 4: work-stealing queue — only unfinished slices ────────
            let first_slice = (resume_from / READ_SLICE) as usize;
            let n_slices    = ((total + READ_SLICE - 1) / READ_SLICE) as usize;
            let work = Arc::new(Mutex::new(
                (first_slice..n_slices)
                    .map(|i| { let s = i as u64 * READ_SLICE; (s, (s + READ_SLICE).min(total)) })
                    .collect::<Vec<_>>()
            ));

            // ── Phase 5: spawn pipeline workers ─────────────────────────────
            use std::sync::atomic::{AtomicU64, Ordering};
            let transferred = Arc::new(AtomicU64::new(resume_from));
            let mut joins: Vec<tokio::task::JoinHandle<Result<(), String>>> =
                Vec::with_capacity(n_handles);

            for mut handle in handles {
                let work    = Arc::clone(&work);
                let done    = Arc::clone(&transferred);
                let lp      = effective_lpath.clone();
                let paused_w = Arc::clone(&paused);
                let notify_w = Arc::clone(&notify);

                joins.push(tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

                    let mut local = tokio::fs::OpenOptions::new()
                        .write(true).open(&lp).await
                        .map_err(|e| e.to_string())?;
                    let mut buf = vec![0u8; READ_SLICE as usize];

                    // Per-worker quota: total cap shared evenly across workers.
                    // Each slice must take at least `slice_budget` to keep total
                    // throughput ≤ DOWNLOAD_CAP_BPS; we sleep any leftover time.
                    let slice_budget = if DOWNLOAD_CAP_BPS > 0 {
                        let per_worker_bps = (DOWNLOAD_CAP_BPS / PIPELINE as u64).max(1);
                        Some(Duration::from_nanos(
                            (READ_SLICE as u128 * 1_000_000_000 / per_worker_bps as u128) as u64,
                        ))
                    } else {
                        None
                    };

                    loop {
                        check_pause(&paused_w, &notify_w).await;
                        let item = work.lock().unwrap().pop();
                        let Some((start, end)) = item else { break };
                        let need = (end - start) as usize;
                        let t0 = std::time::Instant::now();

                        handle.seek(std::io::SeekFrom::Start(start)).await
                            .map_err(|e| format!("SFTP seek {start}: {e}"))?;
                        handle.read_exact(&mut buf[..need]).await
                            .map_err(|e| format!("SFTP read {start}+{need}: {e}"))?;

                        local.seek(std::io::SeekFrom::Start(start)).await
                            .map_err(|e| format!("Local seek {start}: {e}"))?;
                        local.write_all(&buf[..need]).await
                            .map_err(|e| format!("Local write {start}: {e}"))?;

                        done.fetch_add(need as u64, Ordering::Relaxed);

                        // Pace this slice to its budget, sleeping only the surplus.
                        if let Some(budget) = slice_budget {
                            let elapsed = t0.elapsed();
                            // Scale budget proportionally for partial last slice.
                            let actual_budget = budget * need as u32 / READ_SLICE as u32;
                            if actual_budget > elapsed {
                                tokio::time::sleep(actual_budget - elapsed).await;
                            }
                        }
                    }
                    Ok(())
                }));
            }

            // ── Phase 6: progress ticker + await ────────────────────────────
            let ticker = {
                let app2 = app.clone();
                let tid2 = tid.clone();
                let done = Arc::clone(&transferred);
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        let _ = app2.emit(&format!("sftp://progress/{tid2}"),
                            ProgressPayload { transferred: done.load(Ordering::Relaxed), total });
                    }
                })
            };

            let mut first_err: Option<String> = None;
            for j in joins {
                match j.await {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => { first_err.get_or_insert(e); }
                    Err(e)     => { first_err.get_or_insert(e.to_string()); }
                }
            }
            ticker.abort();

            if let Some(e) = first_err { return Err(e); }
            Ok((transferred.load(std::sync::atomic::Ordering::Relaxed), total))
        }.await;

        ps.remove(&tid);
        match result {
            Ok((xfer, tot)) => {
                let _ = app.emit(&format!("sftp://done/{tid}"),
                    ProgressPayload { transferred: xfer, total: tot });
            }
            Err(e) => { let _ = app.emit(&format!("sftp://error/{tid}"), e); }
        }
    });

    Ok(transfer_id)
}

#[tauri::command]
pub async fn sftp_upload(
    app:            AppHandle,
    sftp_id:        String,
    local_path:     String,
    remote_path:    String,
    preserve_mtime: Option<bool>,
    sftp_state:     State<'_, SftpState>,
    cs:             State<'_, Arc<ConflictState>>,
    ps:             State<'_, Arc<PauseState>>,
) -> Result<String, String> {
    let sftp = get_sftp(&sftp_state, &sftp_id)?;
    let preserve_mtime = preserve_mtime.unwrap_or(false);
    let transfer_id = Uuid::new_v4().to_string();
    let tid = transfer_id.clone();
    let cs  = Arc::clone(&*cs);
    let ps  = Arc::clone(&*ps);

    tokio::spawn(async move {
        let (paused, notify) = ps.register(&tid);
        // (transferred_bytes, total_bytes) returned so the done event can carry the final size.
        let result: Result<(u64, u64), String> = async {
            let total = tokio::fs::metadata(&local_path).await
                .map_err(|e| e.to_string())?.len();

            // ── Conflict check ───────────────────────────────────────────────
            let remote_existing_meta = {
                let g = sftp.lock().await;
                g.session.metadata(&remote_path).await.ok()
            };
            let remote_existing = remote_existing_meta.as_ref().and_then(|m| m.size);
            let effective_rpath = if let Some(existing_size) = remote_existing {
                let existing_modified = remote_existing_meta.as_ref()
                    .and_then(|m| m.mtime).map(|t| t as i64);
                let incoming_modified = tokio::fs::metadata(&local_path).await.ok()
                    .and_then(|m| m.modified().ok()).and_then(mtime_secs);
                let req_id = Uuid::new_v4().to_string();
                let (tx, rx) = tokio::sync::oneshot::channel();
                cs.insert(req_id.clone(), tx);
                let fname = Path::new(&remote_path).file_name()
                    .map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let _ = app.emit(&format!("sftp://conflict/{tid}"), ConflictPayload {
                    request_id: req_id, rel_path: remote_path.clone(), name: fname,
                    is_dir: false, existing_size, incoming_size: total, can_resume: false,
                    existing_modified, incoming_modified,
                });
                match rx.await.unwrap_or(ConflictAction::Skip) {
                    ConflictAction::Skip => return Ok((0, total)),
                    ConflictAction::Rename => {
                        let g = sftp.lock().await;
                        find_unique_remote_path(&g.session, &remote_path).await
                    }
                    _ => remote_path.clone(), // Overwrite / Resume → overwrite
                }
            } else {
                remote_path.clone()
            };

            let mut remote = {
                let g = sftp.lock().await;
                g.session.create(&effective_rpath).await
                    .map_err(|e| format!("Failed to create remote file: {e}"))?
            }; // mutex released

            let mut local = tokio::fs::File::open(&local_path).await
                .map_err(|e| format!("Failed to open local file: {e}"))?;

            let mut transferred: u64 = 0;
            let mut buf = vec![0u8; 2 * 1024 * 1024]; // 2 MB upload buffer
            let mut last_emit = std::time::Instant::now();

            loop {
                check_pause(&paused, &notify).await;
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let n = local.read(&mut buf).await
                    .map_err(|e| format!("Failed to read local file: {e}"))?;
                if n == 0 { break; }
                remote.write_all(&buf[..n]).await
                    .map_err(|e| format!("Failed to write remote file at offset {transferred}: {e}"))?;
                transferred += n as u64;
                // Throttle progress events to ~200 ms
                if last_emit.elapsed().as_millis() >= 200 {
                    let _ = app.emit(&format!("sftp://progress/{tid}"),
                        ProgressPayload { transferred, total });
                    last_emit = std::time::Instant::now();
                }
            }

            drop(remote); // close remote file before setstat

            // Optionally preserve modification time
            if preserve_mtime {
                if let Ok(meta) = tokio::fs::metadata(&local_path).await {
                    if let Ok(mtime_sys) = meta.modified() {
                        if let Some(mtime_secs_val) = mtime_secs(mtime_sys) {
                            use russh_sftp::protocol::FileAttributes;
                            let attr = FileAttributes {
                                size: None, uid: None, user: None, gid: None, group: None,
                                permissions: None,
                                atime: Some(mtime_secs_val as u32),
                                mtime: Some(mtime_secs_val as u32),
                            };
                            let g = sftp.lock().await;
                            let _ = g.session.set_metadata(&effective_rpath, attr).await;
                        }
                    }
                }
            }

            Ok((transferred, total))
        }.await;

        ps.remove(&tid);
        match result {
            Ok((xfer, tot)) => {
                let _ = app.emit(&format!("sftp://done/{tid}"),
                    ProgressPayload { transferred: xfer, total: tot });
            }
            Err(e) => { let _ = app.emit(&format!("sftp://error/{tid}"), e); }
        }
    });

    Ok(transfer_id)
}

// ---------------------------------------------------------------------------
// Commands: Directory transfer (upload / download recursive)
// ---------------------------------------------------------------------------

/// Walk a local directory tree.  Returns (files, dirs) where:
///   files = Vec<(local_abs_path, remote_abs_path)>
///   dirs  = Vec<remote_abs_path> to create (deepest first is fine — they are
///           created in order so parents exist when children are attempted)
fn collect_local_dir(
    local_root: &Path,
    remote_base: &str,
) -> Result<(Vec<(PathBuf, String)>, Vec<String>), String> {
    let dir_name = local_root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "dir".into());
    let remote_root = format!("{}/{}", remote_base.trim_end_matches('/'), dir_name);

    let mut files: Vec<(PathBuf, String)> = Vec::new();
    let mut dirs:  Vec<String>            = vec![remote_root.clone()];
    // (local_cur, remote_cur)
    let mut queue: Vec<(PathBuf, String)> = vec![(local_root.to_path_buf(), remote_root)];

    while let Some((lcur, rcur)) = queue.pop() {
        for item in std::fs::read_dir(&lcur).map_err(|e| e.to_string())? {
            let item  = item.map_err(|e| e.to_string())?;
            let lpath = item.path();
            let name  = item.file_name().to_string_lossy().into_owned();
            let rpath = format!("{}/{}", rcur, name);
            if lpath.is_dir() {
                dirs.push(rpath.clone());
                queue.push((lpath, rpath));
            } else {
                files.push((lpath, rpath));
            }
        }
    }
    Ok((files, dirs))
}

#[tauri::command]
pub async fn sftp_upload_dir(
    app:            AppHandle,
    sftp_id:        String,
    local_dir:      String,
    remote_base:    String,
    preserve_mtime: Option<bool>,
    sftp_state:     State<'_, SftpState>,
    cs:             State<'_, Arc<ConflictState>>,
    ps:             State<'_, Arc<PauseState>>,
) -> Result<String, String> {
    let ssh = get_ssh(&sftp_state, &sftp_id)?;
    let transfer_id = Uuid::new_v4().to_string();
    let tid = transfer_id.clone();
    let cs  = Arc::clone(&*cs);
    let ps  = Arc::clone(&*ps);
    let preserve_mtime = preserve_mtime.unwrap_or(false);

    tokio::spawn(async move {
        let (paused, notify) = ps.register(&tid);
        let result: Result<(), String> = async {
            use std::sync::atomic::{AtomicU64, Ordering};

            let local_root = PathBuf::from(&local_dir);
            // Compute remote_root so we can derive relative paths for each file.
            let dir_name = local_root.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "dir".into());
            let remote_root = format!("{}/{}", remote_base.trim_end_matches('/'), &dir_name);

            let (files, dirs) = collect_local_dir(&local_root, &remote_base)?;

            // 1. Compute per-file sizes
            let mut file_sizes: Vec<u64> = Vec::with_capacity(files.len());
            let mut total: u64 = 0;
            for (lpath, _) in &files {
                let sz = tokio::fs::metadata(lpath).await.map(|m| m.len()).unwrap_or(0);
                file_sizes.push(sz);
                total += sz;
            }

            // 2. Dedicated SFTP channel for creating remote dirs
            let sftp_dirs = ssh.open_sftp().await.map_err(|e| e.to_string())?;
            for d in &dirs {
                let _ = sftp_dirs.session.create_dir(d).await;
            }

            // 3. Announce all files upfront so the UI can show pending rows
            for ((_, rpath), &sz) in files.iter().zip(&file_sizes) {
                let fname = Path::new(rpath).file_name()
                    .map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let rel = rpath.strip_prefix(&format!("{remote_root}/")).unwrap_or(rpath).to_string();
                let _ = app.emit(&format!("sftp://file/{tid}"),
                    SubFilePayload { rel_path: rel, name: fname, done: false, transferred: 0, total: sz });
            }

            // 4. Parallel upload — up to 4 concurrent tasks, each with its own SFTP channel
            let transferred_total = Arc::new(AtomicU64::new(0));
            let sem = Arc::new(tokio::sync::Semaphore::new(4));
            let mut join_set: tokio::task::JoinSet<Result<(), String>> = tokio::task::JoinSet::new();

            for ((lpath, rpath), file_size) in files.into_iter().zip(file_sizes) {
                let permit      = sem.clone().acquire_owned().await.map_err(|e| e.to_string())?;
                let ssh         = ssh.clone();
                let app         = app.clone();
                let tid         = tid.clone();
                let trans       = Arc::clone(&transferred_total);
                let rroot       = remote_root.clone();
                let cs          = Arc::clone(&cs);
                let paused_t    = Arc::clone(&paused);
                let notify_t    = Arc::clone(&notify);
                let ps_t        = Arc::clone(&ps);
                let sem_t       = Arc::clone(&sem);
                let pmt         = preserve_mtime;

                join_set.spawn(async move {
                    let mut permit_opt = Some(permit);
                    let sftp = ssh.open_sftp().await.map_err(|e| e.to_string())?;
                    let fname = Path::new(&rpath).file_name()
                        .map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    let rel = rpath.strip_prefix(&format!("{rroot}/")).unwrap_or(&rpath).to_string();
                    let file_key = format!("{tid}:{rel}");
                    let (fp, fn_) = ps_t.register(&file_key);

                    // Conflict check
                    let effective_rpath = {
                        let remote_existing_meta = sftp.session.metadata(&rpath).await.ok();
                        let remote_existing = remote_existing_meta.as_ref().and_then(|m| m.size);
                        if let Some(existing_size) = remote_existing {
                            let existing_modified = remote_existing_meta.as_ref()
                                .and_then(|m| m.mtime).map(|t| t as i64);
                            let incoming_modified = tokio::fs::metadata(&lpath).await.ok()
                                .and_then(|m| m.modified().ok()).and_then(mtime_secs);
                            let req_id = Uuid::new_v4().to_string();
                            let (tx, rx) = tokio::sync::oneshot::channel();
                            cs.insert(req_id.clone(), tx);
                            let _ = app.emit(&format!("sftp://conflict/{tid}"), ConflictPayload {
                                request_id: req_id, rel_path: rel.clone(), name: fname.clone(),
                                is_dir: false, existing_size, incoming_size: file_size,
                                can_resume: false, existing_modified, incoming_modified,
                            });
                            match rx.await.unwrap_or(ConflictAction::Skip) {
                                ConflictAction::Skip => {
                                    let _ = app.emit(&format!("sftp://file/{tid}"), SubFilePayload {
                                        rel_path: rel, name: fname, done: true,
                                        transferred: file_size, total: file_size,
                                    });
                                    trans.fetch_add(file_size, Ordering::Relaxed);
                                    return Ok(());
                                }
                                ConflictAction::Rename =>
                                    find_unique_remote_path(&sftp.session, &rpath).await,
                                _ => rpath.clone(),
                            }
                        } else { rpath.clone() }
                    };

                    let mut lf = tokio::fs::File::open(&lpath).await
                        .map_err(|e| format!("Failed to open {}: {e}", lpath.display()))?;
                    let mut rf = sftp.session.create(&effective_rpath).await
                        .map_err(|e| format!("Failed to create remote file {effective_rpath}: {e}"))?;

                    let mut sub_xfer: u64 = 0;
                    let mut sub_emit = std::time::Instant::now();
                    let mut buf = vec![0u8; 512 * 1024];
                    let result_inner: Result<(), String> = async {
                        loop {
                            use std::sync::atomic::Ordering as Ord2;
                            if fp.load(Ord2::Relaxed) || paused_t.load(Ord2::Relaxed) {
                                drop(permit_opt.take());
                                check_pause_file(&paused_t, &notify_t, &fp, &fn_).await;
                                permit_opt = Some(Arc::clone(&sem_t).acquire_owned().await.map_err(|e| e.to_string())?);
                            }
                            use tokio::io::{AsyncReadExt, AsyncWriteExt};
                            let n = lf.read(&mut buf).await.map_err(|e| e.to_string())?;
                            if n == 0 { break; }
                            rf.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                            sub_xfer += n as u64;
                            trans.fetch_add(n as u64, Ordering::Relaxed);
                            if sub_emit.elapsed().as_millis() >= 200 {
                                let _ = app.emit(&format!("sftp://file/{tid}"),
                                    SubFilePayload { rel_path: rel.clone(), name: fname.clone(),
                                        done: false, transferred: sub_xfer, total: file_size });
                                sub_emit = std::time::Instant::now();
                            }
                        }
                        Ok(())
                    }.await;
                    drop(rf); // close before setstat
                    drop(permit_opt);
                    ps_t.remove(&file_key);
                    result_inner?;
                    // Optionally preserve modification time
                    if pmt {
                        if let Ok(meta) = tokio::fs::metadata(&lpath).await {
                            if let Ok(mtime_sys) = meta.modified() {
                                if let Some(mv) = mtime_secs(mtime_sys) {
                                    use russh_sftp::protocol::FileAttributes;
                                    let attr = FileAttributes {
                                        size: None, uid: None, user: None, gid: None, group: None,
                                        permissions: None,
                                        atime: Some(mv as u32), mtime: Some(mv as u32),
                                    };
                                    let _ = sftp.session.set_metadata(&effective_rpath, attr).await;
                                }
                            }
                        }
                    }
                    let _ = app.emit(&format!("sftp://file/{tid}"),
                        SubFilePayload { rel_path: rel, name: fname, done: true, transferred: sub_xfer, total: file_size });
                    Ok(())
                });
            }

            // 5. Progress ticker
            let ticker = {
                let app2 = app.clone(); let tid2 = tid.clone();
                let done = Arc::clone(&transferred_total);
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        let _ = app2.emit(&format!("sftp://progress/{tid2}"),
                            ProgressPayload { transferred: done.load(Ordering::Relaxed), total });
                    }
                })
            };

            let mut first_err: Option<String> = None;
            while let Some(res) = join_set.join_next().await {
                match res {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => { first_err.get_or_insert(e); }
                    Err(e)     => { first_err.get_or_insert(e.to_string()); }
                }
            }
            ticker.abort();
            if let Some(e) = first_err { return Err(e); }
            Ok(())
        }.await;

        ps.remove(&tid);
        match result {
            Ok(_)  => { let _ = app.emit(&format!("sftp://done/{tid}"),    ()); }
            Err(e) => { let _ = app.emit(&format!("sftp://error/{tid}"), e); }
        }
    });

    Ok(transfer_id)
}

#[tauri::command]
pub async fn sftp_download_dir(
    app:        AppHandle,
    sftp_id:    String,
    remote_dir: String,
    local_base: String,
    sftp_state: State<'_, SftpState>,
    cs:         State<'_, Arc<ConflictState>>,
    ps:         State<'_, Arc<PauseState>>,
) -> Result<String, String> {
    let ssh = get_ssh(&sftp_state, &sftp_id)?;
    let transfer_id = Uuid::new_v4().to_string();
    let tid = transfer_id.clone();
    let cs  = Arc::clone(&*cs);
    let ps  = Arc::clone(&*ps);

    tokio::spawn(async move {
        let (paused, notify) = ps.register(&tid);
        let result: Result<(), String> = async {
            use std::sync::atomic::{AtomicU64, Ordering};

            let dir_name = Path::new(&remote_dir)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "dir".into());
            let local_root = PathBuf::from(&local_base).join(&dir_name);
            // remote_prefix is used to compute relative paths: strip it from each rpath
            let remote_prefix = format!("{}/", remote_dir.trim_end_matches('/'));

            // 1. Walk remote tree with a dedicated SFTP channel
            let sftp_walk = ssh.open_sftp().await.map_err(|e| e.to_string())?;
            // (rpath, file_size, remote_mtime, lpath)
            let mut all_files: Vec<(String, u64, Option<i64>, PathBuf)> = Vec::new();
            let mut all_dirs:  Vec<PathBuf> = vec![local_root.clone()];
            let mut queue: Vec<(String, PathBuf)> = vec![(remote_dir.clone(), local_root.clone())];
            while let Some((rcur, lcur)) = queue.pop() {
                let mut rd = sftp_walk.session.read_dir(&rcur).await
                    .map_err(|e| format!("Failed to list directory {rcur}: {e}"))?;
                for item in &mut rd {
                    let name = item.file_name();
                    if name == "." || name == ".." { continue; }
                    let meta  = item.metadata();
                    let rpath = format!("{}/{}", rcur.trim_end_matches('/'), name);
                    let lpath = lcur.join(&name);
                    if meta.is_dir() {
                        all_dirs.push(lpath.clone());
                        queue.push((rpath, lpath));
                    } else {
                        let remote_mtime = meta.mtime.map(|t| t as i64);
                        all_files.push((rpath, meta.size.unwrap_or(0), remote_mtime, lpath));
                    }
                }
            }

            let total: u64 = all_files.iter().map(|(_, s, _, _)| *s).sum();

            // 2. Create local dirs
            for d in &all_dirs {
                tokio::fs::create_dir_all(d).await.map_err(|e| e.to_string())?;
            }

            // 3. Announce all files upfront (pending rows in UI)
            for (rpath, sz, _, _) in &all_files {
                let fname = Path::new(rpath).file_name()
                    .map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let rel = rpath.strip_prefix(&remote_prefix).unwrap_or(rpath).to_string();
                let _ = app.emit(&format!("sftp://file/{tid}"),
                    SubFilePayload { rel_path: rel, name: fname, done: false, transferred: 0, total: *sz });
            }

            // 4. Parallel download — up to 4 concurrent tasks
            let transferred_total = Arc::new(AtomicU64::new(0));
            let sem = Arc::new(tokio::sync::Semaphore::new(4));
            let mut join_set: tokio::task::JoinSet<Result<(), String>> = tokio::task::JoinSet::new();

            for (rpath, file_size, remote_mtime, lpath) in all_files {
                let permit   = sem.clone().acquire_owned().await.map_err(|e| e.to_string())?;
                let ssh      = ssh.clone();
                let app      = app.clone();
                let tid      = tid.clone();
                let trans    = Arc::clone(&transferred_total);
                let rprefix  = remote_prefix.clone();
                let cs       = Arc::clone(&cs);
                let paused_t = Arc::clone(&paused);
                let notify_t = Arc::clone(&notify);
                let ps_t     = Arc::clone(&ps);
                let sem_t    = Arc::clone(&sem);

                join_set.spawn(async move {
                    let mut permit_opt = Some(permit);
                    let sftp = ssh.open_sftp().await.map_err(|e| e.to_string())?;
                    let fname = Path::new(&rpath).file_name()
                        .map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    let rel = rpath.strip_prefix(&rprefix).unwrap_or(&rpath).to_string();
                    let file_key = format!("{tid}:{rel}");
                    let (fp, fn_) = ps_t.register(&file_key);

                    // Conflict check
                    let (effective_lpath, resume_from) = {
                        let local_existing_meta = tokio::fs::metadata(&lpath).await.ok();
                        let local_existing = local_existing_meta.as_ref().map(|m| m.len());
                        if let Some(existing_size) = local_existing {
                            let existing_modified = local_existing_meta.as_ref()
                                .and_then(|m| m.modified().ok()).and_then(mtime_secs);
                            let req_id = Uuid::new_v4().to_string();
                            let (tx, rx) = tokio::sync::oneshot::channel();
                            cs.insert(req_id.clone(), tx);
                            let _ = app.emit(&format!("sftp://conflict/{tid}"), ConflictPayload {
                                request_id: req_id, rel_path: rel.clone(), name: fname.clone(),
                                is_dir: false, existing_size, incoming_size: file_size,
                                can_resume: existing_size < file_size,
                                existing_modified, incoming_modified: remote_mtime,
                            });
                            match rx.await.unwrap_or(ConflictAction::Skip) {
                                ConflictAction::Skip => {
                                    let _ = app.emit(&format!("sftp://file/{tid}"), SubFilePayload {
                                        rel_path: rel, name: fname, done: true,
                                        transferred: file_size, total: file_size,
                                    });
                                    trans.fetch_add(file_size, Ordering::Relaxed);
                                    return Ok(());
                                }
                                ConflictAction::Rename => (find_unique_local_path(&lpath), 0u64),
                                ConflictAction::Resume => (lpath.clone(), existing_size.min(file_size)),
                                ConflictAction::Overwrite => (lpath.clone(), 0u64),
                            }
                        } else { (lpath.clone(), 0u64) }
                    };

                    let mut rf = sftp.session.open(&rpath).await
                        .map_err(|e| format!("Failed to open remote file {rpath}: {e}"))?;
                    if resume_from > 0 {
                        use tokio::io::AsyncSeekExt;
                        rf.seek(std::io::SeekFrom::Start(resume_from)).await
                            .map_err(|e| format!("Failed to seek remote file: {e}"))?;
                    }
                    let mut lf = if resume_from > 0 {
                        tokio::fs::OpenOptions::new().append(true).open(&effective_lpath).await
                            .map_err(|e| format!("Failed to open local file: {e}"))?
                    } else {
                        tokio::fs::File::create(&effective_lpath).await
                            .map_err(|e| format!("Failed to create local file: {e}"))?
                    };

                    let mut sub_xfer: u64 = resume_from;
                    let mut sub_emit = std::time::Instant::now();
                    let mut buf = vec![0u8; 512 * 1024];
                    let result_inner: Result<(), String> = async {
                        loop {
                            use std::sync::atomic::Ordering as Ord2;
                            if fp.load(Ord2::Relaxed) || paused_t.load(Ord2::Relaxed) {
                                drop(permit_opt.take());
                                check_pause_file(&paused_t, &notify_t, &fp, &fn_).await;
                                permit_opt = Some(Arc::clone(&sem_t).acquire_owned().await.map_err(|e| e.to_string())?);
                            }
                            use tokio::io::{AsyncReadExt, AsyncWriteExt};
                            let n = rf.read(&mut buf).await.map_err(|e| e.to_string())?;
                            if n == 0 { break; }
                            lf.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
                            sub_xfer += n as u64;
                            trans.fetch_add(n as u64, Ordering::Relaxed);
                            if sub_emit.elapsed().as_millis() >= 200 {
                                let _ = app.emit(&format!("sftp://file/{tid}"),
                                    SubFilePayload { rel_path: rel.clone(), name: fname.clone(),
                                        done: false, transferred: sub_xfer, total: file_size });
                                sub_emit = std::time::Instant::now();
                            }
                        }
                        Ok(())
                    }.await;
                    drop(permit_opt);
                    ps_t.remove(&file_key);
                    result_inner?;
                    let _ = app.emit(&format!("sftp://file/{tid}"),
                        SubFilePayload { rel_path: rel, name: fname, done: true, transferred: sub_xfer, total: file_size });
                    Ok(())
                });
            }

            // 5. Progress ticker
            let ticker = {
                let app2 = app.clone(); let tid2 = tid.clone();
                let done = Arc::clone(&transferred_total);
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        let _ = app2.emit(&format!("sftp://progress/{tid2}"),
                            ProgressPayload { transferred: done.load(Ordering::Relaxed), total });
                    }
                })
            };

            let mut first_err: Option<String> = None;
            while let Some(res) = join_set.join_next().await {
                match res {
                    Ok(Ok(())) => {}
                    Ok(Err(e)) => { first_err.get_or_insert(e); }
                    Err(e)     => { first_err.get_or_insert(e.to_string()); }
                }
            }
            ticker.abort();

            // Windows: restore ACL inheritance on the created directory tree so the user
            // can delete/rename the downloaded folder without an access-denied prompt.
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("icacls")
                    .args([local_root.to_string_lossy().as_ref(), "/reset", "/T", "/C", "/Q"])
                    .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                    .output();
            }

            if let Some(e) = first_err { return Err(e); }
            Ok(())
        }.await;

        ps.remove(&tid);
        match result {
            Ok(_)  => { let _ = app.emit(&format!("sftp://done/{tid}"),    ()); }
            Err(e) => { let _ = app.emit(&format!("sftp://error/{tid}"), e); }
        }
    });

    Ok(transfer_id)
}

// ---------------------------------------------------------------------------
// Command: Open standalone SFTP connection (no existing SSH terminal needed)
// ---------------------------------------------------------------------------

/// Parameters mirroring the frontend Host shape (only fields needed for SSH auth).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpConnectParams {
    pub host:          String,
    pub port:          u16,
    pub username:      String,
    pub auth_type:     Option<String>,
    /// Password, or (for PublicKey auth) the selected key id; empty = auto-select.
    pub password:      Option<String>,
    pub proxy_type:    Option<String>,
    pub proxy_host:    Option<String>,
    pub proxy_port:    Option<u16>,
    pub proxy_user:    Option<String>,
    pub proxy_pass:    Option<String>,
    pub jump_host_ids: Option<Vec<String>>,
}

#[tauri::command]
pub async fn sftp_open_host(
    params:     SftpConnectParams,
    app:        AppHandle,
    app_state:  State<'_, AppState>,
    kbi_state:  State<'_, crate::ssh_auth::KbiState>,
    sftp_state: State<'_, SftpState>,
) -> Result<SftpOpenResult, String> {
    let mut config = sftp_build_config(&params);

    // Resolve main-host public keys from the key manager (empty id = auto-select).
    if params.auth_type.as_deref() == Some("PublicKey") {
        let key_mgr = KeyManager::new(&app_state.store, &app_state.owner);
        config.auth = AuthMethod::PublicKey {
            keys: crate::ssh_auth::resolve_pubkeys(&key_mgr, params.password.as_deref()),
        };
    }

    // Resolve jump host chain (mirrors ssh_terminal.rs logic exactly)
    if let Some(ids) = &params.jump_host_ids {
        if !ids.is_empty() {
            let host_mgr = HostManager::new(&app_state.store, &app_state.owner);
            let key_mgr  = KeyManager::new(&app_state.store, &app_state.owner);
            let mut jump_configs: Vec<Box<SshConfig>> = Vec::new();
            for id in ids {
                let host = host_mgr.get(id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("jump host not found: {id}"))?;
                let pem = if host.authentication.auth_type == AuthenticationType::PublicKey {
                    key_mgr.get(&host.authentication.password)
                        .ok().flatten()
                        .map(|kp| String::from_utf8_lossy(
                            &base64::engine::general_purpose::STANDARD
                                .decode(&kp.private_key)
                                .unwrap_or_default()
                        ).into_owned())
                } else {
                    None
                };
                jump_configs.push(Box::new(SshConfig::from_host(&host, pem)));
            }
            config.jump_host_configs = jump_configs;
        }
    }

    let responder = kbi_state.make_responder(app.clone());
    let ssh = ssh_lib::connect_with(&config, Some(responder))
        .await
        .map_err(|e| e.to_string())?;
    let sftp_channel = ssh.open_sftp().await.map_err(|e| e.to_string())?;

    // Ask the server for the canonical path of "." — this is the home directory.
    let home_dir = sftp_channel
        .session
        .canonicalize(".")
        .await
        .unwrap_or_else(|_| "/".to_string());

    let sftp_arc = Arc::new(AsyncMutex::new(sftp_channel));
    let sftp_id  = Uuid::new_v4().to_string();
    let watcher  = spawn_sftp_watcher(Arc::clone(&sftp_arc), app, sftp_id.clone());
    sftp_state.sessions.lock().unwrap().insert(
        sftp_id.clone(),
        ActiveSftp { sftp: sftp_arc, ssh, watcher },
    );
    Ok(SftpOpenResult { sftp_id, home_dir })
}

fn sftp_build_config(p: &SftpConnectParams) -> SshConfig {
    let auth = match p.auth_type.as_deref().unwrap_or("Password") {
        // Keys are resolved from the key manager by `sftp_open_host` and
        // injected afterwards; start with an empty candidate list here.
        "PublicKey" => AuthMethod::PublicKey { keys: Vec::new() },
        "SshAgent" => AuthMethod::SshAgent { socket_path: None },
        "No"  => AuthMethod::None,
        _     => AuthMethod::Password(p.password.clone().unwrap_or_default()),
    };

    let proxy = match p.proxy_type.as_deref().unwrap_or("NO") {
        "HTTP" => ProxyConfig::Http {
            host: p.proxy_host.clone().unwrap_or_default(),
            port: p.proxy_port.unwrap_or(8080),
            username: p.proxy_user.clone().filter(|s| !s.is_empty()),
            password: p.proxy_pass.clone().filter(|s| !s.is_empty()),
        },
        "SOCKS5" => ProxyConfig::Socks5 {
            host: p.proxy_host.clone().unwrap_or_default(),
            port: p.proxy_port.unwrap_or(1080),
            username: p.proxy_user.clone().filter(|s| !s.is_empty()),
            password: p.proxy_pass.clone().filter(|s| !s.is_empty()),
        },
        _ => ProxyConfig::None,
    };

    SshConfig {
        host: p.host.clone(),
        port: p.port,
        username: p.username.clone(),
        auth,
        proxy,
        jump_host_configs: vec![],
        heartbeat: Duration::from_secs(30),
        timeout: Duration::from_secs(30),
        env: HashMap::new(),
        term: "xterm-256color".to_string(),
        x11_forwarding: None,
        forward_agent: false,
    }
}

// ---------------------------------------------------------------------------
// Commands: Local filesystem
// ---------------------------------------------------------------------------

/// Returns available drive roots (Windows: ["C:\\", "D:\\", ...], Unix: ["/"]).
#[tauri::command]
pub fn local_list_drives() -> Vec<String> {
    #[cfg(windows)]
    {
        let mut drives = Vec::new();
        for c in b'A'..=b'Z' {
            let path = format!("{}:\\", c as char);
            if std::path::Path::new(&path).exists() {
                drives.push(path);
            }
        }
        drives
    }
    #[cfg(not(windows))]
    {
        vec!["/".to_string()]
    }
}

#[tauri::command]
pub fn local_home_dir() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/".to_string())
}

#[tauri::command]
pub async fn local_list_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let base = PathBuf::from(&path);
    let mut rd = tokio::fs::read_dir(&base).await.map_err(|e| e.to_string())?;
    let mut entries: Vec<FileEntry> = Vec::new();

    while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
        let meta = entry.metadata().await.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let full = base.join(&name).to_string_lossy().into_owned();

        let is_dir = meta.is_dir();
        let is_file = meta.is_file();
        let is_symlink = meta.is_symlink();
        let size = if is_file { meta.len() } else { 0 };
        let modified = meta.modified()
            .map(unix_ms)
            .unwrap_or(0);

        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::PermissionsExt;
            perms_string(meta.permissions().mode())
        };
        #[cfg(not(unix))]
        let permissions = String::new();

        #[cfg(unix)]
        let owner = {
            use std::os::unix::fs::MetadataExt;
            meta.uid().to_string()
        };
        #[cfg(not(unix))]
        let owner = String::new();

        entries.push(FileEntry {
            name,
            path: full,
            is_dir,
            is_file,
            is_symlink,
            size,
            modified,
            permissions,
            owner,
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

// ---------------------------------------------------------------------------
// Commands: SSH exec via existing SFTP session handle
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sftp_exec(
    sftp_id: String,
    command: String,
    sftp_state: State<'_, SftpState>,
) -> Result<String, String> {
    let ssh = sftp_state
        .sessions.lock().unwrap()
        .get(&sftp_id)
        .map(|a| a.ssh.clone())
        .ok_or_else(|| format!("SFTP session not found: {sftp_id}"))?;
    let result = ssh.exec_cmd(&command).await.map_err(|e| e.to_string())?;
    if result.exit_code != 0 {
        return Err(format!("exit {}: {}", result.exit_code, result.stdout.trim()));
    }
    Ok(result.stdout)
}

/// Download a remote file to OS temp dir and open it with the system default app (or a custom command).
#[tauri::command]
pub async fn sftp_edit(
    sftp_id:      String,
    remote_path:  String,
    edit_command: Option<String>,
    sftp_state:   State<'_, SftpState>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_state, &sftp_id)?;
    let data = { let g = sftp.lock().await; g.session.read(&remote_path).await.map_err(|e| e.to_string())? };

    let raw_name = Path::new(&remote_path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "remote_file".into());
    // Windows: colons are illegal in file names
    #[cfg(windows)]
    let name = raw_name.replace(':', "-");
    #[cfg(not(windows))]
    let name = raw_name;

    let local = std::env::temp_dir().join(&name);
    tokio::fs::write(&local, &data).await.map_err(|e| e.to_string())?;
    let local_str = local.to_string_lossy().into_owned();

    if let Some(cmd) = edit_command.filter(|c| !c.trim().is_empty()) {
        // Replace {0} placeholder with local file path; fall back to appending the path
        let formatted = if cmd.contains("{0}") {
            cmd.replace("{0}", &local_str)
        } else {
            format!("{cmd} {local_str}")
        };
        // Parse the command string into program + args
        let mut parts = formatted.splitn(2, ' ');
        let prog = parts.next().unwrap_or("");
        let args: Vec<&str> = parts.next().map(|s| s.split_whitespace().collect()).unwrap_or_default();
        std::process::Command::new(prog).args(args).spawn()
            .map_err(|e| format!("Failed to start editor '{formatted}': {e}"))?;
        Ok(())
    } else {
        local_open_file(local_str)
    }
}

// ---------------------------------------------------------------------------
// Commands: Local file operations (rename / delete / mkdir / create / open)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn local_rename(src: String, dst: String) -> Result<(), String> {
    tokio::fs::rename(&src, &dst).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn local_delete(path: String, is_dir: bool) -> Result<(), String> {
    if is_dir {
        tokio::fs::remove_dir_all(&path).await.map_err(|e| e.to_string())
    } else {
        tokio::fs::remove_file(&path).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<(), String> {
    tokio::fs::create_dir(&path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn local_create_file(path: String) -> Result<(), String> {
    tokio::fs::File::create(&path).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn local_open_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let win_path = path.replace('/', "\\");
        std::process::Command::new("explorer.exe")
            .arg(format!("/select,{win_path}"))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/".to_string());
        std::process::Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Open a file (not folder) with the system default application.
#[tauri::command]
pub fn local_open_file(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let win_path = path.replace('/', "\\");
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &win_path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Copy a single file from src to dst.
#[tauri::command]
pub async fn local_copy_file(src: String, dst: String) -> Result<(), String> {
    tokio::fs::copy(&src, &dst).await.map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands: stat local paths (for drag-drop / paste uploads)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStatEntry {
    pub path:   String,
    pub name:   String,
    pub is_dir: bool,
    pub size:   u64,
}

#[tauri::command]
pub fn local_stat_paths(paths: Vec<String>) -> Vec<LocalStatEntry> {
    paths.into_iter().filter_map(|p| {
        let meta = std::fs::metadata(&p).ok()?;
        let name = std::path::Path::new(&p)
            .file_name()?.to_string_lossy().into_owned();
        Some(LocalStatEntry {
            path:   p,
            name,
            is_dir: meta.is_dir(),
            size:   meta.len(),
        })
    }).collect()
}

// ---------------------------------------------------------------------------
// Commands: read clipboard file paths (Windows CF_HDROP)
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn local_clipboard_files() -> Result<Vec<String>, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use winapi::um::winuser::{OpenClipboard, CloseClipboard, GetClipboardData};
    use winapi::um::shellapi::{DragQueryFileW, HDROP};
    const CF_HDROP: winapi::shared::minwindef::UINT = 15;
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("cannot open clipboard".into());
        }
        let h = GetClipboardData(CF_HDROP);
        if h.is_null() {
            CloseClipboard();
            return Ok(vec![]);
        }
        let hdrop = h as HDROP;
        let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
        let mut out = Vec::with_capacity(count as usize);
        for i in 0..count {
            let len = DragQueryFileW(hdrop, i, std::ptr::null_mut(), 0) as usize;
            let mut buf = vec![0u16; len + 1];
            DragQueryFileW(hdrop, i, buf.as_mut_ptr(),
                (len + 1) as winapi::shared::minwindef::UINT);
            out.push(OsString::from_wide(&buf[..len]).to_string_lossy().into_owned());
        }
        CloseClipboard();
        Ok(out)
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn local_clipboard_files() -> Result<Vec<String>, String> {
    Ok(vec![])
}

// ---------------------------------------------------------------------------
// Commands: SFTP create file / chmod
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sftp_create_file(
    sftp_id: String,
    path: String,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    let sftp = get_sftp(&sftp_state, &sftp_id)?;
    let guard = sftp.lock().await;
    guard.session.write(&path, &[]).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_chmod(
    sftp_id: String,
    path: String,
    mode: u32,
    sftp_state: State<'_, SftpState>,
) -> Result<(), String> {
    use russh_sftp::protocol::FileAttributes;
    let sftp = get_sftp(&sftp_state, &sftp_id)?;
    let guard = sftp.lock().await;
    let meta = FileAttributes {
        size: None, uid: None, user: None, gid: None, group: None,
        permissions: Some(mode),
        atime: None, mtime: None,
    };
    guard.session.set_metadata(&path, meta).await.map_err(|e| e.to_string())
}
