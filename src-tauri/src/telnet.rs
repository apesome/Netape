//! Tauri command bridge: xterm.js ↔ Telnet (RFC 854) connection.
//!
//! A minimal but functional Telnet client: it opens a TCP connection (through
//! the configured proxy, reusing the SSH layer's `tcp_connect`), performs IAC
//! option negotiation (terminal type, window size/NAWS, suppress-go-ahead,
//! binary, remote echo), strips control sequences from the data stream, and
//! pipes the clean bytes to the frontend.
//!
//! Events: `telnet://output/<id>` (base64), `telnet://exit/<id>`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use encoding_rs::Encoding;
use netape_protocol::ssh::config::ProxyConfig;
use netape_protocol::ssh::proxy::tcp_connect;
use netape_protocol::telnet::{escape_iac, initial_negotiation, naws, TelnetParser};
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::AbortHandle;
use uuid::Uuid;

use crate::encoding::{charset_for, encode_input, is_utf8};

struct TelnetSession {
    writer: Arc<AsyncMutex<OwnedWriteHalf>>,
    encoding: &'static Encoding,
    cols: u16,
    rows: u16,
    abort: AbortHandle,
}

#[derive(Default)]
pub struct TelnetState {
    sessions: Mutex<HashMap<String, TelnetSession>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelnetConnectParams {
    host: String,
    port: u16,
    rows: u16,
    cols: u16,
    encoding: Option<String>,
    proxy_type: Option<String>,
    proxy_host: Option<String>,
    proxy_port: Option<u16>,
    proxy_user: Option<String>,
    proxy_pass: Option<String>,
}

fn build_proxy(p: &TelnetConnectParams) -> ProxyConfig {
    let user = p.proxy_user.clone().filter(|s| !s.is_empty());
    let pass = p.proxy_pass.clone().filter(|s| !s.is_empty());
    match p.proxy_type.as_deref() {
        Some("HTTP") => ProxyConfig::Http {
            host: p.proxy_host.clone().unwrap_or_default(),
            port: p.proxy_port.unwrap_or(8080),
            username: user,
            password: pass,
        },
        Some("SOCKS5") => ProxyConfig::Socks5 {
            host: p.proxy_host.clone().unwrap_or_default(),
            port: p.proxy_port.unwrap_or(1080),
            username: user,
            password: pass,
        },
        _ => ProxyConfig::None,
    }
}

#[tauri::command]
pub async fn telnet_connect(
    app: AppHandle,
    state: State<'_, TelnetState>,
    params: TelnetConnectParams,
) -> Result<String, String> {
    let proxy = build_proxy(&params);
    let stream = tcp_connect(&params.host, params.port, &proxy)
        .await
        .map_err(|e| e.to_string())?;
    let _ = stream.set_nodelay(true);

    let (mut rd, wr) = stream.into_split();
    let writer = Arc::new(AsyncMutex::new(wr));
    let charset = charset_for(params.encoding.as_deref());

    // Proactively advertise our supported options.
    {
        let mut w = writer.lock().await;
        w.write_all(&initial_negotiation()).await.map_err(|e| e.to_string())?;
        w.flush().await.map_err(|e| e.to_string())?;
    }

    let session_id = Uuid::new_v4().to_string();
    let out_event  = format!("telnet://output/{session_id}");
    let exit_event = format!("telnet://exit/{session_id}");
    let app_out    = app.clone();
    let writer_rd  = Arc::clone(&writer);
    let utf8       = is_utf8(charset);
    let (cols0, rows0) = (params.cols, params.rows);

    let join = tokio::spawn(async move {
        let engine = base64::engine::general_purpose::STANDARD;
        let mut decoder = charset.new_decoder();
        let mut parser = TelnetParser::new(cols0, rows0);
        let mut buf = [0u8; 8192];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let (data, responses) = parser.feed(&buf[..n]);
                    if !responses.is_empty() {
                        let mut w = writer_rd.lock().await;
                        if w.write_all(&responses).await.is_err() { break; }
                        let _ = w.flush().await;
                    }
                    if !data.is_empty() {
                        let encoded = if utf8 {
                            engine.encode(&data)
                        } else {
                            let mut s = String::with_capacity(data.len() * 2);
                            let _ = decoder.decode_to_string(&data, &mut s, false);
                            engine.encode(s.as_bytes())
                        };
                        if app_out.emit(&out_event, encoded).is_err() { break; }
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app_out.emit(&exit_event, ());
    });

    state.sessions.lock().unwrap().insert(
        session_id.clone(),
        TelnetSession {
            writer,
            encoding: charset,
            cols: params.cols,
            rows: params.rows,
            abort: join.abort_handle(),
        },
    );

    Ok(session_id)
}

#[tauri::command]
pub async fn telnet_write(
    state: State<'_, TelnetState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let (writer, charset) = {
        let guard = state.sessions.lock().unwrap();
        let s = guard
            .get(&session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        (Arc::clone(&s.writer), s.encoding)
    };
    let bytes = encode_input(charset, &data);
    // Escape IAC (0xFF) in user data so it isn't taken as a command.
    let out = escape_iac(&bytes);
    let mut w = writer.lock().await;
    w.write_all(&out).await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn telnet_resize(
    state: State<'_, TelnetState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let writer = {
        let mut guard = state.sessions.lock().unwrap();
        let Some(s) = guard.get_mut(&session_id) else { return Ok(()) };
        s.cols = cols;
        s.rows = rows;
        Arc::clone(&s.writer)
    };
    let frame = naws(cols, rows);
    let mut w = writer.lock().await;
    let _ = w.write_all(&frame).await;
    let _ = w.flush().await;
    Ok(())
}

#[tauri::command]
pub fn telnet_close(state: State<'_, TelnetState>, session_id: String) -> Result<(), String> {
    if let Some(s) = state.sessions.lock().unwrap().remove(&session_id) {
        s.abort.abort();
    }
    Ok(())
}

pub fn init(app: &AppHandle) {
    app.manage(TelnetState::default());
}
