use crate::plugin::{catalog_dir, install_from_dir, plugins_dir, PluginManager};
use netape_plugin_package::{
    check_cancel, extract_archive, load_catalog, newer, read_manifest, validate_id,
    validate_package, Catalog, CatalogEntry, Manifest, TrustConfig,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};

fn trust() -> Result<TrustConfig, String> {
    serde_json::from_str(include_str!("../../config/plugin-market.json")).map_err(|e| e.to_string())
}
const TARGET: &str = env!("NETAPE_BUILD_TARGET");
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Default)]
pub struct MarketplaceState {
    catalog: Mutex<Option<Catalog>>,
    refresh: tokio::sync::Mutex<()>,
    job: Mutex<Option<Job>>,
}

struct Job {
    progress: InstallProgress,
    cancel: Arc<AtomicBool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    id: String,
    request_id: String,
    phase: String,
    received: u64,
    total: u64,
}

struct Reservation<'a>(&'a MarketplaceState);
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        *self.0.job.lock().unwrap() = None;
    }
}

fn progress(app: &AppHandle, state: &MarketplaceState, phase: &str, received: u64, total: u64) {
    if let Some(job) = state.job.lock().unwrap().as_mut() {
        job.progress.phase = phase.into();
        job.progress.received = received;
        job.progress.total = total;
        let _ = app.emit("plugins://install-progress", job.progress.clone());
    }
}

fn begin_commit(app: &AppHandle, state: &MarketplaceState) -> Result<(), String> {
    let mut jobs = state.job.lock().unwrap();
    let job = jobs.as_mut().ok_or("Plugin task no longer exists")?;
    check_cancel(&job.cancel)?;
    job.progress.phase = "installing".into();
    let _ = app.emit("plugins://install-progress", job.progress.clone());
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketEntry {
    #[serde(flatten)]
    manifest: Manifest,
    source: String,
    installed: bool,
    installed_version: Option<String>,
    update_available: bool,
    compatible: bool,
    unavailable_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    entries: Vec<MarketEntry>,
    target: String,
    from_cache: bool,
    warning: Option<String>,
    active_install: Option<InstallProgress>,
}

fn local_entries() -> Vec<Manifest> {
    let mut entries = Vec::new();
    if let Some(root) = catalog_dir() {
        if let Ok(dirs) = std::fs::read_dir(root) {
            for dir in dirs.flatten() {
                if dir
                    .file_type()
                    .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
                {
                    if let Ok(manifest) = read_manifest(&dir.path()) {
                        if dir.file_name().to_str() == Some(manifest.id.as_str()) {
                            entries.push(manifest);
                        }
                    }
                }
            }
        }
    }
    entries
}

#[tauri::command]
pub async fn plugins_marketplace(
    mgr: State<'_, PluginManager>,
    state: State<'_, MarketplaceState>,
) -> Result<Marketplace, String> {
    let _refresh = state.refresh.lock().await;
    let trust = trust()?;
    let cache = plugins_dir()
        .parent()
        .unwrap()
        .join("plugin-market-cache.json");
    let (remote, from_cache, warning) = match load_catalog(&trust, &cache).await {
        Ok(loaded) => {
            *state.catalog.lock().unwrap() = Some(loaded.catalog.clone());
            (loaded.catalog.plugins, loaded.from_cache, loaded.warning)
        }
        Err(error) => {
            *state.catalog.lock().unwrap() = None;
            (Vec::new(), false, Some(error))
        }
    };
    mgr.rescan();
    let installed = mgr.list();
    let mut entries = BTreeMap::<String, MarketEntry>::new();
    for manifest in local_entries() {
        let compatible = manifest.protocol != "SMB" || cfg!(windows);
        entries.insert(
            manifest.id.clone(),
            MarketEntry {
                manifest,
                source: "local".into(),
                installed: false,
                installed_version: None,
                update_available: false,
                compatible,
                unavailable_reason: (!compatible).then(|| "platform".into()),
            },
        );
    }
    for item in remote {
        let compatible = item.compatible(TARGET, APP_VERSION);
        let reason = if !item.platforms.contains_key(TARGET)
            || (item.manifest.protocol == "SMB" && !cfg!(windows))
        {
            "platform"
        } else {
            "appVersion"
        };
        // A compatible local package remains usable if the remote release has no artifact for this target.
        if !compatible && entries.contains_key(&item.manifest.id) {
            continue;
        }
        entries.insert(
            item.manifest.id.clone(),
            MarketEntry {
                manifest: item.manifest,
                source: "online".into(),
                installed: false,
                installed_version: None,
                update_available: false,
                compatible,
                unavailable_reason: (!compatible).then(|| reason.into()),
            },
        );
    }
    for item in entries.values_mut() {
        if let Some(previous) = installed.iter().find(|p| p.id == item.manifest.id) {
            item.installed = true;
            item.installed_version = Some(previous.version.clone());
            item.update_available = newer(&item.manifest.version, &previous.version);
        }
    }
    let active_install = state
        .job
        .lock()
        .unwrap()
        .as_ref()
        .map(|job| job.progress.clone());
    Ok(Marketplace {
        entries: entries.into_values().collect(),
        target: TARGET.into(),
        from_cache,
        warning,
        active_install,
    })
}

#[tauri::command]
pub fn plugins_install_status(state: State<'_, MarketplaceState>) -> Option<InstallProgress> {
    state
        .job
        .lock()
        .unwrap()
        .as_ref()
        .map(|job| job.progress.clone())
}

#[tauri::command]
pub fn plugins_cancel_install(
    state: State<'_, MarketplaceState>,
    request_id: String,
) -> Result<(), String> {
    let jobs = state.job.lock().unwrap();
    if let Some(job) = jobs
        .as_ref()
        .filter(|job| job.progress.request_id == request_id)
    {
        if job.progress.phase != "installing" {
            job.cancel.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn plugins_install_market(
    app: AppHandle,
    state: State<'_, MarketplaceState>,
    id: String,
    version: String,
    source: String,
    request_id: String,
) -> Result<Manifest, String> {
    validate_id(&id)?;
    uuid::Uuid::parse_str(&request_id).map_err(|_| "Invalid plugin installation request")?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = state.job.lock().unwrap();
        if jobs.is_some() {
            return Err("Another plugin operation is already in progress".into());
        }
        *jobs = Some(Job {
            progress: InstallProgress {
                id: id.clone(),
                request_id,
                phase: "preparing".into(),
                received: 0,
                total: 0,
            },
            cancel: cancel.clone(),
        });
    }
    let _reservation = Reservation(&state);
    if source == "local" {
        let root = catalog_dir().ok_or("Local plugin catalog is unavailable")?;
        let path = root.join(&id);
        let manifest = read_manifest(&path)?;
        if manifest.id != id || manifest.version != version {
            return Err("Local plugin catalog changed; refresh before installing".into());
        }
        check_cancel(&cancel)?;
        begin_commit(&app, &state)?;
        return tauri::async_runtime::spawn_blocking(move || {
            install_from_dir(&app.state::<PluginManager>(), &path)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    if source != "online" {
        return Err("Unknown plugin installation source".into());
    }
    let entry: CatalogEntry = {
        let catalog = state.catalog.lock().unwrap();
        let catalog = catalog
            .as_ref()
            .filter(|catalog| catalog.expires_at > netape_plugin_package::now())
            .ok_or("Refresh the signed plugin catalog before installing")?;
        catalog
            .plugins
            .iter()
            .find(|entry| {
                entry.manifest.id == id
                    && entry.manifest.version == version
                    && entry.compatible(TARGET, APP_VERSION)
            })
            .cloned()
            .ok_or("Plugin version is unavailable for this platform; refresh the marketplace")?
    };
    let artifact = entry.platforms.get(TARGET).unwrap().clone();
    let root = plugins_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let temporary = tempfile::Builder::new()
        .prefix(".download-")
        .tempdir_in(&root)
        .map_err(|e| e.to_string())?;
    let archive = temporary.path().join("package.archive");
    progress(&app, &state, "downloading", 0, artifact.size);
    netape_plugin_package::download_artifact(
        &artifact,
        &trust()?,
        &archive,
        &cancel,
        |received, total| progress(&app, &state, "downloading", received, total),
    )
    .await?;
    progress(&app, &state, "verifying", artifact.size, artifact.size);
    let app_copy = app.clone();
    let cancel_copy = cancel.clone();
    let staged = tauri::async_runtime::spawn_blocking(move || {
        let stage = tempfile::Builder::new()
            .prefix(".stage-")
            .tempdir_in(&root)
            .map_err(|e| e.to_string())?;
        extract_archive(&archive, &artifact.archive, stage.path(), &cancel_copy)?;
        validate_package(stage.path(), Some(&entry.manifest))?;
        check_cancel(&cancel_copy)?;
        Ok::<_, String>((temporary, stage, entry.manifest))
    })
    .await
    .map_err(|e| e.to_string())??;
    check_cancel(&cancel)?;
    begin_commit(&app, &state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (_temporary, stage, manifest) = staged;
        app_copy
            .state::<PluginManager>()
            .replace_staged(stage.path(), &manifest)?;
        Ok(manifest)
    })
    .await
    .map_err(|e| e.to_string())?
}
