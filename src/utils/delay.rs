//! Delay, jitter, and retry-classification helpers. Port of AstroEX-node
//! src/utils/delayUtils.ts.

use rand::Rng;

#[derive(Debug, Clone)]
pub struct RetryConfig {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
    pub backoff_factor: u32,
    pub jitter: bool,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base_delay_ms: 1000,
            max_delay_ms: 30000,
            backoff_factor: 2,
            jitter: true,
        }
    }
}

/// Random jitter delay between min and max seconds, returned in ms.
/// Validates positivity (Node throws on invalid input).
pub fn get_random_jitter_delay_ms(min_seconds: f64, max_seconds: f64) -> crate::error::Result<u64> {
    // `NaN` satisfies every comparison below, and `gen_range(NaN..NaN)` panics
    // inside `rand::Uniform`, so finiteness must be checked explicitly. This
    // mirrors `cli::seconds_to_millis`.
    if !min_seconds.is_finite() || !max_seconds.is_finite() {
        return Err(crate::error::AppError::message(
            "Delay values must be finite",
        ));
    }
    if min_seconds < 0.0 || max_seconds < 0.0 {
        return Err(crate::error::AppError::message(
            "Delay values must be positive",
        ));
    }
    if max_seconds < min_seconds {
        return Err(crate::error::AppError::message(
            "minDelay cannot be greater than maxDelay",
        ));
    }
    let seconds = if min_seconds == max_seconds {
        min_seconds
    } else {
        rand::thread_rng().gen_range(min_seconds..max_seconds)
    };
    Ok((seconds * 1000.0).round() as u64)
}

pub async fn sleep_with_jitter(min_seconds: f64, max_seconds: f64) -> crate::error::Result<()> {
    let ms = get_random_jitter_delay_ms(min_seconds, max_seconds)?;
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
    Ok(())
}

/// Retry with exponential backoff and up to 10% random jitter.
pub async fn retry_with_backoff_custom<F, Fut, T>(
    config: &RetryConfig,
    mut operation: F,
) -> crate::error::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = crate::error::Result<T>>,
{
    let mut attempt: u32 = 0;
    loop {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(err) => {
                if attempt >= config.max_retries {
                    return Err(err);
                }
                attempt += 1;
                // Clamp the factor before multiplying: a large base delay and
                // attempt count would otherwise overflow u64 (panicking in
                // debug, wrapping to a tiny delay in release).
                let exponent = config
                    .max_delay_ms
                    .checked_div(config.base_delay_ms.max(1))
                    .unwrap_or(u64::MAX)
                    .min(u32::MAX as u64) as u32;
                let factor = (config.backoff_factor as u64).pow(exponent.min(attempt - 1));
                let mut delay = config
                    .base_delay_ms
                    .saturating_mul(factor)
                    .min(config.max_delay_ms);
                if config.jitter {
                    let jitter: f64 = rand::thread_rng().gen_range(0.0..0.1);
                    delay = delay.saturating_add((delay as f64 * jitter) as u64);
                }
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
        }
    }
}

/// Whether an HTTP status should be retried. Node's `isRetryableError`
/// retries every 5xx status in addition to 408/429.
pub fn is_retryable_status(status: u16) -> bool {
    status >= 500 || status == 408 || status == 429
}

/// Network-error keyword matcher (heuristic, like Node's isNetworkError).
pub fn is_network_error(message: &str) -> bool {
    let lower = message.to_lowercase();
    [
        "network",
        "timeout",
        "connection",
        "fetch",
        "request",
        "errno",
        "econnreset",
        "econnrefused",
        "enotfound",
    ]
    .iter()
    .any(|kw| lower.contains(kw))
}
