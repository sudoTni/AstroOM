//! Runtime path resolution and launcher-independent execution.
//!
//! These are the guard rails for the two portability defects that made a
//! distributed binary impossible: a compile-time application root, and
//! launcher-shaped path assumptions. The tests run the real binary with the
//! source checkout *not* on any search path, so a regression to a build-time
//! path shows up as a failure rather than as a silent convenience.

mod common;

use common::*;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Builds a self-contained distribution tree: the real executable plus the
/// three read-only resource directories, and nothing else.
fn distribution_tree(sandbox: &Sandbox) -> PathBuf {
    let dist = sandbox.path().join("dist");
    std::fs::create_dir_all(&dist).unwrap();
    copy_executable(&bin(), &dist.join(binary_file_name()));
    for dir in ["config", "prompts", "sysprompts"] {
        copy_tree(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join(dir),
            &dist.join(dir),
        );
    }
    dist
}

/// Copies an executable and makes sure it is safe to `exec`.
///
/// Copying a binary and immediately executing it races with any other write
/// descriptor the test process (or cargo, which may still hold the freshly
/// linked test binary open) has on that inode, which surfaces as a spurious
/// `ETXTBSY` / "Text file busy". Syncing and closing the last write handle
/// here, and retrying briefly on that specific error, makes the test
/// deterministic instead of intermittently red.
fn copy_executable(source: &Path, dest: &Path) {
    let attempt = || -> std::io::Result<()> {
        std::fs::copy(source, dest)?;
        let file = std::fs::File::open(dest)?;
        file.sync_all()?;
        drop(file);
        set_executable(dest);
        Ok(())
    };
    let mut last = std::io::Error::other("not attempted");
    for _ in 0..40 {
        match attempt() {
            Ok(()) => return,
            Err(error) if error.raw_os_error() == Some(26) => {
                last = error;
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(error) => panic!("copy {} -> {}: {error}", source.display(), dest.display()),
        }
    }
    panic!(
        "copy {} -> {}: still busy after retries: {last}",
        source.display(),
        dest.display()
    );
}

fn binary_file_name() -> &'static str {
    if cfg!(windows) {
        "astroom.exe"
    } else {
        "astroom"
    }
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn run_in(cwd: &Path, program: &Path, args: &[&str]) -> std::process::Output {
    Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("run astroom")
}

/// The preflight report names the resolved directories, which is the cheapest
/// way to observe path resolution without running a pipeline.
fn preflight_json(output: &std::process::Output) -> serde_json::Value {
    assert!(
        output.status.success(),
        "preflight failed: {}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    serde_json::from_slice(&output.stdout).expect("preflight machine json")
}

/// A populated profile directory, so preflight reports a valid setup and the
/// only thing under test is path resolution.
fn profile_dir(sandbox: &Sandbox) -> PathBuf {
    let profile = sandbox.sub("profile");
    populate_profile(&profile);
    profile
}

#[test]
fn relocated_binary_resolves_resources_and_data_next_to_itself() {
    let sandbox = Sandbox::new();
    let dist = distribution_tree(&sandbox);
    let elsewhere = sandbox.sub("elsewhere");
    let profile = profile_dir(&sandbox);

    let output = run_in(
        &elsewhere,
        &dist.join(binary_file_name()),
        &[
            "--no-banner",
            "preflight",
            "--json",
            "--profile-dir",
            profile.to_str().unwrap(),
        ],
    );
    let report = preflight_json(&output);

    // Resources resolved from beside the executable, not the CWD and not the
    // build machine's source tree.
    assert_eq!(
        report["presets"],
        serde_json::json!(["jobCloth", "remoteEval", "jobJudge", "makeMaterials"])
    );
    // The profile directory is the one the caller asked for.
    assert_eq!(
        PathBuf::from(report["profileDirectory"].as_str().unwrap()),
        profile
    );
    // The invocation directory was left completely alone.
    for name in ["data", "logs", "materials"] {
        assert!(
            !elsewhere.join(name).exists(),
            "run must not create {name} in the caller's working directory"
        );
    }
    // Mutable directories landed beside the executable.
    for name in ["data", "logs", "materials"] {
        assert!(
            dist.join(name).is_dir(),
            "{name} should be created next to the executable"
        );
    }
}

#[test]
fn relocated_binary_works_from_an_arbitrary_working_directory() {
    let sandbox = Sandbox::new();
    let dist = distribution_tree(&sandbox);
    let deep = sandbox.path().join("a/b/c/d");
    std::fs::create_dir_all(&deep).unwrap();

    let profile = profile_dir(&sandbox);
    let output = run_in(
        &deep,
        &dist.join(binary_file_name()),
        &[
            "--no-banner",
            "preflight",
            "--json",
            "--profile-dir",
            profile.to_str().unwrap(),
        ],
    );
    let report = preflight_json(&output);
    assert_eq!(report["presets"].as_array().unwrap().len(), 4);
}

#[test]
fn relocated_binary_reports_missing_resources_with_searched_locations() {
    let sandbox = Sandbox::new();
    // A bare binary with no config/, prompts/ or sysprompts/ beside it, and
    // an empty working directory that is not inside an AstroOM tree.
    let bare = sandbox.path().join("bare");
    std::fs::create_dir_all(&bare).unwrap();
    copy_executable(&bin(), &bare.join(binary_file_name()));
    let elsewhere = sandbox.sub("elsewhere");

    let output = run_in(
        &elsewhere,
        &bare.join(binary_file_name()),
        &["--no-banner", "preflight"],
    );
    assert!(
        !output.status.success(),
        "a binary with no resources cannot run the pipeline"
    );
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        combined.contains("resource directory"),
        "the error must name what could not be found: {combined}"
    );
    assert!(
        combined.contains("Searched:"),
        "the error must list where it looked: {combined}"
    );
}

#[test]
fn explicit_directory_flags_win_over_automatic_discovery() {
    let sandbox = Sandbox::new();
    let dist = distribution_tree(&sandbox);
    let data = sandbox.sub("explicit-data");
    let logs = sandbox.sub("explicit-logs");
    let materials = sandbox.sub("explicit-materials");
    let profile = profile_dir(&sandbox);

    let output = run_in(
        sandbox.path(),
        &dist.join(binary_file_name()),
        &[
            "--no-banner",
            "preflight",
            "--json",
            "--data-dir",
            data.to_str().unwrap(),
            "--log-dir",
            logs.to_str().unwrap(),
            "--materials-dir",
            materials.to_str().unwrap(),
            "--profile-dir",
            profile.to_str().unwrap(),
        ],
    );
    let report = preflight_json(&output);
    let writable = report["writableDirectories"].as_object().unwrap();
    for (name, path) in [("data", &data), ("logs", &logs), ("materials", &materials)] {
        assert_eq!(
            writable[name],
            serde_json::json!(true),
            "{name} not writable"
        );
        assert!(path.is_dir());
    }
    // The automatically chosen directories were not used.
    assert!(!dist.join("materials").exists());
}

#[test]
fn resource_dir_override_is_honoured() {
    let sandbox = Sandbox::new();
    let bare = sandbox.path().join("bare");
    std::fs::create_dir_all(&bare).unwrap();
    copy_executable(&bin(), &bare.join(binary_file_name()));

    // Resources live somewhere else entirely.
    let resources = sandbox.sub("resources");
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for dir in ["config", "prompts", "sysprompts"] {
        copy_tree(&manifest.join(dir), &resources.join(dir));
    }

    let profile = profile_dir(&sandbox);
    let output = Command::new(bare.join(binary_file_name()))
        .args(["--no-banner", "preflight", "--json"])
        .arg("--profile-dir")
        .arg(&profile)
        .current_dir(sandbox.path())
        .env("ASTROOM_RESOURCE_DIR", &resources)
        .output()
        .expect("run astroom");
    let report = preflight_json(&output);
    assert_eq!(report["presets"].as_array().unwrap().len(), 4);
}

#[test]
fn app_home_override_relocates_the_mutable_tree() {
    let sandbox = Sandbox::new();
    let dist = distribution_tree(&sandbox);
    let home = sandbox.sub("elsewhere-home");

    let profile = profile_dir(&sandbox);
    let output = Command::new(dist.join(binary_file_name()))
        .args(["--no-banner", "preflight", "--json"])
        .arg("--profile-dir")
        .arg(&profile)
        .current_dir(sandbox.path())
        .env("ASTROOM_HOME", &home)
        .output()
        .expect("run astroom");
    preflight_json(&output);
    for name in ["data", "logs", "materials"] {
        assert!(
            home.join(name).is_dir(),
            "ASTROOM_HOME/{name} should have been created"
        );
    }
}

#[test]
fn no_console_control_sequences_when_stdout_is_not_a_terminal() {
    let sandbox = Sandbox::new();
    let dist = distribution_tree(&sandbox);
    let profile = profile_dir(&sandbox);

    // `Command::output` pipes both streams, so this exercises the
    // redirected/piped path: the banner must degrade to plain text.
    let output = run_in(
        sandbox.path(),
        &dist.join(binary_file_name()),
        &[
            "--no-banner",
            "preflight",
            "--json",
            "--profile-dir",
            profile.to_str().unwrap(),
        ],
    );
    preflight_json(&output);
    assert!(
        !String::from_utf8_lossy(&output.stdout).contains('\u{1b}'),
        "no ANSI escapes may be written to a pipe"
    );
    assert!(
        !String::from_utf8_lossy(&output.stderr).contains('\u{1b}'),
        "no ANSI escapes may be written to a pipe"
    );
}

#[test]
fn banner_falls_back_to_plain_output_when_colour_is_disabled() {
    let sandbox = Sandbox::new();
    let dist = distribution_tree(&sandbox);

    let output = run_in(
        sandbox.path(),
        &dist.join(binary_file_name()),
        &["--no-color", "preflight"],
    );
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !combined.contains('\u{1b}'),
        "--no-color must produce escape-free output"
    );
}

#[test]
fn the_in_tree_development_layout_still_resolves_to_the_source_tree() {
    // Regression guard: the compile-time `CARGO_MANIFEST_DIR` default is gone,
    // but a binary running from inside the checkout must still find the
    // checkout's resources, or every in-tree workflow would break.
    let output = Command::new(bin())
        .args([
            "--no-banner",
            "preflight",
            "--json",
            "--profile-dir",
            "candidate_data.example",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("run astroom");
    let report = preflight_json(&output);
    assert_eq!(report["presets"].as_array().unwrap().len(), 4);
}
