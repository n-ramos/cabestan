mod docker;
mod git;
mod local;
mod ssh;

use std::collections::HashMap;

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Actions dont le raccourci est personnalisable : (id, libellé, raccourci par défaut).
pub const ACTIONS: &[(&str, &str, &str)] = &[
    ("settings", "Réglages…", "CmdOrCtrl+,"),
    ("new-conn", "Nouvelle connexion", "CmdOrCtrl+T"),
    ("new-local", "Nouveau terminal local", "CmdOrCtrl+N"),
    ("close-tab", "Fermer l'onglet", "CmdOrCtrl+W"),
    ("split-right", "Scinder à droite", "CmdOrCtrl+D"),
    ("split-down", "Scinder en dessous", "CmdOrCtrl+Shift+D"),
    ("close-pane", "Fermer le panneau", "CmdOrCtrl+Shift+W"),
    ("next-tab", "Onglet suivant", "Ctrl+Tab"),
    ("prev-tab", "Onglet précédent", "Ctrl+Shift+Tab"),
    ("reconnect", "Reconnecter", "CmdOrCtrl+R"),
    ("toggle-files", "Masquer/afficher l'explorateur", "CmdOrCtrl+E"),
    ("toggle-sync", "Suivre le dossier du terminal", "CmdOrCtrl+Shift+E"),
    ("docker", "Conteneurs Docker…", "CmdOrCtrl+Shift+B"),
    ("git", "Dépôt Git…", "CmdOrCtrl+Shift+G"),
];

fn accel_for<'a>(overrides: &'a HashMap<String, String>, id: &str) -> Option<&'a str> {
    // Une chaîne vide signifie « raccourci retiré ».
    if let Some(custom) = overrides.get(id) {
        return if custom.is_empty() {
            None
        } else {
            Some(custom.as_str())
        };
    }
    ACTIONS
        .iter()
        .find(|(aid, _, _)| *aid == id)
        .map(|(_, _, def)| *def)
}

fn label_for(id: &str) -> &'static str {
    ACTIONS
        .iter()
        .find(|(aid, _, _)| *aid == id)
        .map(|(_, label, _)| *label)
        .unwrap_or("(action inconnue)")
}

/// Construit un élément de menu en appliquant le raccourci courant.
fn item<R: Runtime>(
    app: &AppHandle<R>,
    overrides: &HashMap<String, String>,
    id: &str,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    let mut b = MenuItemBuilder::with_id(id, label_for(id));
    if let Some(accel) = accel_for(overrides, id) {
        b = b.accelerator(accel);
    }
    b.build(app)
}

/// (Re)construit toute la barre de menus avec les raccourcis donnés.
pub fn apply_menu<R: Runtime>(
    app: &AppHandle<R>,
    overrides: &HashMap<String, String>,
) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(app, "Cabestan")
        .about(None)
        .separator()
        .item(&item(app, overrides, "settings")?)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "Fichier")
        .item(&item(app, overrides, "new-conn")?)
        .item(&item(app, overrides, "new-local")?)
        .item(&item(app, overrides, "close-tab")?)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Édition")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view_menu = SubmenuBuilder::new(app, "Session")
        .item(&item(app, overrides, "split-right")?)
        .item(&item(app, overrides, "split-down")?)
        .item(&item(app, overrides, "close-pane")?)
        .separator()
        .item(&item(app, overrides, "next-tab")?)
        .item(&item(app, overrides, "prev-tab")?)
        .separator()
        .item(&item(app, overrides, "reconnect")?)
        .separator()
        .item(&item(app, overrides, "toggle-files")?)
        .item(&item(app, overrides, "toggle-sync")?)
        .separator()
        .item(&item(app, overrides, "docker")?)
        .item(&item(app, overrides, "git")?)
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Fenêtre")
        .minimize()
        .fullscreen()
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutAction {
    pub id: String,
    pub label: String,
    pub default_accel: String,
}

/// Catalogue des actions et de leurs raccourcis par défaut (source de vérité Rust).
#[tauri::command]
fn shortcut_actions() -> Vec<ShortcutAction> {
    ACTIONS
        .iter()
        .map(|(id, label, def)| ShortcutAction {
            id: (*id).to_string(),
            label: (*label).to_string(),
            default_accel: (*def).to_string(),
        })
        .collect()
}

/// Applique des raccourcis personnalisés (id → accélérateur ; "" pour retirer).
#[tauri::command]
fn set_shortcuts(app: AppHandle, overrides: HashMap<String, String>) -> Result<(), String> {
    apply_menu(&app, &overrides).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(ssh::SshState::default())
        .manage(local::LocalState::default())
        .manage(ssh::LogState::default())
        .manage(ssh::FollowState::default())
        .setup(|app| {
            apply_menu(&app.handle().clone(), &HashMap::new())?;
            app.on_menu_event(|app, event| {
                let _ = app.emit("menu", event.id().0.clone());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_disconnect,
            ssh::sftp_list,
            ssh::sftp_mkdir,
            ssh::sftp_remove,
            ssh::sftp_rename,
            ssh::sftp_chmod,
            ssh::sftp_download,
            ssh::sftp_upload,
            ssh::shell_open,
            ssh::shell_write,
            ssh::shell_resize,
            ssh::shell_close,
            ssh::shell_cwd,
            local::local_open,
            local::local_write,
            local::local_resize,
            local::local_close,
            shortcut_actions,
            set_shortcuts,
            ssh::transfer_cancel,
            ssh::edit_open,
            ssh::ssh_config_hosts,
            ssh::cred_set,
            ssh::cred_get,
            ssh::cred_delete,
            ssh::local_public_keys,
            ssh::ssh_copy_id,
            ssh::sftp_touch,
            ssh::remote_du,
            ssh::remote_df,
            ssh::tunnel_open,
            ssh::tunnel_close,
            ssh::tunnel_list,
            ssh::remote_archive,
            ssh::remote_extract,
            ssh::remote_search,
            ssh::remote_sha256,
            ssh::local_sha256,
            ssh::sftp_trash,
            ssh::compare_dirs,
            ssh::server_to_server,
            ssh::remote_stats,
            ssh::remote_services,
            ssh::remote_service_action,
            ssh::remote_preview,
            ssh::known_hosts_list,
            ssh::known_hosts_remove,
            ssh::tunnel_open_remote,
            ssh::tunnel_open_socks,
            ssh::log_start,
            ssh::log_write,
            ssh::log_stop,
            ssh::log_active,
            ssh::config_export,
            ssh::config_import,
            ssh::remote_run,
            ssh::sftp_write_text,
            ssh::sftp_read_text,
            ssh::local_read_text,
            docker::docker_cli,
            docker::docker_probe,
            docker::docker_logs_follow,
            docker::docker_logs_stop,
            git::git_cli,
            ssh::local_trash,
            ssh::remote_history,
            ssh::follow_start,
            ssh::follow_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
