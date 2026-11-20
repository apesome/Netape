//! Windows placement keeps normal bounds and maximization in one native snapshot.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, WebviewWindow};
use winapi::{
    shared::windef::{HWND, RECT},
    um::winuser::{
        GetMonitorInfoW, GetWindowPlacement, MonitorFromRect, SetWindowPlacement, ShowWindow,
        MONITORINFO, MONITOR_DEFAULTTONEAREST, SW_HIDE, SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED,
        SW_SHOWNORMAL, WINDOWPLACEMENT, WPF_RESTORETOMAXIMIZED,
    },
};

pub struct PlacementReady(pub AtomicBool);

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct Placement {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    maximized: bool,
}

fn hwnd(window: &WebviewWindow) -> Result<HWND, String> {
    window
        .hwnd()
        .map(|handle| handle.0 as HWND)
        .map_err(|error| error.to_string())
}

fn native_placement(window: &WebviewWindow) -> Result<WINDOWPLACEMENT, String> {
    let mut placement: WINDOWPLACEMENT = unsafe { std::mem::zeroed() };
    placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
    if unsafe { GetWindowPlacement(hwnd(window)?, &mut placement) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(placement)
}

fn state_path(window: &WebviewWindow) -> Result<std::path::PathBuf, String> {
    window
        .app_handle()
        .path()
        .app_config_dir()
        .map(|path| path.join(".window-placement.json"))
        .map_err(|error| error.to_string())
}

pub fn save(window: &WebviewWindow) -> Result<(), String> {
    if !window.state::<PlacementReady>().0.load(Ordering::Acquire) {
        return Ok(());
    }
    // Hiding can change showCmd; the caller saves before hiding to the tray.
    if !window.is_visible().map_err(|error| error.to_string())? {
        return Ok(());
    }
    let placement = native_placement(window)?;
    let rect = placement.rcNormalPosition;
    let snapshot = Placement {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        maximized: placement.showCmd == SW_SHOWMAXIMIZED as u32
            || (placement.showCmd == SW_SHOWMINIMIZED as u32
                && placement.flags & WPF_RESTORETOMAXIMIZED != 0),
    };
    if snapshot.width <= 0 || snapshot.height <= 0 {
        return Ok(());
    }
    let path = state_path(window)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|error| error.to_string())?;
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&snapshot).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

// Clamp stale/off-screen geometry to a monitor's work area. Oversized legacy
// snapshots came from maximizing without saving the maximized flag.
fn fit_to_work_area(mut placement: Placement, work: [i32; 4], default_size: [i32; 2]) -> Placement {
    let [left, top, right, bottom] = work;
    let width = right - left;
    let height = bottom - top;
    if placement.width <= 0
        || placement.height <= 0
        || placement.width > width
        || placement.height > height
    {
        placement.width = default_size[0].min(width);
        placement.height = default_size[1].min(height);
        placement.x = left + (width - placement.width) / 2;
        placement.y = top + (height - placement.height) / 2;
    } else {
        placement.x = placement.x.clamp(left, right - placement.width);
        placement.y = placement.y.clamp(top, bottom - placement.height);
    }
    placement
}

pub fn restore(window: &WebviewWindow, legacy_maximized: bool) -> Result<(), String> {
    let handle = hwnd(window)?;
    let mut native = native_placement(window)?;
    let rect = native.rcNormalPosition;
    let path = state_path(window)?;
    let saved = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Placement>(&bytes).ok());
    // Migrate the old plugin file only once; it may contain maximized bounds
    // marked as normal. The old DB flag is used only for this migration.
    let legacy = || -> Option<Placement> {
        let bytes = std::fs::read(path.parent()?.join(".window-state.json")).ok()?;
        let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        let state = json.get("main")?;
        Some(Placement {
            x: state.get("x")?.as_i64()?.try_into().ok()?,
            y: state.get("y")?.as_i64()?.try_into().ok()?,
            width: state.get("width")?.as_i64()?.try_into().ok()?,
            height: state.get("height")?.as_i64()?.try_into().ok()?,
            maximized: legacy_maximized
                || state
                    .get("maximized")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false),
        })
    };
    let saved = saved.or_else(legacy);
    let first_launch = saved.is_none();
    let mut placement = saved.unwrap_or(Placement {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        maximized: legacy_maximized,
    });
    let proposed = RECT {
        left: placement.x,
        top: placement.y,
        right: placement.x.saturating_add(placement.width.max(1)),
        bottom: placement.y.saturating_add(placement.height.max(1)),
    };
    let monitor = unsafe { MonitorFromRect(&proposed, MONITOR_DEFAULTTONEAREST) };
    let mut info: MONITORINFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let work = info.rcWork;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let default_size = [
        (1024.0 * scale).round() as i32,
        (720.0 * scale).round() as i32,
    ];
    // WINDOWPLACEMENT uses workspace coordinates (not screen coordinates).
    let left = info.rcMonitor.left;
    let top = info.rcMonitor.top;
    let right = left + work.right - work.left;
    let bottom = top + work.bottom - work.top;
    placement = fit_to_work_area(placement, [left, top, right, bottom], default_size);
    if first_launch {
        placement.x = left + (right - left - placement.width) / 2;
        placement.y = top + (bottom - top - placement.height) / 2;
    }
    native.flags = 0;
    native.showCmd = SW_HIDE as u32;
    native.rcNormalPosition = RECT {
        left: placement.x,
        top: placement.y,
        right: placement.x + placement.width,
        bottom: placement.y + placement.height,
    };
    if unsafe { SetWindowPlacement(handle, &native) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // Keep Tao's internal visibility flags in sync with the native window.
    // A native ShowWindow alone leaves VISIBLE=false, making later hide() a no-op.
    window.show().map_err(|error| error.to_string())?;
    // Apply the final mode synchronously on the UI thread before notifying JS.
    unsafe {
        ShowWindow(
            handle,
            if placement.maximized {
                SW_SHOWMAXIMIZED
            } else {
                SW_SHOWNORMAL
            },
        );
    }
    window
        .state::<PlacementReady>()
        .0
        .store(true, Ordering::Release);
    save(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_maximized_bounds_are_recentered_without_changing_mode() {
        let result = fit_to_work_area(
            Placement {
                x: -13,
                y: -13,
                width: 2048,
                height: 1888,
                maximized: true,
            },
            [0, 0, 1920, 1040],
            [1024, 720],
        );
        assert_eq!(
            (result.x, result.y, result.width, result.height),
            (448, 160, 1024, 720)
        );
        assert!(result.maximized);
    }

    #[test]
    fn normal_bounds_and_negative_coordinate_monitor_are_preserved() {
        let result = fit_to_work_area(
            Placement {
                x: -1600,
                y: 150,
                width: 1024,
                height: 720,
                maximized: false,
            },
            [-1920, 0, 0, 1040],
            [1024, 720],
        );
        assert_eq!((result.x, result.y), (-1600, 150));
    }

    #[test]
    fn removed_monitor_placement_is_clamped() {
        let result = fit_to_work_area(
            Placement {
                x: 3000,
                y: -100,
                width: 1024,
                height: 720,
                maximized: false,
            },
            [0, 0, 1920, 1040],
            [1024, 720],
        );
        assert_eq!((result.x, result.y), (896, 0));
    }
}
