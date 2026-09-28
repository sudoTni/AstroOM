//! The shipped candidate-profile template.
//!
//! The template is what a new user copies, so two properties must hold and are
//! pinned here:
//!
//! 1. it satisfies `preflight`'s required-file check, so the documented
//!    copy-and-run path actually works; and
//! 2. it does not *silently* do anything. In particular the two filter files
//!    must be empty, because they are read literally — a `#` comment in one
//!    would become an active job exclusion rather than a comment.

mod common;

use common::*;
use std::path::{Path, PathBuf};

fn template_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("candidate_data.example")
}

/// Mirrors `stages::process_data::load_default_filters`, which reads these two
/// files with no comment handling and no trimming.
fn literal_filters(name: &str) -> Vec<String> {
    std::fs::read_to_string(template_dir().join(name))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn the_template_satisfies_the_preflight_required_file_check() {
    let sandbox = Sandbox::new();
    let profile = sandbox.sub("profile");
    copy_dir(&template_dir(), &profile);

    let output = sandbox.run(&[
        "--no-banner",
        "preflight",
        "--json",
        "--profile-dir",
        profile.to_str().unwrap(),
    ]);
    assert_eq!(
        output.status.code(),
        Some(0),
        "the shipped template must pass preflight unmodified.\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        report["missingProfileFiles"],
        serde_json::json!([]),
        "preflight reported missing or empty profile files"
    );
}

#[test]
fn the_shipped_filter_files_contribute_no_exclusions() {
    // company_filters.txt and title_filters.txt are read literally: every line
    // is a case-insensitive substring excluded from the job set, and `#` is not
    // a comment marker. Shipping them with explanatory comments would silently
    // exclude jobs containing that text, so they must be empty.
    for name in ["company_filters.txt", "title_filters.txt"] {
        let filters = literal_filters(name);
        assert!(
            filters.iter().all(|line| line.trim().is_empty()),
            "{name} must not ship active filters, found: {filters:?}"
        );
    }
}

#[test]
fn the_search_terms_file_yields_real_terms() {
    // `load_terms` strips blanks and `#` comments, so the documented template
    // comment syntax is safe here and must actually produce usable terms.
    let raw = std::fs::read_to_string(template_dir().join("search_terms.txt")).unwrap();
    let terms: Vec<String> = raw
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect();
    assert!(
        terms.len() >= 2,
        "the template must offer a few example titles, got {terms:?}"
    );
}

#[test]
fn the_template_ships_every_documented_file_name() {
    for name in [
        "README.md",
        "search_terms.txt",
        "my_resume.txt",
        "my_professional_title.txt",
        "my_professional_summary.txt",
        "my_key_skills.txt",
        "my_testimonials.txt",
        "company_filters.txt",
        "title_filters.txt",
    ] {
        assert!(
            template_dir().join(name).is_file(),
            "the template must ship {name}"
        );
    }
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}
