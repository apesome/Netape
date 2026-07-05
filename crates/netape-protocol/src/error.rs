/// All errors produced by the protocol layer.
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("SSH error: {0}")]
    Ssh(#[from] russh::Error),

    #[error("SSH key error: {0}")]
    SshKey(#[from] russh::keys::Error),

    #[error("authentication failed")]
    AuthFailed,

    #[error("connection refused or timed out: {0}")]
    Connect(String),

    #[error("channel closed")]
    ChannelClosed,

    #[error("proxy error: {0}")]
    Proxy(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

pub type ProtocolResult<T> = Result<T, ProtocolError>;
