//! SSH connection configuration.
//!
//! Converts `netape_domain::host::Host` into the flat parameter set needed
//! by the connection logic. Keeps the SSH layer decoupled from the domain model.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use netape_domain::host::{AuthenticationType, Host, ProxyType, TunnelingType};

/// A single candidate private key for public-key authentication.
#[derive(Debug, Clone)]
pub struct PrivateKeyEntry {
    /// Private-key PEM/OpenSSH text.
    pub private_key_pem: String,
    pub passphrase: Option<String>,
}

/// One keyboard-interactive prompt presented by the server.
#[derive(Debug, Clone)]
pub struct KbiPrompt {
    pub prompt: String,
    /// Whether the typed answer should be echoed (false = password-like).
    pub echo: bool,
}

/// Callback that answers a keyboard-interactive request.
///
/// Arguments: `(name, instructions, prompts)`; returns one answer per prompt.
/// Implemented by the host application (e.g. by prompting the user).
pub type KbiResponder = Arc<
    dyn Fn(String, String, Vec<KbiPrompt>) -> Pin<Box<dyn Future<Output = Vec<String>> + Send>>
        + Send
        + Sync,
>;

/// How the client authenticates to the server.
#[derive(Debug, Clone)]
pub enum AuthMethod {
    /// No authentication (not recommended outside testing).
    None,
    /// Password authentication.
    Password(String),
    /// Public-key authentication. Keys are tried in order until one succeeds;
    /// a single entry means a specific key, multiple entries means "auto-select".
    PublicKey {
        keys: Vec<PrivateKeyEntry>,
    },
    /// Keyboard-interactive (challenge–response).
    KeyboardInteractive,
    /// Delegate to a running ssh-agent (socket path / named pipe).
    SshAgent { socket_path: Option<String> },
}

/// Proxy configuration.
#[derive(Debug, Clone)]
pub enum ProxyConfig {
    None,
    Http {
        host: String,
        port: u16,
        username: Option<String>,
        password: Option<String>,
    },
    Socks5 {
        host: String,
        port: u16,
        username: Option<String>,
        password: Option<String>,
    },
}

/// Flat SSH connection parameters derived from [`Host`].
///
/// Port of the parameters scattered across `SshClients.openClient` /
/// `doOpenSession`.
#[derive(Debug, Clone)]
pub struct SshConfig {
    /// Remote hostname or IP.
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    pub proxy: ProxyConfig,
    /// IDs of jump hosts to traverse (in order).
    pub jump_host_configs: Vec<Box<SshConfig>>,
    /// SSH heartbeat interval.
    pub heartbeat: Duration,
    /// TCP / authentication timeout.
    pub timeout: Duration,
    /// Additional environment variables for the shell.
    pub env: HashMap<String, String>,
    /// Terminal type string.
    pub term: String,
    /// X11 forwarding — `Some((display_host, base_port))`.
    pub x11_forwarding: Option<(String, u16)>,
    /// Forward the ssh-agent into the remote shell.
    pub forward_agent: bool,
}

impl SshConfig {
    /// Minimal config for unit tests.
    pub fn test(host: &str, port: u16, username: &str, password: &str) -> Self {
        SshConfig {
            host: host.to_string(),
            port,
            username: username.to_string(),
            auth: AuthMethod::Password(password.to_string()),
            proxy: ProxyConfig::None,
            jump_host_configs: vec![],
            heartbeat: Duration::from_secs(30),
            timeout: Duration::from_secs(10),
            env: HashMap::new(),
            term: "xterm-256color".to_string(),
            x11_forwarding: None,
            forward_agent: false,
        }
    }

    /// Build from a domain [`Host`] and a resolved private-key PEM if auth is
    /// PublicKey (the caller loads the key bytes from `KeyManager`).
    pub fn from_host(host: &Host, private_key_pem: Option<String>) -> Self {
        let auth = match host.authentication.auth_type {
            AuthenticationType::Password => {
                AuthMethod::Password(host.authentication.password.clone())
            }
            AuthenticationType::PublicKey => AuthMethod::PublicKey {
                keys: private_key_pem
                    .filter(|s| !s.is_empty())
                    .map(|pem| {
                        vec![PrivateKeyEntry { private_key_pem: pem, passphrase: None }]
                    })
                    .unwrap_or_default(),
            },
            AuthenticationType::KeyboardInteractive => AuthMethod::KeyboardInteractive,
            AuthenticationType::SshAgent => AuthMethod::SshAgent {
                socket_path: Some(host.authentication.password.clone())
                    .filter(|s| !s.is_empty()),
            },
            AuthenticationType::No => AuthMethod::None,
        };

        let proxy = match host.proxy.proxy_type {
            ProxyType::Http => ProxyConfig::Http {
                host: host.proxy.host.clone(),
                port: host.proxy.port,
                username: Some(host.proxy.username.clone()).filter(|s| !s.is_empty()),
                password: Some(host.proxy.password.clone()).filter(|s| !s.is_empty()),
            },
            ProxyType::Socks5 => ProxyConfig::Socks5 {
                host: host.proxy.host.clone(),
                port: host.proxy.port,
                username: Some(host.proxy.username.clone()).filter(|s| !s.is_empty()),
                password: Some(host.proxy.password.clone()).filter(|s| !s.is_empty()),
            },
            ProxyType::No => ProxyConfig::None,
        };

        let timeout_secs = host
            .options
            .extras
            .get("timeout")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(60);

        let x11 = if host.options.enable_x11_forwarding {
            let parts: Vec<&str> = host.options.x11_forwarding.split(':').collect();
            if parts.len() == 2 {
                let h = parts[0].to_string();
                let p = parts[1].parse::<u16>().unwrap_or(0);
                Some((h, 6000 + p))
            } else {
                None
            }
        } else {
            None
        };

        SshConfig {
            host: host.host.clone(),
            port: host.port,
            username: host.username.clone(),
            auth,
            proxy,
            jump_host_configs: vec![], // populated separately by the caller
            heartbeat: Duration::from_secs(host.options.heartbeat_interval.max(3) as u64),
            timeout: Duration::from_secs(timeout_secs),
            env: host.options.env_map(),
            term: "xterm-256color".to_string(),
            x11_forwarding: x11,
            forward_agent: host.options.extras.get("forwardAgent")
                .and_then(|v| v.parse().ok())
                .unwrap_or(false),
        }
    }

    /// Which tunneling rules come from the host's `tunnelings` list.
    pub fn tunneling_rules(host: &Host) -> Vec<TunnelingRule> {
        host.tunnelings
            .iter()
            .map(|t| TunnelingRule {
                name: t.name.clone(),
                kind: match t.tunneling_type {
                    TunnelingType::Local => TunnelingKind::Local,
                    TunnelingType::Remote => TunnelingKind::Remote,
                    TunnelingType::Dynamic => TunnelingKind::Dynamic,
                },
                src_host: t.source_host.clone(),
                src_port: t.source_port,
                dst_host: t.destination_host.clone(),
                dst_port: t.destination_port,
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelingKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone)]
pub struct TunnelingRule {
    pub name: String,
    pub kind: TunnelingKind,
    pub src_host: String,
    pub src_port: u16,
    pub dst_host: String,
    pub dst_port: u16,
}
