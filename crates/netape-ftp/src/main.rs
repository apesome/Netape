//! Netape FTP transfer plugin — sidecar binary.
//!
//! Speaks line-delimited JSON-RPC over stdio with the Netape plugin host.
//! Each process owns one FTP control connection. Requests carry an `id`;
//! responses echo it (`{id, ok, result|error}`). Transfer progress is reported
//! out-of-band as id-less notifications (`{method:"progress", params:{...}}`).

use std::io::{self, BufRead, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};
use suppaftp::list::File as FtpFile;
use suppaftp::types::FileType;
use suppaftp::{FtpError, FtpStream, Mode};

type Out = Arc<Mutex<io::Stdout>>;

fn write_json(out: &Out, v: &Value) {
    if let Ok(s) = serde_json::to_string(v) {
        let mut o = out.lock().unwrap();
        let _ = writeln!(o, "{s}");
        let _ = o.flush();
    }
}

fn notify_progress(out: &Out, tid: &str, transferred: u64, total: u64) {
    write_json(
        out,
        &json!({
            "method": "progress",
            "params": { "transferId": tid, "transferred": transferred, "total": total }
        }),
    );
}

fn main() {
    let stdin = io::stdin();
    let out: Out = Arc::new(Mutex::new(io::stdout()));
    let ftp: Arc<Mutex<Option<FtpStream>>> = Arc::new(Mutex::new(None));

    spawn_heartbeat(Arc::clone(&ftp));

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let id = req.get("id").and_then(Value::as_u64).unwrap_or(0);
        let method = req.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let params = req.get("params").cloned().unwrap_or(Value::Null);

        let resp = {
            let mut guard = ftp.lock().unwrap();
            match dispatch(&method, &params, &mut guard, &out) {
                Ok(v) => json!({ "id": id, "ok": true, "result": v }),
                Err(e) => json!({ "id": id, "ok": false, "error": e }),
            }
        };
        write_json(&out, &resp);

        if method == "close" {
            break;
        }
    }
}

/// Periodically NOOP the control connection. This keeps it alive *and* detects
/// a server-side drop quickly: on failure the process exits, which the plugin
/// host turns into an `ftp://exit` event so the UI marks the session offline
/// without waiting for the next user action.
fn spawn_heartbeat(ftp: Arc<Mutex<Option<FtpStream>>>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let mut guard = ftp.lock().unwrap();
        if let Some(stream) = guard.as_mut() {
            if stream.noop().is_err() {
                std::process::exit(0);
            }
        }
    });
}

fn dispatch(method: &str, p: &Value, ftp: &mut Option<FtpStream>, out: &Out) -> Result<Value, String> {
    match method {
        "connect" => cmd_connect(ftp, p),
        "list" => cmd_list(ftp, p),
        "stat" => cmd_stat(ftp, p),
        "mkdir" => {
            stream(ftp)?.mkdir(s(p, "path")).map_err(es)?;
            Ok(Value::Null)
        }
        "rename" => {
            stream(ftp)?.rename(s(p, "from"), s(p, "to")).map_err(es)?;
            Ok(Value::Null)
        }
        "remove" => cmd_remove(ftp, p),
        "download" => cmd_download(ftp, p, out),
        "upload" => cmd_upload(ftp, p, out),
        "close" => {
            if let Some(mut f) = ftp.take() {
                let _ = f.quit();
            }
            Ok(Value::Null)
        }
        other => Err(format!("unknown method: {other}")),
    }
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn es(e: FtpError) -> String {
    e.to_string()
}

fn s<'a>(p: &'a Value, key: &str) -> &'a str {
    p.get(key).and_then(Value::as_str).unwrap_or("")
}

fn stream(ftp: &mut Option<FtpStream>) -> Result<&mut FtpStream, String> {
    ftp.as_mut().ok_or_else(|| "not connected".to_string())
}

fn basename(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

// ── commands ────────────────────────────────────────────────────────────────

fn cmd_connect(ftp: &mut Option<FtpStream>, p: &Value) -> Result<Value, String> {
    let host = s(p, "host");
    let port = p.get("port").and_then(Value::as_u64).unwrap_or(21) as u16;
    let user = {
        let u = s(p, "username");
        if u.is_empty() { "anonymous".to_string() } else { u.to_string() }
    };
    let pass = s(p, "password").to_string();
    let passive = p.get("passive").and_then(Value::as_bool).unwrap_or(true);

    let mut st = FtpStream::connect((host, port)).map_err(es)?;
    st.set_mode(if passive { Mode::Passive } else { Mode::Active });
    st.login(&user, &pass).map_err(es)?;
    st.transfer_type(FileType::Binary).map_err(es)?;
    let cwd = st.pwd().map_err(es)?;
    *ftp = Some(st);
    Ok(json!({ "cwd": cwd }))
}

fn cmd_list(ftp: &mut Option<FtpStream>, p: &Value) -> Result<Value, String> {
    let f = stream(ftp)?;
    let path = p.get("path").and_then(Value::as_str);
    let lines = f.list(path).map_err(es)?;
    let mut entries = Vec::new();
    for line in &lines {
        // Unparseable lines (e.g. a "total 4" header) are skipped.
        if let Ok(file) = FtpFile::try_from(line.as_str()) {
            let modified = file
                .modified()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            entries.push(json!({
                "name": file.name(),
                "isDir": file.is_directory(),
                "isSymlink": file.is_symlink(),
                "size": file.size() as u64,
                "modified": modified,
            }));
        }
    }
    Ok(json!({ "entries": entries }))
}

fn cmd_stat(ftp: &mut Option<FtpStream>, p: &Value) -> Result<Value, String> {
    let f = stream(ftp)?;
    let path = s(p, "path");
    // FTP has no portable stat; SIZE succeeds for files, fails for dirs.
    let (is_dir, size) = match f.size(path) {
        Ok(sz) => (false, sz as u64),
        Err(_) => (true, 0),
    };
    Ok(json!({ "name": basename(path), "isDir": is_dir, "isSymlink": false, "size": size, "modified": 0 }))
}

fn cmd_remove(ftp: &mut Option<FtpStream>, p: &Value) -> Result<Value, String> {
    let f = stream(ftp)?;
    let path = s(p, "path");
    if p.get("isDir").and_then(Value::as_bool).unwrap_or(false) {
        f.rmdir(path).map_err(es)?;
    } else {
        f.rm(path).map_err(es)?;
    }
    Ok(Value::Null)
}

fn cmd_download(ftp: &mut Option<FtpStream>, p: &Value, out: &Out) -> Result<Value, String> {
    let f = stream(ftp)?;
    let remote = s(p, "remotePath").to_string();
    let local = s(p, "localPath").to_string();
    let tid = s(p, "transferId").to_string();
    let total = f.size(&remote).map(|n| n as u64).unwrap_or(0);

    let mut local_file = std::fs::File::create(&local).map_err(|e| e.to_string())?;
    let mut transferred: u64 = 0;
    let mut last_notify: u64 = 0;
    f.retr(&remote, |reader| {
        let mut buf = [0u8; 65536];
        loop {
            let n = reader.read(&mut buf).map_err(FtpError::ConnectionError)?;
            if n == 0 {
                break;
            }
            local_file.write_all(&buf[..n]).map_err(FtpError::ConnectionError)?;
            transferred += n as u64;
            if transferred - last_notify >= 16_384 {
                notify_progress(out, &tid, transferred, total);
                last_notify = transferred;
            }
        }
        Ok(())
    })
    .map_err(es)?;
    let final_total = total.max(transferred);
    notify_progress(out, &tid, transferred, final_total);
    Ok(json!({ "transferred": transferred, "total": final_total }))
}

fn cmd_upload(ftp: &mut Option<FtpStream>, p: &Value, out: &Out) -> Result<Value, String> {
    let f = stream(ftp)?;
    let local = s(p, "localPath").to_string();
    let remote = s(p, "remotePath").to_string();
    let tid = s(p, "transferId").to_string();

    let file = std::fs::File::open(&local).map_err(|e| e.to_string())?;
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut reader = ProgressReader { inner: file, transferred: 0, total, tid, out: Arc::clone(out), last: 0 };
    let n = f.put_file(&remote, &mut reader).map_err(es)?;
    Ok(json!({ "transferred": n, "total": total }))
}

/// A `Read` wrapper that reports upload progress as it is consumed.
struct ProgressReader {
    inner: std::fs::File,
    transferred: u64,
    total: u64,
    tid: String,
    out: Out,
    last: u64,
}

impl Read for ProgressReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        if n > 0 {
            self.transferred += n as u64;
            if self.transferred - self.last >= 262_144 || self.transferred >= self.total {
                notify_progress(&self.out, &self.tid, self.transferred, self.total);
                self.last = self.transferred;
            }
        }
        Ok(n)
    }
}
