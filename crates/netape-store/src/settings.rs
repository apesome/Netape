//! Typed setting facades over the raw key-value store.
//!
//! Port of `DatabaseManager.IProperties` and its concrete subclasses
//! (`Terminal`, `Appearance`, `SFTP`, `Properties`).
//!
//! Each [`Settings`] instance is a thin namespace view over the `settings`
//! table — keys are stored as `"<namespace>.<key>"`.

use crate::db::Store;
use crate::error::StoreResult;

/// A namespaced view of the settings table.
///
/// ```
/// # use netape_store::db::Store;
/// let store = Store::open_in_memory().unwrap();
/// let t = store.terminal_settings();
/// let font = t.get_string("font").unwrap().unwrap_or("JetBrains Mono".into());
/// t.set("font", "Fira Code").unwrap();
/// ```
pub struct Settings<'a> {
    store: &'a Store,
    namespace: &'static str,
}

impl<'a> Settings<'a> {
    pub(crate) fn new(store: &'a Store, namespace: &'static str) -> Self {
        Settings { store, namespace }
    }

    fn full_key(&self, key: &str) -> String {
        format!("{}.{}", self.namespace, key)
    }

    /// Read any setting as a raw string.
    pub fn get_string(&self, key: &str) -> StoreResult<Option<String>> {
        self.store.get_setting(&self.full_key(key))
    }

    /// Read with a default fallback.
    pub fn get_string_or(&self, key: &str, default: &str) -> String {
        self.get_string(key)
            .ok()
            .flatten()
            .unwrap_or_else(|| default.to_string())
    }

    pub fn get_i64_or(&self, key: &str, default: i64) -> i64 {
        self.get_string(key)
            .ok()
            .flatten()
            .and_then(|s| s.parse().ok())
            .unwrap_or(default)
    }

    pub fn get_f64_or(&self, key: &str, default: f64) -> f64 {
        self.get_string(key)
            .ok()
            .flatten()
            .and_then(|s| s.parse().ok())
            .unwrap_or(default)
    }

    pub fn get_bool_or(&self, key: &str, default: bool) -> bool {
        self.get_string(key)
            .ok()
            .flatten()
            .and_then(|s| s.parse().ok())
            .unwrap_or(default)
    }

    /// Write a setting (converts value to string).
    pub fn set(&self, key: &str, value: impl ToString) -> StoreResult<()> {
        self.store
            .set_setting(&self.full_key(key), &value.to_string())
    }
}

// ---------------------------------------------------------------------------
// Typed setting wrappers
// ---------------------------------------------------------------------------

/// Terminal display settings.
///
pub struct TerminalSettings<'a>(pub Settings<'a>);

impl<'a> TerminalSettings<'a> {
    pub fn font(&self) -> String {
        self.0.get_string_or("font", "JetBrains Mono")
    }
    pub fn set_font(&self, v: &str) -> StoreResult<()> {
        self.0.set("font", v)
    }

    pub fn fallback_font(&self) -> String {
        self.0.get_string_or("fallbackFont", "")
    }

    pub fn font_size(&self) -> i64 {
        self.0.get_i64_or("fontSize", 14)
    }
    pub fn set_font_size(&self, v: i64) -> StoreResult<()> {
        self.0.set("fontSize", v)
    }

    pub fn max_rows(&self) -> i64 {
        self.0.get_i64_or("maxRows", 5000)
    }

    pub fn cursor_blink(&self) -> bool {
        self.0.get_bool_or("cursorBlink", false)
    }

    pub fn beep(&self) -> bool {
        self.0.get_bool_or("beep", true)
    }

    pub fn hyperlink(&self) -> bool {
        self.0.get_bool_or("hyperlink", true)
    }

    pub fn select_copy(&self) -> bool {
        self.0.get_bool_or("selectCopy", false)
    }

    pub fn right_click(&self) -> String {
        self.0.get_string_or("rightClick", "Copy")
    }

    pub fn cursor_style(&self) -> String {
        self.0.get_string_or("cursor", "Block")
    }

    pub fn auto_close_tab_when_disconnected(&self) -> bool {
        self.0.get_bool_or("autoCloseTabWhenDisconnected", false)
    }

    pub fn floating_toolbar(&self) -> bool {
        self.0.get_bool_or("floatingToolbar", true)
    }

    pub fn local_shell(&self) -> String {
        self.0.get_string_or("localShell", default_shell())
    }
}

/// Appearance (theme, language, …) settings.
///
/// Port of `DatabaseManager.Appearance`.
pub struct AppearanceSettings<'a>(pub Settings<'a>);

impl<'a> AppearanceSettings<'a> {
    pub fn theme(&self) -> String {
        self.0.get_string_or("theme", "Light")
    }
    pub fn set_theme(&self, v: &str) -> StoreResult<()> {
        self.0.set("theme", v)
    }

    pub fn layout(&self) -> String {
        self.0.get_string_or("layout", "Screen")
    }

    pub fn follow_system(&self) -> bool {
        self.0.get_bool_or("followSystem", true)
    }

    pub fn dark_theme(&self) -> String {
        self.0.get_string_or("darkTheme", "Dark")
    }

    pub fn light_theme(&self) -> String {
        self.0.get_string_or("lightTheme", "Light")
    }

    pub fn background_running(&self) -> bool {
        self.0.get_bool_or("backgroundRunning", false)
    }

    pub fn confirm_tab_close(&self) -> bool {
        self.0.get_bool_or("confirmTabClose", false)
    }

    pub fn background_image(&self) -> String {
        self.0.get_string_or("backgroundImage", "")
    }

    pub fn language(&self) -> String {
        self.0.get_string_or("language", "en_US")
    }
    pub fn set_language(&self, v: &str) -> StoreResult<()> {
        self.0.set("language", v)
    }

    pub fn opacity(&self) -> f64 {
        self.0.get_f64_or("opacity", 1.0)
    }
}

/// SFTP settings.
///
/// Port of `DatabaseManager.SFTP`.
pub struct SftpSettings<'a>(pub Settings<'a>);

impl<'a> SftpSettings<'a> {
    pub fn edit_command(&self) -> String {
        self.0.get_string_or("editCommand", "")
    }

    pub fn db_click_behavior(&self) -> String {
        self.0.get_string_or("dbClickBehavior", "Transfer")
    }

    pub fn sftp_command(&self) -> String {
        self.0.get_string_or("sftpCommand", "")
    }

    pub fn default_directory(&self) -> String {
        self.0.get_string_or("defaultDirectory", "")
    }

    pub fn pin_tab(&self) -> bool {
        self.0.get_bool_or("pinTab", false)
    }

    pub fn preserve_modification_time(&self) -> bool {
        self.0.get_bool_or("preserveModificationTime", false)
    }
}

fn default_shell() -> &'static str {
    if cfg!(windows) {
        "powershell.exe"
    } else {
        "/bin/bash"
    }
}

#[cfg(test)]
mod tests {
    use crate::db::Store;
    use crate::settings::{AppearanceSettings, TerminalSettings};

    #[test]
    fn terminal_defaults() {
        let store = Store::open_in_memory().unwrap();
        let ts = TerminalSettings(store.terminal_settings());
        assert_eq!(ts.font(), "JetBrains Mono");
        assert_eq!(ts.font_size(), 14);
        assert!(!ts.cursor_blink());
    }

    #[test]
    fn terminal_persist() {
        let store = Store::open_in_memory().unwrap();
        let ts = TerminalSettings(store.terminal_settings());
        ts.set_font_size(18).unwrap();
        let ts2 = TerminalSettings(store.terminal_settings());
        assert_eq!(ts2.font_size(), 18);
    }

    #[test]
    fn appearance_language() {
        let store = Store::open_in_memory().unwrap();
        let ap = AppearanceSettings(store.appearance_settings());
        ap.set_language("zh_CN").unwrap();
        assert_eq!(AppearanceSettings(store.appearance_settings()).language(), "zh_CN");
    }
}
