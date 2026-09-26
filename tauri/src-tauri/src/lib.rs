use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Mirrors `getConfigDir()` in src/server/config/paths.ts exactly: `PSMAIL_CONFIG_DIR` first, else
/// the OS's own config directory (Application Support on macOS, %APPDATA% on Windows, XDG_CONFIG_HOME/
/// ~/.config on Linux — which is exactly what the `dirs` crate's `config_dir()` resolves to on each of
/// these three platforms) plus "psmail".
fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PSMAIL_CONFIG_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::config_dir()
        .expect("could not determine the OS config directory")
        .join("psmail")
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

/// Only the two fields the desktop shell itself needs — the server's own settings.ts has the full schema.
#[derive(Deserialize, Default)]
struct SettingsFile {
    port: Option<u16>,
    hostname: Option<String>,
}

/// The server's own default (src/server/config/settings.ts) when settings.json doesn't exist yet, or
/// doesn't set these fields — kept in sync with that file by hand, since this reads the raw JSON
/// directly rather than sharing code with the TypeScript server.
const DEFAULT_PORT: u16 = 5387;
const DEFAULT_HOSTNAME: &str = "127.0.0.1";

fn read_server_address() -> (String, u16) {
    let parsed: SettingsFile = std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    (
        parsed.hostname.unwrap_or_else(|| DEFAULT_HOSTNAME.to_string()),
        parsed.port.unwrap_or(DEFAULT_PORT),
    )
}

/// The address the *webview* should load — not always the same as what the server binds to:
/// - "0.0.0.0" (every interface) isn't a valid address to connect *to*; loopback reaches the same server.
/// - A loopback IP literal ("127.0.0.1"/"::1") is a valid address to connect to, but not a valid WebAuthn
///   relying-party ID — passkey unlock (src/lib/passkeyVault.ts, defaults `rp.id` to the page's own
///   hostname) fails immediately with a SecurityError ("This is an invalid domain") on one, since the
///   WebAuthn spec requires the RP ID to be a real domain string, IP addresses excluded. "localhost" reaches
///   the exact same server (it's just another name for loopback) and *is* accepted as a domain, so it's
///   used for anything that resolves to loopback, matching what a browser tab opened at the documented
///   http://localhost:<port> already gets.
fn browsable_host(hostname: &str) -> &str {
    match hostname {
        "0.0.0.0" | "127.0.0.1" | "::1" => "localhost",
        other => other,
    }
}

fn wait_for_server(host: &str, port: u16, timeout: Duration) -> bool {
    let addr = format!("{host}:{port}");
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(&addr).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// Holds the sidecar's handle for the app's lifetime, so it can be killed when the app exits —
/// otherwise it would keep running as an orphan process after the window closes.
struct BackendProcess(Mutex<Option<CommandChild>>);

fn open_settings_file() {
    let path = settings_path();
    if let Err(err) = open::that(&path) {
        log::error!("Could not open {}: {err}", path.display());
    }
}

fn open_settings_folder() {
    let path = config_dir();
    if let Err(err) = open::that(&path) {
        log::error!("Could not open {}: {err}", path.display());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BackendProcess(Mutex::new(None)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let open_settings = MenuItem::with_id(app, "open-settings", "Open Settings", true, None::<&str>)?;
            let open_settings_folder_item =
                MenuItem::with_id(app, "open-settings-folder", "Open Settings Folder", true, None::<&str>)?;
            let app_menu = Submenu::with_items(
                app,
                "P.S.Mail",
                true,
                &[
                    &PredefinedMenuItem::about(app, Some("About P.S.Mail"), None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &open_settings,
                    &open_settings_folder_item,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;
            let menu = Menu::with_items(app, &[&app_menu, &edit_menu])?;
            app.set_menu(menu)?;

            let (hostname, port) = read_server_address();
            let host = browsable_host(&hostname).to_string();

            // The same sidecar binary (see tauri/scripts/build-sidecar.ts) is used in `tauri dev` and
            // `tauri build` alike, both of which run that script first (beforeDevCommand/
            // beforeBuildCommand) — so this is the one and only way the backend ever gets started.
            let (mut rx, child) = app.shell().sidecar("psmail-server")?.spawn()?;
            app.state::<BackendProcess>().0.lock().unwrap().replace(child);
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => log::info!("[psmail-server] {}", String::from_utf8_lossy(&line).trim_end()),
                        CommandEvent::Stderr(line) => log::error!("[psmail-server] {}", String::from_utf8_lossy(&line).trim_end()),
                        CommandEvent::Error(err) => log::error!("[psmail-server] {err}"),
                        _ => {}
                    }
                }
            });

            if !wait_for_server(&host, port, Duration::from_secs(20)) {
                log::error!("psmail-server never answered on {host}:{port} — opening the window anyway");
            }

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(format!("http://{host}:{port}").parse()?))
                .title("P.S.Mail")
                .inner_size(1280.0, 840.0)
                .min_inner_size(720.0, 480.0)
                .build()?;

            Ok(())
        })
        .on_menu_event(|_app, event| match event.id().as_ref() {
            "open-settings" => open_settings_file(),
            "open-settings-folder" => open_settings_folder(),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building the tauri application");

    // Either event means the app is on its way out: ExitRequested fires first (Quit/Cmd+Q calls
    // app.exit(), which is what actually reaches this — a generic OS-level "quit" sent to the app
    // from outside, e.g. via AppleScript, bypasses it), Exit is the final catch-all right before
    // the process itself ends. Whichever fires first takes the child handle, so this never tries
    // to kill it twice.
    app.run(|app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if let Some(child) = app_handle.state::<BackendProcess>().0.lock().unwrap().take() {
                if let Err(err) = child.kill() {
                    log::error!("Could not stop the psmail-server sidecar on exit: {err}");
                }
            }
        }
    });
}
