use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, Manager, State};

struct LocalTerm {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct LocalState {
    terms: Mutex<HashMap<String, LocalTerm>>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[tauri::command]
pub fn local_open(
    app: AppHandle,
    state: State<'_, LocalState>,
    term_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pty = native_pty_system()
        .openpty(size(cols, rows))
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-il");
    cmd.env("TERM", "xterm-256color");
    cmd.env("LANG", std::env::var("LANG").unwrap_or_else(|_| "fr_FR.UTF-8".into()));
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }

    let child = pty.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let mut reader = pty.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pty.master.take_writer().map_err(|e| e.to_string())?;

    state.terms.lock().unwrap().insert(
        term_id.clone(),
        LocalTerm {
            master: pty.master,
            writer,
            killer,
        },
    );

    // Lecture bloquante dans un thread dédié ; chaque paquet part en événement.
    std::thread::spawn(move || {
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app.emit(&format!("local-data-{}", term_id), b64.encode(&buf[..n]));
                }
            }
        }
        let _ = app.emit(&format!("local-closed-{}", term_id), ());
        if let Some(st) = app.try_state::<LocalState>() {
            st.terms.lock().unwrap().remove(&term_id);
        }
    });

    Ok(())
}

#[tauri::command]
pub fn local_write(
    state: State<'_, LocalState>,
    term_id: String,
    data: String,
) -> Result<(), String> {
    let mut terms = state.terms.lock().unwrap();
    let term = terms.get_mut(&term_id).ok_or("Terminal local inconnu")?;
    term.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_resize(
    state: State<'_, LocalState>,
    term_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let terms = state.terms.lock().unwrap();
    let term = terms.get(&term_id).ok_or("Terminal local inconnu")?;
    term.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn local_close(state: State<'_, LocalState>, term_id: String) -> Result<(), String> {
    if let Some(mut term) = state.terms.lock().unwrap().remove(&term_id) {
        let _ = term.killer.kill();
    }
    Ok(())
}
