//! Console output primitives. Port of AstroEX-node src/logging/transports.ts
//! and src/logging/consoleOutput.ts. All process output flows through here so
//! the execution log tee (execution_log.rs) can mirror it.
//!
//! Every writer takes [`lock_console`]. The execution-log reader threads take
//! the same lock before writing to the real descriptor on Unix, so taking it
//! unconditionally is what keeps log lines, LLM stream deltas and the tee
//! mirror from interleaving mid-line.

use super::fader::{apply_hsv_fade, FadeOptions, GradientKey};
use serde_json::Value;
use std::io::Write;
use std::sync::Mutex;

pub static CONSOLE_OUTPUT_LOCK: Mutex<()> = Mutex::new(());

/// Helper to execute a closure while holding the global console output lock.
pub fn with_console_lock<F, R>(f: F) -> R
where
    F: FnOnce() -> R,
{
    let _guard = lock_console();
    f()
}

pub fn lock_console() -> std::sync::MutexGuard<'static, ()> {
    CONSOLE_OUTPUT_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn write_raw(stream: &mut impl Write, text: &str) {
    let _ = stream.write_all(text.as_bytes());
    let _ = stream.flush();
}

/// Pretty-printed machine JSON to stdout, always uncolored.
pub fn write_machine_json(value: &Value) {
    let body = serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string());
    {
        let _guard = lock_console();
        write_raw(&mut std::io::stdout(), &body);
        write_raw(&mut std::io::stdout(), "\n");
    }
    super::execution_log::mirror_console_bytes(&body);
    super::execution_log::mirror_console_bytes("\n");
}

/// Internal logging failure fallback to stderr.
pub fn write_internal_console_failure(message: &str) {
    let styled = apply_hsv_fade(
        message,
        GradientKey::ErrorFallback,
        FadeOptions {
            use_color: Some(super::use_color()),
            ..Default::default()
        },
    );
    {
        let _guard = lock_console();
        write_raw(&mut std::io::stderr(), &styled);
        write_raw(&mut std::io::stderr(), "\n");
    }
    super::execution_log::mirror_console_bytes(message);
    super::execution_log::mirror_console_bytes("\n");
}

pub fn write_stdout_line(line: &str) {
    {
        let _guard = lock_console();
        write_raw(&mut std::io::stdout(), line);
        write_raw(&mut std::io::stdout(), "\n");
    }
    super::execution_log::mirror_console_bytes(line);
    super::execution_log::mirror_console_bytes("\n");
}

pub fn write_stderr_line(line: &str) {
    {
        let _guard = lock_console();
        write_raw(&mut std::io::stderr(), line);
        write_raw(&mut std::io::stderr(), "\n");
    }
    super::execution_log::mirror_console_bytes(line);
    super::execution_log::mirror_console_bytes("\n");
}

/// Raw (unterminated) console write, used by the LLM streaming renderer.
///
/// Takes the same console lock as the line writers so a stream delta cannot
/// interleave with a log line or the execution-log tee mirror. Stream deltas
/// *are* application output, so they belong in the execution log.
pub fn write_stdout_fragment(text: &str) {
    {
        let _guard = lock_console();
        write_raw(&mut std::io::stdout(), text);
    }
    super::execution_log::mirror_console_bytes(text);
}

/// Writes terminal chrome straight to the console, bypassing the execution log.
///
/// The animated banner is drawn at 30 frames per second. Routing those frames
/// through the log tee would mirror every one of them into the execution log —
/// tens of megabytes of cursor-movement sequences for a normal run, swamping
/// the actual log records. The banner is decoration, not output, so it goes
/// directly to the console descriptor and is never recorded.
///
/// Still takes the console lock: the tee reader threads write to that same
/// descriptor, and the animation must not interleave with a log line.
pub fn write_console_fragment(text: &str) {
    let _guard = lock_console();
    #[cfg(unix)]
    {
        // With the tee installed, fd 1 is a pipe into the log; the saved
        // descriptor is the real console. Writing there keeps the bytes out of
        // the log entirely.
        if let Some(fd) = super::execution_log::console_stdout_fd() {
            super::execution_log::write_all_fd(fd, text.as_bytes());
            return;
        }
    }
    // No tee installed, or Windows: fd 1 is already the console, and the
    // Windows API-level tee must not mirror chrome either.
    write_raw(&mut std::io::stdout(), text);
}

/// Re-emit external (child process) command output through the HSV styling:
/// stderr uses the "errorFallback" gradient, stdout uses the "activity" gradient.
pub fn write_external_command_output(stdout_chunk: Option<&str>, stderr_chunk: Option<&str>) {
    let use_color = super::use_color();
    let mut to_mirror = String::new();
    {
        let _guard = lock_console();
        if let Some(chunk) = stdout_chunk {
            if !chunk.is_empty() {
                let styled = apply_hsv_fade(
                    chunk,
                    GradientKey::Activity,
                    FadeOptions {
                        use_color: Some(use_color),
                        ..Default::default()
                    },
                );
                write_raw(&mut std::io::stdout(), &styled);
                to_mirror.push_str(chunk);
            }
        }
        if let Some(chunk) = stderr_chunk {
            if !chunk.is_empty() {
                let styled = apply_hsv_fade(
                    chunk,
                    GradientKey::ErrorFallback,
                    FadeOptions {
                        use_color: Some(use_color),
                        ..Default::default()
                    },
                );
                write_raw(&mut std::io::stderr(), &styled);
                to_mirror.push_str(chunk);
            }
        }
    }
    // Draining waits on the reader threads, which take the console lock
    // themselves, so it must happen with the lock released.
    super::execution_log::mirror_console_bytes(&to_mirror);
    super::execution_log::flush_execution_log();
}
