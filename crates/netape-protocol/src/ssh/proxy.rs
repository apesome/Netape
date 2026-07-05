//! Proxy TCP-stream factory.
//!
//! Port of `SshClients.MyIoConnector.getClientProxyConnector` (HTTP CONNECT /
//! SOCKS5 via JGit's `HttpClientConnector` / `Socks5ClientConnector`).
//!
//! Returns a `TcpStream` that is already connected through the proxy, so the
//! SSH handshake runs on top of it transparently.

use std::net::SocketAddr;

use tokio::net::TcpStream;
use tokio_socks::tcp::Socks5Stream;
use tracing::debug;

use crate::error::{ProtocolError, ProtocolResult};
use crate::ssh::config::ProxyConfig;

/// Open a TCP stream to `target`, routing through `proxy` if configured.
pub async fn tcp_connect(
    target_host: &str,
    target_port: u16,
    proxy: &ProxyConfig,
) -> ProtocolResult<TcpStream> {
    match proxy {
        ProxyConfig::None => {
            let addr = format!("{target_host}:{target_port}");
            debug!("tcp: direct connect to {addr}");
            let stream = TcpStream::connect(&addr)
                .await
                .map_err(ProtocolError::Io)?;
            // Disable Nagle so small SSH/FTP commands are sent immediately.
            let _ = stream.set_nodelay(true);
            Ok(stream)
        }

        ProxyConfig::Socks5 {
            host: proxy_host,
            port: proxy_port,
            username,
            password,
        } => {
            let proxy_addr = format!("{proxy_host}:{proxy_port}");
            let target_addr = (target_host, target_port);
            debug!("tcp: SOCKS5 via {proxy_addr} → {target_host}:{target_port}");

            let stream = match (username, password) {
                (Some(u), Some(p)) => {
                    Socks5Stream::connect_with_password(
                        proxy_addr.parse::<SocketAddr>()
                            .map_err(|e| ProtocolError::Proxy(e.to_string()))?,
                        target_addr,
                        u,
                        p,
                    )
                    .await
                    .map_err(|e| ProtocolError::Proxy(e.to_string()))?
                }
                _ => {
                    Socks5Stream::connect(
                        proxy_addr.parse::<SocketAddr>()
                            .map_err(|e| ProtocolError::Proxy(e.to_string()))?,
                        target_addr,
                    )
                    .await
                    .map_err(|e| ProtocolError::Proxy(e.to_string()))?
                }
            };

            let inner = stream.into_inner();
            let _ = inner.set_nodelay(true);
            Ok(inner)
        }

        ProxyConfig::Http {
            host: proxy_host,
            port: proxy_port,
            username,
            password,
        } => {
            let proxy_addr = format!("{proxy_host}:{proxy_port}");
            debug!("tcp: HTTP CONNECT via {proxy_addr} → {target_host}:{target_port}");

            let mut stream = TcpStream::connect(&proxy_addr)
                .await
                .map_err(ProtocolError::Io)?;

            http_connect(
                &mut stream,
                target_host,
                target_port,
                username.as_deref(),
                password.as_deref(),
            )
            .await?;

            let _ = stream.set_nodelay(true);
            Ok(stream)
        }
    }
}

/// HTTP CONNECT tunnel negotiation.
async fn http_connect(
    stream: &mut TcpStream,
    host: &str,
    port: u16,
    username: Option<&str>,
    password: Option<&str>,
) -> ProtocolResult<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut req = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n");

    if let (Some(u), Some(p)) = (username, password) {
        use base64::Engine;
        let creds = base64::engine::general_purpose::STANDARD
            .encode(format!("{u}:{p}"));
        req.push_str(&format!("Proxy-Authorization: Basic {creds}\r\n"));
    }
    req.push_str("\r\n");

    stream
        .write_all(req.as_bytes())
        .await
        .map_err(ProtocolError::Io)?;

    // Read until \r\n\r\n
    let mut buf = Vec::with_capacity(256);
    loop {
        let b = stream.read_u8().await.map_err(ProtocolError::Io)?;
        buf.push(b);
        if buf.ends_with(b"\r\n\r\n") {
            break;
        }
        if buf.len() > 4096 {
            return Err(ProtocolError::Proxy("HTTP CONNECT response too large".into()));
        }
    }

    let response = String::from_utf8_lossy(&buf);
    let status_line = response.lines().next().unwrap_or("");
    // Expect "HTTP/1.x 200 …"
    if !status_line.contains("200") {
        return Err(ProtocolError::Proxy(format!(
            "HTTP CONNECT rejected: {status_line}"
        )));
    }

    Ok(())
}
