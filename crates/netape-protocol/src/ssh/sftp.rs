//! SFTP channel — opens an SFTP subsystem channel on an existing SSH connection.

use std::sync::Arc;

use russh::client;
use russh_sftp::client::SftpSession;

use crate::error::{ProtocolError, ProtocolResult};
use super::session::ClientHandler;

/// A thin wrapper around a `russh_sftp::SftpSession`.
pub struct SftpChannel {
    pub session: SftpSession,
}

/// Open an SFTP subsystem channel using an existing russh connection handle.
pub async fn open(
    handle: &Arc<client::Handle<ClientHandler>>,
) -> ProtocolResult<SftpChannel> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(ProtocolError::Ssh)?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(ProtocolError::Ssh)?;

    let session = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| ProtocolError::Other(e.to_string()))?;

    Ok(SftpChannel { session })
}
