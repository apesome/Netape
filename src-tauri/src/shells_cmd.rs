use std::sync::OnceLock;

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredShell {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub is_default: bool,
}

static SHELL_CACHE: OnceLock<Vec<DiscoveredShell>> = OnceLock::new();

fn get_shells() -> &'static [DiscoveredShell] {
    SHELL_CACHE.get_or_init(discover_impl)
}

/// Resolve a shell id (or raw path) to (command, args) for spawning.
/// Returns None if id is empty → caller uses the default shell.
pub fn resolve_shell(id: &str) -> Option<(String, Vec<String>)> {
    if id.is_empty() {
        return None;
    }
    // Try discovered shell first
    if let Some(s) = get_shells().iter().find(|s| s.id == id) {
        return Some((s.command.clone(), s.args.clone()));
    }
    // Fall back: treat as raw command/path with no extra args
    Some((id.to_string(), vec![]))
}

#[tauri::command]
pub fn discover_shells() -> Vec<DiscoveredShell> {
    get_shells().to_vec()
}

fn discover_impl() -> Vec<DiscoveredShell> {
    #[cfg(windows)]
    {
        discover_windows()
    }
    #[cfg(not(windows))]
    {
        discover_unix()
    }
}

// ── Windows ────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn discover_windows() -> Vec<DiscoveredShell> {
    let mut shells: Vec<DiscoveredShell> = Vec::new();

    if let Some(s) = detect_cmd() {
        shells.push(s);
    }
    if let Some(s) = detect_powershell() {
        shells.push(s);
    }
    if let Some(s) = detect_pwsh() {
        shells.push(s);
    }
    shells.extend(detect_wsl());
    if let Some(s) = detect_git_bash() {
        shells.push(s);
    }

    // Mark default: pwsh > powershell > cmd
    let default_id = shells
        .iter()
        .find(|s| s.id == "pwsh")
        .or_else(|| shells.iter().find(|s| s.id == "powershell"))
        .or_else(|| shells.iter().find(|s| s.id == "cmd"))
        .map(|s| s.id.clone());
    if let Some(id) = default_id {
        if let Some(s) = shells.iter_mut().find(|s| s.id == id) {
            s.is_default = true;
        }
    }
    shells
}

/// Run `where.exe <name>`, return first real path (skipping WindowsApps aliases).
#[cfg(windows)]
fn find_on_path(name: &str) -> Option<String> {
    let out = std::process::Command::new("where.exe")
        .arg(name)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let aliases_prefix = {
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default().to_lowercase();
        format!("{}\\microsoft\\windowsapps", local)
    };
    text.lines()
        .map(|l| l.trim().to_string())
        .filter(|p| !p.is_empty() && !p.to_lowercase().starts_with(&aliases_prefix))
        .find(|p| std::path::Path::new(p).exists())
}

/// Query a named value (or default value when `value_name` is "") from the registry.
#[cfg(windows)]
fn reg_query(key: &str, value_name: &str) -> Option<String> {
    let args: &[&str] = if value_name.is_empty() {
        &["query", key, "/ve"]
    } else {
        &["query", key, "/v", value_name]
    };
    let out = std::process::Command::new("reg").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        for reg_type in &["REG_SZ", "REG_EXPAND_SZ"] {
            if let Some(pos) = line.find(reg_type) {
                let rest = line[pos + reg_type.len()..].trim();
                if !rest.is_empty() {
                    return Some(rest.to_string());
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn detect_cmd() -> Option<DiscoveredShell> {
    let path = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
    Some(DiscoveredShell {
        id: "cmd".into(),
        name: "CMD".into(),
        command: path,
        args: vec![],
        is_default: false,
    })
}

#[cfg(windows)]
fn detect_powershell() -> Option<DiscoveredShell> {
    let path = find_on_path("powershell").or_else(|| {
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        let p = format!(
            "{}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            sys
        );
        std::path::Path::new(&p).exists().then_some(p)
    })?;
    Some(DiscoveredShell {
        id: "powershell".into(),
        name: "Windows PowerShell".into(),
        command: path,
        args: vec!["-NoLogo".into()],
        is_default: false,
    })
}

#[cfg(windows)]
fn detect_pwsh() -> Option<DiscoveredShell> {
    let path = find_on_path("pwsh")
        .or_else(|| {
            reg_query(
                "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\pwsh.exe",
                "",
            )
            .filter(|p| std::path::Path::new(p).exists())
        })
        .or_else(|| {
            let pf = std::env::var("ProgramFiles")
                .unwrap_or_else(|_| "C:\\Program Files".into());
            let p = format!("{}\\PowerShell\\7\\pwsh.exe", pf);
            std::path::Path::new(&p).exists().then_some(p)
        })?;
    Some(DiscoveredShell {
        id: "pwsh".into(),
        name: "PowerShell 7".into(),
        command: path,
        args: vec!["-NoLogo".into()],
        is_default: false,
    })
}

#[cfg(windows)]
fn detect_wsl() -> Vec<DiscoveredShell> {
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let wsl_exe = format!("{}\\System32\\wsl.exe", sys);
    if !std::path::Path::new(&wsl_exe).exists() {
        return vec![];
    }
    let Ok(out) = std::process::Command::new(&wsl_exe)
        .args(["-l", "-q"])
        .output()
    else {
        return vec![];
    };

    // wsl.exe outputs UTF-16LE on most builds (NUL bytes between chars)
    let text = if out.stdout.contains(&0x00) {
        let wide: Vec<u16> = out
            .stdout
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c.get(1).copied().unwrap_or(0)]))
            .collect();
        String::from_utf16_lossy(&wide)
    } else {
        String::from_utf8_lossy(&out.stdout).into_owned()
    };

    text.lines()
        .map(|l| l.trim().replace('\0', ""))
        .filter(|l| !l.is_empty())
        .map(|distro| {
            let slug = distro
                .to_lowercase()
                .chars()
                .map(|c| if c.is_alphanumeric() { c } else { '-' })
                .collect::<String>();
            DiscoveredShell {
                id: format!("wsl-{}", slug),
                name: format!("{} (WSL)", distro),
                command: wsl_exe.clone(),
                args: vec!["-d".into(), distro],
                is_default: false,
            }
        })
        .collect()
}

#[cfg(windows)]
fn detect_git_bash() -> Option<DiscoveredShell> {
    let bash = reg_query("HKLM\\SOFTWARE\\GitForWindows", "InstallPath")
        .map(|p| format!("{}\\bin\\bash.exe", p))
        .filter(|p| std::path::Path::new(p).exists())
        .or_else(|| {
            let pf = std::env::var("ProgramFiles")
                .unwrap_or_else(|_| "C:\\Program Files".into());
            let p = format!("{}\\Git\\bin\\bash.exe", pf);
            std::path::Path::new(&p).exists().then_some(p)
        })?;
    Some(DiscoveredShell {
        id: "git-bash".into(),
        name: "Git Bash".into(),
        command: bash,
        args: vec!["--login".into(), "-i".into()],
        is_default: false,
    })
}

// ── Unix / macOS ────────────────────────────────────────────────────────────

#[cfg(not(windows))]
fn discover_unix() -> Vec<DiscoveredShell> {
    let env_shell = std::env::var("SHELL").ok();
    let mut shells: Vec<DiscoveredShell> = Vec::new();
    let mut seen: std::collections::HashSet<String> = Default::default();

    let paths: Vec<String> = std::fs::read_to_string("/etc/shells")
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter(|p| std::path::Path::new(p).exists())
        .map(str::to_string)
        .collect();

    for path in &paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        let base = std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let args = if matches!(base.as_str(), "bash" | "zsh" | "fish" | "ksh" | "sh") {
            vec!["-l".into()]
        } else {
            vec![]
        };
        let is_default = env_shell.as_deref() == Some(path.as_str());
        shells.push(DiscoveredShell {
            id: base.clone(),
            name: unix_shell_name(&base),
            command: path.clone(),
            args,
            is_default,
        });
    }

    // Ensure $SHELL is present
    if let Some(ref sh) = env_shell {
        if !seen.contains(sh) && std::path::Path::new(sh).exists() {
            let base = std::path::Path::new(sh)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            shells.insert(
                0,
                DiscoveredShell {
                    id: base.clone(),
                    name: unix_shell_name(&base),
                    command: sh.clone(),
                    args: vec!["-l".into()],
                    is_default: true,
                },
            );
        }
    }

    if !shells.iter().any(|s| s.is_default) {
        if let Some(first) = shells.first_mut() {
            first.is_default = true;
        }
    }

    shells
}

#[cfg(not(windows))]
fn unix_shell_name(base: &str) -> String {
    match base {
        "zsh" => "Zsh",
        "bash" => "Bash",
        "fish" => "Fish",
        "sh" => "sh",
        "ksh" => "Ksh",
        "tcsh" => "tcsh",
        "nu" | "nushell" => "Nushell",
        "pwsh" => "PowerShell",
        other => other,
    }
    .to_string()
}
