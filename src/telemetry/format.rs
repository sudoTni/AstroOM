//! Display and text formatting utilities for the persistent footer dashboard.
//!
//! Provides deterministic string truncation, SI token counting, monetary formatting,
//! progress bar rendering, and duration/ETA representation.

use std::time::Duration;

/// Returns the visual display column width of a string in a terminal.
///
/// Treats ASCII and common European/box characters as width 1, control characters as 0,
/// and East Asian / fullwidth characters as width 2.
/// Transparently strips ANSI escape codes before computing display width.
pub fn str_display_width(s: &str) -> usize {
    if s.contains('\x1b') {
        let stripped = crate::logging::strip_ansi(s);
        stripped.chars().map(char_display_width).sum()
    } else {
        s.chars().map(char_display_width).sum()
    }
}

/// Returns the visual terminal width of a single unicode character.
pub fn char_display_width(c: char) -> usize {
    if c < ' ' || ('\x7f'..'\u{a0}').contains(&c) {
        return 0;
    }
    // Fast path for ASCII
    if c <= '\x7e' {
        return 1;
    }
    // Block elements, box drawing, geometric shapes are width 1
    if ('\u{2500}'..='\u{259f}').contains(&c) {
        return 1;
    }
    // Basic East Asian Wide and Fullwidth ranges
    if ('\u{1100}'..='\u{115f}').contains(&c)
        || ('\u{2329}'..='\u{232a}').contains(&c)
        || ('\u{2e80}'..='\u{303e}').contains(&c)
        || ('\u{3040}'..='\u{a4cf}').contains(&c)
        || ('\u{ac00}'..='\u{d7a3}').contains(&c)
        || ('\u{f900}'..='\u{faff}').contains(&c)
        || ('\u{fe10}'..='\u{fe19}').contains(&c)
        || ('\u{fe30}'..='\u{fe6f}').contains(&c)
        || ('\u{ff00}'..='\u{ff60}').contains(&c)
        || ('\u{ffe0}'..='\u{ffe6}').contains(&c)
        || ('\u{1f300}'..='\u{1f64f}').contains(&c)
        || ('\u{1f900}'..='\u{1f9ff}').contains(&c)
    {
        return 2;
    }
    1
}

/// Truncate a string so that its visible display width does not exceed `max_width`.
///
/// If truncated, appends `ellipsis` (e.g. "…" or "...").
/// Handles ANSI escape sequences transparently without miscounting widths or corrupting escape codes.
pub fn truncate_to_width(s: &str, max_width: usize, ellipsis: &str) -> String {
    let current_width = str_display_width(s);
    if current_width <= max_width {
        return s.to_string();
    }
    let ellipsis_width = str_display_width(ellipsis);
    if max_width <= ellipsis_width {
        let mut out = String::new();
        let mut w = 0;
        for c in ellipsis.chars() {
            let cw = char_display_width(c);
            if w + cw > max_width {
                break;
            }
            out.push(c);
            w += cw;
        }
        return out;
    }

    let target_content_width = max_width - ellipsis_width;
    let mut out = String::new();
    let mut accumulated_width = 0;

    if !s.contains('\x1b') {
        for c in s.chars() {
            let cw = char_display_width(c);
            if accumulated_width + cw > target_content_width {
                break;
            }
            out.push(c);
            accumulated_width += cw;
        }
        out.push_str(ellipsis);
        return out;
    }

    // ANSI-aware truncation
    let mut chars = s.chars().peekable();
    let mut has_ansi = false;

    while let Some(c) = chars.next() {
        if c == '\x1b' {
            has_ansi = true;
            out.push(c);
            // Check CSI: \x1b[ ... [@-~]
            if let Some(&next_c) = chars.peek() {
                if next_c == '[' {
                    chars.next();
                    out.push('[');
                    for csi_c in chars.by_ref() {
                        out.push(csi_c);
                        if ('@'..='~').contains(&csi_c) {
                            break;
                        }
                    }
                    continue;
                } else if next_c == ']' {
                    chars.next();
                    out.push(']');
                    // OSC: until \x07 (BEL) or \x1b\\ (ST)
                    while let Some(osc_c) = chars.next() {
                        out.push(osc_c);
                        if osc_c == '\x07' {
                            break;
                        }
                        if osc_c == '\x1b' {
                            if let Some(&'\\') = chars.peek() {
                                chars.next();
                                out.push('\\');
                                break;
                            }
                        }
                    }
                    continue;
                } else if ('@'..='_').contains(&next_c) {
                    chars.next();
                    out.push(next_c);
                    continue;
                }
            }
            continue;
        }

        let cw = char_display_width(c);
        if accumulated_width + cw > target_content_width {
            break;
        }
        out.push(c);
        accumulated_width += cw;
    }

    out.push_str(ellipsis);
    if has_ansi {
        out.push_str("\x1b[0m");
    }
    out
}

/// Formats a token count into compact SI units (e.g. 987, 1.24k, 592.1k, 1.24M).
pub fn format_tokens(tokens: u64) -> String {
    if tokens < 1_000 {
        tokens.to_string()
    } else if tokens < 100_000 {
        let val = tokens as f64 / 1_000.0;
        format!("{:.2}k", val)
    } else if tokens < 1_000_000 {
        let val = tokens as f64 / 1_000.0;
        format!("{:.1}k", val)
    } else {
        let val = tokens as f64 / 1_000_000.0;
        format!("{:.2}M", val)
    }
}

/// Formats currency with appropriate precision for micro-costs.
pub fn format_cost_usd(cost: f64) -> String {
    if cost == 0.0 {
        "$0.00".to_string()
    } else if cost < 0.01 {
        // Micro-cost e.g. $0.00062
        format!("${:.5}", cost)
    } else if cost < 1.0 {
        format!("${:.4}", cost)
    } else {
        format!("${:.2}", cost)
    }
}

/// Formats a duration compactly without milliseconds (e.g. 42s, 4m 12s, 1h 08m).
pub fn format_duration(d: Duration) -> String {
    let total_secs = d.as_secs();
    let hours = total_secs / 3600;
    let minutes = (total_secs % 3600) / 60;
    let seconds = total_secs % 60;

    if hours > 0 {
        format!("{}h {:02}m", hours, minutes)
    } else if minutes > 0 {
        format!("{}m {:02}s", minutes, seconds)
    } else {
        format!("{}s", seconds)
    }
}

/// Formats clock-style duration e.g. "07:41" for elapsed time under an hour.
pub fn format_clock_duration(d: Duration) -> String {
    let total_secs = d.as_secs();
    let hours = total_secs / 3600;
    let minutes = (total_secs % 3600) / 60;
    let seconds = total_secs % 60;

    if hours > 0 {
        format!("{:02}:{:02}:{:02}", hours, minutes, seconds)
    } else {
        format!("{:02}:{:02}", minutes, seconds)
    }
}

/// Formats an estimated remaining time with explicit approximation prefix "~".
pub fn format_eta(eta: Option<Duration>, samples: u64, total: Option<u64>) -> String {
    if total.is_none() {
        return "—".to_string();
    }
    if samples < 3 {
        return "~calculating…".to_string();
    }
    match eta {
        Some(d) => format!("~{}", format_duration(d)),
        None => "—".to_string(),
    }
}

/// Renders a unicode progress bar `[████████░░░]` fitting into the requested character width.
pub fn render_progress_bar(completed: u64, total: Option<u64>, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let Some(total) = total else {
        return "░".repeat(width);
    };
    if total == 0 {
        return "█".repeat(width);
    }
    let fraction = (completed as f64 / total as f64).clamp(0.0, 1.0);
    let filled_cells = (fraction * width as f64).round() as usize;
    let empty_cells = width.saturating_sub(filled_cells);

    let mut out = String::with_capacity(width * 4);
    for _ in 0..filled_cells {
        out.push('█');
    }
    for _ in 0..empty_cells {
        out.push('░');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_formatting() {
        assert_eq!(format_tokens(987), "987");
        assert_eq!(format_tokens(1_240), "1.24k");
        assert_eq!(format_tokens(592_100), "592.1k");
        assert_eq!(format_tokens(1_240_000), "1.24M");
    }

    #[test]
    fn test_currency_formatting() {
        assert_eq!(format_cost_usd(0.0), "$0.00");
        assert_eq!(format_cost_usd(0.00062), "$0.00062");
        assert_eq!(format_cost_usd(0.0588), "$0.0588");
        assert_eq!(format_cost_usd(1.42), "$1.42");
    }

    #[test]
    fn test_duration_formatting() {
        assert_eq!(format_duration(Duration::from_secs(42)), "42s");
        assert_eq!(format_duration(Duration::from_secs(252)), "4m 12s");
        assert_eq!(format_duration(Duration::from_secs(4080)), "1h 08m");
    }

    #[test]
    fn test_display_width_and_truncation() {
        assert_eq!(str_display_width("Technical Support"), 17);
        let truncated = truncate_to_width("Technical Support Specialist", 20, "…");
        assert_eq!(str_display_width(&truncated), 20);
        assert!(truncated.ends_with('…'));

        // ANSI escape sequences
        let styled = "\x1b[1m\x1b[36mJobCloth\x1b[0m";
        assert_eq!(str_display_width(styled), 8);

        let styled_long = "\x1b[36mJobCloth Extra Details\x1b[0m";
        let truncated_styled = truncate_to_width(styled_long, 12, "…");
        assert_eq!(str_display_width(&truncated_styled), 12);
        assert!(truncated_styled.ends_with("\x1b[0m"));
        assert!(truncated_styled.contains('…'));

        // Fitting styled string is preserved exactly
        let fits = truncate_to_width(styled, 20, "…");
        assert_eq!(fits, styled);
    }

    #[test]
    fn test_progress_bar_rendering() {
        let bar = render_progress_bar(50, Some(100), 10);
        assert_eq!(bar, "█████░░░░░");
        let bar_full = render_progress_bar(100, Some(100), 10);
        assert_eq!(bar_full, "██████████");
        let bar_none = render_progress_bar(10, None, 10);
        assert_eq!(bar_none, "░░░░░░░░░░");
    }
}
