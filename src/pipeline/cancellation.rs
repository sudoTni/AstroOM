//! Pipeline cancellation plumbing. Port of AstroEX-node
//! src/pipelineCancellation.ts.

use crate::error::AppError;
use tokio_util::sync::CancellationToken;

/// The reason a pipeline run was cancelled.
#[derive(Debug, Clone)]
pub enum CancellationCause {
    Watchdog {
        error: AppError,
    },
    Signal {
        signal: &'static str,
        error: AppError,
    },
}

pub struct PipelineCancellationController {
    token: CancellationToken,
    cause: std::sync::Mutex<Option<CancellationCause>>,
    finished: std::sync::atomic::AtomicBool,
}

impl Default for PipelineCancellationController {
    fn default() -> Self {
        Self::new()
    }
}

impl PipelineCancellationController {
    pub fn new() -> Self {
        Self {
            token: CancellationToken::new(),
            cause: std::sync::Mutex::new(None),
            finished: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    /// Cancel the pipeline; idempotent-once (returns false if already
    /// cancelled or finished).
    pub fn cancel(&self, cause: CancellationCause) -> bool {
        if self.token.is_cancelled() || self.finished.load(std::sync::atomic::Ordering::SeqCst) {
            return false;
        }
        {
            let mut c = self
                .cause
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if c.is_none() {
                *c = Some(cause);
            }
        }
        self.token.cancel();
        true
    }

    pub fn cause(&self) -> Option<CancellationCause> {
        self.cause
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
    }

    /// Marks the run as finished (prevents later cancels from mattering).
    pub fn finish(&self) {
        self.finished
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Throws (returns Err) if the signal is cancelled, using its reason.
pub fn throw_if_cancelled(token: &CancellationToken) -> crate::error::Result<()> {
    if token.is_cancelled() {
        return Err(AppError::message(
            "Pipeline cancelled before operation started",
        ));
    }
    Ok(())
}

/// Outcome of a delivered termination signal, mapped to AstroOM's exit codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignalOutcome {
    pub name: &'static str,
    pub exit_code: u16,
}

impl SignalOutcome {
    const SIGINT: Self = Self {
        name: "SIGINT",
        exit_code: 130,
    };
    /// Windows never delivers SIGTERM to a console process; see `second_signal`.
    #[cfg(unix)]
    const SIGTERM: Self = Self {
        name: "SIGTERM",
        exit_code: 143,
    };
}

impl From<SignalOutcome> for AppError {
    fn from(outcome: SignalOutcome) -> Self {
        AppError::new(
            outcome.name,
            outcome.exit_code,
            format!("Pipeline cancelled by {}", outcome.name),
        )
    }
}

/// Boxed so both platform backends expose the same non-`Unpin` signature and
/// `tokio::select!` can poll them alongside the stop token.
type SignalFuture = std::pin::Pin<Box<dyn std::future::Future<Output = SignalOutcome> + Send>>;

/// A long-running task that reports the first termination signal it observes.
///
/// Shared by both platform backends so the pipeline's cancellation semantics
/// live in one place. A `None` `second` means the platform delivers only one
/// kind of signal. When `stop` fires first, nothing is reported.
async fn wait_for_signal(
    mut first: SignalFuture,
    second: Option<SignalFuture>,
    stop: CancellationToken,
) -> Option<SignalOutcome> {
    let outcome = match second {
        Some(mut second) => {
            tokio::select! {
                outcome = &mut first => outcome,
                outcome = &mut second => outcome,
                _ = stop.cancelled() => return None,
            }
        }
        None => {
            tokio::select! {
                outcome = &mut first => outcome,
                _ = stop.cancelled() => return None,
            }
        }
    };
    crate::logging::log(
        "Pipeline",
        &format!("Received {}; cancelling pipeline gracefully.", outcome.name),
        crate::types::LogLevel::Warn,
    );
    Some(outcome)
}

/// Spawns the platform's termination-signal watcher.
///
/// Unix observes SIGINT and SIGTERM and reports exit codes 130 and 143, which
/// is what the Node CLI did. Windows does not deliver SIGTERM to console
/// processes; Ctrl+C arrives as `CTRL_C_EVENT` and maps to 130.
pub fn spawn_signal_watcher(
    cancellation: CancellationToken,
    stop: CancellationToken,
) -> tokio::task::JoinHandle<Option<SignalOutcome>> {
    tokio::spawn(async move {
        let outcome = wait_for_signal(first_signal(), second_signal(), stop).await;
        // Only a real signal cancels the run; a clean `stop` does not.
        if outcome.is_some() {
            cancellation.cancel();
        }
        outcome
    })
}

#[cfg(unix)]
fn first_signal() -> SignalFuture {
    Box::pin(async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()) {
            Ok(mut interrupt) => {
                interrupt.recv().await;
                SignalOutcome::SIGINT
            }
            Err(_) => std::future::pending().await,
        }
    })
}

#[cfg(unix)]
fn second_signal() -> Option<SignalFuture> {
    Some(Box::pin(async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                terminate.recv().await;
                SignalOutcome::SIGTERM
            }
            Err(_) => std::future::pending().await,
        }
    }))
}

#[cfg(windows)]
fn first_signal() -> SignalFuture {
    Box::pin(async {
        match tokio::signal::ctrl_c().await {
            Ok(()) => SignalOutcome::SIGINT,
            Err(_) => std::future::pending().await,
        }
    })
}

#[cfg(windows)]
fn second_signal() -> Option<SignalFuture> {
    None
}

/// In a catch block: swallow the original error and rethrow the
/// cancellation reason when aborted (prevents retry loops from masking
/// cancellation). Returns the original error otherwise.
pub fn rethrow_if_cancelled(
    original: AppError,
    token: &CancellationToken,
) -> crate::error::Result<()> {
    if token.is_cancelled() {
        return Err(AppError::message(format!(
            "Pipeline cancelled (original error: {})",
            original.message
        )));
    }
    Err(original)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signal_cause(name: &'static str) -> CancellationCause {
        CancellationCause::Signal {
            signal: name,
            error: AppError::new(name, 1, format!("cancelled by {name}")),
        }
    }

    #[test]
    fn cancel_is_idempotent_and_first_writer_wins() {
        let controller = PipelineCancellationController::new();
        assert!(!controller.is_cancelled());
        assert!(controller.cancel(signal_cause("SIGINT")));
        assert!(controller.is_cancelled());
        assert!(!controller.cancel(signal_cause("SIGTERM")));
        match controller.cause() {
            Some(CancellationCause::Signal { signal, .. }) => assert_eq!(signal, "SIGINT"),
            other => panic!("expected first cause, got {other:?}"),
        }
    }

    #[test]
    fn finish_prevents_later_cancellation() {
        let controller = PipelineCancellationController::new();
        controller.finish();
        assert!(!controller.cancel(signal_cause("SIGINT")));
        assert!(!controller.is_cancelled());
        assert!(controller.cause().is_none());
    }

    #[test]
    fn throw_if_cancelled_reports_only_after_cancel() {
        let token = CancellationToken::new();
        assert!(throw_if_cancelled(&token).is_ok());
        token.cancel();
        assert!(throw_if_cancelled(&token).is_err());
    }

    #[test]
    fn rethrow_prefers_cancellation_but_keeps_original_otherwise() {
        let token = CancellationToken::new();
        let original = AppError::new("BOOM", 500, "original failure");
        let error = rethrow_if_cancelled(original, &token).expect_err("error");
        assert_eq!(error.message, "original failure");

        token.cancel();
        let error = rethrow_if_cancelled(AppError::new("BOOM", 500, "original failure"), &token)
            .expect_err("cancelled");
        assert!(error.message.starts_with("Pipeline cancelled"));
    }
}
