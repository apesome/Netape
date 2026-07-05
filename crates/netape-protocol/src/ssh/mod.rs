//! SSH protocol implementation.
//!
//! Port of `app.termora.plugin.internal.ssh.SshClients` (Apache MINA SSHD)
//! → russh (async, tokio).
//!
//! # Public API
//!
//! ```text
//! ssh::connect(&config)      →  SshSession
//! session.open_shell(size)   →  PtyChannel
//! session.exec(cmd)          →  (exit_code, stdout)
//! session.start_local_fwd()  →  bound local port
//! ```

pub mod channel;
pub mod config;
pub mod known_hosts;
pub mod proxy;
pub mod session;
pub mod sftp;
pub mod tunneling;

pub use channel::{PtyChannel, PtyHandle, PtySize};
pub use config::{KbiPrompt, KbiResponder, PrivateKeyEntry, SshConfig};
pub use session::SshSession;
pub use sftp::SftpChannel;

use crate::error::ProtocolResult;

/// Top-level entry point: build a config from a [`netape_domain::host::Host`]
/// and open an authenticated SSH session.
///
/// Port of `SshClients.openClient` + `SshClients.openSession`.
pub async fn connect(config: &SshConfig) -> ProtocolResult<SshSession> {
    session::connect(config).await
}

/// Like [`connect`], but with a keyboard-interactive responder for answering
/// server challenge prompts.
pub async fn connect_with(
    config: &SshConfig,
    kbi: Option<KbiResponder>,
) -> ProtocolResult<SshSession> {
    session::connect_with(config, kbi).await
}
