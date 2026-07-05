//! Telnet (RFC 854 / 855) option negotiation — pure protocol logic, no I/O.
//!
//! The Tauri layer owns the TCP socket and event plumbing; this module owns the
//! byte-level IAC state machine so it can be unit-tested without a runtime.
//!
//! Covers terminal type, window size (NAWS), suppress-go-ahead, binary mode,
//! and remote echo negotiation.

use std::collections::HashSet;

// ── Protocol bytes ──────────────────────────────────────────────────────────
pub const IAC: u8 = 255;
pub const DONT: u8 = 254;
pub const DO: u8 = 253;
pub const WONT: u8 = 252;
pub const WILL: u8 = 251;
pub const SB: u8 = 250;
pub const SE: u8 = 240;
// Options
pub const OPT_BINARY: u8 = 0;
pub const OPT_ECHO: u8 = 1;
pub const OPT_SGA: u8 = 3;
pub const OPT_TTYPE: u8 = 24;
pub const OPT_NAWS: u8 = 31;
// Terminal-type sub-negotiation
const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

const TERM_TYPE: &[u8] = b"xterm-256color";

/// The options we proactively advertise on connect. Seeded into the parser so
/// the peer's agreement replies don't trigger a negotiation echo loop.
pub fn initial_negotiation() -> [u8; 21] {
    [
        IAC, WILL, OPT_TTYPE,
        IAC, WILL, OPT_NAWS,
        IAC, WILL, OPT_SGA,
        IAC, DO, OPT_SGA,
        IAC, DO, OPT_ECHO,
        IAC, WILL, OPT_BINARY,
        IAC, DO, OPT_BINARY,
    ]
}

/// A full NAWS (window size) sub-negotiation: `IAC SB NAWS w1 w0 h1 h0 IAC SE`,
/// with any 0xFF size byte escaped.
pub fn naws(cols: u16, rows: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(10);
    push_naws(&mut out, cols, rows);
    out
}

fn push_naws(out: &mut Vec<u8>, cols: u16, rows: u16) {
    out.extend_from_slice(&[IAC, SB, OPT_NAWS]);
    for b in [(cols >> 8) as u8, cols as u8, (rows >> 8) as u8, rows as u8] {
        if b == IAC {
            out.push(IAC);
        }
        out.push(b);
    }
    out.extend_from_slice(&[IAC, SE]);
}

/// Escape user input so a literal 0xFF byte isn't interpreted as IAC.
pub fn escape_iac(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for &b in data {
        if b == IAC {
            out.push(IAC);
        }
        out.push(b);
    }
    out
}

// ── IAC state machine ───────────────────────────────────────────────────────

enum St {
    Normal,
    Iac,
    Opt(u8),
    Sb,
    SbIac,
}

pub struct TelnetParser {
    state: St,
    sb: Vec<u8>,
    /// Options we have agreed to perform (sent WILL for).
    will: HashSet<u8>,
    /// Options we have asked the peer to perform (sent DO for).
    doo: HashSet<u8>,
    cols: u16,
    rows: u16,
}

impl TelnetParser {
    /// Seed the negotiation sets to match [`initial_negotiation`], so the peer's
    /// agreement replies don't bounce back as another offer.
    pub fn new(cols: u16, rows: u16) -> Self {
        TelnetParser {
            state: St::Normal,
            sb: Vec::new(),
            will: HashSet::from([OPT_TTYPE, OPT_NAWS, OPT_SGA, OPT_BINARY]),
            doo: HashSet::from([OPT_SGA, OPT_ECHO, OPT_BINARY]),
            cols,
            rows,
        }
    }

    /// Consume input bytes, returning `(clean terminal data, bytes to send back)`.
    pub fn feed(&mut self, input: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut data = Vec::with_capacity(input.len());
        let mut resp = Vec::new();
        for &b in input {
            match self.state {
                St::Normal => {
                    if b == IAC {
                        self.state = St::Iac;
                    } else {
                        data.push(b);
                    }
                }
                St::Iac => match b {
                    IAC => {
                        data.push(IAC); // escaped 0xFF literal
                        self.state = St::Normal;
                    }
                    WILL | WONT | DO | DONT => self.state = St::Opt(b),
                    SB => {
                        self.sb.clear();
                        self.state = St::Sb;
                    }
                    _ => self.state = St::Normal, // GA / NOP / etc.
                },
                St::Opt(cmd) => {
                    self.negotiate(cmd, b, &mut resp);
                    self.state = St::Normal;
                }
                St::Sb => {
                    if b == IAC {
                        self.state = St::SbIac;
                    } else {
                        self.sb.push(b);
                    }
                }
                St::SbIac => match b {
                    SE => {
                        self.handle_sb(&mut resp);
                        self.state = St::Normal;
                    }
                    IAC => {
                        self.sb.push(IAC);
                        self.state = St::Sb;
                    }
                    _ => self.state = St::Normal, // malformed
                },
            }
        }
        (data, resp)
    }

    fn negotiate(&mut self, cmd: u8, opt: u8, resp: &mut Vec<u8>) {
        match cmd {
            DO => {
                if matches!(opt, OPT_TTYPE | OPT_NAWS | OPT_SGA | OPT_BINARY) {
                    if self.will.insert(opt) {
                        resp.extend_from_slice(&[IAC, WILL, opt]);
                    }
                    if opt == OPT_NAWS {
                        push_naws(resp, self.cols, self.rows);
                    }
                } else {
                    resp.extend_from_slice(&[IAC, WONT, opt]);
                }
            }
            DONT => {
                if self.will.remove(&opt) {
                    resp.extend_from_slice(&[IAC, WONT, opt]);
                }
            }
            WILL => {
                if matches!(opt, OPT_ECHO | OPT_SGA | OPT_BINARY) {
                    if self.doo.insert(opt) {
                        resp.extend_from_slice(&[IAC, DO, opt]);
                    }
                } else {
                    resp.extend_from_slice(&[IAC, DONT, opt]);
                }
            }
            WONT => {
                if self.doo.remove(&opt) {
                    resp.extend_from_slice(&[IAC, DONT, opt]);
                }
            }
            _ => {}
        }
    }

    fn handle_sb(&mut self, resp: &mut Vec<u8>) {
        // Terminal-type query: IAC SB TTYPE SEND IAC SE → reply with our type.
        if self.sb.len() >= 2 && self.sb[0] == OPT_TTYPE && self.sb[1] == TTYPE_SEND {
            resp.extend_from_slice(&[IAC, SB, OPT_TTYPE, TTYPE_IS]);
            resp.extend_from_slice(TERM_TYPE);
            resp.extend_from_slice(&[IAC, SE]);
        }
        self.sb.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_data_passes_through() {
        let mut p = TelnetParser::new(80, 24);
        let (data, resp) = p.feed(b"hello");
        assert_eq!(data, b"hello");
        assert!(resp.is_empty());
    }

    #[test]
    fn escaped_iac_becomes_single_ff() {
        let mut p = TelnetParser::new(80, 24);
        let (data, resp) = p.feed(&[b'a', IAC, IAC, b'b']);
        assert_eq!(data, vec![b'a', 0xFF, b'b']);
        assert!(resp.is_empty());
    }

    #[test]
    fn do_unsupported_option_refused_with_wont() {
        let mut p = TelnetParser::new(80, 24);
        let (data, resp) = p.feed(&[IAC, DO, 5 /* STATUS */]);
        assert!(data.is_empty());
        assert_eq!(resp, vec![IAC, WONT, 5]);
    }

    #[test]
    fn will_unsupported_option_refused_with_dont() {
        let mut p = TelnetParser::new(80, 24);
        let (_d, resp) = p.feed(&[IAC, WILL, 5]);
        assert_eq!(resp, vec![IAC, DONT, 5]);
    }

    #[test]
    fn agreement_replies_do_not_loop() {
        // Server agreeing to our proactively-offered options must not echo.
        let mut p = TelnetParser::new(80, 24);
        let (_d, resp) = p.feed(&[IAC, DO, OPT_TTYPE, IAC, WILL, OPT_ECHO]);
        assert!(resp.is_empty(), "expected no response, got {resp:?}");
    }

    #[test]
    fn do_naws_sends_window_size() {
        let mut p = TelnetParser::new(0x5051, 0x2728);
        let (_d, resp) = p.feed(&[IAC, DO, OPT_NAWS]);
        assert_eq!(resp, vec![IAC, SB, OPT_NAWS, 0x50, 0x51, 0x27, 0x28, IAC, SE]);
    }

    #[test]
    fn naws_escapes_ff_size_byte() {
        // cols=255 → low byte 0xFF must be doubled inside the sub-negotiation.
        let mut p = TelnetParser::new(255, 24);
        let (_d, resp) = p.feed(&[IAC, DO, OPT_NAWS]);
        assert_eq!(resp, vec![IAC, SB, OPT_NAWS, 0x00, 0xFF, 0xFF, 0x00, 24, IAC, SE]);
    }

    #[test]
    fn ttype_send_replies_with_terminal_type() {
        let mut p = TelnetParser::new(80, 24);
        let (_d, resp) = p.feed(&[IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]);
        let mut expected = vec![IAC, SB, OPT_TTYPE, TTYPE_IS];
        expected.extend_from_slice(TERM_TYPE);
        expected.extend_from_slice(&[IAC, SE]);
        assert_eq!(resp, expected);
    }

    #[test]
    fn data_interleaved_with_commands() {
        let mut p = TelnetParser::new(80, 24);
        let mut input = vec![b'h', b'i'];
        input.extend_from_slice(&[IAC, DO, 5]);
        input.push(b'!');
        let (data, resp) = p.feed(&input);
        assert_eq!(data, b"hi!");
        assert_eq!(resp, vec![IAC, WONT, 5]);
    }

    #[test]
    fn command_split_across_feeds() {
        let mut p = TelnetParser::new(80, 24);
        let (d1, r1) = p.feed(&[b'x', IAC]);
        assert_eq!(d1, b"x");
        assert!(r1.is_empty());
        let (d2, r2) = p.feed(&[DO, 5]);
        assert!(d2.is_empty());
        assert_eq!(r2, vec![IAC, WONT, 5]);
    }

    #[test]
    fn dont_after_our_will_is_acknowledged_once() {
        // Server refuses an option we offered → single WONT, repeat is silent.
        let mut p = TelnetParser::new(80, 24);
        let (_d, r1) = p.feed(&[IAC, DONT, OPT_TTYPE]);
        assert_eq!(r1, vec![IAC, WONT, OPT_TTYPE]);
        let (_d2, r2) = p.feed(&[IAC, DONT, OPT_TTYPE]);
        assert!(r2.is_empty());
    }

    #[test]
    fn helpers_match_machine() {
        // initial_negotiation is 7 option triples.
        assert_eq!(initial_negotiation().len(), 21);
        assert_eq!(escape_iac(&[0xFF, 1, 0xFF]), vec![0xFF, 0xFF, 1, 0xFF, 0xFF]);
        assert_eq!(naws(80, 24), vec![IAC, SB, OPT_NAWS, 0, 80, 0, 24, IAC, SE]);
    }
}
