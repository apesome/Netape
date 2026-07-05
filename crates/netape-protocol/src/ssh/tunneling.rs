//! SSH port-forwarding helpers.
//!
//! Port of `SshClients.openTunneling` (local / remote / dynamic).

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tracing::{debug, info, warn};

use crate::error::{ProtocolError, ProtocolResult};
use crate::ssh::config::{TunnelingKind, TunnelingRule};
use crate::ssh::session::ClientHandler;

type Handle = Arc<russh::client::Handle<ClientHandler>>;

/// Start a port-forwarding rule on the given session.
///
/// Returns the locally-bound address string (local/dynamic) or
/// `"<remote>:<port>"` (remote forwarding).
pub async fn start_forwarding(
    handle: Handle,
    rule: &TunnelingRule,
) -> ProtocolResult<String> {
    match rule.kind {
        TunnelingKind::Local => start_local(handle, rule).await,
        TunnelingKind::Remote => start_remote(handle, rule).await,
        TunnelingKind::Dynamic => start_dynamic(handle, rule).await,
    }
}

// ---------------------------------------------------------------------------
// Local forwarding
// ---------------------------------------------------------------------------

async fn start_local(handle: Handle, rule: &TunnelingRule) -> ProtocolResult<String> {
    let bind_addr = format!(
        "{}:{}",
        if rule.src_host.is_empty() { "127.0.0.1" } else { &rule.src_host },
        rule.src_port
    );
    let listener = TcpListener::bind(&bind_addr)
        .await
        .map_err(ProtocolError::Io)?;
    let bound = listener.local_addr().map_err(ProtocolError::Io)?;

    info!("ssh: local forwarding {} → {}:{} started", bound, rule.dst_host, rule.dst_port);

    let dst_host = rule.dst_host.clone();
    let dst_port = rule.dst_port;
    let rule_name = rule.name.clone();

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((mut tcp, peer)) => {
                    debug!("ssh[{rule_name}]: accepted local fwd connection from {peer}");
                    let handle = Arc::clone(&handle);
                    let dh = dst_host.clone();
                    let dp = dst_port;
                    let src_ip = peer.ip().to_string();
                    let src_port = peer.port();

                    tokio::spawn(async move {
                        let ch = match tokio::time::timeout(
                            std::time::Duration::from_secs(30),
                            handle.channel_open_direct_tcpip(&dh, dp as u32, &src_ip, src_port as u32),
                        ).await {
                            Ok(Ok(c)) => c,
                            Ok(Err(e)) => {
                                warn!("ssh: failed to open direct-tcpip channel to {dh}:{dp}: {e}");
                                return;
                            }
                            Err(_) => {
                                warn!("ssh: timeout opening direct-tcpip channel to {dh}:{dp}");
                                return;
                            }
                        };

                        let mut ch_stream = ch.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut tcp, &mut ch_stream).await;
                    });
                }
                Err(e) => {
                    warn!("ssh: local fwd listener error: {e}");
                    break;
                }
            }
        }
    });

    Ok(bound.to_string())
}

// ---------------------------------------------------------------------------
// Remote forwarding
// ---------------------------------------------------------------------------

async fn start_remote(handle: Handle, rule: &TunnelingRule) -> ProtocolResult<String> {
    handle
        .tcpip_forward(&rule.src_host, rule.src_port as u32)
        .await
        .map_err(ProtocolError::Ssh)?;

    let addr = format!("{}:{}", rule.src_host, rule.src_port);
    info!("ssh: remote forwarding {addr} → {}:{}", rule.dst_host, rule.dst_port);
    Ok(addr)
}

// ---------------------------------------------------------------------------
// Dynamic forwarding (SOCKS5 proxy on local port)
// ---------------------------------------------------------------------------

async fn start_dynamic(handle: Handle, rule: &TunnelingRule) -> ProtocolResult<String> {
    let bind_addr = format!(
        "{}:{}",
        if rule.src_host.is_empty() { "127.0.0.1" } else { &rule.src_host },
        rule.src_port
    );
    let listener = TcpListener::bind(&bind_addr)
        .await
        .map_err(ProtocolError::Io)?;
    let bound = listener.local_addr().map_err(ProtocolError::Io)?;

    info!("ssh: dynamic (SOCKS5) forwarding on {bound}");

    let rule_name = rule.name.clone();

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, peer)) => {
                    debug!("ssh[{rule_name}]: dynamic fwd connection from {peer}");
                    let handle = Arc::clone(&handle);
                    tokio::spawn(handle_socks5(handle, stream, peer));
                }
                Err(e) => {
                    warn!("ssh: dynamic fwd listener error: {e}");
                    break;
                }
            }
        }
    });

    Ok(bound.to_string())
}

async fn handle_socks5(handle: Handle, mut stream: tokio::net::TcpStream, _peer: SocketAddr) {
    // SOCKS5 greeting
    let mut buf = [0u8; 2];
    if stream.read_exact(&mut buf).await.is_err() { return; }
    let n_methods = buf[1] as usize;
    let mut methods = vec![0u8; n_methods];
    if stream.read_exact(&mut methods).await.is_err() { return; }
    let _ = stream.write_all(&[0x05, 0x00]).await;

    // SOCKS5 request
    let mut req = [0u8; 4];
    if stream.read_exact(&mut req).await.is_err() { return; }
    if req[0] != 0x05 || req[1] != 0x01 { return; }

    let (host, port) = match req[3] {
        0x01 => {
            let mut addr = [0u8; 4];
            if stream.read_exact(&mut addr).await.is_err() { return; }
            let mut p = [0u8; 2];
            if stream.read_exact(&mut p).await.is_err() { return; }
            (std::net::Ipv4Addr::from(addr).to_string(), u16::from_be_bytes(p))
        }
        0x03 => {
            let mut len = [0u8; 1];
            if stream.read_exact(&mut len).await.is_err() { return; }
            let mut domain = vec![0u8; len[0] as usize];
            if stream.read_exact(&mut domain).await.is_err() { return; }
            let mut p = [0u8; 2];
            if stream.read_exact(&mut p).await.is_err() { return; }
            (String::from_utf8_lossy(&domain).to_string(), u16::from_be_bytes(p))
        }
        _ => return,
    };

    let ch = match handle
        .channel_open_direct_tcpip(&host, port as u32, "127.0.0.1", 0)
        .await
    {
        Ok(c) => c,
        Err(_) => {
            let _ = stream.write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
            return;
        }
    };

    let _ = stream.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;

    let mut ch_stream = ch.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut ch_stream).await;
}
