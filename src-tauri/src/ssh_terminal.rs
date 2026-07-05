//! Tauri command bridge: xterm.js ↔ SSH PTY.
//!
//! # Command / event contract
//!
//! ```text
//! invoke("ssh_connect", { params: { host, port, username, authType, password?,
//!                                   rows, cols, heartbeat?, env?,
//!                                   proxyType?, proxyHost?, proxyPort?,
//!                                   proxyUser?, proxyPass? } })
//!   → session_id: String
//!
//! invoke("ssh_write",  { sessionId, data: String })  → ()
//! invoke("ssh_resize", { sessionId, rows, cols })    → ()
//! invoke("ssh_close",  { sessionId })               → ()
//!
//! event "ssh://output/<sessionId>"  payload: base64
//! event "ssh://exit/<sessionId>"    payload: Option<u32>
//! ```

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use netape_domain::host::{AuthenticationType, HostManager};
use netape_domain::keymgr::KeyManager;
use netape_protocol::ssh::{self, PtyHandle, PtySize, SshConfig, SshSession};
use netape_protocol::ssh::config::{AuthMethod, ProxyConfig, TunnelingKind, TunnelingRule};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

use crate::app_state::AppState;

/// A single port-forwarding rule sent by the frontend.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelingParam {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,         // "Local" | "Remote" | "Dynamic"
    pub source_host: String,
    pub source_port: u16,
    pub destination_host: String,
    pub destination_port: u16,
}

/// All parameters sent by the frontend for a new SSH connection.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    // Remote target
    pub host:       String,
    pub port:       u16,
    pub username:   String,

    // Authentication
    /// "Password" | "PublicKey" | "KeyboardInteractive" | "SshAgent" | "No"
    pub auth_type:   Option<String>,
    /// For Password auth: the password. For PublicKey auth: the selected key id
    /// from the key manager (empty = auto-select / try all keys).
    pub password:    Option<String>,

    // Terminal
    pub rows: u16,
    pub cols: u16,

    // Options
    pub heartbeat:   Option<u64>,    // seconds
    /// "KEY=val\nKEY2=val2" multi-line string
    pub env:         Option<String>,
    pub startup_cmd: Option<String>,
    /// Terminal charset (e.g. "UTF-8", "GBK"); defaults to UTF-8.
    pub encoding:    Option<String>,

    // Proxy
    pub proxy_type:  Option<String>, // "HTTP" | "SOCKS5" | "NO"
    pub proxy_host:  Option<String>,
    pub proxy_port:  Option<u16>,
    pub proxy_user:  Option<String>,
    pub proxy_pass:  Option<String>,

    // Jump hosts (ordered list of host IDs to traverse before reaching target)
    pub jump_host_ids: Option<Vec<String>>,

    // Port-forwarding rules to start immediately after connecting.
    pub tunnelings: Option<Vec<TunnelingParam>>,
}

struct ActiveSession {
    ssh:      SshSession,   // kept alive + shared with SFTP
    handle:   PtyHandle,
    encoding: &'static encoding_rs::Encoding,
}

#[derive(Default)]
pub struct SshTerminalState {
    sessions: Mutex<HashMap<String, ActiveSession>>,
}

impl SshTerminalState {
    /// Clone the SSH session handle so the SFTP layer can open new channels
    /// on the same underlying TCP connection.
    pub fn clone_ssh(&self, session_id: &str) -> Option<SshSession> {
        self.sessions.lock().unwrap().get(session_id).map(|s| s.ssh.clone())
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ssh_connect(
    app:        AppHandle,
    state:      State<'_, SshTerminalState>,
    app_state:  State<'_, AppState>,
    kbi_state:  State<'_, crate::ssh_auth::KbiState>,
    params:     ConnectParams,
) -> Result<String, String> {
    let mut config = build_config(&params);

    // Resolve main-host public keys from the key manager. For PublicKey auth the
    // frontend stores the selected key id in `password` (empty = auto-select).
    if params.auth_type.as_deref() == Some("PublicKey") {
        let key_mgr = KeyManager::new(&app_state.store, &app_state.owner);
        config.auth = AuthMethod::PublicKey {
            keys: crate::ssh_auth::resolve_pubkeys(&key_mgr, params.password.as_deref()),
        };
    }

    // Resolve jump host IDs → SshConfig chain
    if let Some(ids) = &params.jump_host_ids {
        let host_mgr = HostManager::new(&app_state.store, &app_state.owner);
        let key_mgr  = KeyManager::new(&app_state.store, &app_state.owner);
        let mut jump_configs: Vec<Box<SshConfig>> = Vec::new();
        for id in ids {
            let host = host_mgr.get(id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("jump host not found: {id}"))?;
            let pem = if host.authentication.auth_type == AuthenticationType::PublicKey {
                key_mgr.get(&host.authentication.password)
                    .ok().flatten()
                    .map(|kp| String::from_utf8_lossy(
                        &base64::engine::general_purpose::STANDARD
                            .decode(&kp.private_key)
                            .unwrap_or_default()
                    ).into_owned())
            } else {
                None
            };
            jump_configs.push(Box::new(SshConfig::from_host(&host, pem)));
        }
        config.jump_host_configs = jump_configs;
    }

    let startup_cmd = params.startup_cmd.clone().filter(|s| !s.is_empty());
    let tunneling_params = params.tunnelings.unwrap_or_default();

    let responder = kbi_state.make_responder(app.clone());
    let session = ssh::connect_with(&config, Some(responder))
        .await
        .map_err(|e| e.to_string())?;

    // Start configured port-forwarding rules right after auth.
    for t in &tunneling_params {
        let kind = match t.kind.as_str() {
            "Remote"  => TunnelingKind::Remote,
            "Dynamic" => TunnelingKind::Dynamic,
            _         => TunnelingKind::Local,
        };
        let rule = TunnelingRule {
            name: t.name.clone(),
            kind,
            src_host: t.source_host.clone(),
            src_port: t.source_port,
            dst_host: t.destination_host.clone(),
            dst_port: t.destination_port,
        };
        if let Err(e) = session.start_forwarding(&rule).await {
            tracing::warn!("ssh: tunnel '{}' failed to start: {e}", t.name);
        }
    }

    let pty = session
        .open_shell(PtySize { rows: params.rows, cols: params.cols })
        .await
        .map_err(|e| e.to_string())?;

    let session_id = Uuid::new_v4().to_string();

    let id_data  = session_id.clone();
    let id_exit  = session_id.clone();
    let app_data = app.clone();
    let app_exit = app.clone();
    let engine   = base64::engine::general_purpose::STANDARD;

    let charset = crate::encoding::charset_for(params.encoding.as_deref());
    let utf8 = crate::encoding::is_utf8(charset);
    let mut decoder = charset.new_decoder();

    let handle = pty.spawn(
        move |data: &[u8]| {
            // UTF-8 passes through; other charsets decode to a UTF-8 string
            // (streaming) before reaching the frontend.
            let encoded = if utf8 {
                engine.encode(data)
            } else {
                let mut s = String::with_capacity(data.len() * 2);
                let _ = decoder.decode_to_string(data, &mut s, false);
                engine.encode(s.as_bytes())
            };
            let _ = app_data.emit(&format!("ssh://output/{id_data}"), encoded);
        },
        move |exit_code: Option<u32>| {
            let _ = app_exit.emit(&format!("ssh://exit/{id_exit}"), exit_code);
        },
    );

    // Send startup command after shell is ready (encoded in the shell's charset).
    if let Some(cmd) = startup_cmd {
        let _ = handle
            .write(&crate::encoding::encode_input(charset, &format!("{cmd}\r")))
            .await;
    }

    state
        .sessions
        .lock()
        .unwrap()
        .insert(session_id.clone(), ActiveSession { ssh: session, handle, encoding: charset });

    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_write(
    state:      State<'_, SshTerminalState>,
    session_id: String,
    data:       String,
) -> Result<(), String> {
    let (handle, charset) = {
        let guard = state.sessions.lock().unwrap();
        let s = guard
            .get(&session_id)
            .ok_or_else(|| format!("session not found: {session_id}"))?;
        (s.handle.clone(), s.encoding)
    };
    let bytes = crate::encoding::encode_input(charset, &data);
    handle.write(&bytes).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_resize(
    state:      State<'_, SshTerminalState>,
    session_id: String,
    rows:       u16,
    cols:       u16,
) -> Result<(), String> {
    let handle = clone_handle(&state, &session_id)?;
    handle.resize(PtySize { rows, cols }).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_close(
    state:      State<'_, SshTerminalState>,
    session_id: String,
) -> Result<(), String> {
    let entry = state.sessions.lock().unwrap().remove(&session_id);
    if let Some(active) = entry {
        active.handle.close().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn ssh_get_cwd(
    state:      State<'_, SshTerminalState>,
    session_id: String,
) -> Result<String, String> {
    let ssh = state
        .clone_ssh(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let result = ssh.exec_cmd("pwd").await.map_err(|e| e.to_string())?;
    Ok(result.stdout.trim().to_string())
}

// ---------------------------------------------------------------------------
// Server stats
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStat {
    pub mount: String,
    pub used:  f64,   // GB
    pub total: f64,   // GB
    pub pct:   u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawNetIface {
    pub name: String,
    pub rx:   u64,
    pub tx:   u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid:     String,
    pub mem_pct: f32,
    pub cmd:     String,
}

/// Raw counters returned to the frontend.  The frontend computes deltas
/// (CPU %, network speeds) so no Rust-side state is needed.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawServerStats {
    pub cpu_cores:    u32,
    pub cpu_total:    u64,
    pub cpu_idle:     u64,
    pub cpu_pct:      f32,
    pub cpu_per_core: Vec<[u64; 2]>,
    pub mem_total:   u64,
    pub mem_free:    u64,
    pub mem_buffers: u64,
    pub mem_cached:  u64,
    pub swap_total:  u64,
    pub swap_free:   u64,
    pub disks:       Vec<DiskStat>,
    pub net_ifaces:  Vec<RawNetIface>,
    pub top_procs:   Vec<ProcessInfo>,
    pub ts:          u64,
}

const STATS_SCRIPT: &str = r#"#!/bin/sh
_os=$(uname -s 2>/dev/null)
# top-10 processes by memory (pid:pct:cmd separated by ;)
_ps_cmd() { ps -eo pid,%mem,comm --sort=-%mem 2>/dev/null || ps -eo pid,%mem,comm 2>/dev/null | sort -k2 -rn; }
_p=$(_ps_cmd | awk 'NR>1&&NR<=11{cmd=$3;gsub(/;/,"_",cmd);gsub(/:/,"_",cmd);printf "%s:%.1f:%s;",$1,$2,cmd}' | sed 's/;$//')
if [ "$_os" = "Darwin" ]; then
  _c=$(sysctl -n hw.logicalcpu 2>/dev/null || echo 1)
  _cu=$(top -l 2 -s 1 -n 0 2>/dev/null | grep 'CPU usage:' | tail -1 | awk '{for(i=1;i<=NF;i++){if($(i+1)~/idle/){v=$i;gsub(/%/,"",v);printf "%.0f",100-v}}}')
  _mt=$(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%d",$1/1048576}')
  _mf=$(vm_stat 2>/dev/null | awk 'BEGIN{ps=4096}/Pages free/{f=$3+0}/Pages speculative/{s=$3+0}END{gsub(/\./,"",f);gsub(/\./,"",s);printf "%d",(f+s)*ps/1048576}')
  _d=$(df -k 2>/dev/null | awk 'NR>1&&/\/dev\//&&($NF=="/"||$NF~/^\/Volumes\//){u=$3/1048576;t=$2/1048576;p=$5;gsub(/%/,"",p);printf "%s:%.0f:%.0f:%s,",$NF,u,t,p}' | sed 's/,$//')
  _n=$(netstat -ib 2>/dev/null | awk '/^[a-z]/&&/Link/&&$1!~/^lo/{if($4~/:/){rx=$7;tx=$10}else{rx=$6;tx=$9};if(rx+0>0){n=$1;gsub(/\*/,"",n);printf "%s:%s:%s,",n,rx,tx}}' | sed 's/,$//')
  printf "OS:Darwin|CORES:%s|CU:%s|MT:%s|MF:%s|DISKS:%s|NET:%s|PROCS:%s\n" "$_c" "$_cu" "$_mt" "$_mf" "$_d" "$_n" "$_p"
else
  _c=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)
  _cr=$(awk '/^cpu /{t=0;for(i=2;i<=NF;i++)t+=$i;printf "%d %d",t,$5}' /proc/stat 2>/dev/null)
  _pc=$(awk '/^cpu[0-9]/{t=0;for(i=2;i<=NF;i++)t+=$i;printf "%d:%d,",t,$5}' /proc/stat 2>/dev/null | sed 's/,$//')
  _m=$(awk '/^MemTotal:/{t=$2}/^MemFree:/{f=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}/^SReclaimable:/{s=$2}/^SwapTotal:/{st=$2}/^SwapFree:/{sf=$2}END{printf "%d %d %d %d %d %d",t/1024,f/1024,b/1024,(c+s)/1024,st/1024,sf/1024}' /proc/meminfo 2>/dev/null)
  _d=$(df -BG 2>/dev/null | awk 'NR>1&&$1~/^\/dev/{gsub(/G/,"",$2);gsub(/G/,"",$3);gsub(/%/,"",$5);printf "%s:%s:%s:%s,",$6,$3,$2,$5}' | sed 's/,$//')
  _n=$(awk 'NR>2{gsub(/^[ \t]+/,"");split($0,a,":");if(a[1]!="lo"&&a[1]!~/^veth/&&a[1]!~/^docker/&&a[1]!~/^br-/){split(a[2],b);printf "%s:%s:%s,",a[1],b[1],b[9]}}' /proc/net/dev 2>/dev/null | sed 's/,$//')
  printf "OS:Linux|CORES:%s|CR:%s|PC:%s|MEM:%s|DISKS:%s|NET:%s|PROCS:%s\n" "$_c" "$_cr" "$_pc" "$_m" "$_d" "$_n" "$_p"
fi"#;

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn parse_stats_line(line: &str) -> RawServerStats {
    let mut s = RawServerStats {
        cpu_cores: 1, cpu_total: 0, cpu_idle: 0, cpu_pct: 0.0, cpu_per_core: Vec::new(),
        mem_total: 0, mem_free: 0, mem_buffers: 0, mem_cached: 0, swap_total: 0, swap_free: 0,
        disks: Vec::new(), net_ifaces: Vec::new(), top_procs: Vec::new(), ts: now_ms(),
    };
    for kv in line.split('|') {
        if let Some(v) = kv.strip_prefix("CORES:") {
            s.cpu_cores = v.trim().parse().unwrap_or(1);
        } else if let Some(v) = kv.strip_prefix("CR:") {
            // "total idle"
            let mut it = v.split_whitespace();
            s.cpu_total = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            s.cpu_idle  = it.next().and_then(|x| x.parse().ok()).unwrap_or(0);
        } else if let Some(v) = kv.strip_prefix("CU:") {
            s.cpu_pct = v.trim().parse().unwrap_or(0.0);
        } else if let Some(v) = kv.strip_prefix("PC:") {
            // "total:idle,total:idle,…"
            s.cpu_per_core = v.split(',').filter_map(|core| {
                let mut it = core.splitn(2, ':');
                let total: u64 = it.next()?.parse().ok()?;
                let idle:  u64 = it.next()?.parse().ok()?;
                Some([total, idle])
            }).collect();
        } else if let Some(v) = kv.strip_prefix("MEM:") {
            // "total free buffers cached swapTotal swapFree"
            let ns: Vec<u64> = v.split_whitespace().map(|n| n.parse().unwrap_or(0)).collect();
            if ns.len() >= 6 {
                s.mem_total   = ns[0]; s.mem_free    = ns[1];
                s.mem_buffers = ns[2]; s.mem_cached  = ns[3];
                s.swap_total  = ns[4]; s.swap_free   = ns[5];
            }
        } else if let Some(v) = kv.strip_prefix("MT:") {
            s.mem_total = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = kv.strip_prefix("MF:") {
            s.mem_free = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = kv.strip_prefix("DISKS:") {
            // "mount:usedGB:totalGB:pct,…"
            s.disks = v.split(',').filter_map(|d| {
                let p: Vec<&str> = d.splitn(4, ':').collect();
                if p.len() < 4 { return None; }
                Some(DiskStat {
                    mount: p[0].to_string(),
                    used:  p[1].parse().unwrap_or(0.0),
                    total: p[2].parse().unwrap_or(0.0),
                    pct:   p[3].parse().unwrap_or(0),
                })
            }).collect();
        } else if let Some(v) = kv.strip_prefix("NET:") {
            // "iface:rx:tx,…"
            s.net_ifaces = v.split(',').filter_map(|i| {
                let p: Vec<&str> = i.splitn(3, ':').collect();
                if p.len() < 3 { return None; }
                Some(RawNetIface {
                    name: p[0].to_string(),
                    rx:   p[1].parse().unwrap_or(0),
                    tx:   p[2].parse().unwrap_or(0),
                })
            }).collect();
        } else if let Some(v) = kv.strip_prefix("PROCS:") {
            // "pid:pct:cmd;…"
            s.top_procs = v.split(';').filter_map(|e| {
                let p: Vec<&str> = e.splitn(3, ':').collect();
                if p.len() < 3 { return None; }
                Some(ProcessInfo {
                    pid:     p[0].to_string(),
                    mem_pct: p[1].parse().unwrap_or(0.0),
                    cmd:     p[2].to_string(),
                })
            }).collect();
        }
    }
    s
}

#[tauri::command]
pub async fn ssh_server_stats(
    state:      State<'_, SshTerminalState>,
    session_id: String,
) -> Result<RawServerStats, String> {
    let ssh = state
        .clone_ssh(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        ssh.exec_cmd(STATS_SCRIPT),
    ).await
    .map_err(|_| "stats timed out".to_string())?
    .map_err(|e| e.to_string())?;
    let line = result.stdout.lines().last().unwrap_or("").trim();
    if line.is_empty() { return Err("empty output".to_string()); }
    Ok(parse_stats_line(line))
}

#[tauri::command]
pub async fn ssh_ping(
    state:      State<'_, SshTerminalState>,
    session_id: String,
) -> Result<u64, String> {
    let ssh = state
        .clone_ssh(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let start = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(5), ssh.exec_cmd("echo 1"))
        .await
        .map_err(|_| "ping timed out".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(start.elapsed().as_millis() as u64)
}

// ---------------------------------------------------------------------------
// Process list + Docker commands
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessEntry {
    pub pid:     String,
    pub user:    String,
    pub cpu:     f32,
    pub mem:     f32,
    pub cmd:     String,
    pub stat:    String,   // process state (R/S/D/T/Z…)
    pub rss:     u64,      // resident set size, KB
    pub vsz:     u64,      // virtual set size, KB
    pub ppid:    String,   // parent PID
    pub elapsed: String,   // etime: [[dd-]hh:]mm:ss
}

#[tauri::command]
pub async fn ssh_process_list(
    state:      State<'_, SshTerminalState>,
    session_id: String,
) -> Result<Vec<ProcessEntry>, String> {
    let ssh = state
        .clone_ssh(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    // ps axo gives: USER PID %CPU %MEM VSZ RSS STAT ELAPSED PPID ARGS
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        ssh.exec_cmd("ps axo user,pid,pcpu,pmem,vsz,rss,stat,etime,ppid,args 2>/dev/null; true"),
    ).await
    .map_err(|_| "process list timed out".to_string())?
    .map_err(|e| e.to_string())?;
    let mut procs = Vec::new();
    for line in result.stdout.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 10 {
            procs.push(ProcessEntry {
                user:    parts[0].to_string(),
                pid:     parts[1].to_string(),
                cpu:     parts[2].parse().unwrap_or(0.0),
                mem:     parts[3].parse().unwrap_or(0.0),
                vsz:     parts[4].parse().unwrap_or(0),
                rss:     parts[5].parse().unwrap_or(0),
                stat:    parts[6].to_string(),
                elapsed: parts[7].to_string(),
                ppid:    parts[8].to_string(),
                cmd:     parts[9..].join(" "),
            });
        }
    }
    Ok(procs)
}

#[tauri::command]
pub async fn ssh_process_renice(
    state:      State<'_, SshTerminalState>,
    session_id: String,
    pid:        String,
    nice:       i32,
) -> Result<String, String> {
    if !pid.chars().all(|c| c.is_ascii_digit()) {
        return Err("invalid pid".into());
    }
    if !(-20..=19).contains(&nice) {
        return Err("nice value must be between -20 and 19".into());
    }
    let ssh = state.clone_ssh(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        ssh.exec_cmd(&format!("renice -n {nice} -p {pid} 2>&1; true")),
    ).await
    .map_err(|_| "timeout".to_string())?
    .map_err(|e| e.to_string())?;
    Ok(result.stdout.trim().to_string())
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id:     String,
    pub name:   String,
    pub image:  String,
    pub status: String,
    pub state:  String,  // "running" | "paused" | "exited" | "created" …
    pub ports:  String,  // port mapping string
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DockerImage {
    pub id:         String,
    pub repository: String,
    pub tag:        String,
    pub size:       String,
    pub created:    String,
}

#[tauri::command]
pub async fn ssh_docker_list(
    state:      State<'_, SshTerminalState>,
    session_id: String,
) -> Result<Vec<DockerContainer>, String> {
    let ssh = state
        .clone_ssh(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        ssh.exec_cmd(
            r#"docker ps -a --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>&1"#,
        ),
    ).await
    .map_err(|_| "docker list timed out".to_string())?
    .map_err(|e| e.to_string())?;
    if result.exit_code != 0 {
        return Err(result.stdout.trim().to_string());
    }
    let mut containers = Vec::new();
    for line in result.stdout.lines() {
        let parts: Vec<&str> = line.splitn(5, '|').collect();
        if parts.len() >= 3 {
            let id = parts[0];
            containers.push(DockerContainer {
                id:     id[..id.len().min(12)].to_string(),
                name:   parts[1].to_string(),
                image:  parts[2].to_string(),
                status: parts.get(3).unwrap_or(&"").trim().to_string(),
                state:  "".to_string(),  // derived from status in frontend
                ports:  parts.get(4).unwrap_or(&"").trim().to_string(),
            });
        }
    }
    Ok(containers)
}

#[tauri::command]
pub async fn ssh_process_signal(
    state:      State<'_, SshTerminalState>,
    session_id: String,
    pid:        String,
    signal:     String,
) -> Result<String, String> {
    let sig = match signal.as_str() {
        "TERM" | "KILL" | "STOP" | "CONT" | "HUP" => signal.as_str(),
        _ => return Err("invalid signal".into()),
    };
    if !pid.chars().all(|c| c.is_ascii_digit()) {
        return Err("invalid pid".into());
    }
    let ssh = state.clone_ssh(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        ssh.exec_cmd(&format!("kill -{sig} {pid} 2>&1; true")),
    ).await
    .map_err(|_| "timeout".to_string())?
    .map_err(|e| e.to_string())?;
    Ok(result.stdout.trim().to_string())
}

#[tauri::command]
pub async fn ssh_docker_action(
    state:        State<'_, SshTerminalState>,
    session_id:   String,
    container_id: String,
    action:       String,
) -> Result<String, String> {
    let act = match action.as_str() {
        "start" | "stop" | "restart" | "pause" | "unpause" | "rm" => action.as_str(),
        _ => return Err("invalid action".into()),
    };
    if !container_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid container id".into());
    }
    let ssh = state.clone_ssh(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let cmd = if act == "rm" {
        format!("docker rm -f {container_id} 2>&1; true")
    } else {
        format!("docker {act} {container_id} 2>&1; true")
    };
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        ssh.exec_cmd(&cmd),
    ).await
    .map_err(|_| "timeout".to_string())?
    .map_err(|e| e.to_string())?;
    Ok(result.stdout.trim().to_string())
}

#[tauri::command]
pub async fn ssh_docker_image_list(
    state:      State<'_, SshTerminalState>,
    session_id: String,
) -> Result<Vec<DockerImage>, String> {
    let ssh = state
        .clone_ssh(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        ssh.exec_cmd(
            r#"docker images --format '{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedSince}}' 2>&1"#,
        ),
    ).await
    .map_err(|_| "docker image list timed out".to_string())?
    .map_err(|e| e.to_string())?;
    if result.exit_code != 0 {
        return Err(result.stdout.trim().to_string());
    }
    let mut images = Vec::new();
    for line in result.stdout.lines() {
        let parts: Vec<&str> = line.splitn(5, '|').collect();
        if parts.len() >= 3 {
            let id = parts[0];
            images.push(DockerImage {
                id:         id[..id.len().min(12)].to_string(),
                repository: parts[1].to_string(),
                tag:        parts.get(2).unwrap_or(&"").to_string(),
                size:       parts.get(3).unwrap_or(&"").trim().to_string(),
                created:    parts.get(4).unwrap_or(&"").trim().to_string(),
            });
        }
    }
    Ok(images)
}

#[tauri::command]
pub async fn ssh_docker_image_action(
    state:      State<'_, SshTerminalState>,
    session_id: String,
    image_id:   String,
    action:     String,
) -> Result<String, String> {
    let ssh = state
        .clone_ssh(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let cmd = match action.as_str() {
        "rmi" => {
            if !image_id.chars().all(|c| c.is_ascii_alphanumeric() || "-_:/.".contains(c)) {
                return Err("invalid image id".into());
            }
            format!("docker rmi {image_id} 2>&1; true")
        }
        "prune" => "docker image prune -f 2>&1".to_string(),
        _ => return Err("invalid action".into()),
    };
    let result = tokio::time::timeout(
        Duration::from_secs(60),
        ssh.exec_cmd(&cmd),
    ).await
    .map_err(|_| "timeout".to_string())?
    .map_err(|e| e.to_string())?;
    Ok(result.stdout.trim().to_string())
}

// ---------------------------------------------------------------------------
// System info (one-shot: OS, kernel, arch, hostname, uptime, CPU model)
// ---------------------------------------------------------------------------

const SYSINFO_SCRIPT: &str = r#"#!/bin/sh
_os=$(uname -s 2>/dev/null)
if [ "$_os" = "Darwin" ]; then
  _osname=$(sw_vers -productName 2>/dev/null)
  _osver=$(sw_vers -productVersion 2>/dev/null)
  _cpumodel=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || sysctl -n hw.model 2>/dev/null)
  _cores=$(sysctl -n hw.logicalcpu 2>/dev/null)
  _mem=$(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.1f GiB",$1/1073741824}')
  _boot=$(sysctl -n kern.boottime 2>/dev/null | awk '{gsub(/[^0-9]/,"",$4);print $4}')
  _now=$(date +%s 2>/dev/null)
  _up=$(awk -v b="$_boot" -v n="$_now" 'BEGIN{s=n-b;if(s>=86400)printf "%dd %dh",s/86400,(s%86400)/3600;else if(s>=3600)printf "%dh %dm",s/3600,(s%3600)/60;else printf "%dm",s/60}')
  _ip=$(ipconfig getifaddr en0 2>/dev/null)
  [ -z "$_ip" ] && _ip=$(ipconfig getifaddr en1 2>/dev/null)
else
  _osname=$(grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '"' | head -1)
  [ -z "$_osname" ] && _osname=$(head -1 /etc/issue 2>/dev/null | sed 's/ \\.*$//')
  _osver=""
  _cpumodel=$(grep 'model name' /proc/cpuinfo 2>/dev/null | head -1 | cut -d: -f2 | sed 's/^ *//')
  _cores=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo "")
  _mem=$(awk '/^MemTotal:/{printf "%.1f GiB",$2/1048576}' /proc/meminfo 2>/dev/null)
  _up=$(awk '{s=int($1);if(s>=86400)printf "%dd %dh",s/86400,(s%86400)/3600;else if(s>=3600)printf "%dh %dm",s/3600,(s%3600)/60;else printf "%dm",s/60}' /proc/uptime 2>/dev/null)
  _ip=$(ip -4 route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}')
  [ -z "$_ip" ] && _ip=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
_kern=$(uname -r 2>/dev/null)
_arch=$(uname -m 2>/dev/null)
_host=$(hostname 2>/dev/null)
_user=$(whoami 2>/dev/null)
printf "HOST:%s|USER:%s|IP:%s|OS:%s|VER:%s|KERN:%s|ARCH:%s|CPU:%s|CORES:%s|MEM:%s|UP:%s\n" \
  "$_host" "$_user" "$_ip" "$_osname" "$_osver" "$_kern" "$_arch" "$_cpumodel" "$_cores" "$_mem" "$_up"
"#;

#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SysInfo {
    pub hostname:  String,
    pub user:      String,
    pub ip_addr:   String,
    pub os_name:   String,
    pub os_ver:    String,
    pub kernel:    String,
    pub arch:      String,
    pub cpu_model: String,
    pub cpu_cores: String,
    pub mem_total: String,
    pub uptime:    String,
}

fn parse_sysinfo_line(line: &str) -> SysInfo {
    let mut s = SysInfo::default();
    for kv in line.split('|') {
        if      let Some(v) = kv.strip_prefix("HOST:")  { s.hostname  = v.trim().to_string(); }
        else if let Some(v) = kv.strip_prefix("USER:")  { s.user      = v.trim().to_string(); }
        else if let Some(v) = kv.strip_prefix("IP:")    { s.ip_addr   = v.trim().to_string(); }
        else if let Some(v) = kv.strip_prefix("OS:")    { s.os_name   = v.trim().to_string(); }
        else if let Some(v) = kv.strip_prefix("VER:")   { s.os_ver    = v.trim().to_string(); }
        else if let Some(v) = kv.strip_prefix("KERN:")  { s.kernel    = v.trim().to_string(); }
        else if let Some(v) = kv.strip_prefix("ARCH:")  { s.arch      = v.trim().to_string(); }
        else if let Some(v) = kv.strip_prefix("CPU:")   { s.cpu_model = v.trim().to_string(); }
        else if let Some(v) = kv.strip_prefix("CORES:") { s.cpu_cores = v.trim().to_string(); }
        else if let Some(v) = kv.strip_prefix("MEM:")   { s.mem_total = v.trim().to_string(); }
        else if let Some(v) = kv.strip_prefix("UP:")    { s.uptime    = v.trim().to_string(); }
    }
    s
}

#[tauri::command]
pub async fn ssh_sysinfo(
    state:      State<'_, SshTerminalState>,
    session_id: String,
) -> Result<SysInfo, String> {
    let ssh = state
        .clone_ssh(&session_id)
        .ok_or_else(|| format!("session not found: {session_id}"))?;
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        ssh.exec_cmd(SYSINFO_SCRIPT),
    ).await
    .map_err(|_| "sysinfo timed out".to_string())?
    .map_err(|e| e.to_string())?;
    let line = result.stdout.lines().last().unwrap_or("").trim();
    if line.is_empty() { return Err("empty output".to_string()); }
    Ok(parse_sysinfo_line(line))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn clone_handle(
    state:      &State<'_, SshTerminalState>,
    session_id: &str,
) -> Result<PtyHandle, String> {
    state
        .sessions
        .lock()
        .unwrap()
        .get(session_id)
        .map(|s| s.handle.clone())
        .ok_or_else(|| format!("session not found: {session_id}"))
}

fn build_config(p: &ConnectParams) -> SshConfig {
    let auth = match p.auth_type.as_deref().unwrap_or("Password") {
        // Keys are resolved from the key manager by `ssh_connect` and injected
        // afterwards; start with an empty candidate list here.
        "PublicKey" => AuthMethod::PublicKey { keys: Vec::new() },
        "KeyboardInteractive" => AuthMethod::KeyboardInteractive,
        "SshAgent" => AuthMethod::SshAgent { socket_path: None },
        "No" => AuthMethod::None,
        _ => AuthMethod::Password(p.password.clone().unwrap_or_default()),
    };

    let proxy = match p.proxy_type.as_deref().unwrap_or("NO") {
        "HTTP" => ProxyConfig::Http {
            host: p.proxy_host.clone().unwrap_or_default(),
            port: p.proxy_port.unwrap_or(8080),
            username: p.proxy_user.clone().filter(|s| !s.is_empty()),
            password: p.proxy_pass.clone().filter(|s| !s.is_empty()),
        },
        "SOCKS5" => ProxyConfig::Socks5 {
            host: p.proxy_host.clone().unwrap_or_default(),
            port: p.proxy_port.unwrap_or(1080),
            username: p.proxy_user.clone().filter(|s| !s.is_empty()),
            password: p.proxy_pass.clone().filter(|s| !s.is_empty()),
        },
        _ => ProxyConfig::None,
    };

    let env: HashMap<String, String> = p
        .env
        .as_deref()
        .map(|s| {
            s.lines()
                .filter_map(|line| {
                    let mut it = line.splitn(2, '=');
                    let k = it.next()?.trim().to_string();
                    let v = it.next().unwrap_or("").to_string();
                    if k.is_empty() { None } else { Some((k, v)) }
                })
                .collect()
        })
        .unwrap_or_default();

    SshConfig {
        host: p.host.clone(),
        port: p.port,
        username: p.username.clone(),
        auth,
        proxy,
        jump_host_configs: vec![],
        heartbeat: Duration::from_secs(p.heartbeat.unwrap_or(30)),
        timeout: Duration::from_secs(30),
        env,
        term: "xterm-256color".to_string(),
        x11_forwarding: None,
        forward_agent: false,
    }
}

pub fn init(app: &AppHandle) {
    app.manage(SshTerminalState::default());
}
