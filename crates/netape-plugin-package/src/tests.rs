use crate::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Write, sync::atomic::AtomicBool};

fn manifest() -> Manifest {
    Manifest {
        id: "ftp".into(),
        name: "FTP".into(),
        version: "1.1.0".into(),
        kind: "transfer".into(),
        protocol: "FTP".into(),
        bin: "netape-ftp".into(),
        description: "FTP file transfer".into(),
        author: "apesome".into(),
        capabilities: vec!["transfer".into()],
        plugin_api_version: 1,
    }
}
fn artifact() -> Artifact {
    Artifact {
        url: "https://github.com/apesome/Netape/releases/download/plugin-ftp-v1.1.0/ftp.zip".into(),
        archive: "zip".into(),
        size: 10,
        sha256: "00".repeat(32),
    }
}
fn signed_catalog() -> (Vec<u8>, SignatureEnvelope, TrustConfig) {
    let key = SigningKey::from_bytes(&[42; 32]);
    let catalog = Catalog {
        schema_version: 1,
        generated_at: 1000,
        expires_at: 2000,
        plugins: vec![CatalogEntry {
            manifest: manifest(),
            min_app_version: "0.1.0".into(),
            platforms: BTreeMap::from([("test-target".into(), artifact())]),
        }],
    };
    let bytes = serde_json::to_vec(&catalog).unwrap();
    let sig = SignatureEnvelope {
        key_id: "test".into(),
        signature: STANDARD.encode(key.sign(&bytes).to_bytes()),
    };
    let public = key
        .verifying_key()
        .as_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let trust = TrustConfig {
        index_url: "https://github.com/index.json".into(),
        allowed_hosts: vec!["github.com".into()],
        keys: BTreeMap::from([("test".into(), public)]),
    };
    (bytes, sig, trust)
}

#[test]
fn signatures_expiry_target_and_tampering() {
    let (bytes, sig, trust) = signed_catalog();
    let catalog = verify_catalog(&bytes, &sig, &trust, 1500).unwrap();
    assert!(catalog.plugins[0].compatible("test-target", "0.1.0"));
    assert!(!catalog.plugins[0].compatible("different", "0.1.0"));
    assert!(!catalog.plugins[0].compatible("test-target", "0.0.9"));
    let mut modified = bytes.clone();
    modified.push(b' ');
    assert!(verify_catalog(&modified, &sig, &trust, 1500).is_err());
    assert!(verify_catalog(&bytes, &sig, &trust, 2000).is_err());
    let mut unknown = sig.clone();
    unknown.key_id = "other".into();
    assert!(verify_catalog(&bytes, &unknown, &trust, 1500).is_err());
}

#[test]
fn unsafe_paths_urls_identifiers_and_manifests_are_rejected() {
    for path in [
        "../escape",
        "/absolute",
        "C:/drive",
        "a\\b",
        "a/../b",
        "a//b",
        "CON",
        "file.",
        "a:stream",
        "a /file",
    ] {
        assert!(validate_relative(path).is_err(), "{path}");
    }
    for id in ["../ftp", "FTP", "", "con", "a/b", ".staging", "aux"] {
        assert!(validate_id(id).is_err(), "{id}");
    }
    for path in ["plugin.json", "licenses/EchoBird-MIT.txt", "netape-ftp.exe"] {
        validate_relative(path).unwrap();
    }
    let (_, _, trust) = signed_catalog();
    for url in [
        "http://github.com/file",
        "https://evil.test/file",
        "https://github.com.evil.test/file",
        "https://u:p@github.com/file",
        "https://github.com:444/file",
    ] {
        assert!(validate_url(url, &trust).is_err());
    }
    let mut bad = manifest();
    bad.bin = "../run".into();
    assert!(bad.validate().is_err());
    assert!(!newer("1.0.0", "1.1.0"));
    assert!(newer("1.10.0", "1.2.0"));
}

fn zip_file(path: &std::path::Path, entries: &[(&str, &[u8])]) {
    let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    for (name, data) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(data).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn verified_archive_installs_and_corruption_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("test.zip");
    let manifest = manifest();
    let json = serde_json::to_vec(&manifest).unwrap();
    let exe = manifest.executable();
    zip_file(
        &archive,
        &[("plugin.json", &json), (&exe, b"not executed by installer")],
    );
    let bytes = std::fs::read(&archive).unwrap();
    let mut spec = artifact();
    spec.size = bytes.len() as u64;
    spec.sha256 = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    verify_artifact(&archive, &spec).unwrap();
    let stage = tempfile::tempdir_in(tmp.path()).unwrap();
    extract_archive(&archive, "zip", stage.path(), &AtomicBool::new(false)).unwrap();
    validate_package(stage.path(), Some(&manifest)).unwrap();
    let root = tmp.path().join("plugins");
    commit_staged(&root, stage.path(), &manifest).unwrap();
    assert_eq!(read_manifest(&root.join("ftp")).unwrap(), manifest);
    spec.sha256 = "00".repeat(32);
    assert!(verify_artifact(&archive, &spec).is_err());
    spec.size += 1;
    assert!(verify_artifact(&archive, &spec).is_err());
}

#[test]
fn zip_traversal_duplicates_and_cancellation_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("bad.zip");
    for entries in [
        vec![("../escape", &b"x"[..])],
        vec![("a", &b"x"[..]), ("A", &b"y"[..])],
    ] {
        zip_file(&archive, &entries);
        let out = tempfile::tempdir().unwrap();
        assert!(extract_archive(&archive, "zip", out.path(), &AtomicBool::new(false)).is_err());
    }
    zip_file(&archive, &[("file", b"x")]);
    let out = tempfile::tempdir().unwrap();
    assert!(extract_archive(&archive, "zip", out.path(), &AtomicBool::new(true)).is_err());
    assert!(!tmp.path().join("escape").exists());
}

#[test]
fn zip_and_tar_links_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("link.zip");
    let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive).unwrap());
    zip.add_symlink(
        "link",
        "../escape",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.finish().unwrap();
    let out = tempfile::tempdir().unwrap();
    assert!(extract_archive(&archive, "zip", out.path(), &AtomicBool::new(false)).is_err());
    let archive = tmp.path().join("link.tar.gz");
    let encoder = flate2::write::GzEncoder::new(
        std::fs::File::create(&archive).unwrap(),
        flate2::Compression::default(),
    );
    let mut tar = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_size(0);
    header.set_mode(0o777);
    header.set_cksum();
    tar.append_link(&mut header, "link", "../escape").unwrap();
    tar.into_inner().unwrap().finish().unwrap();
    let out = tempfile::tempdir().unwrap();
    assert!(extract_archive(&archive, "tar.gz", out.path(), &AtomicBool::new(false)).is_err());
}

fn package(root: &std::path::Path, m: &Manifest) {
    std::fs::create_dir_all(root).unwrap();
    std::fs::write(root.join("plugin.json"), serde_json::to_vec(m).unwrap()).unwrap();
    std::fs::write(root.join(m.executable()), b"executable fixture").unwrap();
}

#[test]
fn invalid_update_preserves_old_and_backup_blocks_destructive_replacement() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    let m = manifest();
    package(&root.join("ftp"), &m);
    let staged = tempfile::tempdir_in(&root).unwrap();
    let mut bad = m.clone();
    bad.version = "2.0.0".into();
    package(staged.path(), &bad);
    assert!(commit_staged(&root, staged.path(), &m).is_err());
    assert_eq!(read_manifest(&root.join("ftp")).unwrap(), m);
    std::fs::create_dir(root.join(".backup-ftp")).unwrap();
    assert!(commit_staged(&root, staged.path(), &bad).is_err());
    assert_eq!(read_manifest(&root.join("ftp")).unwrap(), m);
}

#[test]
fn safe_update_replaces_and_cleans_backup() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    let m = manifest();
    package(&root.join("ftp"), &m);
    let stage = tempfile::tempdir_in(&root).unwrap();
    let mut next = m.clone();
    next.version = "1.2.0".into();
    package(stage.path(), &next);
    commit_staged(&root, stage.path(), &next).unwrap();
    assert_eq!(read_manifest(&root.join("ftp")).unwrap(), next);
    assert!(!root.join(".backup-ftp").exists());
}

#[test]
fn rename_failure_restores_previous_directory() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugins");
    let manifest = manifest();
    package(&root.join("ftp"), &manifest);
    // Moving the previous installation removes this deliberately invalid staging path,
    // forcing the second rename to fail after the backup has been created.
    assert!(commit_staged(&root, &root.join("ftp"), &manifest).is_err());
    assert_eq!(read_manifest(&root.join("ftp")).unwrap(), manifest);
    assert!(!root.join(".backup-ftp").exists());
}

#[test]
fn tar_archive_round_trip_and_expansion_limit() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("plugin.tar.gz");
    let encoder = flate2::write::GzEncoder::new(
        std::fs::File::create(&archive).unwrap(),
        flate2::Compression::default(),
    );
    let mut tar = tar::Builder::new(encoder);
    let data = b"package file";
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "licenses/notice.txt", &data[..])
        .unwrap();
    tar.into_inner().unwrap().finish().unwrap();
    let out = tempfile::tempdir().unwrap();
    extract_archive(&archive, "tar.gz", out.path(), &AtomicBool::new(false)).unwrap();
    assert_eq!(
        std::fs::read(out.path().join("licenses/notice.txt")).unwrap(),
        data
    );
    let mut header = tar::Header::new_gnu();
    header.set_path("oversized").unwrap();
    header.set_size(MAX_EXPANDED + 1);
    header.set_mode(0o644);
    header.set_cksum();
    let mut encoder = flate2::write::GzEncoder::new(
        std::fs::File::create(&archive).unwrap(),
        flate2::Compression::default(),
    );
    encoder.write_all(header.as_bytes()).unwrap();
    encoder.finish().unwrap();
    let out = tempfile::tempdir().unwrap();
    assert!(
        extract_archive(&archive, "tar.gz", out.path(), &AtomicBool::new(false))
            .unwrap_err()
            .contains("size limit")
    );
}

#[test]
fn local_package_copy_and_missing_binary_preserve_existing_installation() {
    let source = tempfile::tempdir().unwrap();
    let m = manifest();
    package(source.path(), &m);
    let destination = tempfile::tempdir().unwrap();
    copy_local(source.path(), destination.path(), &AtomicBool::new(false)).unwrap();
    assert_eq!(validate_package(destination.path(), None).unwrap(), m);
    std::fs::remove_file(destination.path().join(m.executable())).unwrap();
    assert!(validate_package(destination.path(), Some(&m)).is_err());
    let cancelled = tempfile::tempdir().unwrap();
    assert!(copy_local(source.path(), cancelled.path(), &AtomicBool::new(true)).is_err());
}

#[tokio::test]
async fn signed_cache_survives_offline_but_tampered_cache_does_not() {
    let (mut bytes, _, mut trust) = signed_catalog();
    let mut catalog: Catalog = serde_json::from_slice(&bytes).unwrap();
    catalog.generated_at = now() - 10;
    catalog.expires_at = now() + 3600;
    bytes = serde_json::to_vec(&catalog).unwrap();
    let key = SigningKey::from_bytes(&[42; 32]);
    let sig = SignatureEnvelope {
        key_id: "test".into(),
        signature: STANDARD.encode(key.sign(&bytes).to_bytes()),
    };
    trust.index_url = "https://127.0.0.1/index.json".into();
    trust.allowed_hosts.push("127.0.0.1".into());
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("cache.json");
    let cache = serde_json::json!({"payload":STANDARD.encode(&bytes),"signature":sig,"etag":null});
    std::fs::write(&path, serde_json::to_vec(&cache).unwrap()).unwrap();
    let loaded = load_catalog(&trust, &path).await.unwrap();
    assert!(loaded.from_cache);
    assert!(loaded.warning.is_some());
    let mut cache = cache;
    cache["payload"] = STANDARD.encode(b"tampered").into();
    std::fs::write(&path, serde_json::to_vec(&cache).unwrap()).unwrap();
    assert!(load_catalog(&trust, &path).await.is_err());
}
