//! Indeed scraper credential preservation.
//!
//! The Indeed key is a public mobile-client identifier compiled into the
//! binary, not a user secret and not a file. These tests pin the resolution
//! order and prove that no path, platform, or packaging change can silently
//! stop the scraper from finding it.
//!
//! No test prints the key: they assert on its *shape* and on the resolution
//! logic only.

use astroom::acquisition::indeed;
use astroom::acquisition::AcquisitionQuery;
use serde_json::json;

fn default_key_is_a_client_identifier() {
    // Shape only. The literal value is never reproduced.
    let key = indeed::DEFAULT_INDEED_CLIENT_KEY;
    assert_eq!(key.len(), 64, "Indeed client keys are 64 hex characters");
    assert!(
        key.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "Indeed client keys are lowercase hex"
    );
}

fn query_with_key(key: Option<&str>) -> AcquisitionQuery {
    let mut query = AcquisitionQuery::empty();
    query.indeed_api_key = key.map(str::to_string);
    query
}

#[test]
fn the_default_key_is_compiled_in_and_needs_no_file_or_environment() {
    default_key_is_a_client_identifier();
    // Nothing on disk and nothing in the environment is consulted: the same
    // key is returned every time, so a relocated binary, a missing `.env`, or a
    // different platform cannot change the outcome.
    let first = indeed::resolve_indeed_api_key(&query_with_key(None));
    let second = indeed::resolve_indeed_api_key(&query_with_key(None));
    assert_eq!(first, indeed::DEFAULT_INDEED_CLIENT_KEY);
    assert_eq!(first, second);
    assert_eq!(
        first,
        indeed::resolve_indeed_api_key(&query_with_key(Some(""))),
        "an empty override must fall back to the compiled-in key"
    );
    assert_eq!(
        indeed::resolve_indeed_api_key(&query_with_key(Some("   "))),
        indeed::DEFAULT_INDEED_CLIENT_KEY,
        "a whitespace-only override must fall back to the compiled-in key"
    );
}

#[test]
fn an_explicit_override_wins_over_the_compiled_in_key() {
    let overridden = indeed::resolve_indeed_api_key(&query_with_key(Some("user-supplied")));
    assert_eq!(overridden, "user-supplied");
}

/// The external-secret-source tier sits between the CLI flag and the compiled
/// in public default. Exercised through the explicit-source variant so this
/// suite never mutates the process environment, which is global and racy under
/// a parallel test runner; `tests/indeed_api_key_env.rs` covers the actual
/// `$ASTROOM_INDEED_API_KEY` read in its own process.
#[test]
fn the_environment_credential_is_used_when_no_flag_is_given() {
    assert_eq!(
        indeed::resolve_indeed_api_key_with(None, Some("env-supplied".to_string())),
        "env-supplied"
    );
    assert_eq!(
        indeed::resolve_indeed_api_key_with(
            Some("flag-supplied"),
            Some("env-supplied".to_string())
        ),
        "flag-supplied",
        "--indeed-api-key must outrank the environment"
    );
    assert_eq!(
        indeed::resolve_indeed_api_key_with(None, None),
        indeed::DEFAULT_INDEED_CLIENT_KEY,
        "with neither source set, the compiled-in key must still be used so a \
         zero-config install keeps scraping"
    );
}

#[test]
fn a_blank_environment_credential_falls_through_instead_of_breaking_acquisition() {
    for blank in ["", "   ", "\t\n"] {
        assert_eq!(
            indeed::resolve_indeed_api_key_with(None, Some(blank.to_string())),
            indeed::DEFAULT_INDEED_CLIENT_KEY,
            "an empty {blank:?} value must be treated as absent"
        );
        assert_eq!(
            indeed::resolve_indeed_api_key_with(Some("flag-supplied"), Some(blank.to_string())),
            "flag-supplied",
            "a blank environment value must not mask an explicit flag"
        );
    }
}

#[test]
fn a_surrounded_environment_credential_is_trimmed() {
    assert_eq!(
        indeed::resolve_indeed_api_key_with(None, Some("  env-supplied\n".to_string())),
        "env-supplied"
    );
}

#[test]
fn the_environment_variable_has_a_stable_documented_name() {
    // Renaming this would silently stop any deployment that sets it.
    assert_eq!(indeed::INDEED_API_KEY_ENV, "ASTROOM_INDEED_API_KEY");
}

#[test]
fn the_key_is_sent_as_the_indeed_api_key_header() {
    // The header name is part of Indeed's request contract; renaming it
    // silently breaks every request.
    let (name, value) = indeed::indeed_api_key_header_value(&query_with_key(None));
    assert_eq!(name, "indeed-api-key");
    assert_eq!(value, indeed::DEFAULT_INDEED_CLIENT_KEY);
}

#[test]
fn the_key_never_appears_in_a_log_line() {
    // `--show-fetch-url` logs the request URL and filter mode. Neither may
    // carry the credential.
    let line = indeed::describe_request_for_log(&query_with_key(None), 1, 0, 0);
    assert!(!line.contains(indeed::DEFAULT_INDEED_CLIENT_KEY));
    assert!(!line.contains("indeed-api-key"));
    assert!(line.contains(indeed::INDEED_API_URL));
}

#[test]
fn country_and_filter_construction_are_unaffected() {
    // The key travels alongside these; a regression here would break scraping
    // just as surely as losing the key.
    assert_eq!(indeed::country_code_for_test(Some("USA")), ("www", "US"));
    assert_eq!(indeed::country_code_for_test(Some("uk")), ("uk", "GB"));
    assert!(indeed::build_indeed_filters(Some(24), false, false, true, None).is_ok());
    assert!(indeed::build_indeed_filters(Some(0), false, false, true, None).is_err());
}

#[test]
fn the_remote_job_classifier_still_works() {
    let remote = json!({
        "title": "Cloud Engineer",
        "attributes": [{ "key": "DSQF7", "label": "Remote" }]
    });
    assert!(indeed::is_indeed_remote_job(&remote));

    let onsite = json!({
        "title": "Cashier",
        "location": { "formatted": { "long": "Dallas, TX" } }
    });
    assert!(!indeed::is_indeed_remote_job(&onsite));
}
