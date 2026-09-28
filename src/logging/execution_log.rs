//! Execution log tee. Port of AstroEX-node src/logging/executionLog.ts.
//!
//! Mirrors console output to one execution-scoped, ANSI-free file without
//! changing the bytes seen by the console. Node wraps the stream write
//! methods; the Rust port uses the most faithful equivalent per platform:
//!
//! * **Unix** — stdout and stderr file descriptors 1 and 2 are redirected
//!   through pipes and every chunk is forwarded both to the saved original
//!   descriptors (ANSI intact) and to the log file (ANSI-stripped). This
//!   captures *everything*, including output from foreign code and child
//!   processes. It is the historical behaviour, unchanged.
//!
//! * **Windows** — the equivalent is an API-level tee: `console_output` writes
//!   each line to the real console and then hands the text to
//!   [`mirror_console_bytes`], which appends the ANSI-stripped form to the log
//!   file. Standard handles are left untouched, so the console cannot be
//!   corrupted by a failed redirection, and the Windows console keeps working
//!   exactly as the user's terminal expects.
//!
//!   The observable difference is scope, not content: the Windows tee mirrors
//!   what AstroOM writes through `console_output` (which is every log line,
//!   every LLM stream delta, the banner, and the re-emitted `rclone` output
//!   from `write_external_command_output`) rather than raw bytes emitted
//!   directly against the handle. The only bypasses in the crate are funnelled
//!   through `console_output` as well — see `write_stdout` in `llm/stream.rs`
//!   and `display_banner` in `utils/mod.rs`.

use std::fs::File;
use std::io::{Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::platform;

/// The single execution-scoped log file for this process.
struct LogFileState {
    path: PathBuf,
    file: Arc<Mutex<File>>,
}

static LOG_FILE: Mutex<Option<LogFileState>> = Mutex::new(None);

fn safe_identifier(value: &str) -> String {
    static RE_INVALID: OnceLock<regex::Regex> = OnceLock::new();
    static RE_EDGES: OnceLock<regex::Regex> = OnceLock::new();
    let re_invalid = RE_INVALID.get_or_init(|| regex::Regex::new(r"[^a-z0-9_-]+").unwrap());
    let re_edges = RE_EDGES.get_or_init(|| regex::Regex::new(r"^-+|-+$").unwrap());
    let lowered = value.trim().to_lowercase();
    let dashed = re_invalid.replace_all(&lowered, "-");
    let trimmed = re_edges.replace_all(&dashed, "");
    let sanitized = trimmed.to_string();
    if sanitized.is_empty() {
        "command".to_string()
    } else {
        sanitized
    }
}

fn command_identifier(args: &[String]) -> String {
    let first = args
        .iter()
        .find(|argument| !argument.starts_with('-'))
        .map(String::as_str)
        .unwrap_or("cli");
    safe_identifier(first)
}

fn timestamp_for_file() -> String {
    chrono::Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        .replace(&['-', ':', '.'][..], "")
}

/// Creates the execution log directory (plus the payload log subdirectories)
/// and the execution-scoped log file. Idempotent: a second call is a no-op.
///
/// On Unix this additionally installs the file-descriptor tee; see the module
/// documentation for the per-platform split.
pub fn initialize_execution_log(log_dir: &Path, args: &[String]) -> std::io::Result<()> {
    let file = {
        let mut state = LOG_FILE.lock().unwrap_or_else(|e| e.into_inner());
        if state.is_some() {
            return Ok(());
        }

        platform::create_private_dir_all(log_dir)?;
        for subdirectory in super::payload_logs::LLM_PAYLOAD_LOG_DIRECTORIES {
            platform::create_private_dir_all(&log_dir.join(subdirectory))?;
        }

        let file_name = format!(
            "astroom_{}_{}_p{}_{}.log",
            command_identifier(args),
            timestamp_for_file(),
            std::process::id(),
            uuid::Uuid::new_v4()
        );
        let file_path = log_dir.join(file_name);
        let file = platform::private_writer(&file_path)?;
        let shared = Arc::new(Mutex::new(file));
        *state = Some(LogFileState {
            path: file_path,
            file: Arc::clone(&shared),
        });
        shared
    };

    // Installed after publishing the file state so that a failure here still
    // leaves a log file the operator can inspect, and the next call is a no-op.
    fd_tee::install(file)
}

/// Returns whether the execution log is currently being written.
pub fn is_tee_active() -> bool {
    LOG_FILE.lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

/// Returns the current execution log file path, if it exists.
pub fn execution_log_path() -> Option<PathBuf> {
    LOG_FILE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|state| state.path.clone())
}

/// Returns whether the process' console is attached to a terminal.
///
/// On Unix this must consult the *saved* descriptor once the tee is installed,
/// because fd 1 is then a pipe rather than the terminal.
pub fn is_stdout_terminal() -> bool {
    #[cfg(unix)]
    {
        if let Some(saved) = fd_tee::saved_stdout() {
            return unsafe { libc::isatty(saved) == 1 };
        }
    }
    platform::is_stdout_terminal_raw()
}

/// The descriptor that really is the user's console, or `None` when the tee
/// is not installed.
///
/// After `initialize_execution_log`, file descriptors 1 and 2 are pipes, so
/// anything that probes the terminal (size, TTY-ness) must use the descriptor
/// saved before the redirect.
pub fn console_stdout_fd() -> Option<i32> {
    #[cfg(unix)]
    {
        fd_tee::saved_stdout()
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// Appends ANSI-stripped console text to the execution log file.
///
/// Compiled to a no-op on Unix: the file-descriptor tee has already captured
/// every byte, so stripping escapes and re-locking the file here would be
/// wasted work on the hot logging path (three regex passes plus an allocation
/// per line). The Windows API-level tee has no such capture and relies on this.
#[cfg(not(unix))]
pub fn mirror_console_bytes(text: &str) {
    let plain_text = crate::logging::strip_ansi(text);
    if plain_text.is_empty() {
        return;
    }
    let file = {
        let state = LOG_FILE.lock().unwrap_or_else(|e| e.into_inner());
        match state.as_ref() {
            Some(state) => Some(Arc::clone(&state.file)),
            None => None,
        }
    };
    if let Some(file) = file {
        if let Ok(mut log) = file.lock() {
            let _ = log.write_all(plain_text.as_bytes());
        }
    }
}

/// See the Unix note above: nothing to do, because the tee already captured it.
#[cfg(unix)]
pub fn mirror_console_bytes(_text: &str) {}

/// Flushes pending console output through to its destination and the log file.
pub fn flush_execution_log() {
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    #[cfg(unix)]
    fd_tee::drain();
    let file = {
        let state = LOG_FILE.lock().unwrap_or_else(|e| e.into_inner());
        state.as_ref().map(|s| Arc::clone(&s.file))
    };
    if let Some(file) = file {
        if let Ok(file) = file.lock() {
            let _ = file.sync_data();
        }
    }
}

/// Finalises the execution log: stops the tee, waits for pending output to be
/// mirrored, rewrites the file ANSI-free, and fsyncs it.
///
/// Best-effort, mirroring Node's `close()` semantics.
pub fn close_execution_log() {
    let taken = {
        let mut guard = LOG_FILE.lock().unwrap_or_else(|e| e.into_inner());
        guard.take()
    };
    let Some(state) = taken else {
        return;
    };

    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    #[cfg(unix)]
    fd_tee::uninstall();

    let final_result = state.file.lock().map(|mut file| {
        if let Ok(contents) = std::fs::read_to_string(&state.path) {
            let plain_text = crate::logging::strip_ansi(&contents);
            if plain_text != contents {
                let _ = file.set_len(0);
                let _ = file.seek(std::io::SeekFrom::Start(0));
                let _ = file.write_all(plain_text.as_bytes());
            }
        }
        file.sync_all()
    });
    let _ = final_result;
}

/// Writes every byte of `data` to a raw file descriptor, retrying on `EINTR`.
#[cfg(unix)]
pub fn write_all_fd(fd: i32, mut data: &[u8]) {
    while !data.is_empty() {
        let written = unsafe { libc::write(fd, data.as_ptr() as *const libc::c_void, data.len()) };
        if written < 0 {
            if errno_is_eintr() {
                continue;
            }
            break;
        }
        data = &data[written as usize..];
    }
}

#[cfg(unix)]
fn errno_is_eintr() -> bool {
    unsafe { *libc::__errno_location() == libc::EINTR }
}

// ---------------------------------------------------------------------------
// Unix file-descriptor tee
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod fd_tee {
    use super::*;
    use std::sync::{Condvar, Mutex};

    #[derive(Debug)]
    struct ChannelSync {
        read_fd: i32,
        busy: bool,
        cycles: u64,
    }

    struct SharedSync {
        stdout: Mutex<ChannelSync>,
        stderr: Mutex<ChannelSync>,
        condvar: Condvar,
    }

    struct TeeState {
        saved_stdout: i32,
        saved_stderr: i32,
        readers: Vec<std::thread::JoinHandle<()>>,
        sync: Arc<SharedSync>,
    }

    static TEE: Mutex<Option<TeeState>> = Mutex::new(None);

    pub(super) fn saved_stdout() -> Option<i32> {
        TEE.lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|s| s.saved_stdout)
    }

    pub(super) fn install(log_file: Arc<Mutex<File>>) -> std::io::Result<()> {
        let mut slot = TEE.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            return Ok(());
        }

        let saved_stdout = unsafe { libc::dup(1) };
        if saved_stdout < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let saved_stderr = unsafe { libc::dup(2) };
        if saved_stderr < 0 {
            unsafe { libc::close(saved_stdout) };
            return Err(std::io::Error::last_os_error());
        }

        let mut stdout_pipe = [0i32; 2];
        if unsafe { libc::pipe(stdout_pipe.as_mut_ptr()) } != 0 {
            unsafe {
                libc::close(saved_stdout);
                libc::close(saved_stderr);
            }
            return Err(std::io::Error::last_os_error());
        }
        let mut stderr_pipe = [0i32; 2];
        if unsafe { libc::pipe(stderr_pipe.as_mut_ptr()) } != 0 {
            unsafe {
                libc::close(saved_stdout);
                libc::close(saved_stderr);
                libc::close(stdout_pipe[0]);
                libc::close(stdout_pipe[1]);
            }
            return Err(std::io::Error::last_os_error());
        }

        let redirected = unsafe {
            let stdout_result = libc::dup2(stdout_pipe[1], 1);
            libc::close(stdout_pipe[1]);
            let stderr_result = libc::dup2(stderr_pipe[1], 2);
            libc::close(stderr_pipe[1]);
            stdout_result >= 0 && stderr_result >= 0
        };
        if !redirected {
            let error = std::io::Error::last_os_error();
            unsafe {
                libc::dup2(saved_stdout, 1);
                libc::dup2(saved_stderr, 2);
                libc::close(saved_stdout);
                libc::close(saved_stderr);
                libc::close(stdout_pipe[0]);
                libc::close(stderr_pipe[0]);
            }
            return Err(error);
        }

        let sync = Arc::new(SharedSync {
            stdout: Mutex::new(ChannelSync {
                read_fd: stdout_pipe[0],
                busy: false,
                cycles: 0,
            }),
            stderr: Mutex::new(ChannelSync {
                read_fd: stderr_pipe[0],
                busy: false,
                cycles: 0,
            }),
            condvar: Condvar::new(),
        });
        let readers = vec![
            spawn_reader(
                "stdout",
                stdout_pipe[0],
                saved_stdout,
                Arc::clone(&log_file),
                Arc::clone(&sync),
            ),
            spawn_reader(
                "stderr",
                stderr_pipe[0],
                saved_stderr,
                Arc::clone(&log_file),
                Arc::clone(&sync),
            ),
        ];

        *slot = Some(TeeState {
            saved_stdout,
            saved_stderr,
            readers,
            sync,
        });
        Ok(())
    }

    /// Restores fds 1/2 and joins the reader threads so no chunk is lost.
    pub(super) fn uninstall() {
        let taken = {
            let mut guard = TEE.lock().unwrap_or_else(|e| e.into_inner());
            guard.take()
        };
        let Some(state) = taken else {
            return;
        };

        unsafe {
            libc::dup2(state.saved_stdout, 1);
            libc::dup2(state.saved_stderr, 2);
        }

        // FDs 1 and 2 no longer keep the pipe write ends alive, so readers see
        // EOF and drain. Keep the duplicated destination descriptors open until
        // after that drain: each reader still writes its final chunk through one.
        for reader in state.readers {
            let _ = reader.join();
        }
        unsafe {
            libc::close(state.saved_stdout);
            libc::close(state.saved_stderr);
        }
    }

    /// Blocks until both pipes have been fully consumed by the reader threads.
    pub(super) fn drain() {
        let Some(sync) = TEE
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|s| Arc::clone(&s.sync))
        else {
            return;
        };

        let drain_channel = |channel_name: &str| loop {
            let (read_fd, is_busy) = {
                let chan = if channel_name == "stdout" {
                    sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
                } else {
                    sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
                };
                (chan.read_fd, chan.busy)
            };

            let mut available: libc::c_int = 0;
            let ioctl_res = unsafe { libc::ioctl(read_fd, libc::FIONREAD, &mut available) };
            let has_pending_bytes = ioctl_res == 0 && available > 0;

            if !has_pending_bytes && !is_busy {
                break;
            }

            let chan = if channel_name == "stdout" {
                sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
            } else {
                sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
            };
            let _ = sync
                .condvar
                .wait_timeout(chan, std::time::Duration::from_millis(50));
        };

        drain_channel("stderr");
        drain_channel("stdout");
    }

    fn spawn_reader(
        channel_name: &'static str,
        read_fd: i32,
        mirror_fd: i32,
        file: Arc<Mutex<File>>,
        sync: Arc<SharedSync>,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut pending: Vec<u8> = Vec::with_capacity(16384);
            loop {
                // Signal that we are currently idle and about to block in read()
                {
                    let mut chan = if channel_name == "stdout" {
                        sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
                    } else {
                        sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
                    };
                    chan.busy = false;
                    sync.condvar.notify_all();
                }

                let read = unsafe {
                    libc::read(
                        read_fd,
                        buffer.as_mut_ptr() as *mut libc::c_void,
                        buffer.len(),
                    )
                };
                if read < 0 {
                    if errno_is_eintr() {
                        continue;
                    }
                    break;
                }
                if read == 0 {
                    break;
                }

                // Signal that we are busy processing new bytes
                {
                    let mut chan = if channel_name == "stdout" {
                        sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
                    } else {
                        sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
                    };
                    chan.busy = true;
                }

                pending.extend_from_slice(&buffer[..read as usize]);

                // Check if more data is waiting in the pipe
                let mut available: libc::c_int = 0;
                let ioctl_res = unsafe { libc::ioctl(read_fd, libc::FIONREAD, &mut available) };
                let has_more = ioctl_res == 0 && available > 0;

                let emit_chunk = if has_more && pending.len() < 65536 {
                    if let Some(last_nl) = pending.iter().rposition(|&b| b == b'\n') {
                        let to_emit = pending.drain(..=last_nl).collect::<Vec<u8>>();
                        Some(to_emit)
                    } else {
                        None
                    }
                } else if !pending.is_empty() {
                    Some(std::mem::take(&mut pending))
                } else {
                    None
                };

                if let Some(chunk) = emit_chunk {
                    {
                        let _guard = super::super::console_output::lock_console();
                        write_all_fd(mirror_fd, &chunk);
                    }
                    let plain_text = crate::logging::strip_ansi(&String::from_utf8_lossy(&chunk));
                    if !plain_text.is_empty() {
                        if let Ok(mut log) = file.lock() {
                            let _ = log.write_all(plain_text.as_bytes());
                        }
                    }
                }

                // Processing cycle completed
                {
                    let mut chan = if channel_name == "stdout" {
                        sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
                    } else {
                        sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
                    };
                    chan.cycles += 1;
                    chan.busy = !pending.is_empty();
                    sync.condvar.notify_all();
                }
            }

            if !pending.is_empty() {
                {
                    let _guard = super::super::console_output::lock_console();
                    write_all_fd(mirror_fd, &pending);
                }
                let plain_text = crate::logging::strip_ansi(&String::from_utf8_lossy(&pending));
                if !plain_text.is_empty() {
                    if let Ok(mut log) = file.lock() {
                        let _ = log.write_all(plain_text.as_bytes());
                    }
                }
            }

            unsafe { libc::close(read_fd) };

            let mut chan = if channel_name == "stdout" {
                sync.stdout.lock().unwrap_or_else(|e| e.into_inner())
            } else {
                sync.stderr.lock().unwrap_or_else(|e| e.into_inner())
            };
            chan.busy = false;
            sync.condvar.notify_all();
        })
    }
}

/// Windows has no descriptor tee; the log file alone is the destination.
#[cfg(not(unix))]
mod fd_tee {
    use super::*;

    pub(super) fn install(_log_file: Arc<Mutex<File>>) -> std::io::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_identifier_uses_first_positional_argument() {
        let args: Vec<String> = ["--json", "run-pipeline", "--batch", "10"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(command_identifier(&args), "run-pipeline");
    }

    #[test]
    fn command_identifier_falls_back_when_only_flags() {
        let args: Vec<String> = ["--json", "--verbose"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(command_identifier(&args), "cli");
    }

    #[test]
    fn safe_identifier_strips_separators_and_edges() {
        assert_eq!(safe_identifier("Run Pipeline!"), "run-pipeline");
        assert_eq!(safe_identifier("  --x--  "), "x");
        assert_eq!(safe_identifier("!!!"), "command");
    }
}
