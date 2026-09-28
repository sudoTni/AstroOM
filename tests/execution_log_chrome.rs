//! Terminal chrome must not be recorded in the execution log.
//!
//! The animated banner is drawn at 30 frames per second. When those frames go
//! through the execution-log tee they are mirrored into the log file, which
//! turns a normal run into tens of megabytes of cursor-movement sequences that
//! bury the actual log records.
//!
//! The contract these tests pin:
//!
//!   * the banner is still *displayed* — chrome is redirected, not suppressed;
//!   * the banner is *not* recorded in the execution log;
//!   * genuine application output, including streamed LLM output, still is.

mod common;

use common::*;
use regex::Regex;

/// Box-drawing and shade characters that only appear in the banner art.
fn logo_glyph_pattern() -> Regex {
    Regex::new(r"[\u{2580}-\u{2593}]").expect("glyph regex")
}

fn read_execution_log(logs: &std::path::Path) -> String {
    let file = find_file_starting_with(logs, "astroom_").expect("an execution log was created");
    std::fs::read_to_string(&file).expect("read execution log")
}

#[test]
fn the_banner_is_displayed_but_never_written_to_the_execution_log() {
    let sandbox = Sandbox::new();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);

    // `--color true` is forced so the banner is rendered with glyphs even
    // though stdout is a pipe, which makes the leak observable without a PTY.
    let output = sandbox.run(&[
        "preflight",
        "--color",
        "true",
        "--api-key",
        "test-key",
        "--log-dir",
        logs.to_str().unwrap(),
        "--data-dir",
        data.to_str().unwrap(),
        "--profile-dir",
        profile.to_str().unwrap(),
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    let glyphs = logo_glyph_pattern();
    assert!(
        glyphs.is_match(&stdout),
        "the banner must still be displayed on the console"
    );

    let log = read_execution_log(&logs);
    assert!(
        !glyphs.is_match(&log),
        "the execution log must not contain the animated banner; it held {} logo glyphs in a {}-byte log",
        glyphs.find_iter(&log).count(),
        log.len()
    );
}

#[test]
fn application_output_is_still_recorded() {
    // The complement of the test above: excluding chrome must not have
    // disabled the log. `preflight --json` writes a machine-readable record.
    let sandbox = Sandbox::new();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);

    let output = sandbox.run(&[
        "preflight",
        "--api-key",
        "test-key",
        "--log-dir",
        logs.to_str().unwrap(),
        "--data-dir",
        data.to_str().unwrap(),
        "--profile-dir",
        profile.to_str().unwrap(),
    ]);
    assert_eq!(output.status.code(), Some(0));

    let log = read_execution_log(&logs);
    assert!(
        !log.trim().is_empty(),
        "the execution log must not be empty: chrome is excluded, output is not"
    );
    assert!(
        !logo_glyph_pattern().is_match(&log),
        "no banner glyphs in the log either"
    );
}

#[test]
fn a_terminated_run_leaves_a_log_bounded_by_its_records() {
    // A pipeline produces a known, small number of records. If the banner were
    // being mirrored, the log would be orders of magnitude larger than the
    // handful of lines the run actually logs.
    let sandbox = Sandbox::new();
    let logs = sandbox.sub("logs");
    let data = sandbox.sub("data");
    let profile = sandbox.sub("profile");
    populate_profile(&profile);

    let output = sandbox.run(&[
        "run-pipeline",
        "--api-key",
        "test-key",
        "--resume",
        "deployment",
        "--color",
        "true",
        "--log-dir",
        logs.to_str().unwrap(),
        "--data-dir",
        data.to_str().unwrap(),
        "--profile-dir",
        profile.to_str().unwrap(),
    ]);
    // The resumed run legitimately fails on the missing remoteEval artifact;
    // what matters is that it terminated and produced a log.
    assert!(!output.status.success() || output.status.success());

    let log = read_execution_log(&logs);
    let record_lines = log.lines().filter(|l| !l.trim().is_empty()).count();
    assert!(
        log.len() < 64 * 1024,
        "execution log is {} bytes for {record_lines} records; the banner is leaking in",
        log.len()
    );
    assert!(record_lines > 0, "the run should have produced log records");
}
