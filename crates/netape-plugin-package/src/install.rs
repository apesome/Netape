use crate::{
    check_cancel, validate_relative, Manifest, Result, MAX_ENTRIES, MAX_EXPANDED, MAX_MANIFEST,
};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::AtomicBool;

pub fn read_manifest(root: &Path) -> Result<Manifest> {
    let path = root.join("plugin.json");
    let meta = fs::symlink_metadata(&path).map_err(|_| "Missing plugin.json")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_MANIFEST {
        return Err("Invalid plugin.json file".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("Oversized plugin manifest".into());
    }
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid plugin.json: {e}"))?;
    manifest.validate()?;
    Ok(manifest)
}

pub fn validate_package(root: &Path, expected: Option<&Manifest>) -> Result<Manifest> {
    if root.join("uninstalled").exists() {
        return Err("Package contains a reserved uninstall marker".into());
    }
    let manifest = read_manifest(root)?;
    if let Some(expected) = expected {
        if &manifest != expected {
            return Err("Package manifest does not match the signed catalog".into());
        }
    }
    let bin = root.join(manifest.executable());
    let meta = fs::symlink_metadata(&bin).map_err(|_| "Plugin executable is missing")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() == 0 {
        return Err("Invalid plugin executable".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Only the named executable gets execute bits; never restore setuid or world-writable archive permissions.
        fs::set_permissions(bin, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(manifest)
}

/// Copy a local folder into a fresh staging directory using the same path and expansion limits as online packages.
pub fn copy_local(src: &Path, dst: &Path, cancel: &AtomicBool) -> Result<()> {
    fn walk(
        src: &Path,
        dst: &Path,
        rel: &str,
        count: &mut usize,
        size: &mut u64,
        cancel: &AtomicBool,
    ) -> Result<()> {
        for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
            check_cancel(cancel)?;
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "Non-UTF8 plugin filename")?;
            let relative = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            validate_relative(&relative)?;
            *count += 1;
            if *count > MAX_ENTRIES {
                return Err("Too many plugin files".into());
            }
            let meta = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
            if meta.file_type().is_symlink() {
                return Err("Plugin links are not supported".into());
            }
            let dest = dst.join(&name);
            if meta.is_dir() {
                fs::create_dir(&dest).map_err(|e| e.to_string())?;
                walk(&entry.path(), &dest, &relative, count, size, cancel)?;
            } else if meta.is_file() {
                *size = size
                    .checked_add(meta.len())
                    .filter(|value| *value <= MAX_EXPANDED)
                    .ok_or("Plugin size limit exceeded")?;
                let mut input = fs::File::open(entry.path())
                    .map_err(|e| e.to_string())?
                    .take(meta.len() + 1);
                let mut output = fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(dest)
                    .map_err(|e| e.to_string())?;
                let copied = std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
                if copied != meta.len() {
                    return Err("Plugin file changed during installation".into());
                }
            } else {
                return Err("Special plugin files are not supported".into());
            }
        }
        Ok(())
    }
    if fs::symlink_metadata(src)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Plugin directory links are not supported".into());
    }
    if fs::read_dir(dst)
        .map_err(|e| e.to_string())?
        .next()
        .is_some()
    {
        return Err("Staging directory must be empty".into());
    }
    walk(src, dst, "", &mut 0, &mut 0, cancel)
}

/// Replace within one filesystem. The previous installation is never deleted before the new directory is ready.
/// The caller must serialize mutations and prevent sidecar processes starting during this commit.
pub fn commit_staged(root: &Path, staged: &Path, manifest: &Manifest) -> Result<()> {
    manifest.validate()?;
    validate_package(staged, Some(manifest))?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(root)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Plugin root must not be a link".into());
    }
    let destination = root.join(&manifest.id);
    let backup = root.join(format!(".backup-{}", manifest.id));
    if backup.exists() {
        return Err("A previous plugin backup needs recovery before installation".into());
    }
    let exists = fs::symlink_metadata(&destination).is_ok();
    if exists {
        let meta = fs::symlink_metadata(&destination).map_err(|e| e.to_string())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("Existing plugin directory is not safe to replace".into());
        }
        fs::rename(&destination, &backup).map_err(|e| {
            format!("Cannot move existing plugin; close its connections first: {e}")
        })?;
    }
    if let Err(error) = fs::rename(staged, &destination) {
        if exists {
            fs::rename(&backup, &destination).map_err(|restore| {
                format!(
                    "Installation failed ({error}); restore {} manually: {restore}",
                    backup.display()
                )
            })?;
        }
        return Err(format!(
            "Plugin installation failed; previous version preserved: {error}"
        ));
    }
    if exists {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}
