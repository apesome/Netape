use crate::{Result, MAX_ARCHIVE};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    #[serde(default)]
    pub protocol: String,
    pub bin: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default = "api_version")]
    pub plugin_api_version: u32,
}
fn api_version() -> u32 {
    1
}

pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 64
        || !id.as_bytes()[0].is_ascii_lowercase()
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || reserved_name(id)
    {
        return Err("Invalid plugin identifier".into());
    }
    Ok(())
}

fn reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

pub fn validate_relative(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 240
        || path.contains('\\')
        || path.starts_with('/')
        || path.contains(':')
    {
        return Err("Unsafe package path".into());
    }
    for part in path.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || reserved_name(part)
            || !part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b' '))
        {
            return Err("Unsafe package path".into());
        }
    }
    Ok(())
}

impl Manifest {
    pub fn validate(&self) -> Result<()> {
        validate_id(&self.id)?;
        validate_relative(&self.bin)?;
        if self.bin.contains('/')
            || self.bin.starts_with('.')
            || self.name.trim().is_empty()
            || self.name.len() > 128
            || self.kind != "transfer"
            || !matches!(self.protocol.as_str(), "FTP" | "SMB")
            || self.plugin_api_version != 1
            || self.description.len() > 4096
            || self.author.len() > 256
            || self.capabilities != ["transfer"]
        {
            return Err("Unsupported or invalid plugin manifest".into());
        }
        Version::parse(&self.version).map_err(|_| "Invalid plugin version")?;
        Ok(())
    }
    pub fn executable(&self) -> String {
        if cfg!(windows) && !self.bin.to_ascii_lowercase().ends_with(".exe") {
            format!("{}.exe", self.bin)
        } else {
            self.bin.clone()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Artifact {
    pub url: String,
    pub archive: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    #[serde(flatten)]
    pub manifest: Manifest,
    pub min_app_version: String,
    pub platforms: BTreeMap<String, Artifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub schema_version: u32,
    pub generated_at: u64,
    pub expires_at: u64,
    pub plugins: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignatureEnvelope {
    pub key_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustConfig {
    pub index_url: String,
    pub allowed_hosts: Vec<String>,
    pub keys: BTreeMap<String, String>,
}

pub fn hex_decode<const N: usize>(value: &str) -> Result<[u8; N]> {
    if value.len() != N * 2 || !value.is_ascii() {
        return Err("Invalid hexadecimal value".into());
    }
    let mut out = [0; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)
            .map_err(|_| "Invalid hexadecimal value")?;
    }
    Ok(out)
}

pub fn validate_url(value: &str, trust: &TrustConfig) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid download URL")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
        || !trust
            .allowed_hosts
            .iter()
            .any(|host| Some(host.as_str()) == url.host_str())
    {
        return Err("Plugin URL is not an allowed HTTPS origin".into());
    }
    Ok(url)
}

pub fn verify_catalog(
    bytes: &[u8],
    signature: &SignatureEnvelope,
    trust: &TrustConfig,
    now: u64,
) -> Result<Catalog> {
    if bytes.len() > 1024 * 1024 {
        return Err("Plugin catalog is too large".into());
    }
    let key = trust
        .keys
        .get(&signature.key_id)
        .ok_or("Unknown catalog signing key")?;
    let key = VerifyingKey::from_bytes(&hex_decode::<32>(key)?)
        .map_err(|_| "Invalid catalog public key")?;
    let signature = STANDARD
        .decode(&signature.signature)
        .map_err(|_| "Invalid catalog signature")?;
    let signature = Signature::from_slice(&signature).map_err(|_| "Invalid catalog signature")?;
    key.verify_strict(bytes, &signature)
        .map_err(|_| "Catalog signature verification failed")?;
    let catalog: Catalog =
        serde_json::from_slice(bytes).map_err(|e| format!("Invalid plugin catalog: {e}"))?;
    if catalog.schema_version != 1
        || catalog.plugins.len() > 100
        || catalog.generated_at > now.saturating_add(300)
        || catalog.expires_at <= now
        || catalog.expires_at <= catalog.generated_at
        || catalog.expires_at - catalog.generated_at > 90 * 86400
    {
        return Err("Unsupported, expired or invalid plugin catalog".into());
    }
    let mut ids = HashSet::new();
    for entry in &catalog.plugins {
        entry.manifest.validate()?;
        if !ids.insert(&entry.manifest.id) {
            return Err("Duplicate plugin identifier in catalog".into());
        }
        Version::parse(&entry.min_app_version).map_err(|_| "Invalid minimum app version")?;
        if entry.platforms.is_empty() || entry.platforms.len() > 16 {
            return Err("Invalid plugin targets".into());
        }
        for artifact in entry.platforms.values() {
            validate_url(&artifact.url, trust)?;
            if artifact.size == 0
                || artifact.size > MAX_ARCHIVE
                || !matches!(artifact.archive.as_str(), "zip" | "tar.gz")
            {
                return Err("Unsupported or oversized plugin archive".into());
            }
            hex_decode::<32>(&artifact.sha256)?;
        }
    }
    Ok(catalog)
}

impl CatalogEntry {
    pub fn compatible(&self, target: &str, app_version: &str) -> bool {
        self.platforms.contains_key(target)
            && !(self.manifest.protocol == "SMB" && !target.contains("windows"))
            && Version::parse(app_version)
                .ok()
                .zip(Version::parse(&self.min_app_version).ok())
                .is_some_and(|(app, min)| app >= min)
    }
}

pub fn newer(candidate: &str, installed: &str) -> bool {
    Version::parse(candidate)
        .ok()
        .zip(Version::parse(installed).ok())
        .is_some_and(|(a, b)| a > b)
}
