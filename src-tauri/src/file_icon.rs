/// Extract the shell icon for a local file path and return it as a base64-encoded PNG.
///
/// On Windows this calls `SHGetFileInfoW` (SHGFI_ICON | SHGFI_SMALLICON) which resolves
/// `.lnk` shortcuts, reads embedded executable icons, and falls back to the registered
/// file-type icon — exactly what Explorer shows.
///
/// On other platforms the command always returns an error; the frontend falls back to
/// its own SVG category icons.
#[tauri::command]
pub fn get_file_icon(path: String) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    return win::icon_b64(&path);

    #[cfg(target_os = "macos")]
    return mac::icon_b64(&path);

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return Err("not supported on this platform".into());
}

// ─── Windows implementation ───────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod win {
    use std::ffi::OsStr;
    use std::mem;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    use winapi::um::shellapi::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON};
    use winapi::um::winuser::{DestroyIcon, GetIconInfo, ICONINFO};
    use winapi::um::wingdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };

    pub fn icon_b64(path: &str) -> Result<String, String> {
        let (w, h, rgba) = extract_rgba(path)?;
        let png = encode_png(w, h, &rgba)?;
        use base64::Engine as _;
        Ok(base64::engine::general_purpose::STANDARD.encode(&png))
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(Some(0)).collect()
    }

    fn extract_rgba(path: &str) -> Result<(u32, u32, Vec<u8>), String> {
        let path_w = wide(path);

        unsafe {
            // ── 1. get HICON from shell ──────────────────────────────────────
            let mut shfi: SHFILEINFOW = mem::zeroed();
            let result = SHGetFileInfoW(
                path_w.as_ptr(),
                0,
                &mut shfi,
                mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_SMALLICON,
            );
            if result == 0 || shfi.hIcon.is_null() {
                return Err("SHGetFileInfoW failed".into());
            }
            let hicon = shfi.hIcon;

            // ── 2. get the colour bitmap from the icon ───────────────────────
            let mut info: ICONINFO = mem::zeroed();
            if GetIconInfo(hicon, &mut info) == 0 {
                DestroyIcon(hicon);
                return Err("GetIconInfo failed".into());
            }

            let mut bm: BITMAP = mem::zeroed();
            GetObjectW(
                info.hbmColor as *mut _,
                mem::size_of::<BITMAP>() as i32,
                &mut bm as *mut _ as *mut _,
            );
            let w = bm.bmWidth.unsigned_abs();
            let h = bm.bmHeight.unsigned_abs();

            if w == 0 || h == 0 {
                cleanup_icon_info(&info);
                DestroyIcon(hicon);
                return Err("zero-size icon".into());
            }

            // ── 3. GetDIBits → raw BGRA pixels ──────────────────────────────
            let dc = CreateCompatibleDC(ptr::null_mut());

            let mut bmi: BITMAPINFO = mem::zeroed();
            bmi.bmiHeader.biSize = mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = w as i32;
            bmi.bmiHeader.biHeight = -(h as i32); // negative = top-down
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB;

            let mut pixels = vec![0u8; (w * h * 4) as usize];
            let lines = GetDIBits(
                dc,
                info.hbmColor,
                0,
                h,
                pixels.as_mut_ptr() as *mut _,
                &mut bmi,
                DIB_RGB_COLORS,
            );

            DeleteDC(dc);
            cleanup_icon_info(&info);
            DestroyIcon(hicon);

            if lines == 0 {
                return Err("GetDIBits returned 0 scan lines".into());
            }

            // ── 4. BGRA → RGBA; fix fully-opaque icons with zero alpha ───────
            let all_zero_alpha = pixels.chunks_exact(4).all(|p| p[3] == 0);
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2); // B ↔ R
                if all_zero_alpha {
                    px[3] = 255;
                }
            }

            Ok((w, h, pixels))
        }
    }

    unsafe fn cleanup_icon_info(info: &ICONINFO) {
        if !info.hbmColor.is_null() {
            DeleteObject(info.hbmColor as *mut _);
        }
        if !info.hbmMask.is_null() {
            DeleteObject(info.hbmMask as *mut _);
        }
    }

    fn encode_png(w: u32, h: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
        let mut buf = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut buf, w, h);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut writer = enc.write_header().map_err(|e| e.to_string())?;
            writer.write_image_data(rgba).map_err(|e| e.to_string())?;
        } // writer + enc drop here, releasing the borrow on buf
        Ok(buf)
    }
}

// ─── macOS implementation ────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod mac {
    use cocoa::appkit::{NSBitmapImageFileType, NSImage};
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSAutoreleasePool, NSData, NSRect, NSSize, NSString};
    use objc::{class, msg_send, sel, sel_impl};

    pub fn icon_b64(path: &str) -> Result<String, String> {
        let png = icon_png(path)?;
        use base64::Engine as _;
        Ok(base64::engine::general_purpose::STANDARD.encode(&png))
    }

    fn icon_png(path: &str) -> Result<Vec<u8>, String> {
        unsafe {
            let _pool = NSAutoreleasePool::new(nil);
            let ws: id = msg_send![class!(NSWorkspace), sharedWorkspace];
            if ws == nil {
                return Err("NSWorkspace unavailable".into());
            }

            let ns_path = NSString::alloc(nil).init_str(path);
            let image: id = msg_send![ws, iconForFile: ns_path];
            if image == nil {
                return Err("iconForFile returned nil".into());
            }

            let size = NSSize::new(32.0, 32.0);
            let _: () = msg_send![image, setSize: size];

            let bitmap: id = msg_send![class!(NSBitmapImageRep), alloc];
            let bitmap: id = msg_send![bitmap,
                initWithBitmapDataPlanes: std::ptr::null_mut::<*mut u8>()
                pixelsWide: 32usize
                pixelsHigh: 32usize
                bitsPerSample: 8usize
                samplesPerPixel: 4usize
                hasAlpha: true
                isPlanar: false
                colorSpaceName: NSString::alloc(nil).init_str("NSCalibratedRGBColorSpace")
                bytesPerRow: 0usize
                bitsPerPixel: 0usize
            ];
            if bitmap == nil {
                return Err("failed to create NSBitmapImageRep".into());
            }

            let ctx: id = msg_send![class!(NSGraphicsContext), graphicsContextWithBitmapImageRep: bitmap];
            if ctx == nil {
                return Err("failed to create graphics context".into());
            }

            let _: () = msg_send![class!(NSGraphicsContext), saveGraphicsState];
            let _: () = msg_send![class!(NSGraphicsContext), setCurrentContext: ctx];
            let draw_rect = NSRect::new(cocoa::foundation::NSPoint::new(0.0, 0.0), size);
            let _: () = msg_send![image, drawInRect: draw_rect];
            let _: () = msg_send![class!(NSGraphicsContext), restoreGraphicsState];

            let data: id = msg_send![bitmap, representationUsingType: NSBitmapImageFileType::NSPNGFileType properties: nil];
            if data == nil {
                return Err("failed to encode PNG".into());
            }

            let bytes = NSData::bytes(data) as *const u8;
            let len = NSData::length(data);
            if bytes.is_null() || len == 0 {
                return Err("empty PNG data".into());
            }
            Ok(std::slice::from_raw_parts(bytes, len).to_vec())
        }
    }
}
