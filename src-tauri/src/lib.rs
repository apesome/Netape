mod app_state;
mod window_cmd;
mod encoding;
mod file_icon;
mod fonts_cmd;
mod shells_cmd;
mod ftp;
mod smb;
mod highlight_cmd;
mod hosts;
mod keymgr_cmd;
mod plugin;
mod settings_cmd;
mod sftp;
mod note_cmd;
mod ssh_auth;
mod ssh_terminal;
mod telnet;
mod terminal;

use std::sync::Arc;
use tauri::menu::{Menu, MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

const TRAY_ID: &str = "main-tray";
const TRAY_SHOW_ID: &str = "tray-show";
const TRAY_QUIT_ID: &str = "tray-quit";

fn tray_menu_labels(lang: &str) -> (&'static str, &'static str) {
    match lang {
        "zh_CN" => ("显示 Netape", "退出"),
        "de" => ("Netape anzeigen", "Beenden"),
        "ja" => ("Netape を表示", "終了"),
        _ => ("Show Netape", "Quit"),
    }
}

fn build_tray_menu<R: Runtime>(app: &AppHandle<R>, lang: &str) -> tauri::Result<Menu<R>> {
    let (show_text, quit_text) = tray_menu_labels(lang);
    let show_item = MenuItem::with_id(app, TRAY_SHOW_ID, show_text, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_QUIT_ID, quit_text, true, None::<&str>)?;
    MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

pub(crate) fn refresh_tray_menu<R: Runtime>(app: &AppHandle<R>, lang: &str) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let menu = build_tray_menu(app, lang)?;
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

fn init_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let lang = app
        .state::<app_state::AppState>()
        .store
        .get_setting("Setting.Appearance.language")
        .ok()
        .flatten()
        .unwrap_or_else(|| "zh_CN".to_string());
    let menu = build_tray_menu(app, &lang)?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Netape")
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            if event.id.as_ref() == TRAY_SHOW_ID {
                show_main_window(app);
            } else if event.id.as_ref() == TRAY_QUIT_ID {
                app.exit(0);
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, button_state, .. } = event {
                if button == MouseButton::Left && button_state == MouseButtonState::Up {
                    show_main_window(tray.app_handle());
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    let tray = tray.build(app)?;
    let visible = app
        .state::<app_state::AppState>()
        .store
        .get_setting("Setting.Appearance.backgroundRunning")
        .ok()
        .flatten()
        .map(|v| v != "false")
        .unwrap_or(true);
    let _ = tray.set_visible(visible);

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Only save/restore SIZE and POSITION — exclude VISIBLE so the plugin
        // never shows the window early (we call win.show() ourselves in windowInit.ts
        // after centering / restoring position).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            terminal::init(&app.handle());
            ssh_terminal::init(&app.handle());
            telnet::init(&app.handle());
            sftp::init(&app.handle());
            plugin::init(&app.handle());

            let app_state = app_state::AppState::init(&app.handle())
                .expect("failed to open app store");

            // Center the window before it becomes visible so the black loading
            // phase (especially in dev mode) appears centered on screen.
            // JS windowInit.ts may later restore a saved position before show().
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.center();
            }

            app.manage(app_state);
            app.manage(ssh_auth::KbiState::default());
            app.manage(ftp::FtpTunnelState::default());
            app.manage(Arc::new(sftp::ConflictState::default()));
            app.manage(Arc::new(sftp::PauseState::default()));
            init_tray(&app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Local PTY
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::wsl_list_distributions,
            // SSH
            ssh_terminal::ssh_connect,
            ssh_terminal::ssh_write,
            ssh_terminal::ssh_resize,
            ssh_terminal::ssh_close,
            ssh_terminal::ssh_get_cwd,
            ssh_terminal::ssh_server_stats,
            ssh_terminal::ssh_ping,
            ssh_terminal::ssh_process_list,
            ssh_terminal::ssh_process_signal,
            ssh_terminal::ssh_process_renice,
            ssh_terminal::ssh_docker_list,
            ssh_terminal::ssh_docker_action,
            ssh_terminal::ssh_docker_image_list,
            ssh_terminal::ssh_docker_image_action,
            ssh_terminal::ssh_sysinfo,
            ssh_auth::ssh_kbi_respond,
            // Telnet
            telnet::telnet_connect,
            telnet::telnet_write,
            telnet::telnet_resize,
            telnet::telnet_close,
            // Hosts
            hosts::host_list,
            hosts::host_save,
            hosts::host_remove,
            // Key manager
            keymgr_cmd::key_list,
            keymgr_cmd::key_generate,
            keymgr_cmd::key_import,
            keymgr_cmd::key_remove,
            // Settings
            settings_cmd::settings_get,
            settings_cmd::settings_set,
            // Notes
            note_cmd::note_list,
            note_cmd::note_save,
            note_cmd::note_remove,
            // Keyword highlights
            highlight_cmd::highlight_list,
            highlight_cmd::highlight_save,
            highlight_cmd::highlight_remove,
            // SFTP transfer
            sftp::sftp_open,
            sftp::sftp_close,
            sftp::sftp_list_dir,
            sftp::sftp_stat,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_remove,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::sftp_download_dir,
            sftp::sftp_upload_dir,
            sftp::local_home_dir,
            sftp::local_list_dir,
            sftp::local_list_drives,
            sftp::local_rename,
            sftp::local_delete,
            sftp::local_mkdir,
            sftp::local_create_file,
            sftp::local_open_in_explorer,
            sftp::local_open_file,
            sftp::local_copy_file,
            sftp::local_stat_paths,
            sftp::local_clipboard_files,
            sftp::sftp_create_file,
            sftp::sftp_chmod,
            sftp::sftp_exec,
            sftp::sftp_edit,
            sftp::sftp_open_host,
            sftp::sftp_resolve_conflict,
            sftp::sftp_pause_transfer,
            sftp::sftp_resume_transfer,
            // File icon (shell icon extraction)
            file_icon::get_file_icon,
            // Plugins
            plugin::plugins_list,
            plugin::plugins_install,
            plugin::plugins_uninstall,
            plugin::plugins_marketplace,
            plugin::plugins_install_market,
            // Window
            window_cmd::window_set_opacity,
            // Fonts / system
            fonts_cmd::system_fonts,
            fonts_cmd::terminal_beep,
            // Shell discovery
            shells_cmd::discover_shells,
            // FTP (plugin) transfer
            ftp::ftp_open_host,
            ftp::ftp_list_dir,
            ftp::ftp_stat,
            ftp::ftp_mkdir,
            ftp::ftp_rename,
            ftp::ftp_remove,
            ftp::ftp_close,
            ftp::ftp_download,
            ftp::ftp_upload,
            // SMB (plugin) transfer
            smb::smb_open_host,
            smb::smb_list_shares,
            smb::smb_list_dir,
            smb::smb_stat,
            smb::smb_mkdir,
            smb::smb_rename,
            smb::smb_remove,
            smb::smb_close,
            smb::smb_download,
            smb::smb_download_dir,
            smb::smb_upload,
            smb::smb_upload_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Netape");
}
