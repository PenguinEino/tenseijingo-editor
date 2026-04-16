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
    #[serde(default)]
    bold_ranges: Vec<[usize; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AppConfig {
    #[serde(default)]
    data_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct GitLogEntry {
    commit_hash: String,
    message: String,
    timestamp: String,
    char_count: usize,
}

fn config_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .join("config.json")
}

fn load_config(app: &tauri::AppHandle) -> AppConfig {
    let path = config_path(app);
    if path.exists() {
        if let Ok(data) = fs::read_to_string(&path) {
            if let Ok(config) = serde_json::from_str::<AppConfig>(&data) {
                return config;
            }
        }
    }
    AppConfig { data_dir: None }
}

fn save_config(app: &tauri::AppHandle, config: &AppConfig) -> Result<(), String> {
    let base = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");
    if !base.exists() {
        fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    }
    let path = config_path(app);
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn copy_dir_contents(from: &PathBuf, to: &PathBuf) -> Result<(), String> {
    if !to.exists() {
        fs::create_dir_all(to).map_err(|e| e.to_string())?;
    }
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src = entry.path();
        let dest = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir_contents(&src, &dest)?;
        } else {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(&src, &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn default_data_dir(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .expect("failed to get app data dir")
        .join("manuscripts")
}

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
    let config = load_config(app);
    let dir = if let Some(ref custom) = config.data_dir {
        PathBuf::from(custom)
    } else {
        default_data_dir(app)
    };
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
fn is_first_launch(app: tauri::AppHandle) -> bool {
    !config_path(&app).exists()
}

#[tauri::command]
fn get_data_dir(app: tauri::AppHandle) -> String {
    data_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn get_default_data_dir(app: tauri::AppHandle) -> String {
    default_data_dir(&app).to_string_lossy().to_string()
}

#[tauri::command]
fn set_data_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = PathBuf::from(&path);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let mut config = load_config(&app);
    config.data_dir = Some(path);
    save_config(&app, &config)
}

#[tauri::command]
fn switch_data_dir(
    app: tauri::AppHandle,
    path: String,
    migrate_existing: bool,
) -> Result<(), String> {
    let current_dir = data_dir(&app);
    let new_dir = PathBuf::from(&path);
    if !new_dir.exists() {
        fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;
    }

    let current_canon = fs::canonicalize(&current_dir).unwrap_or(current_dir.clone());
    let new_canon = fs::canonicalize(&new_dir).unwrap_or(new_dir.clone());
    if migrate_existing && current_canon != new_canon && current_dir.exists() {
        copy_dir_contents(&current_dir, &new_dir)?;
    }

    let mut config = load_config(&app);
    config.data_dir = Some(path);
    save_config(&app, &config)
}

#[tauri::command]
fn set_default_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = default_data_dir(&app);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let mut config = load_config(&app);
    config.data_dir = None;
    save_config(&app, &config)?;
    Ok(dir.to_string_lossy().to_string())
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
        bold_ranges: Vec::new(),
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
fn save_file(
    app: tauri::AppHandle,
    id: String,
    body: String,
    bold_ranges: Option<Vec<[usize; 2]>>,
) -> Result<FileEntry, String> {
    let path = file_path(&app, &id);
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut entry: FileEntry = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    entry.char_count = count_display_chars(&body);
    if !entry.custom_title {
        entry.title = derive_title(&body);
    }
    entry.body = body;
    entry.updated_at = now_iso();
    if let Some(ranges) = bold_ranges {
        entry.bold_ranges = ranges;
    }
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
fn export_file_to(dest: String, content: String) -> Result<(), String> {
    fs::write(&dest, content).map_err(|e| e.to_string())
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
                .item(&MenuItemBuilder::with_id("preview", "プレビュー").accelerator("CmdOrCtrl+P").build(app)?)
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
            is_first_launch,
            get_data_dir,
            get_default_data_dir,
            set_data_dir,
            switch_data_dir,
            set_default_data_dir,
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

#[cfg(test)]
mod tests {
    use super::*;

    struct TestStorage {
        root: PathBuf,
    }

    impl TestStorage {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("tenseijingo-test-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn config_path(&self) -> PathBuf {
            self.root.join("config.json")
        }

        fn default_data_dir(&self) -> PathBuf {
            self.root.join("manuscripts")
        }

        fn load_config(&self) -> AppConfig {
            let path = self.config_path();
            if path.exists() {
                serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
            } else {
                AppConfig { data_dir: None }
            }
        }

        fn save_config(&self, config: &AppConfig) {
            fs::create_dir_all(&self.root).unwrap();
            fs::write(self.config_path(), serde_json::to_string_pretty(config).unwrap()).unwrap();
        }

        fn data_dir(&self) -> PathBuf {
            let config = self.load_config();
            let dir = if let Some(custom) = config.data_dir {
                PathBuf::from(custom)
            } else {
                self.default_data_dir()
            };
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn set_data_dir(&self, path: PathBuf) {
            fs::create_dir_all(&path).unwrap();
            self.save_config(&AppConfig {
                data_dir: Some(path.to_string_lossy().to_string()),
            });
        }

        fn switch_data_dir(&self, path: PathBuf, migrate_existing: bool) {
            let current_dir = self.data_dir();
            fs::create_dir_all(&path).unwrap();
            let current_canon = fs::canonicalize(&current_dir).unwrap_or(current_dir.clone());
            let next_canon = fs::canonicalize(&path).unwrap_or(path.clone());
            if migrate_existing && current_canon != next_canon && current_dir.exists() {
                copy_dir_contents(&current_dir, &path).unwrap();
            }
            self.set_data_dir(path);
        }

        fn ensure_repo(&self) -> Repository {
            let dir = self.data_dir();
            match Repository::open(&dir) {
                Ok(repo) => repo,
                Err(_) => {
                    let repo = Repository::init(&dir).unwrap();
                    let sig = make_signature();
                    let mut index = repo.index().unwrap();
                    index.write().unwrap();
                    let tree_id = index.write_tree().unwrap();
                    let tree = repo.find_tree(tree_id).unwrap();
                    repo.commit(Some("HEAD"), &sig, &sig, "初期化", &tree, &[])
                        .unwrap();
                    drop(tree);
                    repo
                }
            }
        }

        fn file_path(&self, id: &str) -> PathBuf {
            self.data_dir().join(format!("{id}.json"))
        }

        fn create_file(&self) -> String {
            let id = Uuid::new_v4().to_string();
            let entry = FileEntry {
                id: id.clone(),
                title: "無題".into(),
                body: String::new(),
                updated_at: now_iso(),
                char_count: 0,
                custom_title: false,
                bold_ranges: Vec::new(),
            };
            fs::write(
                self.file_path(&id),
                serde_json::to_string_pretty(&entry).unwrap(),
            )
            .unwrap();
            self.git_commit_file(&format!("{id}.json"), &format!("新規作成: {}", entry.title));
            id
        }

        fn read_file(&self, id: &str) -> FileEntry {
            serde_json::from_str(&fs::read_to_string(self.file_path(id)).unwrap()).unwrap()
        }

        fn save_file(&self, id: &str, body: &str) -> FileEntry {
            let mut entry = self.read_file(id);
            entry.char_count = count_display_chars(body);
            if !entry.custom_title {
                entry.title = derive_title(body);
            }
            entry.body = body.to_string();
            entry.updated_at = now_iso();
            fs::write(
                self.file_path(id),
                serde_json::to_string_pretty(&entry).unwrap(),
            )
            .unwrap();
            self.git_commit_file(
                &format!("{id}.json"),
                &format!("保存: {} ({}文字)", entry.title, entry.char_count),
            );
            entry
        }

        fn rename_file(&self, id: &str, title: &str) {
            let mut entry = self.read_file(id);
            entry.title = title.to_string();
            entry.custom_title = true;
            entry.updated_at = now_iso();
            fs::write(
                self.file_path(id),
                serde_json::to_string_pretty(&entry).unwrap(),
            )
            .unwrap();
            self.git_commit_file(&format!("{id}.json"), &format!("名前変更: {title}"));
        }

        fn delete_file(&self, id: &str) {
            let path = self.file_path(id);
            let file_name = format!("{id}.json");
            fs::remove_file(&path).unwrap();
            let repo = self.ensure_repo();
            let mut index = repo.index().unwrap();
            index.remove_path(std::path::Path::new(&file_name)).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let sig = make_signature();
            let head = repo.head().unwrap();
            let parent = head.peel_to_commit().unwrap();
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                &format!("削除: {file_name}"),
                &tree,
                &[&parent],
            )
            .unwrap();
        }

        fn set_default_data_dir(&self) -> PathBuf {
            let dir = self.default_data_dir();
            fs::create_dir_all(&dir).unwrap();
            self.save_config(&AppConfig { data_dir: None });
            dir
        }

        fn list_files(&self) -> Vec<FileEntry> {
            let dir = self.data_dir();
            let mut entries = Vec::new();
            if let Ok(read) = fs::read_dir(dir) {
                for entry in read.flatten() {
                    let path = entry.path();
                    if path.extension().map(|e| e == "json").unwrap_or(false) {
                        let data = fs::read_to_string(path).unwrap();
                        let parsed: FileEntry = serde_json::from_str(&data).unwrap();
                        entries.push(parsed);
                    }
                }
            }
            entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            entries
        }

        fn git_commit_file(&self, file_name: &str, message: &str) {
            let repo = self.ensure_repo();
            let mut index = repo.index().unwrap();
            index.add_path(std::path::Path::new(file_name)).unwrap();
            index.write().unwrap();
            let tree_id = index.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let sig = make_signature();
            let head = repo.head().unwrap();
            let parent = head.peel_to_commit().unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&parent])
                .unwrap();
        }

        fn git_log(&self, id: &str) -> Vec<GitLogEntry> {
            let repo = self.ensure_repo();
            let file_name = format!("{id}.json");
            let mut entries = Vec::new();
            let mut revwalk = repo.revwalk().unwrap();
            revwalk.push_head().unwrap();
            revwalk.set_sorting(git2::Sort::TIME).unwrap();
            for oid_result in revwalk {
                let oid = oid_result.unwrap();
                let commit = repo.find_commit(oid).unwrap();
                let tree = commit.tree().unwrap();
                if tree.get_name(&file_name).is_none() {
                    continue;
                }
                let char_count = get_file_content_at_commit(&repo, &oid.to_string(), &file_name)
                    .ok()
                    .and_then(|content| serde_json::from_str::<FileEntry>(&content).ok())
                    .map(|entry| entry.char_count)
                    .unwrap_or(0);
                entries.push(GitLogEntry {
                    commit_hash: oid.to_string(),
                    message: commit.message().unwrap_or("").to_string(),
                    timestamp: "ts".into(),
                    char_count,
                });
                if entries.len() >= 100 {
                    break;
                }
            }
            entries
        }

        fn git_show(&self, id: &str, commit_hash: &str) -> String {
            let repo = self.ensure_repo();
            let file_name = format!("{id}.json");
            let content = get_file_content_at_commit(&repo, commit_hash, &file_name).unwrap();
            let entry: FileEntry = serde_json::from_str(&content).unwrap();
            entry.body
        }

        fn git_restore(&self, id: &str, commit_hash: &str) -> FileEntry {
            let repo = self.ensure_repo();
            let file_name = format!("{id}.json");
            let old_content = get_file_content_at_commit(&repo, commit_hash, &file_name).unwrap();
            let mut entry: FileEntry = serde_json::from_str(&old_content).unwrap();
            entry.updated_at = now_iso();
            entry.char_count = count_display_chars(&entry.body);
            fs::write(
                self.file_path(id),
                serde_json::to_string_pretty(&entry).unwrap(),
            )
            .unwrap();
            self.git_commit_file(&file_name, &format!("復元: {} ← {}", entry.title, &commit_hash[..7.min(commit_hash.len())]));
            entry
        }
    }

    impl Drop for TestStorage {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn data_dir_defaults_to_manuscripts_under_app_dir() {
        let storage = TestStorage::new();
        assert_eq!(storage.data_dir(), storage.default_data_dir());
        assert!(storage.default_data_dir().exists());
    }

    #[test]
    fn switch_data_dir_can_migrate_existing_manuscripts() {
        let storage = TestStorage::new();
        let id = storage.create_file();
        storage.save_file(&id, "最初の原稿");
        let target = storage.root.join("external-manuscripts");

        storage.switch_data_dir(target.clone(), true);

        assert_eq!(storage.data_dir(), target);
        let copied = storage.read_file(&id);
        assert_eq!(copied.body, "最初の原稿");
    }

    #[test]
    fn switch_data_dir_without_migration_keeps_new_dir_empty() {
        let storage = TestStorage::new();
        let id = storage.create_file();
        storage.save_file(&id, "移動しない原稿");
        let target = storage.root.join("fresh-dir");

        storage.switch_data_dir(target.clone(), false);

        assert_eq!(storage.data_dir(), target);
        assert!(fs::read_dir(storage.data_dir()).unwrap().next().is_none());
    }

    #[test]
    fn switch_data_dir_without_migration_keeps_original_files_in_old_dir() {
        let storage = TestStorage::new();
        let old_dir = storage.data_dir();
        let id = storage.create_file();
        storage.save_file(&id, "旧保存先の原稿");
        let target = storage.root.join("new-dir");

        storage.switch_data_dir(target.clone(), false);

        assert!(old_dir.join(format!("{id}.json")).exists());
        assert!(!target.join(format!("{id}.json")).exists());
    }

    #[test]
    fn set_default_data_dir_resets_config_to_default_location() {
        let storage = TestStorage::new();
        let custom = storage.root.join("custom-dir");
        storage.set_data_dir(custom);

        let default_dir = storage.set_default_data_dir();

        assert_eq!(storage.data_dir(), default_dir);
        assert_eq!(storage.load_config().data_dir, None);
    }

    #[test]
    fn save_file_updates_char_count_and_derived_title() {
        let storage = TestStorage::new();
        let id = storage.create_file();

        let entry = storage.save_file(&id, "99年\n次行");

        assert_eq!(entry.char_count, count_display_chars("99年\n次行"));
        assert_eq!(entry.title, "99年");
    }

    #[test]
    fn rename_file_sets_custom_title_and_persists_it() {
        let storage = TestStorage::new();
        let id = storage.create_file();
        storage.save_file(&id, "自動タイトル");

        storage.rename_file(&id, "手動タイトル");
        let entry = storage.read_file(&id);

        assert_eq!(entry.title, "手動タイトル");
        assert!(entry.custom_title);
    }

    #[test]
    fn delete_file_removes_manuscript_from_data_dir() {
        let storage = TestStorage::new();
        let id = storage.create_file();
        let path = storage.file_path(&id);
        assert!(path.exists());

        storage.delete_file(&id);

        assert!(!path.exists());
    }

    #[test]
    fn list_files_returns_newest_first() {
        let storage = TestStorage::new();
        let first = storage.create_file();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = storage.create_file();

        let files = storage.list_files();

        assert_eq!(files[0].id, second);
        assert_eq!(files[1].id, first);
    }

    #[test]
    fn git_history_tracks_saved_revisions_and_can_show_old_body() {
        let storage = TestStorage::new();
        let id = storage.create_file();
        storage.save_file(&id, "一稿");
        storage.save_file(&id, "二稿");

        let logs = storage.git_log(&id);
        assert!(logs.len() >= 3);
        assert_eq!(logs[0].char_count, count_display_chars("二稿"));
        let first_saved = logs
            .iter()
            .find(|log| storage.git_show(&id, &log.commit_hash) == "一稿")
            .unwrap();
        let old_body = storage.git_show(&id, &first_saved.commit_hash);
        assert_eq!(old_body, "一稿");
    }

    #[test]
    fn git_restore_brings_back_previous_revision() {
        let storage = TestStorage::new();
        let id = storage.create_file();
        storage.save_file(&id, "一稿");
        storage.save_file(&id, "二稿");
        let logs = storage.git_log(&id);
        let first_saved = logs
            .iter()
            .find(|log| storage.git_show(&id, &log.commit_hash) == "一稿")
            .unwrap();

        let restored = storage.git_restore(&id, &first_saved.commit_hash);

        assert_eq!(restored.body, "一稿");
        assert_eq!(storage.read_file(&id).body, "一稿");
    }
}
