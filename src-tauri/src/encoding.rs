//! Character-encoding helpers for terminal I/O.
//!
//! Terminal output from a shell is in the host's configured charset (e.g. GBK
//! on a Chinese Windows `cmd`), but xterm.js on the frontend always expects
//! UTF-8. We therefore decode shell bytes → UTF-8 on the way out, and encode
//! UTF-8 → the charset on the way in. UTF-8 hosts are passed through untouched.
//!
use encoding_rs::Encoding;

/// Resolve an encoding label (e.g. "UTF-8", "GBK", "GB18030", "Big5",
/// "Shift_JIS") to an [`Encoding`]. Unknown or empty labels fall back to UTF-8.
pub fn charset_for(name: Option<&str>) -> &'static Encoding {
    match name {
        Some(n) if !n.trim().is_empty() => {
            Encoding::for_label(n.trim().as_bytes()).unwrap_or(encoding_rs::UTF_8)
        }
        _ => encoding_rs::UTF_8,
    }
}

/// True when no conversion is needed (the frontend speaks UTF-8 natively).
pub fn is_utf8(enc: &'static Encoding) -> bool {
    enc == encoding_rs::UTF_8
}

/// Encode UTF-8 `text` into `enc`'s bytes for writing to the shell.
pub fn encode_input(enc: &'static Encoding, text: &str) -> Vec<u8> {
    if is_utf8(enc) {
        return text.as_bytes().to_vec();
    }
    let (bytes, _, _) = enc.encode(text);
    bytes.into_owned()
}
