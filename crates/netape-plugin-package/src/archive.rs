use crate::{
    check_cancel, hex_decode, validate_relative, Artifact, Result, MAX_ENTRIES, MAX_EXPANDED,
};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::AtomicBool;

pub fn verify_artifact(path: &Path, artifact: &Artifact) -> Result<()> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != artifact.size {
        return Err("Plugin archive size mismatch".into());
    }
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    if hasher.finalize().as_slice() != hex_decode::<32>(&artifact.sha256)? {
        return Err("Plugin archive SHA-256 mismatch".into());
    }
    Ok(())
}

fn prepare_entry(
    root: &Path,
    raw: &str,
    directory: bool,
    seen: &mut HashSet<String>,
) -> Result<std::path::PathBuf> {
    let name = if directory {
        raw.strip_suffix('/').unwrap_or(raw)
    } else {
        raw
    };
    validate_relative(name)?;
    // Case folding also avoids aliases when extracting a portable package on Windows/macOS.
    if !seen.insert(name.to_ascii_lowercase()) || seen.len() > MAX_ENTRIES {
        return Err("Duplicate paths or too many archive entries".into());
    }
    let dest = root.join(name);
    if directory {
        std::fs::create_dir_all(&dest)
    } else {
        std::fs::create_dir_all(dest.parent().unwrap())
    }
    .map_err(|e| e.to_string())?;
    Ok(dest)
}

fn write_entry(
    reader: &mut impl Read,
    dest: &Path,
    size: u64,
    total: &mut u64,
    cancel: &AtomicBool,
) -> Result<()> {
    *total = total
        .checked_add(size)
        .filter(|value| *value <= MAX_EXPANDED)
        .ok_or("Plugin expanded size limit exceeded")?;
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .map_err(|e| e.to_string())?;
    let mut remaining = size;
    let mut buffer = [0; 65536];
    while remaining > 0 {
        check_cancel(cancel)?;
        let count = (remaining as usize).min(buffer.len());
        let n = reader
            .read(&mut buffer[..count])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("Truncated plugin archive entry".into());
        }
        out.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        remaining -= n as u64;
    }
    // Force the decompressor to validate the entry's end/CRC without accepting excess data.
    if reader.read(&mut buffer[..1]).map_err(|e| e.to_string())? != 0 {
        return Err("Archive entry exceeds declared size".into());
    }
    out.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

/// Extract into a new empty directory. Links, devices, path aliases and executable permission bits are never trusted.
pub fn extract_archive(
    archive: &Path,
    format: &str,
    root: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    if std::fs::read_dir(root)
        .map_err(|e| e.to_string())?
        .next()
        .is_some()
    {
        return Err("Extraction directory must be empty".into());
    }
    let mut seen = HashSet::new();
    let mut total = 0;
    match format {
        "zip" => {
            let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if zip.len() > MAX_ENTRIES {
                return Err("Too many archive entries".into());
            }
            for i in 0..zip.len() {
                check_cancel(cancel)?;
                let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
                let directory = entry.is_dir();
                let file_type = entry.unix_mode().unwrap_or(0) & 0o170000;
                if !matches!(file_type, 0 | 0o100000 | 0o040000)
                    || (file_type == 0o040000 && !directory)
                {
                    return Err("Links and special files are not allowed in plugin archives".into());
                }
                let dest = prepare_entry(root, entry.name(), directory, &mut seen)?;
                let size = entry.size();
                if directory {
                    if size != 0 {
                        return Err("Invalid archive directory size".into());
                    }
                } else {
                    write_entry(&mut entry, &dest, size, &mut total, cancel)?;
                }
            }
        }
        "tar.gz" => {
            let decoder =
                flate2::read::GzDecoder::new(File::open(archive).map_err(|e| e.to_string())?);
            let mut tar = tar::Archive::new(decoder);
            for entry in tar.entries().map_err(|e| e.to_string())? {
                check_cancel(cancel)?;
                let mut entry = entry.map_err(|e| e.to_string())?;
                let kind = entry.header().entry_type();
                if !kind.is_file() && !kind.is_dir() {
                    return Err("Links and special files are not allowed in plugin archives".into());
                }
                let name = entry
                    .path()
                    .map_err(|e| e.to_string())?
                    .to_str()
                    .ok_or("Non-UTF8 archive path")?
                    .to_string();
                let dest = prepare_entry(root, &name, kind.is_dir(), &mut seen)?;
                let size = entry.size();
                if kind.is_dir() {
                    if size != 0 {
                        return Err("Invalid archive directory size".into());
                    }
                } else {
                    write_entry(&mut entry, &dest, size, &mut total, cancel)?;
                }
            }
            // Read the gzip trailer to detect corruption, with a bounded tail.
            let mut decoder = tar.into_inner();
            let mut tail = Vec::new();
            std::io::Read::by_ref(&mut decoder)
                .take(1024 * 1024)
                .read_to_end(&mut tail)
                .map_err(|e| e.to_string())?;
            if tail.len() >= 1024 * 1024 || tail.iter().any(|byte| *byte != 0) {
                return Err("Unexpected archive trailing data".into());
            }
        }
        _ => return Err("Unsupported plugin archive format".into()),
    }
    if seen.is_empty() {
        return Err("Empty plugin archive".into());
    }
    Ok(())
}
