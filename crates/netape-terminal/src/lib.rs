//! Terminal core types for Netape.
//!
//! This crate collects the shared terminal model types: screen coordinates,
//! input modes, and the foundation for future native terminal state handling.
//!
//! The current vertical slice delegates VT parsing and rendering to xterm.js in
//! the WebView, so only the foundational, UI-independent types live here for
//! now. As the port progresses, the processors (`ControlSequenceIntroducer`,
//! `OperatingSystemCommand`, `DeviceControlString`, …) move here so the backend
//! owns terminal state natively.

use serde::{Deserialize, Serialize};

/// A 1-based position on the terminal grid.
///
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Position {
    pub x: i32,
    pub y: i32,
}

impl Position {
    pub const fn new(x: i32, y: i32) -> Self {
        Position { x, y }
    }
}

/// Mouse reporting mode negotiated via control sequences.
///
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MouseMode {
    None,
    Normal,
    Button,
    Any,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_constructs() {
        let p = Position::new(1, 1);
        assert_eq!(p.x, 1);
        assert_eq!(p.y, 1);
    }
}
