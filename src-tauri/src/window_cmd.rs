/// Set the native window opacity (0.0 = fully transparent, 1.0 = opaque).
///
/// On Windows uses `SetLayeredWindowAttributes`.  At full opacity (1.0) the
/// WS_EX_LAYERED style is removed so the compositor renders the window
/// without the extra compositing pass.
/// On other platforms the command is a no-op.
#[tauri::command]
pub fn window_set_opacity(app: tauri::AppHandle, opacity: f64) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    win::apply(&app, opacity)?;

    #[cfg(not(target_os = "windows"))]
    let _ = (app, opacity);

    Ok(())
}

#[cfg(target_os = "windows")]
mod win {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use tauri::Manager;
    use winapi::{
        shared::windef::HWND,
        um::winuser::{
            GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW,
            GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED,
        },
    };

    pub fn apply(app: &tauri::AppHandle, opacity: f64) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;

        let handle = window.window_handle().map_err(|e| e.to_string())?;
        let RawWindowHandle::Win32(h) = handle.as_raw() else {
            return Err("not a Win32 HWND".into());
        };
        // NonZeroIsize → raw HWND pointer
        let hwnd = h.hwnd.get() as *mut std::ffi::c_void as HWND;
        let alpha = (opacity.clamp(0.0, 1.0) * 255.0).round() as u8;

        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            if alpha < 255 {
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED as isize);
                SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA);
            } else {
                // Remove layered flag at full opacity (cleaner compositor path).
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !(WS_EX_LAYERED as isize));
            }
        }
        Ok(())
    }
}
