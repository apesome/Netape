//! PTY abstraction for Netape.
//!
//! A [`PtySession`] owns a pseudo-terminal plus the attached child process and
//! exposes a byte-oriented read/write/resize API for higher-level terminal
//! layers.

use std::io::{Read, Write};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

/// Logical size of a terminal, in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TermSize {
    pub rows: u16,
    pub cols: u16,
}

impl Default for TermSize {
    fn default() -> Self {
        TermSize { rows: 24, cols: 80 }
    }
}

impl From<TermSize> for PtySize {
    fn from(s: TermSize) -> Self {
        PtySize {
            rows: s.rows,
            cols: s.cols,
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PtyError {
    #[error("failed to open pty: {0}")]
    Open(String),
    #[error("failed to spawn command: {0}")]
    Spawn(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// An open pseudo-terminal with a child process attached.
///
/// Holds the PTY master for resizing, a stdin writer, and the child handle for
/// lifecycle control. The read side is handed out once via
/// [`PtySession::take_reader`] so the caller can pump output on its own thread.
pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    reader: Option<Box<dyn Read + Send>>,
}

impl PtySession {
    /// Spawn the user's default login shell in a new PTY.
    pub fn spawn_default_shell(size: TermSize) -> Result<Self, PtyError> {
        Self::spawn_default_shell_with(size, &[])
    }

    /// Spawn the user's default login shell with extra environment variables.
    ///
    /// Used by saved "Local" hosts so their configured env carries into the
    /// shell. `TERM` and the home working directory are still applied; the
    /// supplied vars are layered on top (and may override them).
    pub fn spawn_default_shell_with(
        size: TermSize,
        env: &[(String, String)],
    ) -> Result<Self, PtyError> {
        let (shell, args) = default_shell();
        let mut cmd = CommandBuilder::new(&shell);
        for a in &args { cmd.arg(a); }
        // Start in the user's home directory.
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        cmd.env("TERM", "xterm-256color");
        for (k, v) in env {
            if !k.is_empty() {
                cmd.env(k, v);
            }
        }
        Self::spawn(cmd, size)
    }

    /// Spawn an arbitrary program (with args) in a new PTY, applying the home
    /// working directory, `TERM`, and the supplied environment. Used for WSL
    /// hosts (`wsl.exe -d <distro>`) and similar.
    pub fn spawn_program(
        program: &str,
        args: &[String],
        size: TermSize,
        env: &[(String, String)],
    ) -> Result<Self, PtyError> {
        let mut cmd = CommandBuilder::new(program);
        for a in args { cmd.arg(a); }
        if let Some(home) = dirs::home_dir() {
            cmd.cwd(home);
        }
        cmd.env("TERM", "xterm-256color");
        for (k, v) in env {
            if !k.is_empty() {
                cmd.env(k, v);
            }
        }
        Self::spawn(cmd, size)
    }

    /// Spawn an arbitrary command in a new PTY.
    pub fn spawn(cmd: CommandBuilder, size: TermSize) -> Result<Self, PtyError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size.into())
            .map_err(|e| PtyError::Open(e.to_string()))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        // The slave is no longer needed in this process once the child holds it.
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::Open(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::Open(e.to_string()))?;

        Ok(PtySession {
            master: pair.master,
            writer,
            child,
            reader: Some(reader),
        })
    }

    /// Take the output reader. Returns `None` if already taken.
    pub fn take_reader(&mut self) -> Option<Box<dyn Read + Send>> {
        self.reader.take()
    }

    /// Write bytes to the terminal's stdin.
    pub fn write(&mut self, data: &[u8]) -> Result<(), PtyError> {
        self.writer.write_all(data)?;
        self.writer.flush()?;
        Ok(())
    }

    /// Resize the terminal.
    pub fn resize(&self, size: TermSize) -> Result<(), PtyError> {
        self.master
            .resize(size.into())
            .map_err(|e| PtyError::Open(e.to_string()))
    }

    /// Terminate the child process.
    pub fn kill(&mut self) -> Result<(), PtyError> {
        self.child.kill()?;
        Ok(())
    }
}

/// Best-effort default shell for the host platform.
/// Returns (executable, extra_args).
fn default_shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        // powershell.exe ships with every Windows installation; -NoLogo suppresses the banner.
        ("powershell.exe".to_string(), vec![])
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        (shell, vec![])
    }
}
