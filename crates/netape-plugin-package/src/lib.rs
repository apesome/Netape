mod archive;
mod catalog;
mod install;
mod network;

pub use archive::{extract_archive, verify_artifact};
pub use catalog::*;
pub use install::{commit_staged, copy_local, read_manifest, validate_package};
pub use network::{download_artifact, load_catalog, CatalogLoad};

pub const MAX_ARCHIVE: u64 = 128 * 1024 * 1024;
pub const MAX_EXPANDED: u64 = 512 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 2048;
pub const MAX_MANIFEST: u64 = 64 * 1024;

pub type Result<T> = std::result::Result<T, String>;

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn check_cancel(cancel: &std::sync::atomic::AtomicBool) -> Result<()> {
    if cancel.load(std::sync::atomic::Ordering::Relaxed) {
        Err("Plugin installation cancelled".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests;
