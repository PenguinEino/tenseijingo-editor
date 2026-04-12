use chrono::Utc;
use git2::{Oid, Repository, Signature};
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

#[derive(Debug, Clone, Serialize)]
struct GitLogEntry {
    commit_hash: String,
    message: String,
    timestamp: String,
    char_count: usize,
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
    chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string()
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

// ===== Git helpers =====

fn ensure_repo(app: &tauri::AppHandle) -> Result<Repository, String> {
    let dir = data_dir(app);
    match Repository::open(&dir) {
        Ok(repo) => Ok(repo),
        Err(_) => {
            let repo = Repository::init(&dir).map_err(|e| format!("Git init failed: {}", e))?;
            // Create initial commit so we have a valid HEAD
            {
                let sig = make_signature();
                let mut index = repo.index().map_err(|e| e.to_string())?;
                index.write().map_err(|e| e.to_string())?;
                let tree_id = index.write_tree().map_err(|e| e.to_string())?;
                let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
                repo.commit(Some("HEAD"), &sig, &sig, "初期化", &tree, &[])
                    .map_err(|e| e.to_string())?;
            }
            Ok(repo)
        }
    }
}

fn make_signature() -> Signature<'static> {
    Signature::now("天声人語エディタ", "tenseijingo@local").unwrap()
}

fn git_commit_file(app: &tauri::AppHandle, file_name: &str, message: &str) -> Result<Oid, String> {
    let repo = ensure_repo(app)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;

    // Stage the specific file
    index
        .add_path(std::path::Path::new(file_name))
        .map_err(|e| format!("git add failed: {}", e))?;
    index.write().map_err(|e| e.to_string())?;

    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let sig = make_signature();

    let head = repo.head().map_err(|e| e.to_string())?;
    let parent = head.peel_to_commit().map_err(|e| e.to_string())?;

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
        .map_err(|e| format!("git commit failed: {}", e))?;

    Ok(oid)
}

fn get_file_content_at_commit(
    repo: &Repository,
    commit_hash: &str,
    file_name: &str,
) -> Result<String, String> {
    let oid = Oid::from_str(commit_hash).map_err(|e| e.to_string())?;
    let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let entry = tree
        .get_name(file_name)
        .ok_or_else(|| "ファイルが見つかりません".to_string())?;
    let blob = entry
        .to_object(&repo)
        .map_err(|e| e.to_string())?
        .peel_to_blob()
        .map_err(|e| e.to_string())?;
    String::from_utf8(blob.content().to_vec()).map_err(|e| e.to_string())
}

// ===== Tauri Commands =====

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

    // Git commit the new file
    let file_name = format!("{}.json", id);
    let _ = git_commit_file(&app, &file_name, &format!("新規作成: {}", entry.title));

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

    // Git auto-commit
    let file_name = format!("{}.json", id);
    let now = Utc::now().format("%Y/%m/%d %H:%M:%S").to_string();
    let msg = format!("保存: {} ({}文字) - {}", entry.title, entry.char_count, now);
    let _ = git_commit_file(&app, &file_name, &msg);

    Ok(entry)
}

#[tauri::command]
fn rename_file(app: tauri::AppHandle, id: String, title: String) -> Result<(), String> {
    let path = file_path(&app, &id);
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut entry: FileEntry = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    entry.title = title.clone();
    entry.custom_title = true;
    entry.updated_at = now_iso();
    fs::write(&path, serde_json::to_string_pretty(&entry).unwrap()).map_err(|e| e.to_string())?;

    // Git commit rename
    let file_name = format!("{}.json", id);
    let _ = git_commit_file(&app, &file_name, &format!("名前変更: {}", title));

    Ok(())
}

#[tauri::command]
fn delete_file(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = file_path(&app, &id);
    let file_name = format!("{}.json", id);

    fs::remove_file(&path).map_err(|e| e.to_string())?;

    // Git commit deletion
    let repo = ensure_repo(&app)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .remove_path(std::path::Path::new(&file_name))
        .map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    let tree_id = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;
    let sig = make_signature();
    let head = repo.head().map_err(|e| e.to_string())?;
    let parent = head.peel_to_commit().map_err(|e| e.to_string())?;
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &format!("削除: {}", file_name),
        &tree,
        &[&parent],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn export_file_to(app: tauri::AppHandle, id: String, dest: String) -> Result<(), String> {
    let path = file_path(&app, &id);
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let entry: FileEntry = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    fs::write(&dest, &entry.body).map_err(|e| e.to_string())
}

#[tauri::command]
fn git_log(app: tauri::AppHandle, id: String) -> Result<Vec<GitLogEntry>, String> {
    let repo = ensure_repo(&app)?;
    let file_name = format!("{}.json", id);
    let mut entries: Vec<GitLogEntry> = Vec::new();

    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push_head().map_err(|e| e.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    for oid_result in revwalk {
        let oid = oid_result.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;

        // Check if this commit touches our file
        let tree = commit.tree().map_err(|e| e.to_string())?;
        if tree.get_name(&file_name).is_none() {
            continue;
        }

        // Check if the file content actually changed vs parent
        let dominated_by_parent = if commit.parent_count() > 0 {
            if let Ok(parent) = commit.parent(0) {
                if let Ok(parent_tree) = parent.tree() {
                    match (tree.get_name(&file_name), parent_tree.get_name(&file_name)) {
                        (Some(a), Some(b)) => a.id() == b.id(),
                        _ => false,
                    }
                } else {
                    false
                }
            } else {
                false
            }
        } else {
            false
        };

        if dominated_by_parent {
            continue;
        }

        // Get the file content to count chars
        let char_count = if let Ok(content) = get_file_content_at_commit(&repo, &oid.to_string(), &file_name) {
            if let Ok(fe) = serde_json::from_str::<FileEntry>(&content) {
                fe.char_count
            } else {
                0
            }
        } else {
            0
        };

        let timestamp = {
            let time = commit.time();
            let secs = time.seconds();
            // Convert to human-readable using chrono
            let dt = chrono::DateTime::from_timestamp(secs, 0)
                .unwrap_or_default();
            dt.format("%Y/%m/%d %H:%M:%S").to_string()
        };

        entries.push(GitLogEntry {
            commit_hash: oid.to_string(),
            message: commit.message().unwrap_or("").to_string(),
            timestamp,
            char_count,
        });

        // Limit to 100 entries
        if entries.len() >= 100 {
            break;
        }
    }

    Ok(entries)
}

#[tauri::command]
fn git_show(app: tauri::AppHandle, id: String, commit_hash: String) -> Result<String, String> {
    let repo = ensure_repo(&app)?;
    let file_name = format!("{}.json", id);
    let content = get_file_content_at_commit(&repo, &commit_hash, &file_name)?;
    let entry: FileEntry = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(entry.body)
}

#[tauri::command]
fn git_restore(app: tauri::AppHandle, id: String, commit_hash: String) -> Result<FileEntry, String> {
    let repo = ensure_repo(&app)?;
    let file_name = format!("{}.json", id);

    // Get the old content
    let old_content = get_file_content_at_commit(&repo, &commit_hash, &file_name)?;
    let mut entry: FileEntry = serde_json::from_str(&old_content).map_err(|e| e.to_string())?;

    // Update the timestamp
    entry.updated_at = now_iso();
    entry.char_count = count_display_chars(&entry.body);

    // Write to disk
    let path = file_path(&app, &id);
    let json = serde_json::to_string_pretty(&entry).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;

    // Git commit the restore
    let short_hash = &commit_hash[..7.min(commit_hash.len())];
    let msg = format!("復元: {} ← {}", entry.title, short_hash);
    let _ = git_commit_file(&app, &file_name, &msg);

    // Re-read to return fresh entry
    drop(repo);
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
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
                .item(&MenuItemBuilder::with_id("history", "版履歴").accelerator("CmdOrCtrl+H").build(app)?)
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
                "new" | "save" | "export" | "rename" | "preview" | "back" | "history" => {
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
            export_file_to,
            git_log,
            git_show,
            git_restore
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
