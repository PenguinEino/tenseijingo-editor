use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileEntry {
    id: String,
    title: String,
    body: String,
    updated_at: String,
    char_count: usize,
    #[serde(default)]
    custom_title: bool,
}

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .join("manuscripts");
    if !dir.exists() {
        fs::create_dir_all(&dir).expect("failed to create data dir");
    }
    dir
}

fn file_path(app: &tauri::AppHandle, id: &str) -> PathBuf {
    data_dir(app).join(format!("{}.json", id))
}

fn now_iso() -> String {
    let now = std::time::SystemTime::now();
    let dur = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let days = secs / 86400;
    let time_of_day = secs % 86400;
    let h = time_of_day / 3600;
    let m = (time_of_day % 3600) / 60;
    let s = time_of_day % 60;
    let mut y: i64 = 1970;
    let mut remaining = days as i64;
    loop {
        let days_in_year: i64 = if is_leap(y) { 366 } else { 365 };
        if remaining < days_in_year {
            break;
        }
        remaining -= days_in_year;
        y += 1;
    }
    let month_days: [i64; 12] = if is_leap(y) {
        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    } else {
        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    };
    let mut mo = 0;
    for md in &month_days {
        if remaining < *md {
            break;
        }
        remaining -= md;
        mo += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        y,
        mo + 1,
        remaining + 1,
        h,
        m,
        s
    )
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn derive_title(body: &str) -> String {
    let first_line = body.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        "無題".to_string()
    } else {
        first_line.chars().take(20).collect()
    }
}

fn count_display_chars(body: &str) -> usize {
    let chars: Vec<char> = body.chars().collect();
    let mut count = 0;
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\n' {
            i += 1;
            continue;
        }
        if chars[i].is_ascii_digit() || ('０'..='９').contains(&chars[i]) {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_digit() || ('０'..='９').contains(&chars[i]))
            {
                i += 1;
            }
            let run = i - start;
            if run == 2 {
                count += 1;
            } else {
                count += run;
            }
            continue;
        }
        count += 1;
        i += 1;
    }
    count
}

#[tauri::command]
fn list_files(app: tauri::AppHandle) -> Vec<FileEntry> {
    let dir = data_dir(&app);
    let mut entries: Vec<FileEntry> = Vec::new();
    if let Ok(read) = fs::read_dir(&dir) {
        for entry in read.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                if let Ok(data) = fs::read_to_string(&path) {
                    if let Ok(fe) = serde_json::from_str::<FileEntry>(&data) {
                        entries.push(fe);
                    }
                }
            }
        }
    }
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    entries
}

#[tauri::command]
fn create_file(app: tauri::AppHandle) -> String {
    let id = Uuid::new_v4().to_string();
    let entry = FileEntry {
        id: id.clone(),
        title: "無題".to_string(),
        body: String::new(),
        updated_at: now_iso(),
        char_count: 0,
        custom_title: false,
    };
    let path = file_path(&app, &id);
    fs::write(&path, serde_json::to_string_pretty(&entry).unwrap()).unwrap();
    id
}

#[tauri::command]
fn read_file(app: tauri::AppHandle, id: String) -> Result<FileEntry, String> {
    let path = file_path(&app, &id);
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_file(app: tauri::AppHandle, id: String, body: String) -> Result<FileEntry, String> {
    let path = file_path(&app, &id);
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut entry: FileEntry = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    entry.char_count = count_display_chars(&body);
    if !entry.custom_title {
        entry.title = derive_title(&body);
    }
    entry.body = body;
    entry.updated_at = now_iso();
    let json = serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(entry)
}

#[tauri::command]
fn rename_file(app: tauri::AppHandle, id: String, title: String) -> Result<(), String> {
    let path = file_path(&app, &id);
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut entry: FileEntry = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    entry.title = title;
    entry.custom_title = true;
    entry.updated_at = now_iso();
    fs::write(&path, serde_json::to_string_pretty(&entry).unwrap()).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = file_path(&app, &id);
    fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn export_file_to(app: tauri::AppHandle, id: String, dest: String) -> Result<(), String> {
    let path = file_path(&app, &id);
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let entry: FileEntry = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    fs::write(&dest, &entry.body).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(|app| {
            let file_submenu = SubmenuBuilder::new(app, "ファイル")
                .item(&MenuItemBuilder::with_id("new", "新規作成").accelerator("CmdOrCtrl+N").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id("save", "保存").accelerator("CmdOrCtrl+S").build(app)?)
                .item(&MenuItemBuilder::with_id("export", "書き出し…").accelerator("CmdOrCtrl+Shift+E").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id("rename", "名前変更…").build(app)?)
                .item(&MenuItemBuilder::with_id("preview", "テキスト表示").accelerator("CmdOrCtrl+P").build(app)?)
                .separator()
                .item(&MenuItemBuilder::with_id("back", "一覧に戻る").accelerator("CmdOrCtrl+W").build(app)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, Some("終了"))?)
                .build()?;

            let edit_submenu = SubmenuBuilder::new(app, "編集")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            MenuBuilder::new(app)
                .item(&file_submenu)
                .item(&edit_submenu)
                .build()
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            match id {
                "new" | "save" | "export" | "rename" | "preview" | "back" => {
                    let _ = app.emit("menu-action", id);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_files,
            create_file,
            read_file,
            save_file,
            rename_file,
            delete_file,
            export_file_to
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
