//! Verify publisher output without running the plugin binary.
use netape_plugin_package::*;
use std::{path::PathBuf, sync::atomic::AtomicBool};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        return Err("Usage: verify_release TRUST_JSON RELEASE_DIR TARGET".into());
    }
    let trust: TrustConfig =
        serde_json::from_slice(&std::fs::read(&args[1]).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let dir = PathBuf::from(&args[2]);
    let bytes = std::fs::read(dir.join("index.json")).map_err(|e| e.to_string())?;
    let signature: SignatureEnvelope = serde_json::from_slice(
        &std::fs::read(dir.join("index.json.sig")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let catalog = verify_catalog(&bytes, &signature, &trust, now())?;
    for entry in catalog.plugins {
        if let Some(artifact) = entry.platforms.get(&args[3]) {
            let filename = reqwest::Url::parse(&artifact.url)
                .map_err(|e| e.to_string())?
                .path_segments()
                .and_then(|segments| segments.last())
                .ok_or("Missing archive filename")?
                .to_string();
            let path = dir.join(filename);
            verify_artifact(&path, artifact)?;
            let root = tempfile::tempdir().map_err(|e| e.to_string())?;
            let staging = tempfile::tempdir_in(root.path()).map_err(|e| e.to_string())?;
            extract_archive(
                &path,
                &artifact.archive,
                staging.path(),
                &AtomicBool::new(false),
            )?;
            validate_package(staging.path(), Some(&entry.manifest))?;
            commit_staged(root.path(), staging.path(), &entry.manifest)?;
            println!(
                "Verified and staged {} {} for {} (not executed)",
                entry.manifest.id, entry.manifest.version, args[3]
            );
        }
    }
    Ok(())
}
