//! Live-socket integration test for the Telnet client logic.
//!
//! Spins up a minimal fake Telnet server on a real localhost TCP socket and
//! drives it with the same `TelnetParser` + negotiation helpers used by the
//! production `telnet_connect` command. Verifies a full round trip:
//! option negotiation, terminal-type sub-negotiation, NAWS, and clean data.

use std::time::Duration;

use netape_protocol::telnet::{
    initial_negotiation, TelnetParser, DO, IAC, OPT_ECHO, OPT_NAWS, OPT_TTYPE, SB, SE, WILL,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const TTYPE_SEND: u8 = 1;

/// Read from `rd` into `sink` until `deadline`, returning what was collected.
async fn drain_until(mut rd: impl AsyncReadExt + Unpin, deadline: tokio::time::Instant) -> Vec<u8> {
    let mut sink = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, rd.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
            Ok(Ok(n)) => sink.extend_from_slice(&buf[..n]),
        }
    }
    sink
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn telnet_handshake_over_real_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    // ── Fake Telnet server ──────────────────────────────────────────────────
    let server = tokio::spawn(async move {
        let (sock, _) = listener.accept().await.unwrap();
        let (rd, mut wr) = sock.into_split();

        // Ask the client to negotiate, query its terminal type, then prompt.
        let mut hello = vec![
            IAC, DO, OPT_TTYPE,
            IAC, DO, OPT_NAWS,
            IAC, WILL, OPT_ECHO,
            IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE,
        ];
        hello.extend_from_slice(b"login: ");
        wr.write_all(&hello).await.unwrap();
        wr.flush().await.unwrap();

        // Collect the client's replies until it hangs up (or 1s elapses).
        drain_until(rd, tokio::time::Instant::now() + Duration::from_millis(1000)).await
    });

    // ── Client = production Telnet logic ────────────────────────────────────
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(&initial_negotiation()).await.unwrap();
    stream.flush().await.unwrap();

    let mut parser = TelnetParser::new(120, 40);
    let mut clean = Vec::new();
    let mut buf = [0u8; 1024];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if clean.windows(7).any(|w| w == b"login: ") {
            break;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, stream.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => break,
            Ok(Ok(n)) => {
                let (data, resp) = parser.feed(&buf[..n]);
                clean.extend_from_slice(&data);
                if !resp.is_empty() {
                    stream.write_all(&resp).await.unwrap();
                    stream.flush().await.unwrap();
                }
            }
        }
    }
    drop(stream); // let the server's drain loop finish promptly

    let got = server.await.unwrap();

    // 1. Server's data prompt arrived, with IAC sequences stripped.
    assert!(
        clean.windows(7).any(|w| w == b"login: "),
        "client did not receive the prompt; clean={:?}",
        String::from_utf8_lossy(&clean)
    );

    // 2. Server received our terminal type in reply to its SEND query.
    assert!(
        got.windows(14).any(|w| w == b"xterm-256color"),
        "server did not receive the terminal type; got={got:?}"
    );

    // 3. Server received a NAWS (window size) sub-negotiation.
    assert!(
        got.windows(3).any(|w| w == [IAC, SB, OPT_NAWS]),
        "server did not receive NAWS; got={got:?}"
    );
}
