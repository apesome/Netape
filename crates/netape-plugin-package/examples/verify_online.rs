//! Verify the public catalog and stage its packages without executing plugins.
use netape_plugin_package::*;
use std::sync::atomic::AtomicBool;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: verify_online TRUST_JSON TARGET".into());
    }
    let trust: TrustConfig =
        serde_json::from_slice(&std::fs::read(&args[1]).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let temporary = tempfile::tempdir().map_err(|e| e.to_string())?;
    let load = load_catalog(&trust, &temporary.path().join("cache.json")).await?;
    if load.from_cache || load.warning.is_some() {
        return Err("Expected a fresh verified online catalog".into());
    }
    println!("Fetched and verified live catalog: {}", trust.index_url);
    let mut checked = 0;
    for entry in load.catalog.plugins {
        let Some(artifact) = entry.platforms.get(&args[2]) else {
            continue;
        };
        let archive = temporary
            .path()
            .join(format!("{}.archive", entry.manifest.id));
        let cancel = AtomicBool::new(false);
        download_artifact(artifact, &trust, &archive, &cancel, |_, _| {}).await?;
        let plugins = temporary.path().join(&entry.manifest.id);
        std::fs::create_dir(&plugins).map_err(|e| e.to_string())?;
        let staging = tempfile::tempdir_in(&plugins).map_err(|e| e.to_string())?;
        extract_archive(&archive, &artifact.archive, staging.path(), &cancel)?;
        validate_package(staging.path(), Some(&entry.manifest))?;
        commit_staged(&plugins, staging.path(), &entry.manifest)?;
        checked += 1;
        println!(
            "Downloaded, verified and staged {} {} (not executed)",
            entry.manifest.id, entry.manifest.version
        );
    }
    if checked == 0 {
        return Err("No published artifact matches the requested target".into());
    }
    Ok(())
}
