//! Netape SMB transfer plugin — sidecar binary.
//!
//! This sidecar intentionally avoids extra SMB crates and uses the OS SMB
//! session plus UNC filesystem access on Windows. It speaks the same
//! line-delimited JSON-RPC shape as the FTP plugin so the Netape plugin host
//! can manage it uniformly.

use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use serde_json::{json, Value};

type Out = Arc<Mutex<io::Stdout>>;

#[derive(Default)]
struct SmbSession {
    root: PathBuf,
    unc: String,
    connected: bool,
}

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
    let mut session = SmbSession::default();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let id = req.get("id").and_then(Value::as_u64).unwrap_or(0);
        let method = req.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let params = req.get("params").cloned().unwrap_or(Value::Null);

        let resp = match dispatch(&method, &params, &mut session, &out) {
            Ok(v) => json!({ "id": id, "ok": true, "result": v }),
            Err(e) => json!({ "id": id, "ok": false, "error": e }),
        };
        write_json(&out, &resp);

        if method == "close" {
            break;
        }
    }
}

fn dispatch(method: &str, p: &Value, session: &mut SmbSession, out: &Out) -> Result<Value, String> {
    match method {
        "connect" => cmd_connect(session, p),
        "list_shares" => cmd_list_shares(p),
        "list" => cmd_list(session, p),
        "stat" => cmd_stat(session, p),
        "mkdir" => {
            fs::create_dir_all(resolve_remote(session, s(p, "path"))?).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "rename" => {
            fs::rename(resolve_remote(session, s(p, "from"))?, resolve_remote(session, s(p, "to"))?)
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "remove" => cmd_remove(session, p),
        "download" => cmd_download(session, p, out),
        "download_dir" => cmd_download_dir(session, p, out),
        "upload" => cmd_upload(session, p, out),
        "upload_dir" => cmd_upload_dir(session, p, out),
        "close" => {
            disconnect_share(session);
            Ok(Value::Null)
        }
        other => Err(format!("unknown method: {other}")),
    }
}

fn s<'a>(p: &'a Value, key: &str) -> &'a str {
    p.get(key).and_then(Value::as_str).unwrap_or("")
}

fn ensure_connected(session: &SmbSession) -> Result<(), String> {
    if session.connected {
        Ok(())
    } else {
        Err("not connected".to_string())
    }
}

fn basename(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

fn resolve_remote(session: &SmbSession, path: &str) -> Result<PathBuf, String> {
    ensure_connected(session)?;
    let mut pb = session.root.clone();
    let logical = if path.is_empty() { "/" } else { path };
    for comp in Path::new(&logical.replace('/', "\\")).components() {
        match comp {
            Component::Prefix(_) | Component::RootDir | Component::CurDir => {}
            Component::Normal(seg) => pb.push(seg),
            Component::ParentDir => return Err("parent paths are not allowed".to_string()),
        }
    }
    Ok(pb)
}

fn logical_remote(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim();
    if trimmed.is_empty() || trimmed == "/" {
        "/".to_string()
    } else {
        format!("/{}", trimmed.trim_start_matches('/'))
    }
}

fn cmd_connect(session: &mut SmbSession, p: &Value) -> Result<Value, String> {
    let host = s(p, "host").trim();
    let share = s(p, "share").trim_matches('\\').trim_matches('/').trim();
    let username = s(p, "username").trim();
    let password = s(p, "password");
    let domain = s(p, "domain").trim();

    if host.is_empty() {
        return Err("missing host".to_string());
    }
    if share.is_empty() {
        return Err("missing share".to_string());
    }

    let unc = format!(r"\\{}\{}", host, share);
    disconnect_share(session);
    connect_share(&unc, username, password, domain)?;

    let root = PathBuf::from(&unc);
    if !root.exists() {
        return Err(format!("share is unavailable: {unc}"));
    }

    session.root = root;
    session.unc = unc;
    session.connected = true;
    Ok(json!({ "cwd": "/" }))
}

fn cmd_list_shares(p: &Value) -> Result<Value, String> {
    let host = s(p, "host").trim();
    let username = s(p, "username").trim();
    let password = s(p, "password");
    let domain = s(p, "domain").trim();
    if host.is_empty() {
        return Err("missing host".to_string());
    }

    let shares = list_shares(host, username, password, domain)?;
    Ok(json!({ "shares": shares }))
}

fn cmd_list(session: &mut SmbSession, p: &Value) -> Result<Value, String> {
    let dir = resolve_remote(session, s(p, "path"))?;
    let mut entries = Vec::new();
    for item in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let meta = item.metadata().map_err(|e| e.to_string())?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        entries.push(json!({
            "name": item.file_name().to_string_lossy().to_string(),
            "isDir": meta.is_dir(),
            "isSymlink": item.file_type().map(|ft| ft.is_symlink()).unwrap_or(false),
            "size": if meta.is_file() { meta.len() } else { 0 },
            "modified": modified,
        }));
    }
    entries.sort_by(|a, b| {
        let ad = a.get("isDir").and_then(Value::as_bool).unwrap_or(false);
        let bd = b.get("isDir").and_then(Value::as_bool).unwrap_or(false);
        let an = a.get("name").and_then(Value::as_str).unwrap_or("");
        let bn = b.get("name").and_then(Value::as_str).unwrap_or("");
        bd.cmp(&ad).reverse().then_with(|| an.cmp(bn))
    });
    Ok(json!({ "entries": entries }))
}

fn cmd_stat(session: &mut SmbSession, p: &Value) -> Result<Value, String> {
    let path = s(p, "path");
    let full = resolve_remote(session, path)?;
    let meta = fs::metadata(&full).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(json!({
        "name": basename(path),
        "isDir": meta.is_dir(),
        "isSymlink": false,
        "size": if meta.is_file() { meta.len() } else { 0 },
        "modified": modified,
    }))
}

fn cmd_remove(session: &mut SmbSession, p: &Value) -> Result<Value, String> {
    let full = resolve_remote(session, s(p, "path"))?;
    if p.get("isDir").and_then(Value::as_bool).unwrap_or(false) {
        fs::remove_dir_all(full).map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(full).map_err(|e| e.to_string())?;
    }
    Ok(Value::Null)
}

fn cmd_download(session: &mut SmbSession, p: &Value, out: &Out) -> Result<Value, String> {
    let src = resolve_remote(session, s(p, "remotePath"))?;
    let dst = PathBuf::from(s(p, "localPath"));
    let tid = s(p, "transferId").to_string();
    copy_with_progress(&src, &dst, &tid, out)
}

fn cmd_download_dir(session: &mut SmbSession, p: &Value, out: &Out) -> Result<Value, String> {
    let src = resolve_remote(session, s(p, "remoteDir"))?;
    let local_base = PathBuf::from(s(p, "localBase"));
    let dir_name = basename(s(p, "remoteDir"));
    let dst = local_base.join(dir_name);
    let tid = s(p, "transferId").to_string();
    copy_dir_with_progress(&src, &dst, logical_remote(s(p, "remoteDir")), &tid, out)
}

fn cmd_upload(session: &mut SmbSession, p: &Value, out: &Out) -> Result<Value, String> {
    let src = PathBuf::from(s(p, "localPath"));
    let dst = resolve_remote(session, s(p, "remotePath"))?;
    let tid = s(p, "transferId").to_string();
    copy_with_progress(&src, &dst, &tid, out)
}

fn cmd_upload_dir(session: &mut SmbSession, p: &Value, out: &Out) -> Result<Value, String> {
    let src = PathBuf::from(s(p, "localDir"));
    let remote_base = resolve_remote(session, s(p, "remoteBase"))?;
    let dir_name = src
        .file_name()
        .map(|v| v.to_string_lossy().to_string())
        .ok_or_else(|| "invalid local directory".to_string())?;
    let dst = remote_base.join(&dir_name);
    let tid = s(p, "transferId").to_string();
    copy_dir_with_progress(&src, &dst, format!("/{}", dir_name), &tid, out)
}

fn copy_with_progress(src: &Path, dst: &Path, tid: &str, out: &Out) -> Result<Value, String> {
    let total = fs::metadata(src).map_err(|e| e.to_string())?.len();
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut input = fs::File::open(src).map_err(|e| e.to_string())?;
    let mut output = fs::File::create(dst).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 262_144];
    let mut transferred = 0u64;
    loop {
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        transferred += n as u64;
        notify_progress(out, tid, transferred, total);
    }
    Ok(json!({ "transferred": transferred, "total": total }))
}

fn scan_dir_total(path: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    for item in fs::read_dir(path).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let meta = item.metadata().map_err(|e| e.to_string())?;
        if meta.is_dir() {
            total += scan_dir_total(&item.path())?;
        } else if meta.is_file() {
            total += meta.len();
        }
    }
    Ok(total)
}

fn copy_dir_with_progress(
    src_dir: &Path,
    dst_dir: &Path,
    logical_root: String,
    tid: &str,
    out: &Out,
) -> Result<Value, String> {
    let total = scan_dir_total(src_dir)?;
    let mut transferred = 0u64;
    copy_dir_recursive(src_dir, dst_dir, &logical_root, tid, out, total, &mut transferred)?;
    notify_progress(out, tid, transferred, total);
    Ok(json!({ "transferred": transferred, "total": total }))
}

fn copy_dir_recursive(
    src_dir: &Path,
    dst_dir: &Path,
    logical_root: &str,
    tid: &str,
    out: &Out,
    total: u64,
    transferred: &mut u64,
) -> Result<(), String> {
    fs::create_dir_all(dst_dir).map_err(|e| e.to_string())?;
    for item in fs::read_dir(src_dir).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let src_path = item.path();
        let dst_path = dst_dir.join(item.file_name());
        let meta = item.metadata().map_err(|e| e.to_string())?;
        let logical = if logical_root == "/" {
            format!("/{}", item.file_name().to_string_lossy())
        } else {
            format!("{}/{}", logical_root.trim_end_matches('/'), item.file_name().to_string_lossy())
        };
        if meta.is_dir() {
            copy_dir_recursive(&src_path, &dst_path, &logical, tid, out, total, transferred)?;
            write_json(
                out,
                &json!({
                    "method": "file",
                    "params": {
                        "transferId": tid,
                        "rel_path": logical,
                        "name": item.file_name().to_string_lossy().to_string(),
                        "done": true,
                        "transferred": 0u64,
                        "total": 0u64,
                    }
                }),
            );
        } else if meta.is_file() {
            copy_file_with_nested_progress(
                &src_path,
                &dst_path,
                &logical,
                tid,
                out,
                total,
                transferred,
            )?;
        }
    }
    Ok(())
}

fn copy_file_with_nested_progress(
    src: &Path,
    dst: &Path,
    logical: &str,
    tid: &str,
    out: &Out,
    total: u64,
    transferred: &mut u64,
) -> Result<(), String> {
    let file_total = fs::metadata(src).map_err(|e| e.to_string())?.len();
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut input = fs::File::open(src).map_err(|e| e.to_string())?;
    let mut output = fs::File::create(dst).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 262_144];
    let mut file_transferred = 0u64;
    loop {
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        output.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        let chunk = n as u64;
        file_transferred += chunk;
        *transferred += chunk;
        write_json(
            out,
            &json!({
                "method": "file",
                "params": {
                    "transferId": tid,
                    "rel_path": logical,
                    "name": basename(logical),
                    "done": false,
                    "transferred": file_transferred,
                    "total": file_total,
                }
            }),
        );
        notify_progress(out, tid, *transferred, total);
    }
    write_json(
        out,
        &json!({
            "method": "file",
            "params": {
                "transferId": tid,
                "rel_path": logical,
                "name": basename(logical),
                "done": true,
                "transferred": file_total,
                "total": file_total,
            }
        }),
    );
    Ok(())
}

#[cfg(windows)]
fn connect_share(unc: &str, username: &str, password: &str, domain: &str) -> Result<(), String> {
    let account = if username.is_empty() {
        String::new()
    } else if domain.is_empty() {
        username.to_string()
    } else {
        format!(r"{domain}\{username}")
    };

    let run = |delete_first: bool| -> Result<(), String> {
        if delete_first {
            let _ = Command::new("net")
                .args(["use", unc, "/delete", "/y"])
                .output();
        }
        let mut cmd = Command::new("net");
        cmd.arg("use").arg(unc);
        if !password.is_empty() {
            cmd.arg(password);
        } else {
            cmd.arg("");
        }
        if !account.is_empty() {
            cmd.arg(format!("/user:{account}"));
        }
        cmd.arg("/persistent:no");
        let out = cmd.output().map_err(|e| format!("failed to run net use: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string().if_empty_then(String::from_utf8_lossy(&out.stdout).trim().to_string()))
        }
    };

    run(false).or_else(|_| run(true))
}

#[cfg(not(windows))]
fn connect_share(_unc: &str, _username: &str, _password: &str, _domain: &str) -> Result<(), String> {
    Err("SMB plugin is currently supported on Windows only".to_string())
}

#[cfg(windows)]
fn disconnect_share(session: &mut SmbSession) {
    if !session.unc.is_empty() {
        let _ = Command::new("net")
            .args(["use", &session.unc, "/delete", "/y"])
            .output();
    }
    session.connected = false;
}

#[cfg(windows)]
fn list_shares(host: &str, username: &str, password: &str, domain: &str) -> Result<Vec<String>, String> {
    let ipc = format!(r"\\{}\IPC$", host);
    let _guard = NetUseGuard::connect(&ipc, username, password, domain).ok();

    let out = Command::new("net")
        .args(["view", &format!(r"\\{}", host)])
        .output()
        .map_err(|e| format!("failed to run net view: {e}"))?;
    if !out.status.success() {
        return Err(
            String::from_utf8_lossy(&out.stderr)
                .trim()
                .to_string()
                .if_empty_then(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        );
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut shares = Vec::new();
    let mut in_table = false;
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("---") {
            in_table = true;
            continue;
        }
        if !in_table {
            continue;
        }
        if trimmed.starts_with("The command completed successfully")
            || trimmed.starts_with("命令成功完成")
        {
            break;
        }
        if let Some(name) = trimmed.split_whitespace().next() {
            if !name.is_empty() {
                shares.push(name.to_string());
            }
        }
    }
    shares.sort();
    shares.dedup();
    Ok(shares)
}

#[cfg(not(windows))]
fn list_shares(_host: &str, _username: &str, _password: &str, _domain: &str) -> Result<Vec<String>, String> {
    Err("SMB share discovery is currently supported on Windows only".to_string())
}

#[cfg(windows)]
struct NetUseGuard {
    unc: String,
    active: bool,
}

#[cfg(windows)]
impl NetUseGuard {
    fn connect(unc: &str, username: &str, password: &str, domain: &str) -> Result<Self, String> {
        connect_share(unc, username, password, domain)?;
        Ok(Self {
            unc: unc.to_string(),
            active: true,
        })
    }
}

#[cfg(windows)]
impl Drop for NetUseGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = Command::new("net")
                .args(["use", &self.unc, "/delete", "/y"])
                .output();
        }
    }
}

#[cfg(not(windows))]
fn disconnect_share(session: &mut SmbSession) {
    session.connected = false;
}

trait StringExt {
    fn if_empty_then(self, fallback: String) -> String;
}

impl StringExt for String {
    fn if_empty_then(self, fallback: String) -> String {
        if self.trim().is_empty() { fallback } else { self }
    }
}
