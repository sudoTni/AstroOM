//! Differential parity test for secret redaction/sanitization against the
//! Node implementation (`src/logging/redaction.ts`).
//!
//! Goldens are produced by `tests/differential/generate_redaction_oracle.js`
//! calling the real Node `sanitizeString`/`sanitizeContext`.

use astroom::logging::redaction::{sanitize_json, sanitize_string};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct StringCase {
    input: String,
    output: String,
}

#[derive(Deserialize)]
struct ContextCase {
    input: Value,
    output: Value,
}

#[derive(Deserialize)]
struct Oracle {
    strings: Vec<StringCase>,
    contexts: Vec<ContextCase>,
}

/// Stand-in for the 64-character OpenRouter-shaped value the fixture must
/// exercise, so that no tracked file ever contains a literal a secret scanner
/// would read as a live key. See [`expand_placeholders`].
const FAKE_OPENROUTER_KEY_PLACEHOLDER: &str = "<FAKE_OPENROUTER_KEY>";

/// The value the placeholder stands for: 64 lowercase hex characters, which is
/// exactly what the redaction pattern `\bsk-or-v1-[a-f0-9]{64}\b` requires.
/// Built at runtime for the same reason the placeholder exists.
fn fake_openrouter_key() -> String {
    "a".repeat(64)
}

/// Replaces the placeholder with the real-shaped value.
///
/// The fixture is a verbatim capture of the Node implementation's behaviour, so
/// the inputs it replays must be byte-identical to the ones Node saw. Storing
/// the key as a placeholder and rebuilding it here keeps that guarantee while
/// keeping any literal that matches a live-secret pattern out of version
/// control — GitHub push protection rejects the whole push over
/// `sk-or-v1-` + 64 hex characters in *any* tracked file, including test
/// fixtures, however obviously synthetic.
///
/// The substitution runs over the whole document rather than just the `input`
/// fields, so a future case that needs the key elsewhere still works.
fn expand_placeholders(raw: &str) -> String {
    raw.replace(FAKE_OPENROUTER_KEY_PLACEHOLDER, &fake_openrouter_key())
}

fn read_raw_oracle() -> String {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/redaction_oracle.json"
    );
    std::fs::read_to_string(path).expect("read redaction oracle fixture")
}

fn load_oracle() -> Oracle {
    let expanded = expand_placeholders(&read_raw_oracle());
    serde_json::from_str(&expanded).expect("parse redaction oracle fixture")
}

/// True when `text` contains `sk-or-v1-` followed by 64 or more lowercase hex
/// characters, i.e. the shape of a real OpenRouter key.
fn contains_openrouter_shaped_value(text: &str) -> bool {
    const PREFIX: &str = "sk-or-v1-";
    let is_lower_hex = |c: char| c.is_ascii_digit() || ('a'..='f').contains(&c);
    let mut rest = text;
    while let Some(start) = rest.find(PREFIX) {
        let after = &rest[start + PREFIX.len()..];
        if after.chars().take_while(|&c| is_lower_hex(c)).count() >= 64 {
            return true;
        }
        rest = after;
    }
    false
}

/// Guards the invariant that keeps the repository pushable: the committed
/// fixture must never contain a literal matching a live-secret pattern, and the
/// placeholder must actually be in use rather than silently absent.
#[test]
fn the_fixture_holds_no_literal_secret_shaped_value() {
    let raw = read_raw_oracle();
    assert!(
        !contains_openrouter_shaped_value(&raw),
        "the fixture must not contain a literal `sk-or-v1-` + 64 hex characters; \
         use the {FAKE_OPENROUTER_KEY_PLACEHOLDER} placeholder instead"
    );
    assert!(
        raw.contains(FAKE_OPENROUTER_KEY_PLACEHOLDER),
        "the fixture is expected to exercise the 64-character OpenRouter shape \
         via the {FAKE_OPENROUTER_KEY_PLACEHOLDER} placeholder"
    );
    assert!(
        contains_openrouter_shaped_value(&expand_placeholders(&raw)),
        "expanding the placeholder must reconstruct the 64-character shape, \
         otherwise the replayed inputs would not match what Node saw"
    );
}

#[test]
fn sanitize_string_matches_node_oracle() {
    let oracle = load_oracle();
    assert!(!oracle.strings.is_empty());
    for (index, case) in oracle.strings.iter().enumerate() {
        assert_eq!(
            sanitize_string(&case.input),
            case.output,
            "sanitize_string divergence at case #{index}"
        );
    }
}

#[test]
fn sanitize_context_matches_node_oracle() {
    let oracle = load_oracle();
    assert!(!oracle.contexts.is_empty());
    for (index, case) in oracle.contexts.iter().enumerate() {
        assert_eq!(
            sanitize_json(&case.input, 0),
            case.output,
            "sanitize_json divergence at case #{index} for input: {}",
            case.input
        );
    }
}
