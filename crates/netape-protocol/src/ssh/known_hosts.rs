//! Known-hosts file management.
//!
//! For now we accept all host keys (TOFU — trust on first use) and write them
//! to the known_hosts file.  A UI callback for key-change warnings is planned
//! as a Tauri command in a follow-up.

use std::path::PathBuf;

use russh::keys::PublicKey;
use tracing::{info, warn};

/// Verification decision returned to the SSH handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyDecision {
    Accept,
    Reject,
}

/// Verifies the server's host key against a local known_hosts file.
///
/// Policy: accept new keys (TOFU), warn on mismatches (but still accept for now).
pub struct KnownHostsVerifier {
    path: PathBuf,
}

impl KnownHostsVerifier {
    pub fn new(path: PathBuf) -> Self {
        KnownHostsVerifier { path }
    }

    /// Default location: `<data_dir>/Netape/known_hosts`.
    pub fn default_path() -> PathBuf {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Netape")
            .join("known_hosts")
    }

    /// Check a server public key against known_hosts.
    ///
    /// Returns `Accept` in all cases for now (full UI dialog is a future task).
    pub fn verify(&self, host: &str, port: u16, key: &PublicKey) -> VerifyDecision {
        let host_port = format_host_port(host, port);
        let key_fp = key.fingerprint(russh::keys::ssh_key::HashAlg::Sha256).to_string();

        match self.read_known_host(&host_port) {
            Some(known_fp) => {
                if known_fp == key_fp {
                    info!("ssh: known host key matches for {host_port}");
                } else {
                    warn!(
                        "ssh: HOST KEY CHANGED for {host_port}! \
                         expected={known_fp}, got={key_fp}. Accepting anyway (TOFU)."
                    );
                }
            }
            None => {
                info!("ssh: first-time connection to {host_port}, recording key {key_fp}");
                let _ = self.write_known_host(&host_port, &key_fp);
            }
        }
        VerifyDecision::Accept
    }

    fn read_known_host(&self, host_port: &str) -> Option<String> {
        let content = std::fs::read_to_string(&self.path).ok()?;
        for line in content.lines() {
            let parts: Vec<&str> = line.splitn(2, ' ').collect();
            if parts.len() == 2 && parts[0] == host_port {
                return Some(parts[1].to_string());
            }
        }
        None
    }

    fn write_known_host(&self, host_port: &str, fingerprint: &str) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(file, "{host_port} {fingerprint}")?;
        Ok(())
    }
}

fn format_host_port(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    }
}
