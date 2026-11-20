//! SSH session: russh Handler + connect/authenticate logic.
//!
//! The public entry is [`connect`], which returns a ready-to-use [`SshSession`].

use std::sync::Arc;

use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKeyWithHashAlg, PublicKey, decode_secret_key};
use russh::Disconnect;
use tracing::{debug, info, warn};

use crate::error::{ProtocolError, ProtocolResult};
use crate::ssh::channel::{exec, ExecResult, PtyChannel, PtySize};
use crate::ssh::config::{
    AuthMethod, KbiPrompt, KbiResponder, ProxyConfig, SshConfig, TunnelingKind, TunnelingRule,
};
use crate::ssh::known_hosts::KnownHostsVerifier;
use crate::ssh::proxy::tcp_connect;
use crate::ssh::tunneling::start_forwarding;

// ---------------------------------------------------------------------------
// ClientHandler — russh event handler
// ---------------------------------------------------------------------------

pub struct ClientHandler {
    pub(crate) known_hosts: Arc<KnownHostsVerifier>,
    pub(crate) server_host: String,
    pub(crate) server_port: u16,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let decision = self
            .known_hosts
            .verify(&self.server_host, self.server_port, server_public_key);
        Ok(decision == crate::ssh::known_hosts::VerifyDecision::Accept)
    }
}

// ---------------------------------------------------------------------------
// SshSession — public API
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct SshSession {
    /// Shared handle — all channel methods take `&self`, so Arc is appropriate.
    pub(crate) handle: Arc<Handle<ClientHandler>>,
    config: SshConfig,
}

impl SshSession {
    pub async fn open_shell(&self, size: PtySize) -> ProtocolResult<PtyChannel> {
        PtyChannel::open(&self.handle, size, &self.config.term, &self.config.env).await
    }

    pub async fn open_sftp(&self) -> ProtocolResult<super::sftp::SftpChannel> {
        super::sftp::open(&self.handle).await
    }

    pub async fn exec_cmd(&self, command: &str) -> ProtocolResult<ExecResult> {
        exec(&self.handle, command).await
    }

    pub async fn exec_monitored(&self, command: &str, timeout_secs: u64, cancel: tokio::sync::watch::Receiver<bool>, on_output: impl Fn(&str)) -> ProtocolResult<super::channel::MonitoredExecResult> {
        super::channel::exec_monitored(&self.handle, command, timeout_secs, cancel, on_output).await
    }

    pub async fn start_forwarding(&self, rule: &TunnelingRule) -> ProtocolResult<String> {
        start_forwarding(Arc::clone(&self.handle), rule).await
    }

    /// Open a raw direct-tcpip SSH channel to `host:port`.
    /// The returned stream implements `AsyncRead + AsyncWrite` and can be
    /// split with `tokio::io::split` for concurrent reading and writing.
    pub async fn open_direct_tcpip(
        &self,
        host: &str,
        port: u16,
    ) -> ProtocolResult<impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + 'static> {
        let ch = self.handle
            .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
            .await
            .map_err(ProtocolError::Ssh)?;
        Ok(ch.into_stream())
    }

    pub async fn disconnect(self) -> ProtocolResult<()> {
        self.handle
            .disconnect(Disconnect::ByApplication, "bye", "en")
            .await
            .map_err(ProtocolError::Ssh)
    }
}

// ---------------------------------------------------------------------------
// connect() — top-level entry point
// ---------------------------------------------------------------------------

pub async fn connect(config: &SshConfig) -> ProtocolResult<SshSession> {
    connect_with(config, None).await
}

/// Like [`connect`], but accepts a keyboard-interactive responder so the host
/// application can answer server prompts (used for `KeyboardInteractive` auth).
pub async fn connect_with(
    config: &SshConfig,
    kbi: Option<KbiResponder>,
) -> ProtocolResult<SshSession> {
    if !config.jump_host_configs.is_empty() {
        return connect_via_jumps(config, kbi).await;
    }
    connect_direct(config, kbi).await
}

/// Connect directly without jump-host processing.
async fn connect_direct(
    config: &SshConfig,
    kbi: Option<KbiResponder>,
) -> ProtocolResult<SshSession> {
    let russh_config = build_russh_config(config);
    let known_hosts = Arc::new(KnownHostsVerifier::new(KnownHostsVerifier::default_path()));

    let handler = ClientHandler {
        known_hosts,
        server_host: config.host.clone(),
        server_port: config.port,
    };

    info!("ssh: connecting to {}:{}", config.host, config.port);

    let tcp = tcp_connect(&config.host, config.port, &config.proxy).await?;
    let handle = client::connect_stream(Arc::new(russh_config), tcp, handler)
        .await
        .map_err(ProtocolError::Ssh)?;

    authenticate(handle, config, kbi).await
}

/// Walk the jump-host chain.  Each hop uses `connect_direct` (not `connect`)
/// so there is no recursive async call.
async fn connect_via_jumps(
    config: &SshConfig,
    kbi: Option<KbiResponder>,
) -> ProtocolResult<SshSession> {
    let mut chain: Vec<&SshConfig> = config
        .jump_host_configs
        .iter()
        .map(|b| b.as_ref())
        .collect();
    chain.push(config);

    let mut current_host = chain[0].host.clone();
    let mut current_port = chain[0].port;
    let mut _prev_sessions: Vec<SshSession> = Vec::new();

    for (i, hop) in chain.iter().enumerate() {
        let mut hop_config = (*hop).clone();
        hop_config.host = current_host.clone();
        hop_config.port = current_port;
        hop_config.proxy = ProxyConfig::None;
        hop_config.jump_host_configs = vec![];

        let session = connect_direct(&hop_config, kbi.clone()).await?;

        if i + 1 < chain.len() {
            let next = chain[i + 1];
            let rule = TunnelingRule {
                name: format!("jump-{i}"),
                kind: TunnelingKind::Local,
                src_host: "127.0.0.1".into(),
                src_port: 0,
                dst_host: next.host.clone(),
                dst_port: next.port,
            };
            let bound_addr = start_forwarding(Arc::clone(&session.handle), &rule).await?;
            let parts: Vec<&str> = bound_addr.rsplitn(2, ':').collect();
            current_port = parts[0].parse().unwrap_or(next.port);
            current_host = "127.0.0.1".into();
            _prev_sessions.push(session);
        } else {
            return Ok(session);
        }
    }

    Err(ProtocolError::Other("jump-host chain is empty".into()))
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async fn authenticate(
    mut handle: Handle<ClientHandler>,
    config: &SshConfig,
    kbi: Option<KbiResponder>,
) -> ProtocolResult<SshSession> {
    match &config.auth {
        AuthMethod::Password(pw) => {
            debug!("ssh: authenticating with password");
            let res = handle
                .authenticate_password(&config.username, pw.clone())
                .await
                .map_err(ProtocolError::Ssh)?;
            if !res.success() {
                return Err(ProtocolError::AuthFailed);
            }
        }

        AuthMethod::PublicKey { keys } => {
            if keys.is_empty() {
                warn!("ssh: public-key auth requested but no keys available");
                return Err(ProtocolError::AuthFailed);
            }
            let hash_alg = handle
                .best_supported_rsa_hash()
                .await
                .map_err(ProtocolError::Ssh)?
                .flatten();

            // Try each candidate key in order until one authenticates.
            let mut authenticated = false;
            for (i, entry) in keys.iter().enumerate() {
                let key = match load_private_key(&entry.private_key_pem, entry.passphrase.as_deref()) {
                    Ok(k) => k,
                    Err(e) => {
                        warn!("ssh: skipping unusable key #{i}: {e}");
                        continue;
                    }
                };
                let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg.clone());
                let res = handle
                    .authenticate_publickey(&config.username, key_with_alg)
                    .await
                    .map_err(ProtocolError::Ssh)?;
                if res.success() {
                    debug!("ssh: public-key auth succeeded with key #{i}");
                    authenticated = true;
                    break;
                }
                debug!("ssh: public-key #{i} rejected, trying next");
            }
            if !authenticated {
                return Err(ProtocolError::AuthFailed);
            }
        }

        AuthMethod::KeyboardInteractive => {
            debug!("ssh: authenticating with keyboard-interactive");
            authenticate_keyboard_interactive(&mut handle, config, kbi).await?;
        }

        AuthMethod::SshAgent { .. } => {
            return Err(ProtocolError::Other(
                "ssh-agent auth not yet implemented".into(),
            ));
        }

        AuthMethod::None => {
            let res = handle
                .authenticate_none(&config.username)
                .await
                .map_err(ProtocolError::Ssh)?;
            if !res.success() {
                return Err(ProtocolError::AuthFailed);
            }
        }
    }

    info!("ssh: authenticated as {}", config.username);
    Ok(SshSession {
        handle: Arc::new(handle),
        config: config.clone(),
    })
}

/// Drive the keyboard-interactive challenge–response loop.
///
/// The server may send any number of `InfoRequest`s (each with zero or more
/// prompts). Answers are gathered through the [`KbiResponder`] callback. If no
/// responder is supplied, empty answers are sent (which still works for servers
/// that send a zero-prompt request).
async fn authenticate_keyboard_interactive(
    handle: &mut Handle<ClientHandler>,
    config: &SshConfig,
    kbi: Option<KbiResponder>,
) -> ProtocolResult<()> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(config.username.clone(), None)
        .await
        .map_err(ProtocolError::Ssh)?;

    loop {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(ProtocolError::AuthFailed);
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let answers = if prompts.is_empty() {
                    Vec::new()
                } else if let Some(responder) = &kbi {
                    let mapped: Vec<KbiPrompt> = prompts
                        .iter()
                        .map(|p| KbiPrompt { prompt: p.prompt.clone(), echo: p.echo })
                        .collect();
                    let count = mapped.len();
                    let mut a = responder(name, instructions, mapped).await;
                    // Guard against a responder returning the wrong count.
                    a.resize(count, String::new());
                    a
                } else {
                    vec![String::new(); prompts.len()]
                };

                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(ProtocolError::Ssh)?;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn build_russh_config(config: &SshConfig) -> client::Config {
    client::Config {
        // Send SSH keepalive packets at the configured interval so the server
        // doesn't close idle connections. inactivity_timeout is intentionally
        // left at its default (None) — we never want the CLIENT to self-disconnect.
        keepalive_interval: Some(config.heartbeat),
        keepalive_max: 3,
        inactivity_timeout: None,
        ..<client::Config as Default>::default()
    }
}

fn load_private_key(
    pem: &str,
    passphrase: Option<&str>,
) -> ProtocolResult<russh::keys::PrivateKey> {
    decode_secret_key(pem, passphrase).map_err(ProtocolError::SshKey)
}
