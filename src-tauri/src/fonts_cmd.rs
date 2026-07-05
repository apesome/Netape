#[tauri::command]
pub fn terminal_beep() {
    #[cfg(windows)]
    unsafe {
        winapi::um::utilapiset::Beep(880, 80);
    }
}

#[tauri::command]
pub fn system_fonts() -> Vec<String> {
    #[cfg(windows)]
    {
        fonts_windows()
    }
    #[cfg(not(windows))]
    {
        vec![]
    }
}

#[cfg(windows)]
fn fonts_windows() -> Vec<String> {
    use std::mem;
    use winapi::shared::minwindef::{DWORD, LPARAM};
    use winapi::um::wingdi::{EnumFontFamiliesExW, LOGFONTW, TEXTMETRICW, DEFAULT_CHARSET};
    use winapi::um::winuser::{GetDC, ReleaseDC};

    unsafe extern "system" fn callback(
        lplf: *const LOGFONTW,
        _lptm: *const TEXTMETRICW,
        _dw_type: DWORD,
        lparam: LPARAM,
    ) -> i32 {
        let fonts = &mut *(lparam as *mut Vec<String>);
        let face = &(*lplf).lfFaceName;
        let end = face.iter().position(|&c| c == 0).unwrap_or(face.len());
        let name = String::from_utf16_lossy(&face[..end]).to_string();
        // Skip '@'-prefixed fonts (vertical writing variants)
        if !name.starts_with('@') && !fonts.contains(&name) {
            fonts.push(name);
        }
        1
    }

    let mut fonts: Vec<String> = Vec::new();
    unsafe {
        let hdc = GetDC(std::ptr::null_mut());
        let mut lf: LOGFONTW = mem::zeroed();
        lf.lfCharSet = DEFAULT_CHARSET as u8;
        EnumFontFamiliesExW(
            hdc,
            &mut lf,
            Some(callback),
            &mut fonts as *mut Vec<String> as LPARAM,
            0,
        );
        ReleaseDC(std::ptr::null_mut(), hdc);
    }
    fonts.sort_unstable();
    fonts
}
