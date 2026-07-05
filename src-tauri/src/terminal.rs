//! Tauri command bridge: xterm.js ↔ native PTY (local shell).
//!
//! Multi-session: each tab gets its own session keyed by `session_id`.
//! Events are emitted on `terminal://output/<session_id>` and
//! `terminal://exit/<session_id>` so tabs don't cross-contaminate.

use std::collections::HashMap;
use std::io::Read;
use std::sync::Mutex;

use base64::Engine;
use encoding_rs::Encoding;
use netape_pty::{PtySession, TermSize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::encoding::{charset_for, encode_input, is_utf8};

/// A local PTY session plus the charset its shell speaks (for input encoding).
struct LocalSession {
    pty: PtySession,
    encoding: &'static Encoding,
}

#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, LocalSession>>,
}

/// Parse multi-line `KEY=value` env text into pairs. Blank lines and `#`
/// comments are ignored; the first `=` separates key from value.
fn parse_env(text: Option<&str>) -> Vec<(String, String)> {
    let Some(text) = text else { return Vec::new() };
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let idx = line.find('=')?;
            let key = line[..idx].trim().to_string();
            if key.is_empty() {
                return None;
            }
            Some((key, line[idx + 1..].to_string()))
        })
        .collect()
}

/// Create a PTY session for `session_id` and start streaming its output.
///
/// For a saved host: `env` carries its environment variables (multi-line
/// `KEY=value` text), `startup_cmd` is typed into the shell once it starts,
/// `encoding` is the shell's charset, and `protocol`/`wsl_distro` select WSL.
/// The plain "new local terminal" passes none of these.
#[tauri::command]
pub fn terminal_create(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
    env: Option<String>,
    startup_cmd: Option<String>,
    encoding: Option<String>,
    protocol: Option<String>,
    wsl_distro: Option<String>,
    local_shell: Option<String>,
) -> Result<(), String> {
    let size = TermSize { rows, cols };
    let env_pairs = parse_env(env.as_deref());
    let charset = charset_for(encoding.as_deref());

    let is_wsl = protocol.as_deref().map(|p| p.eq_ignore_ascii_case("WSL")).unwrap_or(false);
    let mut session = if let Some((cmd, args)) = local_shell
        .as_deref()
        .filter(|s| !s.is_empty())
        .and_then(crate::shells_cmd::resolve_shell)
    {
        PtySession::spawn_program(&cmd, &args, size, &env_pairs)
    } else if is_wsl && cfg!(windows) {
        // Launch `wsl.exe [-d <distro>]`. wsl.exe lives in System32 which is on PATH.
        let mut args: Vec<String> = Vec::new();
        if let Some(distro) = wsl_distro.filter(|s| !s.trim().is_empty()) {
            args.push("-d".to_string());
            args.push(distro);
        }
        PtySession::spawn_program("wsl.exe", &args, size, &env_pairs)
    } else {
        PtySession::spawn_default_shell_with(size, &env_pairs)
    }
    .map_err(|e| e.to_string())?;

    let mut reader = session
        .take_reader()
        .ok_or_else(|| "pty reader already taken".to_string())?;

    state
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), LocalSession { pty: session, encoding: charset });

    // Run the configured startup command, if any, by feeding it to the shell
    // (encoded in the shell's charset).
    if let Some(cmd) = startup_cmd.filter(|s| !s.trim().is_empty()) {
        if let Some(s) = state.sessions.lock().unwrap().get_mut(&session_id) {
            let bytes = encode_input(s.encoding, &format!("{cmd}\r"));
            let _ = s.pty.write(&bytes);
        }
    }

    let out_event  = format!("terminal://output/{session_id}");
    let exit_event = format!("terminal://exit/{session_id}");

    std::thread::spawn(move || {
        let engine = base64::engine::general_purpose::STANDARD;
        let utf8 = is_utf8(charset);
        let mut decoder = charset.new_decoder();
        let mut buf = [0u8; 8192];
        // Windows ConPTY can return Ok(0) or transient errors at any point
        // (not just at startup) while the process is still alive.  Retry up to
        // MAX_RETRIES consecutive empty/error reads before treating it as EOF.
        // The counter resets whenever real data arrives.
        let mut empty_retries = 0u32;
        const MAX_RETRIES: u32 = 20; // 20 × 50 ms = 1 s
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    if empty_retries < MAX_RETRIES {
                        empty_retries += 1;
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        continue;
                    }
                    break;
                }
                Ok(n) => {
                    empty_retries = 0;
                    // UTF-8 passes through; other charsets are decoded into a
                    // UTF-8 string (streaming, so split multibyte chars survive
                    // a read boundary) before going to the frontend.
                    let encoded = if utf8 {
                        engine.encode(&buf[..n])
                    } else {
                        let mut s = String::with_capacity(n * 2);
                        let _ = decoder.decode_to_string(&buf[..n], &mut s, false);
                        engine.encode(s.as_bytes())
                    };
                    if app.emit(&out_event, encoded).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    if empty_retries < MAX_RETRIES {
                        empty_retries += 1;
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        continue;
                    }
                    break;
                }
            }
        }
        let _ = app.emit(&exit_event, ());
    });

    Ok(())
}

/// Forward user input to the PTY identified by `session_id`.
#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut guard = state.sessions.lock().unwrap();
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let bytes = encode_input(session.encoding, &data);
    session.pty.write(&bytes).map_err(|e| e.to_string())
}

/// Resize the PTY viewport.
#[tauri::command]
pub fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let guard = state.sessions.lock().unwrap();
    if let Some(session) = guard.get(&session_id) {
        session
            .pty
            .resize(TermSize { rows, cols })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Terminate and remove the session.
#[tauri::command]
pub fn terminal_close(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&session_id) {
        let _ = session.pty.kill();
    }
    Ok(())
}

/// List installed WSL distribution names (Windows only). Used to populate the
/// distribution picker when editing a WSL host.
#[tauri::command]
pub fn wsl_list_distributions() -> Vec<String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // `wsl.exe -l -q` prints one distro name per line, encoded in UTF-16LE.
        let output = std::process::Command::new("wsl.exe")
            .args(["-l", "-q"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(out) = output {
            let (text, _, _) = encoding_rs::UTF_16LE.decode(&out.stdout);
            return text
                .lines()
                .map(|l| l.trim().trim_matches('\u{0}').trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
        }
        Vec::new()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

pub fn init(app: &AppHandle) {
    app.manage(TerminalState::default());
}
