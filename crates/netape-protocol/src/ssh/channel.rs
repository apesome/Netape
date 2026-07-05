//! SSH channel types.
//!
//! [`PtyChannel`] wraps a russh `Channel` and uses a task-based I/O model:
//! calling [`PtyChannel::spawn`] starts a background tokio task that owns the
//! channel and drives full-duplex I/O via `tokio::select!`.
//!
//! This avoids the read/write deadlock that arises from `Arc<Mutex<Channel>>`
//! (a `wait()` loop would hold the lock forever while `data()` tries to acquire
//! it). The russh `Channel` itself uses independent internal MPSC channels for
//! send and receive, so the select! pattern is naturally correct.

use std::sync::Arc;

use russh::{Channel, ChannelMsg, client};
use tokio::sync::mpsc;
use tracing::debug;

use crate::error::{ProtocolError, ProtocolResult};

/// Terminal size (rows × cols).
#[derive(Debug, Clone, Copy)]
pub struct PtySize {
    pub rows: u16,
    pub cols: u16,
}

/// Commands sent to the channel task from [`PtyHandle`].
pub enum ChannelCmd {
    Write(Vec<u8>),
    Resize(PtySize),
    Close,
}

/// An open PTY shell channel. Consumed by [`PtyChannel::spawn`].
pub struct PtyChannel {
    channel: Channel<client::Msg>,
}

impl PtyChannel {
    pub(crate) async fn open(
        handle: &Arc<russh::client::Handle<super::session::ClientHandler>>,
        size: PtySize,
        term: &str,
        env: &std::collections::HashMap<String, String>,
    ) -> ProtocolResult<Self> {
        let channel = handle.channel_open_session().await?;

        for (k, v) in env {
            channel.set_env(false, k, v).await?;
        }

        channel
            .request_pty(
                false,
                term,
                size.cols as u32,
                size.rows as u32,
                0,
                0,
                &[],
            )
            .await?;

        channel.request_shell(false).await?;

        debug!("ssh: PTY shell channel opened ({}×{})", size.cols, size.rows);
        Ok(PtyChannel { channel })
    }

    /// Consume the channel and spawn a background task that drives bidirectional I/O.
    ///
    /// Returns a [`PtyHandle`] for sending write/resize/close commands to the
    /// running task. The task calls `on_data` with each chunk of output from the
    /// remote and calls `on_close` with the exit code when the session ends.
    pub fn spawn<F, C>(mut self, mut on_data: F, on_close: C) -> PtyHandle
    where
        F: FnMut(&[u8]) + Send + 'static,
        C: FnOnce(Option<u32>) + Send + 'static,
    {
        let (tx, mut rx) = mpsc::channel::<ChannelCmd>(64);

        tokio::spawn(async move {
            let mut exit_code: Option<u32> = None;

            loop {
                tokio::select! {
                    cmd = rx.recv() => match cmd {
                        Some(ChannelCmd::Write(data)) => {
                            if let Err(e) = self.channel.data(data.as_slice()).await {
                                debug!("ssh: channel write error: {e}");
                                break;
                            }
                        }
                        Some(ChannelCmd::Resize(size)) => {
                            let _ = self.channel
                                .window_change(size.cols as u32, size.rows as u32, 0, 0)
                                .await;
                        }
                        Some(ChannelCmd::Close) => {
                            let _ = self.channel.eof().await;
                            let _ = self.channel.close().await;
                            break;
                        }
                        None => break, // PtyHandle dropped
                    },
                    msg = self.channel.wait() => match msg {
                        Some(ChannelMsg::Data { ref data }) => on_data(data),
                        Some(ChannelMsg::ExtendedData { ref data, ext: 1 }) => on_data(data),
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            exit_code = Some(exit_status);
                            debug!("ssh: shell exited with status {exit_status}");
                        }
                        Some(ChannelMsg::Eof) => {
                            debug!("ssh: channel EOF");
                            break;
                        }
                        Some(ChannelMsg::Close) | None => {
                            debug!("ssh: channel closed");
                            break;
                        }
                        Some(other) => {
                            debug!("ssh: unhandled channel msg: {:?}", other);
                        }
                    },
                }
            }

            on_close(exit_code);
        });

        PtyHandle { tx }
    }
}

/// A cloneable handle to a running [`PtyChannel`] task.
///
/// All operations are async sends to the background task — they never block the
/// caller for more than a single queue slot.
#[derive(Clone)]
pub struct PtyHandle {
    tx: mpsc::Sender<ChannelCmd>,
}

impl PtyHandle {
    pub async fn write(&self, data: &[u8]) -> ProtocolResult<()> {
        self.tx
            .send(ChannelCmd::Write(data.to_vec()))
            .await
            .map_err(|_| ProtocolError::ChannelClosed)
    }

    pub async fn resize(&self, size: PtySize) -> ProtocolResult<()> {
        self.tx
            .send(ChannelCmd::Resize(size))
            .await
            .map_err(|_| ProtocolError::ChannelClosed)
    }

    pub async fn close(&self) {
        let _ = self.tx.send(ChannelCmd::Close).await;
    }
}

// ---------------------------------------------------------------------------
// Exec channel
// ---------------------------------------------------------------------------

/// Result of running a single command over SSH.
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
}

/// Open an exec channel, run `command`, collect stdout, return exit code.
pub async fn exec(
    handle: &Arc<russh::client::Handle<super::session::ClientHandler>>,
    command: &str,
) -> ProtocolResult<ExecResult> {
    let mut channel = handle.channel_open_session().await?;
    channel.exec(false, command).await?;

    let mut output = Vec::new();
    let mut exit_code: i32 = -1;

    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { ref data }) => output.extend_from_slice(data),
            Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = exit_status as i32,
            Some(ChannelMsg::Close) | None => break,
            _ => {}
        }
    }

    Ok(ExecResult {
        exit_code,
        stdout: String::from_utf8_lossy(&output).into_owned(),
    })
}
