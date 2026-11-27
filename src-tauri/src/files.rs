//! File operations for the model, limited to Desktop, Documents and
//! Downloads.
//!
//! The webview passes paths chosen by the model, so every path is checked
//! here: it must stay inside one of those folders, and may not contain `..`,
//! hidden names or symbolic links. Every change is planned first and applied
//! only after the user confirms it in a native dialog that Rust opens, so the
//! webview cannot skip the question.

use crate::platform;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

const MAX_ENTRIES_LISTED: usize = 100;
const MAX_FIND_RESULTS: usize = 20;
const MAX_SCANNED: usize = 20_000;
const MAX_DEPTH: usize = 8;
const MAX_READ_BYTES: u64 = 256 * 1024;
const MAX_READ_CHARS: usize = 6_000;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_HASHED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_COPY_ENTRIES: usize = 2_000;
const PREVIEW_CHARS: usize = 600;

/// Extensions that run code when opened. `open` refuses them, so a file the
/// model wrote or the user downloaded cannot be launched by voice.
const EXECUTABLE_EXTENSIONS: &[&str] = &[
    "app",
    "applescript",
    "bat",
    "cmd",
    "command",
    "desktop",
    "dmg",
    "exe",
    "inetloc",
    "fileloc",
    "jar",
    "js",
    "msi",
    "pkg",
    "mpkg",
    "ps1",
    "py",
    "rb",
    "scpt",
    "scptd",
    "sh",
    "shortcut",
    "terminal",
    "tool",
    "url",
    "vbs",
    "webloc",
    "workflow",
    "zsh",
    "bash",
    "configprofile",
    "mobileconfig",
    "scr",
    "com",
    "reg",
    "lnk",
];

/// Formats `create_document` may write.
const DOCUMENT_EXTENSIONS: &[&str] = &["docx", "xlsx", "pptx", "txt", "md"];

/// Folder categories used by `organize`.
const CATEGORIES: &[(&str, &[&str])] = &[
    (
        "Documents",
        &[
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "odt", "csv",
        ],
    ),
    (
        "Images",
        &[
            "jpg", "jpeg", "png", "gif", "bmp", "svg", "webp", "heic", "ico",
        ],
    ),
    ("Videos", &["mp4", "mkv", "avi", "mov", "flv", "webm"]),
    ("Music", &["mp3", "wav", "flac", "ogg", "m4a", "aac"]),
    ("Archives", &["zip", "rar", "7z", "tar", "gz"]),
    ("Installers", &["dmg", "pkg", "exe", "msi"]),
];

#[derive(Debug, thiserror::Error)]
pub enum FilesError {
    #[error("{0}")]
    Invalid(String),
    #[error("could not access {path}: {message}")]
    Io { path: String, message: String },
    #[error("{0}")]
    Platform(#[from] platform::PlatformError),
    #[error("the user declined the change in the confirmation dialog; nothing was changed")]
    Declined,
}

impl Serialize for FilesError {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

type Result<T> = std::result::Result<T, FilesError>;

fn invalid<T>(message: impl Into<String>) -> Result<T> {
    Err(FilesError::Invalid(message.into()))
}

fn io_error(path: &Path, error: std::io::Error) -> FilesError {
    FilesError::Io {
        path: path.display().to_string(),
        message: error.to_string(),
    }
}

/// The folders the model may work in, with the name used to address each.
#[derive(Debug, Clone)]
pub struct Roots(Vec<(&'static str, PathBuf)>);

impl Roots {
    pub fn new(roots: Vec<(&'static str, PathBuf)>) -> Self {
        Self(roots)
    }

    fn names(&self) -> String {
        self.0
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// Turns `desktop/notes.txt`, `~/Desktop/notes.txt` or an absolute path
    /// inside a root into a checked absolute path. The path need not exist.
    pub fn resolve(&self, input: &str) -> Result<PathBuf> {
        let input = input.trim();
        if input.is_empty() {
            return invalid("a path is required");
        }
        let (root, rest) = self.split(input)?;
        let mut path = root
            .canonicalize()
            .map_err(|error| io_error(&root, error))?;
        for component in rest.components() {
            let name = match component {
                Component::Normal(name) => name,
                Component::CurDir => continue,
                _ => return invalid("the path may not contain \"..\""),
            };
            if name.to_string_lossy().starts_with('.') {
                return invalid("hidden files and folders are off limits");
            }
            path.push(name);
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return invalid("symbolic links are not followed");
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(io_error(&path, error)),
            }
        }
        Ok(path)
    }

    fn split(&self, input: &str) -> Result<(PathBuf, PathBuf)> {
        let path = Path::new(input);
        if path.is_absolute() {
            for (_, root) in &self.0 {
                let canonical = root.canonicalize().ok();
                for base in [Some(root.clone()), canonical].into_iter().flatten() {
                    if let Ok(rest) = path.strip_prefix(&base) {
                        return Ok((root.clone(), rest.to_path_buf()));
                    }
                }
            }
        } else {
            let relative = input.strip_prefix("~/").unwrap_or(input);
            let mut components = Path::new(relative).components();
            if let Some(Component::Normal(first)) = components.next() {
                let first = first.to_string_lossy().to_lowercase();
                if let Some((_, root)) = self.0.iter().find(|(name, _)| *name == first) {
                    return Ok((root.clone(), components.as_path().to_path_buf()));
                }
            }
        }
        invalid(format!(
            "only paths inside these folders are allowed: {}. Start the path with one of them, for example desktop/notes.txt",
            self.names()
        ))
    }

    fn is_root(&self, path: &Path) -> bool {
        self.0
            .iter()
            .any(|(_, root)| root.canonicalize().is_ok_and(|root| root == path))
    }
}

/// Read-only requests. They need no confirmation.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum Query {
    List {
        path: String,
    },
    Read {
        path: String,
    },
    Find {
        path: String,
        name: Option<String>,
        extension: Option<String>,
    },
    Largest {
        path: String,
        count: Option<usize>,
    },
    Info {
        path: String,
    },
    Duplicates {
        path: String,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EditMode {
    Replace,
    Append,
    Prepend,
}

/// Changes. Each one is shown to the user before it happens.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Change {
    CreateFolder {
        path: String,
    },
    Write {
        path: String,
        content: String,
        #[serde(default)]
        overwrite: bool,
    },
    Edit {
        path: String,
        mode: EditMode,
        old_text: Option<String>,
        new_text: String,
    },
    Move {
        path: String,
        destination: String,
    },
    Copy {
        path: String,
        destination: String,
    },
    Rename {
        path: String,
        new_name: String,
    },
    Delete {
        path: String,
    },
    Open {
        path: String,
    },
    Organize {
        path: String,
    },
    /// A document generated by the webview, saved to the Desktop.
    CreateDocument {
        file_name: String,
        data_base64: String,
    },
}

/// What a confirmed change will do. `Open` is returned to the caller, which
/// has the app handle needed to open it.
pub enum Step {
    Done(String),
    Open(PathBuf),
}

type Apply = Box<dyn FnOnce() -> Result<Step> + Send>;

/// A validated change waiting for the user's answer.
pub struct Pending {
    /// Question shown in the confirmation dialog.
    pub summary: String,
    apply: Apply,
}

impl Pending {
    fn new(summary: String, apply: impl FnOnce() -> Result<Step> + Send + 'static) -> Self {
        Self {
            summary,
            apply: Box::new(apply),
        }
    }

    pub fn apply(self) -> Result<Step> {
        (self.apply)()
    }
}

/* ------------------------------------------------------------ queries */

pub fn query(roots: &Roots, query: &Query) -> Result<String> {
    match query {
        Query::List { path } => list(&roots.resolve(path)?),
        Query::Read { path } => read(&roots.resolve(path)?),
        Query::Find {
            path,
            name,
            extension,
        } => find(&roots.resolve(path)?, name.as_deref(), extension.as_deref()),
        Query::Largest { path, count } => largest(
            &roots.resolve(path)?,
            count.unwrap_or(10).clamp(1, MAX_FIND_RESULTS),
        ),
        Query::Info { path } => info(&roots.resolve(path)?),
        Query::Duplicates { path } => duplicates(&roots.resolve(path)?),
    }
}

fn require_dir(path: &Path) -> Result<()> {
    if path.is_dir() {
        Ok(())
    } else {
        invalid(format!("{} is not a folder", path.display()))
    }
}

fn require_file(path: &Path) -> Result<()> {
    if path.is_file() {
        Ok(())
    } else {
        invalid(format!("{} is not a file", path.display()))
    }
}

fn require_exists(path: &Path) -> Result<()> {
    if path.exists() {
        Ok(())
    } else {
        invalid(format!("{} does not exist", path.display()))
    }
}

fn require_free(path: &Path) -> Result<()> {
    if path.exists() {
        invalid(format!(
            "{} already exists; nothing was overwritten",
            path.display()
        ))
    } else {
        Ok(())
    }
}

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

/// Visible, non-link entries of one folder, sorted by name.
fn entries(dir: &Path) -> Result<Vec<(PathBuf, fs::Metadata)>> {
    let mut found = Vec::new();
    for entry in fs::read_dir(dir).map_err(|error| io_error(dir, error))? {
        let entry = entry.map_err(|error| io_error(dir, error))?;
        if is_hidden(&entry.file_name()) {
            continue;
        }
        // `DirEntry::metadata` does not follow links.
        match entry.metadata() {
            Ok(metadata) if !metadata.file_type().is_symlink() => {
                found.push((entry.path(), metadata));
            }
            _ => {}
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(found)
}

struct Scan {
    files: Vec<(PathBuf, u64)>,
    /// The scan stopped early or skipped something, so results may be incomplete.
    partial: bool,
}

/// Every visible file below `dir`, within the depth and count limits.
/// Folders the OS refuses to open are skipped and reported as partial.
fn scan(dir: &Path) -> Result<Scan> {
    require_dir(dir)?;
    let mut result = Scan {
        files: Vec::new(),
        partial: false,
    };
    let mut seen = 0;
    let mut queue = vec![(dir.to_path_buf(), 0)];
    while let Some((folder, depth)) = queue.pop() {
        let Ok(children) = entries(&folder) else {
            result.partial = true;
            continue;
        };
        for (path, metadata) in children {
            seen += 1;
            if seen > MAX_SCANNED {
                result.partial = true;
                return Ok(result);
            }
            if metadata.is_file() {
                result.files.push((path, metadata.len()));
            } else if metadata.is_dir() {
                if depth < MAX_DEPTH {
                    queue.push((path, depth + 1));
                } else {
                    result.partial = true;
                }
            }
        }
    }
    result.files.sort();
    Ok(result)
}

const PARTIAL_NOTE: &str = "\n(Not everything was searched: the folder is very large or deep, or part of it is protected.)";

fn partial_note(partial: bool) -> &'static str {
    if partial { PARTIAL_NOTE } else { "" }
}

fn size_text(bytes: u64) -> String {
    let bytes_f = bytes as f64;
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.1} GB", bytes_f / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes_f / (1024.0 * 1024.0))
    } else {
        format!("{:.1} KB", bytes_f / 1024.0)
    }
}

fn list(dir: &Path) -> Result<String> {
    require_dir(dir)?;
    let children = entries(dir)?;
    if children.is_empty() {
        return Ok(format!("{} is empty.", dir.display()));
    }
    let mut lines = vec![format!("{} ({} items):", dir.display(), children.len())];
    for (path, metadata) in children.iter().take(MAX_ENTRIES_LISTED) {
        let name = file_name(path);
        lines.push(if metadata.is_dir() {
            format!("- {name}/")
        } else {
            format!("- {name} ({})", size_text(metadata.len()))
        });
    }
    if children.len() > MAX_ENTRIES_LISTED {
        lines.push(format!(
            "…and {} more.",
            children.len() - MAX_ENTRIES_LISTED
        ));
    }
    Ok(lines.join("\n"))
}

fn read_text(path: &Path) -> Result<String> {
    require_file(path)?;
    let size = fs::metadata(path)
        .map_err(|error| io_error(path, error))?
        .len();
    if size > MAX_READ_BYTES {
        return invalid(format!(
            "the file is too large to read ({}; the limit is {})",
            size_text(size),
            size_text(MAX_READ_BYTES)
        ));
    }
    let bytes = fs::read(path).map_err(|error| io_error(path, error))?;
    match String::from_utf8(bytes) {
        Ok(text) if !text.contains('\0') => Ok(text),
        _ => invalid("only plain text files can be read or edited"),
    }
}

fn read(path: &Path) -> Result<String> {
    let text = read_text(path)?;
    Ok(match text.char_indices().nth(MAX_READ_CHARS) {
        Some((end, _)) => format!(
            "{}\n…(truncated after {MAX_READ_CHARS} characters)",
            &text[..end]
        ),
        None => text,
    })
}

fn find(dir: &Path, name: Option<&str>, extension: Option<&str>) -> Result<String> {
    let name = name.map(|n| n.trim().to_lowercase()).unwrap_or_default();
    let extension = extension
        .map(|e| e.trim().trim_start_matches('.').to_lowercase())
        .unwrap_or_default();
    if name.is_empty() && extension.is_empty() {
        return invalid("give a name or an extension to search for");
    }
    let scan = scan(dir)?;
    let matches: Vec<_> = scan
        .files
        .iter()
        .filter(|(path, _)| {
            (name.is_empty() || file_name(path).to_lowercase().contains(&name))
                && (extension.is_empty() || extension_of(path) == extension)
        })
        .collect();
    if matches.is_empty() {
        return Ok(format!(
            "No matching files found.{}",
            partial_note(scan.partial)
        ));
    }
    let mut lines = vec![format!("{} matching files:", matches.len())];
    lines.extend(
        matches
            .iter()
            .take(MAX_FIND_RESULTS)
            .map(|(path, size)| format!("- {} ({})", path.display(), size_text(*size))),
    );
    if matches.len() > MAX_FIND_RESULTS {
        lines.push(format!("…showing the first {MAX_FIND_RESULTS}."));
    }
    Ok(lines.join("\n") + partial_note(scan.partial))
}

fn largest(dir: &Path, count: usize) -> Result<String> {
    let mut scan = scan(dir)?;
    scan.files.sort_by_key(|(_, size)| std::cmp::Reverse(*size));
    if scan.files.is_empty() {
        return Ok(format!("No files found.{}", partial_note(scan.partial)));
    }
    let lines: Vec<_> = scan
        .files
        .iter()
        .take(count)
        .map(|(path, size)| format!("- {} — {}", size_text(*size), path.display()))
        .collect();
    Ok(lines.join("\n") + partial_note(scan.partial))
}

fn info(path: &Path) -> Result<String> {
    require_exists(path)?;
    let metadata = fs::metadata(path).map_err(|error| io_error(path, error))?;
    let kind = if metadata.is_dir() { "folder" } else { "file" };
    let mut text = format!("{} is a {kind}", path.display());
    if metadata.is_file() {
        text.push_str(&format!(" of {}", size_text(metadata.len())));
    }
    if let Some(age) = metadata
        .modified()
        .ok()
        .and_then(|time| SystemTime::now().duration_since(time).ok())
    {
        text.push_str(&format!(
            ", last modified {} hours ago",
            age.as_secs() / 3600
        ));
    }
    Ok(text + ".")
}

fn hash_file(path: &Path) -> Result<[u8; 32]> {
    let mut file = fs::File::open(path).map_err(|error| io_error(path, error))?;
    let mut hasher = Sha256::new();
    let mut block = vec![0; 64 * 1024];
    loop {
        let read = file
            .read(&mut block)
            .map_err(|error| io_error(path, error))?;
        if read == 0 {
            return Ok(hasher.finalize().into());
        }
        hasher.update(&block[..read]);
    }
}

/// Files with identical content. Only files of equal size are hashed.
fn duplicates(dir: &Path) -> Result<String> {
    let scan = scan(dir)?;
    let mut partial = scan.partial;
    let mut by_size: BTreeMap<u64, Vec<PathBuf>> = BTreeMap::new();
    for (path, size) in scan.files {
        if size > 0 {
            by_size.entry(size).or_default().push(path);
        }
    }
    let mut hashed = 0;
    let mut found = Vec::new();
    for (size, paths) in by_size {
        if paths.len() < 2 {
            continue;
        }
        let mut originals: BTreeMap<[u8; 32], PathBuf> = BTreeMap::new();
        for path in paths {
            if hashed + size > MAX_HASHED_BYTES {
                partial = true;
                continue;
            }
            hashed += size;
            let Ok(hash) = hash_file(&path) else {
                partial = true;
                continue;
            };
            match originals.get(&hash) {
                Some(original) => found.push((path, original.clone(), size)),
                None => {
                    originals.insert(hash, path);
                }
            }
        }
    }
    if found.is_empty() {
        return Ok(format!(
            "No duplicate files found.{}",
            partial_note(partial)
        ));
    }
    let mut lines = vec![format!("{} duplicate files:", found.len())];
    lines.extend(
        found
            .iter()
            .take(MAX_FIND_RESULTS)
            .map(|(copy, original, size)| {
                format!(
                    "- {} ({}) is identical to {}",
                    copy.display(),
                    size_text(*size),
                    original.display()
                )
            }),
    );
    if found.len() > MAX_FIND_RESULTS {
        lines.push(format!("…showing the first {MAX_FIND_RESULTS}."));
    }
    Ok(lines.join("\n") + partial_note(partial))
}

/* ------------------------------------------------------------ changes */

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/// The start of `text` for a dialog, saying how much is not shown.
fn preview(text: &str) -> String {
    match text.char_indices().nth(PREVIEW_CHARS) {
        Some((end, _)) => format!(
            "{}…\n({} more characters not shown)",
            &text[..end],
            text[end..].chars().count()
        ),
        None => text.to_owned(),
    }
}

/// A single path component the user can see: no separators, not hidden.
fn check_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() || name.starts_with('.') || name.contains(['/', '\\', ':', '\0']) {
        return invalid("the new name must be a plain file name, without folders or a leading dot");
    }
    Ok(name)
}

fn create_parent(path: &Path) -> Result<()> {
    match path.parent() {
        Some(parent) => fs::create_dir_all(parent).map_err(|error| io_error(parent, error)),
        None => Ok(()),
    }
}

/// Writes a file that must not exist yet. Fails instead of overwriting.
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    create_parent(path)?;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(bytes))
        .map_err(|error| io_error(path, error))
}

/// Replaces a file through a temporary one, so a failure keeps the old content.
fn replace_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_file_name(format!(".{}.jarvis-tmp", file_name(path)));
    write_new(&temp, bytes)?;
    if let Ok(metadata) = fs::metadata(path) {
        let _ = fs::set_permissions(&temp, metadata.permissions());
    }
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        io_error(path, error)
    })
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    if from.is_file() {
        let mut source = fs::File::open(from).map_err(|error| io_error(from, error))?;
        let mut target = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(to)
            .map_err(|error| io_error(to, error))?;
        std::io::copy(&mut source, &mut target).map_err(|error| io_error(to, error))?;
        return Ok(());
    }
    fs::create_dir(to).map_err(|error| io_error(to, error))?;
    for (path, _) in entries(from)? {
        copy_tree(&path, &to.join(file_name(&path)))?;
    }
    Ok(())
}

/// The destination of a move or copy: inside it when it is an existing folder.
fn destination_for(source: &Path, destination: PathBuf) -> Result<PathBuf> {
    let target = if destination.is_dir() {
        destination.join(file_name(source))
    } else {
        destination
    };
    require_free(&target)?;
    if target.starts_with(source) {
        return invalid("a folder cannot be moved or copied into itself");
    }
    Ok(target)
}

fn movable(roots: &Roots, path: &str) -> Result<PathBuf> {
    let path = roots.resolve(path)?;
    require_exists(&path)?;
    if roots.is_root(&path) {
        return invalid(
            "the Desktop, Documents and Downloads folders themselves cannot be changed",
        );
    }
    Ok(path)
}

fn category(extension: &str) -> Option<&'static str> {
    CATEGORIES
        .iter()
        .find(|(_, extensions)| extensions.contains(&extension))
        .map(|(name, _)| *name)
}

fn plan_organize(dir: PathBuf) -> Result<Pending> {
    require_dir(&dir)?;
    let mut moves = Vec::new();
    for (path, metadata) in entries(&dir)? {
        if !metadata.is_file() {
            continue;
        }
        let Some(category) = category(&extension_of(&path)) else {
            continue;
        };
        let target = dir.join(category).join(file_name(&path));
        moves.push((path, target, category));
    }
    if moves.is_empty() {
        return invalid("there are no files to organize in that folder");
    }
    let examples: Vec<_> = moves
        .iter()
        .take(8)
        .map(|(path, _, category)| format!("{} → {category}/", file_name(path)))
        .collect();
    let summary = format!(
        "Move {} files in {} into folders by type?\n\n{}{}",
        moves.len(),
        dir.display(),
        examples.join("\n"),
        if moves.len() > examples.len() {
            "\n…"
        } else {
            ""
        }
    );
    Ok(Pending::new(summary, move || {
        let mut moved = 0;
        let mut skipped = Vec::new();
        for (from, to, _) in moves {
            let category_dir = to.parent().map(Path::to_path_buf).unwrap_or_default();
            // A category folder that is a link would move files outside the root.
            let is_link = fs::symlink_metadata(&category_dir)
                .is_ok_and(|metadata| metadata.file_type().is_symlink());
            if is_link
                || to.exists()
                || create_parent(&to).is_err()
                || fs::rename(&from, &to).is_err()
            {
                skipped.push(file_name(&from));
            } else {
                moved += 1;
            }
        }
        if moved == 0 {
            return invalid(format!("no file could be moved: {}", skipped.join(", ")));
        }
        let mut text = format!("Moved {moved} files into folders by type.");
        if !skipped.is_empty() {
            text.push_str(&format!(
                " Left in place (already there or not movable): {}.",
                skipped.join(", ")
            ));
        }
        Ok(Step::Done(text))
    }))
}

/// Validates a change and describes it. Nothing is modified here.
pub fn plan(roots: &Roots, change: Change) -> Result<Pending> {
    match change {
        Change::CreateFolder { path } => {
            let path = roots.resolve(&path)?;
            require_free(&path)?;
            let shown = path.display().to_string();
            Ok(Pending::new(
                format!("Create the folder {shown}?"),
                move || {
                    fs::create_dir_all(&path).map_err(|error| io_error(&path, error))?;
                    Ok(Step::Done(format!("Created the folder {shown}.")))
                },
            ))
        }
        Change::Write {
            path,
            content,
            overwrite,
        } => {
            let path = roots.resolve(&path)?;
            if content.len() > MAX_WRITE_BYTES {
                return invalid("the content is too large");
            }
            let exists = path.exists();
            if exists {
                require_file(&path)?;
                if !overwrite {
                    return invalid(format!(
                        "{} already exists. Set overwrite to true only if the user wants to replace it",
                        path.display()
                    ));
                }
            }
            let shown = path.display().to_string();
            let verb = if exists { "REPLACE" } else { "Create" };
            Ok(Pending::new(
                format!("{verb} the file {shown} with:\n\n{}", preview(&content)),
                move || {
                    if exists {
                        replace_file(&path, content.as_bytes())?;
                    } else {
                        write_new(&path, content.as_bytes())?;
                    }
                    Ok(Step::Done(format!("Saved {shown}.")))
                },
            ))
        }
        Change::Edit {
            path,
            mode,
            old_text,
            new_text,
        } => {
            let path = roots.resolve(&path)?;
            let original = read_text(&path)?;
            let mut replaced = String::new();
            let (updated, what) = match mode {
                EditMode::Append => (format!("{original}\n{new_text}"), "Append to"),
                EditMode::Prepend => (format!("{new_text}\n{original}"), "Add to the start of"),
                EditMode::Replace => {
                    let old = old_text.unwrap_or_default();
                    if old.is_empty() {
                        return invalid("old_text is required to replace text");
                    }
                    if !original.contains(&old) {
                        return invalid("old_text was not found in the file");
                    }
                    replaced = format!("Old text:\n{}\n\n", preview(&old));
                    (original.replacen(&old, &new_text, 1), "Replace text in")
                }
            };
            if updated.len() > MAX_WRITE_BYTES {
                return invalid("the result is too large");
            }
            let shown = path.display().to_string();
            Ok(Pending::new(
                format!(
                    "{what} {shown}?\n\n{replaced}New text:\n{}",
                    preview(&new_text)
                ),
                move || {
                    if read_text(&path)? != original {
                        return invalid("the file changed while waiting; nothing was edited");
                    }
                    replace_file(&path, updated.as_bytes())?;
                    Ok(Step::Done(format!("Edited {shown}.")))
                },
            ))
        }
        Change::Move { path, destination } => {
            let source = movable(roots, &path)?;
            let target = destination_for(&source, roots.resolve(&destination)?)?;
            let text = format!("{} to {}", source.display(), target.display());
            Ok(Pending::new(format!("Move {text}?"), move || {
                require_free(&target)?;
                create_parent(&target)?;
                fs::rename(&source, &target).map_err(|error| io_error(&source, error))?;
                Ok(Step::Done(format!("Moved {text}.")))
            }))
        }
        Change::Copy { path, destination } => {
            let source = roots.resolve(&path)?;
            require_exists(&source)?;
            let target = destination_for(&source, roots.resolve(&destination)?)?;
            if source.is_dir() {
                let scan = scan(&source)?;
                if scan.partial || scan.files.len() > MAX_COPY_ENTRIES {
                    return invalid("the folder is too large to copy");
                }
            }
            let text = format!("{} to {}", source.display(), target.display());
            Ok(Pending::new(format!("Copy {text}?"), move || {
                require_free(&target)?;
                create_parent(&target)?;
                copy_tree(&source, &target)?;
                Ok(Step::Done(format!("Copied {text}.")))
            }))
        }
        Change::Rename { path, new_name } => {
            let source = movable(roots, &path)?;
            let target = source.with_file_name(check_name(&new_name)?);
            require_free(&target)?;
            let text = format!("{} to {}", source.display(), file_name(&target));
            Ok(Pending::new(format!("Rename {text}?"), move || {
                require_free(&target)?;
                fs::rename(&source, &target).map_err(|error| io_error(&source, error))?;
                Ok(Step::Done(format!("Renamed {text}.")))
            }))
        }
        Change::Delete { path } => {
            let path = movable(roots, &path)?;
            let shown = path.display().to_string();
            Ok(Pending::new(
                format!("Move {shown} to the Trash?"),
                move || {
                    platform::current().move_to_trash(&path)?;
                    Ok(Step::Done(format!("Moved {shown} to the Trash.")))
                },
            ))
        }
        Change::Open { path } => {
            let path = roots.resolve(&path)?;
            require_exists(&path)?;
            let extension = extension_of(&path);
            if EXECUTABLE_EXTENSIONS.contains(&extension.as_str())
                || (path.is_file() && extension.is_empty())
            {
                return invalid(
                    "JARVIS does not open programs, scripts, installers, links or files without an extension",
                );
            }
            Ok(Pending::new(
                format!("Open {}?", path.display()),
                move || Ok(Step::Open(path)),
            ))
        }
        Change::Organize { path } => plan_organize(roots.resolve(&path)?),
        Change::CreateDocument {
            file_name: name,
            data_base64,
        } => {
            let name = check_name(&name)?.to_owned();
            if !DOCUMENT_EXTENSIONS.contains(&extension_of(Path::new(&name)).as_str()) {
                return invalid("unsupported document format");
            }
            let bytes = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                data_base64.as_bytes(),
            )
            .map_err(|_| FilesError::Invalid("the document data is not valid".to_owned()))?;
            if bytes.len() > MAX_DOCUMENT_BYTES {
                return invalid("the document is too large");
            }
            let path = roots.resolve(&format!("desktop/{name}"))?;
            require_free(&path)?;
            let shown = path.display().to_string();
            Ok(Pending::new(
                format!(
                    "Save a new document ({}) as {shown}?",
                    size_text(bytes.len() as u64)
                ),
                move || {
                    write_new(&path, &bytes)?;
                    Ok(Step::Done(format!("Saved {shown}.")))
                },
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sandbox {
        base: PathBuf,
        roots: Roots,
    }

    impl Sandbox {
        fn new(label: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let base = std::env::temp_dir().join(format!("jarvis-files-{label}-{nanos}"));
            fs::create_dir_all(base.join("Desktop")).expect("mkdir");
            fs::create_dir_all(base.join("outside")).expect("mkdir");
            let base = base.canonicalize().expect("canonical");
            let roots = Roots::new(vec![("desktop", base.join("Desktop"))]);
            Self { base, roots }
        }

        fn seed(&self, name: &str, content: &str) -> PathBuf {
            let path = self.base.join("Desktop").join(name);
            create_parent(&path).expect("parent");
            fs::write(&path, content).expect("seed");
            path
        }

        fn apply(&self, change: Change) -> Result<String> {
            match plan(&self.roots, change)?.apply()? {
                Step::Done(text) => Ok(text),
                Step::Open(path) => Ok(path.display().to_string()),
            }
        }

        fn query(&self, request: Query) -> Result<String> {
            query(&self.roots, &request)
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn accepts_the_three_ways_to_name_a_path() {
        let sandbox = Sandbox::new("names");
        let expected = sandbox.base.join("Desktop/a.txt");
        for input in [
            "desktop/a.txt",
            "Desktop/a.txt",
            "~/Desktop/a.txt",
            expected.to_str().expect("utf8"),
        ] {
            assert_eq!(sandbox.roots.resolve(input).expect(input), expected);
        }
    }

    #[test]
    fn rejects_paths_that_leave_the_allowed_folders() {
        let sandbox = Sandbox::new("escape");
        let outside = sandbox.base.join("outside").display().to_string();
        for input in [
            "",
            "outside/a",
            "/etc/passwd",
            "~/.ssh/id_rsa",
            "desktop/../outside/a",
            "desktop/.env",
            "desktop/.git/config",
            outside.as_str(),
        ] {
            assert!(sandbox.roots.resolve(input).is_err(), "{input:?}");
        }
    }

    #[test]
    fn does_not_follow_symbolic_links() {
        let sandbox = Sandbox::new("links");
        let desktop = sandbox.base.join("Desktop");
        let outside = sandbox.base.join("outside");
        // Windows needs extra rights to create links; nothing to check there.
        if !platform::create_test_symlink(&outside, &desktop.join("exit")) {
            return;
        }
        assert!(platform::create_test_symlink(
            &sandbox.base.join("nowhere"),
            &desktop.join("dangling")
        ));
        for input in ["desktop/exit", "desktop/exit/a.txt", "desktop/dangling"] {
            assert!(sandbox.roots.resolve(input).is_err(), "{input}");
        }
    }

    #[test]
    fn planning_changes_nothing() {
        let sandbox = Sandbox::new("plan");
        let file = sandbox.seed("keep.txt", "old");
        let pending = plan(
            &sandbox.roots,
            Change::Write {
                path: "desktop/keep.txt".into(),
                content: "new".into(),
                overwrite: true,
            },
        )
        .expect("plan");
        assert!(pending.summary.contains("REPLACE"));
        drop(pending);
        assert_eq!(fs::read_to_string(file).expect("read"), "old");
    }

    #[test]
    fn writing_does_not_overwrite_without_asking_to() {
        let sandbox = Sandbox::new("overwrite");
        sandbox.seed("a.txt", "old");
        let result = sandbox.apply(Change::Write {
            path: "desktop/a.txt".into(),
            content: "new".into(),
            overwrite: false,
        });
        assert!(matches!(result, Err(FilesError::Invalid(_))));
    }

    #[test]
    fn edit_fails_if_the_file_changed_while_waiting() {
        let sandbox = Sandbox::new("stale");
        let file = sandbox.seed("a.txt", "hello");
        let pending = plan(
            &sandbox.roots,
            Change::Edit {
                path: "desktop/a.txt".into(),
                mode: EditMode::Replace,
                old_text: Some("hello".into()),
                new_text: "bye".into(),
            },
        )
        .expect("plan");
        fs::write(&file, "changed by the user").expect("write");
        assert!(pending.apply().is_err());
        assert_eq!(
            fs::read_to_string(file).expect("read"),
            "changed by the user"
        );
    }

    #[test]
    fn move_copy_and_rename_never_replace_a_file() {
        let sandbox = Sandbox::new("noclobber");
        sandbox.seed("a.txt", "a");
        sandbox.seed("b.txt", "b");
        for change in [
            Change::Move {
                path: "desktop/a.txt".into(),
                destination: "desktop/b.txt".into(),
            },
            Change::Copy {
                path: "desktop/a.txt".into(),
                destination: "desktop/b.txt".into(),
            },
            Change::Rename {
                path: "desktop/a.txt".into(),
                new_name: "b.txt".into(),
            },
        ] {
            assert!(sandbox.apply(change).is_err());
        }
    }

    #[test]
    fn roots_cannot_be_moved_or_deleted() {
        let sandbox = Sandbox::new("roots");
        assert!(
            sandbox
                .apply(Change::Delete {
                    path: "desktop".into()
                })
                .is_err()
        );
    }

    #[test]
    fn refuses_to_open_things_that_run_code() {
        let sandbox = Sandbox::new("open");
        for name in ["run.command", "setup.PKG", "script.sh", "binary"] {
            sandbox.seed(name, "x");
            let change = Change::Open {
                path: format!("desktop/{name}"),
            };
            assert!(plan(&sandbox.roots, change).is_err(), "{name}");
        }
        sandbox.seed("notes.txt", "x");
        let change = Change::Open {
            path: "desktop/notes.txt".into(),
        };
        assert!(plan(&sandbox.roots, change).is_ok());
    }

    #[test]
    fn organizes_by_type_and_keeps_existing_files() {
        let sandbox = Sandbox::new("organize");
        sandbox.seed("report.pdf", "new");
        sandbox.seed("photo.JPG", "p");
        sandbox.seed("unknown.xyz", "u");
        sandbox.seed("Documents/report.pdf", "already there");
        let text = sandbox
            .apply(Change::Organize {
                path: "desktop".into(),
            })
            .expect("organize");
        assert!(text.contains("Moved 1 files") && text.contains("report.pdf"));
        let desktop = sandbox.base.join("Desktop");
        assert!(desktop.join("Images/photo.JPG").exists());
        assert!(desktop.join("unknown.xyz").exists());
        assert_eq!(
            fs::read_to_string(desktop.join("Documents/report.pdf")).expect("read"),
            "already there"
        );
    }

    #[test]
    fn finds_duplicates_by_content() {
        let sandbox = Sandbox::new("dupes");
        sandbox.seed("one.txt", "same bytes");
        sandbox.seed("sub/two.txt", "same bytes");
        sandbox.seed("other.txt", "diff bytes");
        let text = sandbox
            .query(Query::Duplicates {
                path: "desktop".into(),
            })
            .expect("query");
        assert!(text.starts_with("1 duplicate files"), "{text}");
    }

    #[test]
    fn reads_text_but_not_binary_files() {
        let sandbox = Sandbox::new("read");
        sandbox.seed("a.txt", "hola");
        sandbox.seed("b.bin", "a\0b");
        let read = |path: &str| sandbox.query(Query::Read { path: path.into() });
        assert_eq!(read("desktop/a.txt").expect("read"), "hola");
        assert!(read("desktop/b.bin").is_err());
    }

    #[test]
    fn documents_go_to_the_desktop_with_a_plain_name() {
        let sandbox = Sandbox::new("document");
        let save = |name: &str| {
            sandbox.apply(Change::CreateDocument {
                file_name: name.into(),
                data_base64: "aG9sYQ==".into(),
            })
        };
        assert!(save("../x.docx").is_err());
        assert!(save("x.command").is_err());
        save("x.docx").expect("save");
        assert!(save("x.docx").is_err());
    }

    #[test]
    fn changes_deserialize_from_the_webview_shape() {
        let change: Change = serde_json::from_value(serde_json::json!({
            "action": "edit", "path": "desktop/a", "mode": "append", "newText": "x"
        }))
        .expect("deserialize");
        assert!(matches!(change, Change::Edit { .. }));
    }
}
