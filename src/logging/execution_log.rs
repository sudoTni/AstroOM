//! Execution log tee. Port of AstroEX-node src/logging/executionLog.ts.
//!
//! Mirrors stdout and stderr to one execution-scoped, ANSI-free file without
//! changing the bytes seen by either console stream. Unlike Node (which wraps
//! the stream write methods), the Rust port redirects file descriptors 1 and 2
//! through pipes and forwards every chunk both to the saved original
//! descriptors (with ANSI intact) and to the log file (ANSI-stripped).

use std::fs::{File, OpenOptions};
use std::io::{Seek, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

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

struct ExecutionLogState {
    path: PathBuf,
    file: Arc<Mutex<File>>,
    saved_stdout: i32,
    saved_stderr: i32,
    readers: Vec<std::thread::JoinHandle<()>>,
    sync: Arc<SharedSync>,
}

static STATE: Mutex<Option<ExecutionLogState>> = Mutex::new(None);

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

/// Creates the execution log directory (plus the four payload log
/// subdirectories), creates the execution-scoped log file, and installs the
/// stdout/stderr tee. Idempotent: a second call is a no-op.
pub fn initialize_execution_log(log_dir: &Path, args: &[String]) -> std::io::Result<()> {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if state.is_some() {
        return Ok(());
    }

    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(log_dir)?;
    for subdirectory in super::payload_logs::LLM_PAYLOAD_LOG_DIRECTORIES {
        builder.create(log_dir.join(subdirectory))?;
    }

    let file_name = format!(
        "astroom_{}_{}_p{}_{}.log",
        command_identifier(args),
        timestamp_for_file(),
        std::process::id(),
        uuid::Uuid::new_v4()
    );
    let file_path = log_dir.join(file_name);
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&file_path)?;

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

    let shared_file = Arc::new(Mutex::new(file));
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
            Arc::clone(&shared_file),
            Arc::clone(&sync),
        ),
        spawn_reader(
            "stderr",
            stderr_pipe[0],
            saved_stderr,
            Arc::clone(&shared_file),
            Arc::clone(&sync),
        ),
    ];

    *state = Some(ExecutionLogState {
        path: file_path,
        file: shared_file,
        saved_stdout,
        saved_stderr,
        readers,
        sync,
    });
    Ok(())
}

/// Returns whether the process stdout is connected to a terminal, taking
/// into account whether the execution log tee is active (checking saved_stdout).
pub fn is_stdout_terminal() -> bool {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(state) = state.as_ref() {
        unsafe { libc::isatty(state.saved_stdout) == 1 }
    } else {
        std::io::IsTerminal::is_terminal(&std::io::stdout())
    }
}

/// Returns whether the execution log tee is currently active.
pub fn is_tee_active() -> bool {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    state.is_some()
}

/// Returns the saved stdout file descriptor if the execution log tee is active.
pub fn get_saved_stdout() -> Option<i32> {
    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    state.as_ref().map(|s| s.saved_stdout)
}

/// Returns the current execution log file path, if the tee is active.
pub fn execution_log_path() -> Option<PathBuf> {
    STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|state| state.path.clone())
}

/// Restores the original stdout/stderr descriptors, waits for the reader
/// threads to drain, then re-writes the file ANSI-stripped and fsyncs it.
/// Best-effort, mirroring Node's close() semantics.
pub fn close_execution_log() {
    let mut state_guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let mut state = match state_guard.take() {
        Some(state) => state,
        None => return,
    };

    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();

    unsafe {
        libc::dup2(state.saved_stdout, 1);
        libc::dup2(state.saved_stderr, 2);
    }

    // FDs 1 and 2 no longer keep the pipe write ends alive, so readers see
    // EOF and drain. Keep the duplicated destination descriptors open until
    // after that drain: each reader still writes its final chunk through one.
    for reader in state.readers.drain(..) {
        let _ = reader.join();
    }
    unsafe {
        libc::close(state.saved_stdout);
        libc::close(state.saved_stderr);
    }

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

/// Flushes stdout and stderr through to their original destinations and the
/// execution log file, blocking until all pending output from both pipes has
/// been completely processed by the background reader threads.
pub fn flush_execution_log() {
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();

    let sync = {
        let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
        match state.as_ref() {
            Some(s) => Arc::clone(&s.sync),
            None => return,
        }
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

    let state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = state.as_ref() {
        if let Ok(file) = s.file.lock() {
            let _ = file.sync_data();
        }
    }
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
            // Signal that we are currently idle and about to block in libc::read
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
                    let _guard = crate::logging::console_output::lock_console();
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
                let _guard = crate::logging::console_output::lock_console();
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

fn errno_is_eintr() -> bool {
    unsafe { *libc::__errno_location() == libc::EINTR }
}

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
