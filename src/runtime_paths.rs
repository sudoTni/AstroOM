//! Runtime path resolution. Ported from AstroEX-node src/runtimePaths.ts.
//!
//! # Why the application root is not a compile-time constant
//!
//! The Node original used `__dirname`, which is correct at *runtime*: it names
//! the directory the script actually lives in. The first Rust port replaced it
//! with `env!("CARGO_MANIFEST_DIR")`, which is resolved at *compile* time and
//! therefore baked the build machine's absolute source path into the binary.
//! A binary built in `/home/…/AstroOM-rust` looked for its data, logs,
//! materials, presets and prompts under that same build path on every machine
//! it was later run on.
//!
//! # The two roots
//!
//! AstroOM has two distinct path concepts that must not be conflated:
//!
//! * **Application root** — the mutable tree holding `data/`, `logs/`,
//!   `materials/` and the candidate profile. It is per-installation and
//!   writable.
//! * **Resource root** — the read-only tree holding `config/presets.json`,
//!   `prompts/*.txt` and `sysprompts/*.txt`. It ships with the executable and
//!   is only ever read.
//!
//! They are resolved separately because they move independently: pointing
//! `ASTROOM_HOME` at a scratch disk must not break preset lookup, and copying
//! the executable to `C:\Tools\AstroOM` must keep working.
//!
//! # Precedence
//!
//! Application root:
//!
//! 1. explicit `--data-dir` / `--log-dir` / `--materials-dir` /
//!    `--profile-dir` (relative values resolve against the process CWD);
//! 2. `ASTROOM_HOME`;
//! 3. the executable's directory;
//! 4. the process CWD, but only when it looks like an AstroOM tree
//!    (`config/presets.json` is present) — the in-tree development case;
//! 5. otherwise an error naming every location that was searched.
//!
//! Resource root:
//!
//! 1. `ASTROOM_RESOURCE_DIR`;
//! 2. the executable's directory;
//! 3. the resolved application root (in-tree development);
//! 4. the process CWD, under the same `config/presets.json` check;
//! 5. otherwise an error naming every location that was searched.
//!
//! Relative command-line paths supplied by the user are deliberately *not*
//! affected by any of this: they always resolve against the process working
//! directory, which is what the user typed and what they expect.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Environment variable overriding the application root for all four
/// mutable directories at once.
pub const APP_HOME_ENV: &str = "ASTROOM_HOME";
/// Environment variable overriding the read-only resource root.
pub const RESOURCE_DIR_ENV: &str = "ASTROOM_RESOURCE_DIR";

/// Default mutable directory names, relative to the application root.
pub const DEFAULT_DATA_DIR: &str = "data";
pub const DEFAULT_LOG_DIR: &str = "logs";
pub const DEFAULT_MATERIALS_DIR: &str = "materials";
pub const DEFAULT_PROFILE_DIR: &str = "candidate_profile";

/// The file whose presence identifies a directory as an AstroOM tree.
const PRESETS_MARKER: [&str; 2] = ["config", "presets.json"];

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// The directory containing the running executable, if it can be determined.
fn executable_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// True when `dir` contains `config/presets.json`, i.e. it is an AstroOM tree.
fn looks_like_app_tree(dir: &Path) -> bool {
    let mut marker = dir.to_path_buf();
    for part in PRESETS_MARKER {
        marker.push(part);
    }
    marker.is_file()
}

/// Nearest ancestor of `start` (inclusive) that looks like an AstroOM tree.
///
/// This is what preserves in-tree development: the executable lives at
/// `<repo>/target/<profile>/astroom`, so walking up from its directory finds
/// `<repo>` and its `config/`, `prompts/` and `sysprompts/` — exactly what the
/// old compile-time `CARGO_MANIFEST_DIR` resolved to, but computed at runtime
/// so a relocated binary no longer depends on where it was built.
fn nearest_app_tree_ancestor(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|dir| looks_like_app_tree(dir))
        .map(Path::to_path_buf)
}

/// A short, human-readable description of the paths that were searched, used
/// in the "cannot find the application directory" error.
fn searched_locations(app: bool) -> String {
    let mut locations: Vec<String> = Vec::new();
    if app {
        if let Some(value) = env_path(APP_HOME_ENV) {
            locations.push(format!("${APP_HOME_ENV}={}", value.display()));
        }
    } else if let Some(value) = env_path(RESOURCE_DIR_ENV) {
        locations.push(format!("${RESOURCE_DIR_ENV}={}", value.display()));
    }
    if let Some(dir) = executable_dir() {
        locations.push(format!("the executable directory ({})", dir.display()));
    }
    if app {
        if let Some(dir) = resource_root_inner(false) {
            locations.push(format!("the resource root ({})", dir.display()));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        locations.push(format!("the current directory ({})", cwd.display()));
    }
    locations.join(", ")
}

fn search_error(app: bool) -> crate::error::AppError {
    let message = if app {
        format!(
            "Could not locate the AstroOM application directory (the parent of \
             data/, logs/, materials/ and the candidate profile).\n\
             Searched: {}\n\
             Set ${APP_HOME_ENV} to the directory that contains it, or pass \
             --data-dir / --log-dir / --materials-dir / --profile-dir.",
            searched_locations(app)
        )
    } else {
        format!(
            "Could not locate the AstroOM resource directory (the one containing \
             config/presets.json, prompts/ and sysprompts/).\n\
             Searched: {}\n\
             These directories must ship alongside the astroom executable. Set \
             ${RESOURCE_DIR_ENV} if they are elsewhere.",
            searched_locations(app)
        )
    };
    crate::error::AppError::message(message)
}

/// Resolves the read-only resource root.
///
/// `allow_env` is false when this is called from the application-root search,
/// so that a bad `ASTROOM_RESOURCE_DIR` cannot create a resolution loop.
fn resource_root_inner(allow_env: bool) -> Option<PathBuf> {
    if allow_env {
        if let Some(dir) = env_path(RESOURCE_DIR_ENV) {
            return Some(dir);
        }
    }
    if let Some(dir) = executable_dir() {
        if looks_like_app_tree(&dir) {
            return Some(dir);
        }
        // In-tree development: `<repo>/target/<profile>/astroom` walks up to
        // `<repo>`, which is where config/ and prompts/ actually live.
        if let Some(root) = nearest_app_tree_ancestor(&dir) {
            return Some(root);
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if looks_like_app_tree(&cwd) {
            return Some(cwd);
        }
        if let Some(root) = nearest_app_tree_ancestor(&cwd) {
            return Some(root);
        }
    }
    None
}

/// The read-only directory holding `config/`, `prompts/` and `sysprompts/`,
/// or `None` when it cannot be located.
///
/// Infallible by design: commands that touch no resource (`--help`,
/// `artifact verify`, `jobDb`) must keep working when `config/`, `prompts/`
/// and `sysprompts/` are absent. Use [`require_resource_root`] from code that
/// actually loads a preset or a prompt template.
pub fn resource_root() -> Option<PathBuf> {
    static CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();
    CACHE.get_or_init(|| resource_root_inner(true)).clone()
}

/// [`resource_root`] with the actionable "here is where we looked" error.
pub fn require_resource_root() -> crate::error::Result<PathBuf> {
    resource_root().ok_or_else(|| search_error(false))
}

/// The directory holding `data/`, `logs/`, `materials/` and the profile.
///
/// Falls back to the process working directory when the executable's own
/// location cannot be determined, so this is effectively infallible; see
/// [`require_app_root`] for the strict variant.
pub fn app_root() -> crate::error::Result<PathBuf> {
    static CACHE: OnceLock<PathBuf> = OnceLock::new();
    if let Some(cached) = CACHE.get() {
        return Ok(cached.clone());
    }
    // Order matters. The resource root is preferred over the executable
    // directory because in a source checkout they differ — the executable is
    // at `<repo>/target/<profile>/astroom` — and the data tree belongs at
    // `<repo>`, exactly where the old compile-time resolution put it. For a
    // distributed install the two coincide.
    let resolved = env_path(APP_HOME_ENV)
        .or_else(|| resource_root_inner(false))
        .or_else(executable_dir)
        .or_else(|| std::env::current_dir().ok())
        .ok_or_else(|| search_error(true))?;
    let _ = CACHE.set(resolved.clone());
    Ok(resolved)
}

/// Resolves one mutable directory.
///
/// An explicit value is used as given, except that a relative value resolves
/// against the process working directory — the user typed it, so it means
/// what they typed. Otherwise it defaults to `app_root()/fallback`.
fn resolve_explicit_or(configured: Option<&Path>, fallback: &str) -> PathBuf {
    match configured {
        Some(p) => {
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(p)
            }
        }
        None => app_root()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(fallback),
    }
}

pub fn data_dir(configured: Option<&Path>) -> PathBuf {
    resolve_explicit_or(configured, DEFAULT_DATA_DIR)
}

pub fn log_dir(configured: Option<&Path>) -> PathBuf {
    resolve_explicit_or(configured, DEFAULT_LOG_DIR)
}

pub fn materials_dir(configured: Option<&Path>) -> PathBuf {
    resolve_explicit_or(configured, DEFAULT_MATERIALS_DIR)
}

pub fn profile_dir(configured: Option<&Path>) -> PathBuf {
    resolve_explicit_or(configured, DEFAULT_PROFILE_DIR)
}

/// Resolves a user-supplied relative path against the process working
/// directory, the correct semantic for something typed on the command line.
pub fn resolve_from_cwd(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

/// The parent directory to use for a stage's data files.
///
/// [`Path::parent`] is misleading for short relative paths: it returns
/// `Some("")` for a bare file name like `out.json` and `Some(".")` for
/// `./out.json`, and `create_dir_all("")` succeeds. Taking that "parent" at
/// face value therefore creates `jobDB.sqlite` and the stage's working
/// directories in the *process working directory* rather than the configured
/// data directory, where `--clean` and the pipeline never look for them.
///
/// Both spellings therefore fall back to `default`. A genuinely explicit
/// subdirectory (`nested/out.json`) is still honoured, because that is a
/// deliberate relocation by the caller.
pub fn parent_or_default(path: &Path, default: &Path) -> PathBuf {
    match path.parent() {
        Some(parent)
            if !parent.as_os_str().is_empty()
                && parent != Path::new(".")
                && parent != Path::new("./") =>
        {
            parent.to_path_buf()
        }
        _ => default.to_path_buf(),
    }
}

/// Compares a path against a `./`-prefixed sentinel using forward slashes on
/// every platform, so a user typing `.\data\foo` on Windows still matches the
/// same default the CLI would have supplied.
pub fn is_default_sentinel(path: &Path, sentinel: &str) -> bool {
    path.to_string_lossy().replace('\\', "/") == sentinel
}

/// Validates a profile file name the same way as getProfileFile in
/// runtimePaths.ts: [a-zA-Z0-9_.-]+ .(txt|json), no "..".
pub fn validate_profile_file_name(file_name: &str) -> crate::error::Result<()> {
    let valid = !file_name.contains("..")
        && file_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        && (file_name.ends_with(".txt") || file_name.ends_with(".json"));
    if valid {
        Ok(())
    } else {
        Err(crate::error::AppError::message(format!(
            "Invalid profile file name: {file_name}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentinel_comparison_normalises_windows_separators() {
        assert!(is_default_sentinel(
            Path::new("./data/clothed_jobs.json"),
            "./data/clothed_jobs.json"
        ));
        assert!(is_default_sentinel(
            Path::new(".\\data\\clothed_jobs.json"),
            "./data/clothed_jobs.json"
        ));
        assert!(!is_default_sentinel(
            Path::new("custom/clothed_jobs.json"),
            "./data/clothed_jobs.json"
        ));
    }

    /// Regression guard for the H-2 class of bug, which appeared in three
    /// separate stages (`jobCloth`, `jobJudge`, `remoteEval`): a short relative
    /// output path must never relocate the SQLite repository out of the
    /// configured data directory and into the process working directory.
    ///
    /// `Path::parent()` has two distinct traps here, and both are covered:
    /// `out.json` yields `Some("")` and `./out.json` yields `Some(".")`.
    #[test]
    fn short_relative_output_paths_fall_back_to_the_data_directory() {
        let data = Path::new("/var/lib/astroom/data");
        for output in ["out.json", "./out.json", r".\out.json", ""] {
            let resolved = parent_or_default(Path::new(output), data);
            assert_eq!(
                resolved, data,
                "{output:?} resolved to {resolved:?} instead of the data directory"
            );
            assert!(resolved.join("jobDB.sqlite").starts_with(data));
        }
    }

    /// An explicitly nested path is a deliberate relocation and is honoured.
    #[test]
    fn explicitly_nested_output_paths_are_honoured() {
        let data = Path::new("/var/lib/astroom/data");
        assert_eq!(
            parent_or_default(Path::new("nested/out.json"), data),
            Path::new("nested")
        );
        assert_eq!(
            parent_or_default(Path::new("/abs/out.json"), data),
            Path::new("/abs")
        );
    }

    #[test]
    fn parent_or_default_ignores_the_empty_parent_of_a_bare_file_name() {
        let default = Path::new("/var/lib/astroom/data");
        assert_eq!(
            parent_or_default(Path::new("out.json"), default),
            default,
            "a bare file name must not resolve to the process working directory"
        );
        assert_eq!(
            parent_or_default(Path::new("nested/out.json"), default),
            Path::new("nested")
        );
        assert_eq!(
            parent_or_default(Path::new("/abs/out.json"), default),
            Path::new("/abs")
        );
    }

    #[test]
    fn explicit_absolute_directories_are_never_rewritten() {
        let configured = Path::new("/tmp/scratch-data");
        assert_eq!(data_dir(Some(configured)), configured);
        assert_eq!(log_dir(Some(configured)), configured);
        assert_eq!(materials_dir(Some(configured)), configured);
        assert_eq!(profile_dir(Some(configured)), configured);
    }

    #[test]
    fn profile_file_name_validation_matches_node_rules() {
        assert!(validate_profile_file_name("my_resume.txt").is_ok());
        assert!(validate_profile_file_name("my-resume.1.json").is_ok());
        assert!(validate_profile_file_name("../escape.txt").is_err());
        assert!(validate_profile_file_name("my resume.txt").is_err());
        assert!(validate_profile_file_name("resume.md").is_err());
    }
}
