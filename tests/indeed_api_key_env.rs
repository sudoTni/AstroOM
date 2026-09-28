//! `$ASTROOM_INDEED_API_KEY` is actually read by the resolver.
//!
//! The environment is process-global, so these tests mutate shared state and
//! are therefore serialised behind [`ENV_LOCK`]. They live in their own
//! integration-test binary so that the mutation cannot be observed by
//! `tests/indeed_credentials.rs`, which deliberately assumes the variable is
//! unset and covers the precedence *rules* without touching the environment.
//! This file covers only the wiring — that the named variable is read at all.
//!
//! No test prints or stores a real credential; every value used is a probe.

use astroom::acquisition::indeed;
use astroom::acquisition::AcquisitionQuery;
use std::sync::{Mutex, MutexGuard};

/// Serialises the environment mutations below. `cargo test` runs the tests in
/// a file on parallel threads, so without this they would interleave and each
/// would observe the other's value.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Takes the lock, yielding the guard that keeps the test serialised.
fn locked_env() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn query() -> AcquisitionQuery {
    let mut query = AcquisitionQuery::empty();
    query.indeed_api_key = None;
    query
}

fn set(value: &str) {
    std::env::set_var(indeed::INDEED_API_KEY_ENV, value);
}

fn unset() {
    std::env::remove_var(indeed::INDEED_API_KEY_ENV);
}

#[test]
fn the_named_environment_variable_overrides_the_compiled_in_key() {
    let _guard = locked_env();

    set("env-probe-value");
    assert_eq!(
        indeed::resolve_indeed_api_key(&query()),
        "env-probe-value",
        "${} must be consulted ahead of the compiled-in key",
        indeed::INDEED_API_KEY_ENV
    );

    unset();
    assert_eq!(
        indeed::resolve_indeed_api_key(&query()),
        indeed::DEFAULT_INDEED_CLIENT_KEY,
        "removing the variable must restore zero-config behaviour"
    );
}

#[test]
fn an_explicit_flag_still_outranks_the_environment_end_to_end() {
    let _guard = locked_env();

    set("env-probe-value");
    let mut query = query();
    query.indeed_api_key = Some("flag-probe-value".to_string());
    assert_eq!(
        indeed::resolve_indeed_api_key(&query),
        "flag-probe-value",
        "--indeed-api-key must win over ${}",
        indeed::INDEED_API_KEY_ENV
    );

    unset();
}

#[test]
fn a_blank_environment_variable_cannot_break_acquisition_end_to_end() {
    let _guard = locked_env();

    for blank in ["", "   ", "\t\n"] {
        set(blank);
        assert_eq!(
            indeed::resolve_indeed_api_key(&query()),
            indeed::DEFAULT_INDEED_CLIENT_KEY,
            "a {blank:?} value must be treated as absent, not sent on the wire"
        );
    }

    unset();
}

/// The integration must stay enabled: resolving a key must still produce a
/// credential, and it must still travel under Indeed's documented header.
#[test]
fn the_scraper_credential_flow_is_still_wired() {
    let _guard = locked_env();
    unset();

    assert_eq!(
        indeed::INDEED_API_KEY_HEADER,
        "indeed-api-key",
        "the header name is part of Indeed's request contract"
    );
    let (name, value) = indeed::indeed_api_key_header_value(&query());
    assert_eq!(name, "indeed-api-key");
    assert_eq!(value, indeed::DEFAULT_INDEED_CLIENT_KEY);
    assert!(indeed::INDEED_API_URL.starts_with("https://"));
    assert!(indeed::build_indeed_filters(Some(24), false, false, true, None).is_ok());
}
