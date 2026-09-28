//! Pure layout and formatting engine for the persistent footer telemetry panel.
//!
//! Renders 9 exact-width lines matching the height of the animated AstroOM logo.
//! Separates semantic layout from terminal escape codes for deterministic testing.

use super::format::*;
use super::model::*;
use std::time::Instant;

/// Breakpoints for responsive footer telemetry layouts.
pub const WIDE_TERMINAL_MIN_COLS: usize = 120;
pub const MEDIUM_TERMINAL_MIN_COLS: usize = 96;
pub const COMPACT_TERMINAL_MIN_COLS: usize = 80;

/// Number of columns reserved for the logo + separator.
pub const LOGO_WIDTH: usize = 62;
pub const LOGO_SEPARATOR_WIDTH: usize = 4;
pub const TOTAL_LOGO_FOOTPRINT: usize = LOGO_WIDTH + LOGO_SEPARATOR_WIDTH; // 66

/// Height of the footer panel in rows (matching ASTRO_LOGO_RAW.len()).
pub const FOOTER_ROW_COUNT: usize = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutMode {
    Wide,
    Medium,
    Compact,
    LogoOnly,
}

impl LayoutMode {
    pub fn for_terminal_width(cols: usize) -> Self {
        if cols >= WIDE_TERMINAL_MIN_COLS {
            LayoutMode::Wide
        } else if cols >= MEDIUM_TERMINAL_MIN_COLS {
            LayoutMode::Medium
        } else if cols >= COMPACT_TERMINAL_MIN_COLS {
            LayoutMode::Compact
        } else {
            LayoutMode::LogoOnly
        }
    }
}

/// ANSI styling sequences.
const ANSI_RESET: &str = "\x1b[0m";
const ANSI_BOLD: &str = "\x1b[1m";
const ANSI_DIM: &str = "\x1b[2m";
const ANSI_CYAN: &str = "\x1b[36m";
const ANSI_GREEN: &str = "\x1b[32m";
const ANSI_YELLOW: &str = "\x1b[33m";
const ANSI_RED: &str = "\x1b[31m";

/// Style helper for optional color emission.
fn style(text: &str, code: &str, use_color: bool) -> String {
    if use_color {
        format!("{code}{text}{ANSI_RESET}")
    } else {
        text.to_string()
    }
}

/// Pure renderer: converts a telemetry snapshot into exactly 9 rendered lines
/// fitting within `available_width`.
pub fn render_telemetry_lines(
    telemetry: &RunTelemetry,
    available_width: usize,
    use_color: bool,
    now: Instant,
) -> Vec<String> {
    if available_width < 10 {
        return vec![String::new(); FOOTER_ROW_COUNT];
    }

    let mut lines = Vec::with_capacity(FOOTER_ROW_COUNT);

    // Row 0: Stage Header (Left: Stage Label, Right: Stage Index / Count)
    lines.push(render_row_header(telemetry, available_width, use_color));

    // Row 1: Progress Bar & Percentage
    lines.push(render_row_progress(telemetry, available_width, use_color));

    // Row 2: Empty spacer
    lines.push(String::new());

    // Row 3: CURRENT Item
    lines.push(render_row_current(telemetry, available_width, use_color));

    // Row 4: TIME (Elapsed & ETA)
    lines.push(render_row_time(telemetry, available_width, use_color, now));

    // Row 5: RUN (LLM Consumption)
    lines.push(render_row_run(telemetry, available_width, use_color));

    // Row 6: LAST (Most recent LLM call)
    lines.push(render_row_last(telemetry, available_width, use_color));

    // Row 7: Stage-specific results / context
    lines.push(render_row_stage_context(
        telemetry,
        available_width,
        use_color,
    ));

    // Row 8: FLOW (Pipeline Funnel) or HEALTH
    lines.push(render_row_flow_or_health(
        telemetry,
        available_width,
        use_color,
    ));

    // Ensure exactly 9 lines, padded and safely truncated to available_width
    while lines.len() < FOOTER_ROW_COUNT {
        lines.push(String::new());
    }
    lines.truncate(FOOTER_ROW_COUNT);

    lines
        .into_iter()
        .map(|line| truncate_to_width(&line, available_width, "…"))
        .collect()
}

fn render_row_header(telemetry: &RunTelemetry, width: usize, use_color: bool) -> String {
    let stage_name = telemetry.pipeline.stage_kind.label();
    let index_text = if telemetry.pipeline.stage_index > 0 {
        format!(
            "{}/{}",
            telemetry.pipeline.stage_index, telemetry.pipeline.stage_count
        )
    } else {
        "—".to_string()
    };

    let stage_styled = style(stage_name, &format!("{ANSI_BOLD}{ANSI_CYAN}"), use_color);
    let index_styled = style(&index_text, ANSI_DIM, use_color);

    let stage_len = str_display_width(stage_name);
    let index_len = str_display_width(&index_text);

    if stage_len + index_len + 2 <= width {
        let padding = width - stage_len - index_len;
        format!("{}{}{}", stage_styled, " ".repeat(padding), index_styled)
    } else {
        stage_styled
    }
}

fn render_row_progress(telemetry: &RunTelemetry, width: usize, use_color: bool) -> String {
    let completed = telemetry.progress.completed;
    let total = telemetry.progress.total;

    let suffix = match total {
        Some(0) => " 0/0".to_string(),
        Some(t) => {
            let pct = telemetry.progress.percentage().unwrap_or(0);
            format!(" {}/{} {}%", completed, t, pct)
        }
        None => format!(" {} complete", completed),
    };

    let suffix_len = str_display_width(&suffix);
    if width <= suffix_len + 4 {
        return style(&suffix, ANSI_GREEN, use_color);
    }

    let bar_width = width - suffix_len;
    let bar = render_progress_bar(completed, total, bar_width);
    let bar_styled = style(&bar, ANSI_GREEN, use_color);
    let suffix_styled = style(&suffix, ANSI_DIM, use_color);
    format!("{}{}", bar_styled, suffix_styled)
}

fn render_row_current(telemetry: &RunTelemetry, width: usize, use_color: bool) -> String {
    let label = style("CURRENT   ", ANSI_DIM, use_color);
    let label_len = 10;
    if width <= label_len {
        return String::new();
    }
    let title = telemetry
        .current_item
        .as_ref()
        .and_then(|item| item.title.as_deref())
        .unwrap_or("—");
    let max_val_width = width.saturating_sub(label_len);
    let truncated_title = truncate_to_width(title, max_val_width, "…");
    format!("{}{}", label, truncated_title)
}

fn render_row_time(
    telemetry: &RunTelemetry,
    width: usize,
    use_color: bool,
    now: Instant,
) -> String {
    let label = style("TIME      ", ANSI_DIM, use_color);
    let label_len = 10;
    if width <= label_len {
        return String::new();
    }
    let elapsed = now.saturating_duration_since(telemetry.timing.stage_started_at);
    let elapsed_str = format!("{} elapsed", format_clock_duration(elapsed));
    let eta_str = format_eta(
        telemetry.timing.eta,
        telemetry.timing.completed_samples,
        telemetry.progress.total,
    );

    let val = if width >= 45 {
        format!("{} · {} remaining", elapsed_str, eta_str)
    } else if width >= 30 {
        format!("{} · {}", format_clock_duration(elapsed), eta_str)
    } else {
        format_clock_duration(elapsed)
    };
    format!("{}{}", label, val)
}

fn render_row_run(telemetry: &RunTelemetry, width: usize, use_color: bool) -> String {
    let label = style("RUN       ", ANSI_DIM, use_color);
    let label_len = 10;
    if width <= label_len {
        return String::new();
    }
    let tokens_str = format_tokens(telemetry.llm.tokens_total);
    let cost_str = format_cost_usd(telemetry.llm.cost_usd_total);
    let calls = telemetry.llm.requests_total;

    let val = if width >= 45 {
        format!("{} tokens · {} calls · {}", tokens_str, calls, cost_str)
    } else if width >= 30 {
        format!("{} · {} · {}", tokens_str, calls, cost_str)
    } else {
        format!("{} · {}", tokens_str, cost_str)
    };
    format!("{}{}", label, val)
}

fn render_row_last(telemetry: &RunTelemetry, width: usize, use_color: bool) -> String {
    let label = style("LAST      ", ANSI_DIM, use_color);
    let label_len = 10;
    if width <= label_len {
        return String::new();
    }
    let val = match &telemetry.llm.last_call {
        Some(last) => {
            let tokens_str = format_tokens(last.total_tokens);
            let time_str = format!("{:.1}s", last.elapsed.as_secs_f64());
            let cost_str = format_cost_usd(last.cost_usd);
            if let Some(p) = &telemetry.llm.provider {
                if width >= 50 {
                    format!(
                        "{} · {} tokens · {} · {}",
                        p, tokens_str, time_str, cost_str
                    )
                } else if width >= 38 {
                    format!("{} · {} · {}", p, tokens_str, time_str)
                } else {
                    format!("{} · {}", tokens_str, time_str)
                }
            } else if width >= 40 {
                format!("{} tokens · {} · {}", tokens_str, time_str, cost_str)
            } else {
                format!("{} · {}", tokens_str, time_str)
            }
        }
        None => "—".to_string(),
    };
    format!("{}{}", label, val)
}

fn render_row_stage_context(telemetry: &RunTelemetry, _width: usize, use_color: bool) -> String {
    let (tag, content) = match &telemetry.stage_metrics {
        StageMetrics::Acquire {
            indeed,
            linkedin,
            acquired,
        } => {
            let ind = indeed.map_or("—".to_string(), |v| v.to_string());
            let lnk = linkedin.map_or("—".to_string(), |v| v.to_string());
            (
                "ACQUIRE   ",
                format!("Indeed {} · LinkedIn {} · total {}", ind, lnk, acquired),
            )
        }
        StageMetrics::ProcessData {
            kept,
            duplicates,
            company_filtered,
            title_filtered,
            previously_seen,
            ..
        } => {
            let blocked = company_filtered + title_filtered + previously_seen;
            (
                "FILTER    ",
                format!(
                    "kept {} · duplicates {} · blocked {}",
                    kept, duplicates, blocked
                ),
            )
        }
        StageMetrics::JobCloth {
            successful_jobs,
            filtered_jobs,
            errors,
            ..
        } => (
            "CLOTH     ",
            format!(
                "passed {} · filtered {} · errors {}",
                successful_jobs, filtered_jobs, errors
            ),
        ),
        StageMetrics::EnrichJobs {
            enriched,
            skipped,
            fetch_failures,
        } => (
            "ENRICH    ",
            format!(
                "enriched {} · skipped {} · failed {}",
                enriched, skipped, fetch_failures
            ),
        ),
        StageMetrics::RemoteEval {
            eligible,
            rejected,
            pending,
        } => (
            "REMOTE    ",
            format!(
                "eligible {} · rejected {} · pending {}",
                eligible, rejected, pending
            ),
        ),
        StageMetrics::JobJudge {
            qualified,
            rejected,
            pending,
        } => (
            "JUDGE     ",
            format!(
                "qualified {} · rejected {} · pending {}",
                qualified, rejected, pending
            ),
        ),
        StageMetrics::MakeMaterials {
            completed_packages,
            failed_packages,
            pending,
        } => (
            "MATERIALS ",
            format!(
                "complete {} · failed {} · pending {}",
                completed_packages, failed_packages, pending
            ),
        ),
        StageMetrics::DeployMaterials {
            deployed,
            skipped,
            failed,
        } => (
            "DEPLOY    ",
            format!(
                "deployed {} · skipped {} · failed {}",
                deployed, skipped, failed
            ),
        ),
        StageMetrics::None => ("RESULTS   ", "—".to_string()),
    };

    let label = style(tag, ANSI_DIM, use_color);
    format!("{}{}", label, content)
}

fn render_row_flow_or_health(telemetry: &RunTelemetry, width: usize, use_color: bool) -> String {
    // In wide layouts, render FLOW funnel; in medium layouts, render HEALTH
    if width >= 50 {
        let label = style("FLOW      ", ANSI_DIM, use_color);
        let f = &telemetry.funnel;
        let acq = f.acquired.map_or("—".to_string(), |v| v.to_string());
        let unq = f
            .unique_or_processed
            .map_or("—".to_string(), |v| v.to_string());
        let clt = f.cloth_passed.map_or("—".to_string(), |v| v.to_string());
        let rem = f.remote_eligible.map_or("—".to_string(), |v| v.to_string());
        let qlf = f.qualified.map_or("—".to_string(), |v| v.to_string());
        let mat = f
            .materials_completed
            .map_or("—".to_string(), |v| v.to_string());

        let flow = format!("{} → {} → {} → {} → {} → {}", acq, unq, clt, rem, qlf, mat);
        format!("{}{}", label, flow)
    } else {
        let label = style("HEALTH    ", ANSI_DIM, use_color);
        let err_color = if telemetry.health.errors > 0 {
            ANSI_RED
        } else {
            ""
        };
        let ret_color = if telemetry.health.retries > 0 {
            ANSI_YELLOW
        } else {
            ""
        };

        let errors_str = style(
            &format!("errors {}", telemetry.health.errors),
            err_color,
            use_color,
        );
        let retries_str = style(
            &format!("retries {}", telemetry.health.retries),
            ret_color,
            use_color,
        );

        format!("{}{} · {}", label, errors_str, retries_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn sample_telemetry() -> RunTelemetry {
        let now = Instant::now();
        RunTelemetry {
            pipeline: PipelineIdentity {
                stage_index: 5,
                stage_count: 8,
                stage_kind: StageKind::RemoteEval,
                stage_label: StageKind::RemoteEval.label(),
            },
            progress: ProgressTelemetry {
                completed: 102,
                total: Some(106),
            },
            current_item: Some(CurrentItemTelemetry {
                ordinal: Some(102),
                total: Some(106),
                title: Some("Technical Support Specialist".to_string()),
                company: Some("Acme Corp".to_string()),
            }),
            timing: TimingTelemetry {
                run_started_at: now - Duration::from_secs(600),
                stage_started_at: now - Duration::from_secs(461),
                eta: Some(Duration::from_secs(18)),
                completed_samples: 102,
                ewma_duration_sec: Some(4.5),
            },
            llm: LlmTelemetry {
                provider: Some("openrouter".to_string()),
                model: Some("z-ai/glm-5.3-flash".to_string()),
                requests_total: 102,
                tokens_total: 592_100,
                cost_usd_total: 0.0588,
                last_call: Some(LlmCallTelemetry {
                    elapsed: Duration::from_secs_f64(4.0),
                    input_tokens: 5_000,
                    output_tokens: 1_600,
                    total_tokens: 6_600,
                    cost_usd: 0.00062,
                    succeeded: true,
                }),
                ..Default::default()
            },
            health: HealthTelemetry {
                errors: 0,
                retries: 0,
                ..Default::default()
            },
            funnel: FunnelTelemetry {
                acquired: Some(824),
                unique_or_processed: Some(611),
                cloth_passed: Some(312),
                remote_eligible: Some(106),
                qualified: None,
                materials_completed: None,
                deployed: None,
            },
            stage_metrics: StageMetrics::RemoteEval {
                eligible: 73,
                rejected: 29,
                pending: 4,
            },
        }
    }

    #[test]
    fn render_deterministic_wide_layout() {
        let tel = sample_telemetry();
        let lines = render_telemetry_lines(&tel, 60, false, Instant::now());
        assert_eq!(lines.len(), 9);
        for line in &lines {
            assert!(str_display_width(line) <= 60);
        }
        assert!(lines[0].contains("REMOTE EVAL"));
        assert!(lines[0].contains("5/8"));
        assert!(lines[3].contains("CURRENT"));
        assert!(lines[3].contains("Technical Support Specialist"));
        assert!(lines[6].contains("openrouter"));
        assert!(lines[7].contains("eligible 73 · rejected 29"));
        assert!(lines[8].contains("824 → 611 → 312 → 106 → — → —"));
    }

    #[test]
    fn render_deterministic_medium_layout() {
        let tel = sample_telemetry();
        let lines = render_telemetry_lines(&tel, 40, false, Instant::now());
        assert_eq!(lines.len(), 9);
        for line in &lines {
            assert!(str_display_width(line) <= 40);
        }
        assert!(lines[8].contains("HEALTH"));
    }

    #[test]
    fn layout_mode_selection_by_terminal_width() {
        assert_eq!(LayoutMode::for_terminal_width(160), LayoutMode::Wide);
        assert_eq!(LayoutMode::for_terminal_width(120), LayoutMode::Wide);
        assert_eq!(LayoutMode::for_terminal_width(119), LayoutMode::Medium);
        assert_eq!(LayoutMode::for_terminal_width(96), LayoutMode::Medium);
        assert_eq!(LayoutMode::for_terminal_width(95), LayoutMode::Compact);
        assert_eq!(LayoutMode::for_terminal_width(80), LayoutMode::Compact);
        assert_eq!(LayoutMode::for_terminal_width(79), LayoutMode::LogoOnly);
        assert_eq!(LayoutMode::for_terminal_width(60), LayoutMode::LogoOnly);
    }
}
