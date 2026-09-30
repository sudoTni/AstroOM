//! Core telemetry domain model for persistent run-status monitoring.
//!
//! Represents execution facts as typed, structured state updated directly
//! by pipeline events rather than parsed from formatted log prose.

use std::time::{Duration, Instant};

/// The eight sequential pipeline stages, plus idle/preflight state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum StageKind {
    #[default]
    Idle,
    AcquireJobs,
    ProcessData,
    JobCloth,
    EnrichJobs,
    RemoteEval,
    JobJudge,
    MakeMaterials,
    DeployMaterials,
}

impl StageKind {
    /// 1-based index of the stage, or 0 if idle.
    pub fn index(self) -> u8 {
        match self {
            StageKind::Idle => 0,
            StageKind::AcquireJobs => 1,
            StageKind::ProcessData => 2,
            StageKind::JobCloth => 3,
            StageKind::EnrichJobs => 4,
            StageKind::RemoteEval => 5,
            StageKind::JobJudge => 6,
            StageKind::MakeMaterials => 7,
            StageKind::DeployMaterials => 8,
        }
    }

    /// Uppercase display label for header formatting.
    pub fn label(self) -> &'static str {
        match self {
            StageKind::Idle => "ASTROOM",
            StageKind::AcquireJobs => "ACQUIRE JOBS",
            StageKind::ProcessData => "PROCESS DATA",
            StageKind::JobCloth => "JOB CLOTH",
            StageKind::EnrichJobs => "ENRICH JOBS",
            StageKind::RemoteEval => "REMOTE EVAL",
            StageKind::JobJudge => "JOB JUDGE",
            StageKind::MakeMaterials => "MAKE MATERIALS",
            StageKind::DeployMaterials => "DEPLOY MATERIALS",
        }
    }

    /// Short label used in the funnel row.
    pub fn short_label(self) -> &'static str {
        match self {
            StageKind::Idle => "idle",
            StageKind::AcquireJobs => "acquired",
            StageKind::ProcessData => "unique",
            StageKind::JobCloth => "clothed",
            StageKind::EnrichJobs => "enriched",
            StageKind::RemoteEval => "remote",
            StageKind::JobJudge => "judged",
            StageKind::MakeMaterials => "materials",
            StageKind::DeployMaterials => "deployed",
        }
    }
}

/// Pipeline stage identity and numbering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PipelineIdentity {
    pub stage_index: u8,
    pub stage_count: u8,
    pub stage_kind: StageKind,
    pub stage_label: &'static str,
}

impl Default for PipelineIdentity {
    fn default() -> Self {
        Self {
            stage_index: 0,
            stage_count: 8,
            stage_kind: StageKind::Idle,
            stage_label: StageKind::Idle.label(),
        }
    }
}

/// Generic unit progress for the current stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ProgressTelemetry {
    pub completed: u64,
    pub total: Option<u64>,
}

impl ProgressTelemetry {
    /// Percentage complete [0, 100], or None if total is unknown or zero.
    pub fn percentage(self) -> Option<u8> {
        match self.total {
            Some(t) if t > 0 => {
                let pct = ((self.completed as f64 / t as f64) * 100.0).round();
                Some(pct.clamp(0.0, 100.0) as u8)
            }
            _ => None,
        }
    }
}

/// Identity of the item currently being evaluated by the stage.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CurrentItemTelemetry {
    pub ordinal: Option<u64>,
    pub total: Option<u64>,
    pub title: Option<String>,
    pub company: Option<String>,
}

/// Execution timing and EWMA-based rolling ETA estimator.
#[derive(Debug, Clone)]
pub struct TimingTelemetry {
    pub run_started_at: Instant,
    pub stage_started_at: Instant,
    pub eta: Option<Duration>,
    pub completed_samples: u64,
    pub ewma_duration_sec: Option<f64>,
}

impl Default for TimingTelemetry {
    fn default() -> Self {
        let now = Instant::now();
        Self {
            run_started_at: now,
            stage_started_at: now,
            eta: None,
            completed_samples: 0,
            ewma_duration_sec: None,
        }
    }
}

impl TimingTelemetry {
    /// Reset stage-local timing and ETA estimation when transitioning to a new stage.
    pub fn reset_stage(&mut self, now: Instant) {
        self.stage_started_at = now;
        self.eta = None;
        self.completed_samples = 0;
        self.ewma_duration_sec = None;
    }

    /// Record completed item duration and update EWMA ETA estimation.
    ///
    /// Uses EWMA with alpha = 0.25. Publication threshold: require >= 3 samples
    /// before publishing an estimate to avoid early distortion.
    pub fn record_item_duration(&mut self, duration: Duration, remaining_items: Option<u64>) {
        self.completed_samples = self.completed_samples.saturating_add(1);
        let sec = duration.as_secs_f64();
        let alpha = 0.25;
        let new_ewma = match self.ewma_duration_sec {
            Some(prev) => alpha * sec + (1.0 - alpha) * prev,
            None => sec,
        };
        self.ewma_duration_sec = Some(new_ewma);

        if self.completed_samples >= 3 {
            if let Some(rem) = remaining_items {
                self.eta = Some(Duration::from_secs_f64(new_ewma * rem as f64));
            } else {
                self.eta = None;
            }
        } else {
            self.eta = None;
        }
    }
}

/// Cumulative LLM usage and last-call telemetry.
#[derive(Debug, Clone, Default)]
pub struct LlmTelemetry {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub requests_total: u64,
    pub input_tokens_total: u64,
    pub output_tokens_total: u64,
    pub tokens_total: u64,
    pub cost_usd_total: f64,
    pub last_call: Option<LlmCallTelemetry>,
    pub request_limit: Option<u64>,
    pub output_token_limit: Option<u64>,
    pub total_output_token_limit: Option<u64>,
}

/// Telemetry for the most recently completed LLM call.
#[derive(Debug, Clone)]
pub struct LlmCallTelemetry {
    pub elapsed: Duration,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub succeeded: bool,
}

/// Health, retries, and errors counter.
#[derive(Debug, Clone, Default)]
pub struct HealthTelemetry {
    pub errors: u64,
    pub retries: u64,
    pub current_retry_streak: u64,
    pub provider_failures: u64,
    pub network_ok: Option<bool>,
}

/// Pipeline acquisition-to-materials funnel progression.
///
/// `None` indicates the stage has not yet run or result is unknown.
/// `Some(0)` indicates an authoritative zero count.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FunnelTelemetry {
    pub acquired: Option<u64>,
    pub unique_or_processed: Option<u64>,
    pub cloth_passed: Option<u64>,
    pub remote_eligible: Option<u64>,
    pub qualified: Option<u64>,
    pub materials_completed: Option<u64>,
    pub deployed: Option<u64>,
}

/// Stage-specific detailed outcome counters.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum StageMetrics {
    Acquire {
        indeed: Option<u64>,
        linkedin: Option<u64>,
        acquired: u64,
    },
    ProcessData {
        input: u64,
        kept: u64,
        duplicates: u64,
        company_filtered: u64,
        title_filtered: u64,
        previously_seen: u64,
    },
    JobCloth {
        completed_batches: u64,
        total_batches: Option<u64>,
        successful_jobs: u64,
        filtered_jobs: u64,
        errors: u64,
    },
    EnrichJobs {
        enriched: u64,
        skipped: u64,
        fetch_failures: u64,
    },
    RemoteEval {
        eligible: u64,
        rejected: u64,
        pending: u64,
    },
    JobJudge {
        qualified: u64,
        rejected: u64,
        pending: u64,
    },
    MakeMaterials {
        completed_packages: u64,
        failed_packages: u64,
        pending: u64,
    },
    DeployMaterials {
        deployed: u64,
        skipped: u64,
        failed: u64,
    },
    #[default]
    None,
}

/// Immutable snapshot of complete telemetry state for UI rendering and inspection.
#[derive(Debug, Clone, Default)]
pub struct RunTelemetry {
    pub pipeline: PipelineIdentity,
    pub progress: ProgressTelemetry,
    pub current_item: Option<CurrentItemTelemetry>,
    pub timing: TimingTelemetry,
    pub llm: LlmTelemetry,
    pub health: HealthTelemetry,
    pub funnel: FunnelTelemetry,
    pub stage_metrics: StageMetrics,
}
