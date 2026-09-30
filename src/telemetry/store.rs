//! Synchronized telemetry store.
//!
//! Provides a concurrency-safe container for pipeline telemetry updates
//! and cheap snapshot generation for the footer renderer and logger.

use super::model::*;
use std::sync::RwLock;
use std::time::{Duration, Instant};

/// Synchronized, thread-safe telemetry store.
#[derive(Debug)]
pub struct TelemetryStore {
    inner: RwLock<RunTelemetry>,
}

impl Default for TelemetryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl TelemetryStore {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(RunTelemetry::default()),
        }
    }

    /// Read an immutable snapshot of current telemetry state.
    pub fn snapshot(&self) -> RunTelemetry {
        let guard = self.inner.read().unwrap_or_else(|e| e.into_inner());
        guard.clone()
    }

    /// Notify that a new pipeline stage has started.
    pub fn stage_started(&self, stage: StageKind, total: Option<u64>) {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.pipeline = PipelineIdentity {
            stage_index: stage.index(),
            stage_count: 8,
            stage_kind: stage,
            stage_label: stage.label(),
        };
        guard.progress = ProgressTelemetry {
            completed: 0,
            total,
        };
        guard.current_item = None;
        guard.timing.reset_stage(Instant::now());
        guard.stage_metrics = match stage {
            StageKind::AcquireJobs => StageMetrics::Acquire {
                indeed: None,
                linkedin: None,
                acquired: 0,
            },
            StageKind::ProcessData => StageMetrics::ProcessData {
                input: total.unwrap_or(0),
                kept: 0,
                duplicates: 0,
                company_filtered: 0,
                title_filtered: 0,
                previously_seen: 0,
            },
            StageKind::JobCloth => StageMetrics::JobCloth {
                completed_batches: 0,
                total_batches: total,
                successful_jobs: 0,
                filtered_jobs: 0,
                errors: 0,
            },
            StageKind::EnrichJobs => StageMetrics::EnrichJobs {
                enriched: 0,
                skipped: 0,
                fetch_failures: 0,
            },
            StageKind::RemoteEval => StageMetrics::RemoteEval {
                eligible: 0,
                rejected: 0,
                pending: total.unwrap_or(0),
            },
            StageKind::JobJudge => StageMetrics::JobJudge {
                qualified: 0,
                rejected: 0,
                pending: total.unwrap_or(0),
            },
            StageKind::MakeMaterials => StageMetrics::MakeMaterials {
                completed_packages: 0,
                failed_packages: 0,
                pending: total.unwrap_or(0),
            },
            StageKind::DeployMaterials => StageMetrics::DeployMaterials {
                deployed: 0,
                skipped: 0,
                failed: 0,
            },
            StageKind::Idle => StageMetrics::None,
        };
    }

    /// Notify that an individual item is starting processing.
    pub fn item_started(
        &self,
        ordinal: Option<u64>,
        total: Option<u64>,
        title: Option<String>,
        company: Option<String>,
    ) {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.current_item = Some(CurrentItemTelemetry {
            ordinal,
            total,
            title,
            company,
        });
    }

    /// Notify that an individual item has completed.
    pub fn item_completed(&self, duration: Option<Duration>) {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.progress.completed = guard.progress.completed.saturating_add(1);
        if let Some(d) = duration {
            let remaining = guard
                .progress
                .total
                .map(|tot| tot.saturating_sub(guard.progress.completed));
            guard.timing.record_item_duration(d, remaining);
        }
    }

    /// Record a completed LLM call with its usage, latency, and success status.
    // One parameter per field of the Node `llmCallCompleted` telemetry event;
    // grouping them would hide the event's shape at every call site.
    #[allow(clippy::too_many_arguments)]
    pub fn llm_call_completed(
        &self,
        model: Option<&str>,
        provider: Option<&str>,
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
        cost_usd: f64,
        elapsed: Duration,
        succeeded: bool,
    ) {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.llm.requests_total = guard.llm.requests_total.saturating_add(1);
        guard.llm.input_tokens_total = guard.llm.input_tokens_total.saturating_add(input_tokens);
        guard.llm.output_tokens_total = guard.llm.output_tokens_total.saturating_add(output_tokens);
        guard.llm.tokens_total = guard.llm.tokens_total.saturating_add(total_tokens);
        guard.llm.cost_usd_total += cost_usd;

        if let Some(m) = model {
            guard.llm.model = Some(m.to_string());
        }
        if let Some(p) = provider {
            guard.llm.provider = Some(p.to_string());
        }

        guard.llm.last_call = Some(LlmCallTelemetry {
            elapsed,
            input_tokens,
            output_tokens,
            total_tokens,
            cost_usd,
            succeeded,
        });

        if !succeeded {
            guard.health.errors = guard.health.errors.saturating_add(1);
        }
    }

    /// Record a retry attempt.
    pub fn retry_recorded(&self) {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.health.retries = guard.health.retries.saturating_add(1);
        guard.health.current_retry_streak = guard.health.current_retry_streak.saturating_add(1);
    }

    /// Reset retry streak on successful completion after retries.
    pub fn retry_streak_reset(&self) {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.health.current_retry_streak = 0;
    }

    /// Update total units expected for the current stage.
    pub fn set_progress_total(&self, total: u64) {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.progress.total = Some(total);
    }

    /// Record a single error occurrence.
    pub fn record_error(&self) {
        self.error_recorded(1);
    }

    /// Record a permanent error.
    pub fn error_recorded(&self, count: u64) {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        guard.health.errors = guard.health.errors.saturating_add(count);
    }

    /// Apply an update function to stage-specific outcome metrics.
    pub fn update_stage_metrics<F>(&self, f: F)
    where
        F: FnOnce(&mut StageMetrics),
    {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        f(&mut guard.stage_metrics);
    }

    /// Apply an update function to the funnel metrics.
    pub fn update_funnel<F>(&self, f: F)
    where
        F: FnOnce(&mut FunnelTelemetry),
    {
        let mut guard = self.inner.write().unwrap_or_else(|e| e.into_inner());
        f(&mut guard.funnel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stage_started_and_progress_invariants() {
        let store = TelemetryStore::new();
        store.stage_started(StageKind::RemoteEval, Some(10));

        let snap = store.snapshot();
        assert_eq!(snap.pipeline.stage_index, 5);
        assert_eq!(snap.pipeline.stage_kind, StageKind::RemoteEval);
        assert_eq!(snap.progress.completed, 0);
        assert_eq!(snap.progress.total, Some(10));

        store.item_started(Some(1), Some(10), Some("Engineer".to_string()), None);
        let snap = store.snapshot();
        assert_eq!(
            snap.current_item.unwrap().title.as_deref(),
            Some("Engineer")
        );

        store.item_completed(Some(Duration::from_millis(500)));
        let snap = store.snapshot();
        assert_eq!(snap.progress.completed, 1);
    }

    #[test]
    fn test_llm_call_accumulation() {
        let store = TelemetryStore::new();
        store.llm_call_completed(
            Some("glm-5.3-flash"),
            Some("openrouter"),
            100,
            50,
            150,
            0.001,
            Duration::from_millis(400),
            true,
        );
        store.llm_call_completed(
            Some("glm-5.3-flash"),
            Some("openrouter"),
            200,
            100,
            300,
            0.002,
            Duration::from_millis(600),
            true,
        );

        let snap = store.snapshot();
        assert_eq!(snap.llm.requests_total, 2);
        assert_eq!(snap.llm.tokens_total, 450);
        assert!((snap.llm.cost_usd_total - 0.003).abs() < 1e-6);
        assert_eq!(snap.llm.last_call.as_ref().unwrap().total_tokens, 300);
    }
}
