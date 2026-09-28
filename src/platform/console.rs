//! Console capability detection and virtual-terminal enablement.
//!
//! Unix uses `isatty`; Windows uses `GetConsoleMode`, which succeeds only for
//! real console handles and therefore doubles as the "is a terminal" test.
//!
//! Windows also needs `ENABLE_VIRTUAL_TERMINAL_PROCESSING` turned on before
//! any ANSI escape sequence is meaningful. [`try_enable_virtual_terminal`] is
//! called once during startup; if it fails the caller must fall back to
//! uncolored output rather than emitting escapes that would print literally.

#[cfg(windows)]
use windows_sys::Win32::Foundation::HANDLE;
#[cfg(windows)]
use windows_sys::Win32::System::Console::{
    GetConsoleMode, GetStdHandle, SetConsoleMode, STD_OUTPUT_HANDLE,
};

/// Current console mode for `which`, or `None` when the handle is not a
/// console (redirected to a file or pipe, or no console attached at all).
#[cfg(windows)]
pub fn console_mode(which: u32) -> Option<u32> {
    let handle = unsafe { GetStdHandle(which) };
    if !is_valid_handle(handle) {
        return None;
    }
    let mut mode: u32 = 0;
    if unsafe { GetConsoleMode(handle, &mut mode) } == 0 {
        return None;
    }
    Some(mode)
}

/// `GetStdHandle` returns NULL or INVALID_HANDLE_VALUE on failure.
#[cfg(windows)]
fn is_valid_handle(handle: HANDLE) -> bool {
    !handle.is_null() && handle as isize != -1
}

/// Whether the process' standard output is attached to a terminal.
#[cfg(unix)]
pub fn is_stdout_terminal_raw() -> bool {
    unsafe { libc::isatty(libc::STDOUT_FILENO) == 1 }
}

/// Whether the process' standard output is attached to a terminal.
#[cfg(windows)]
pub fn is_stdout_terminal_raw() -> bool {
    console_mode(STD_OUTPUT_HANDLE).is_some()
}

/// Enables ANSI / virtual-terminal processing for this process' console.
///
/// Returns `true` when escape sequences will be interpreted. `false` means the
/// caller must disable colour output: on a legacy console host the sequences
/// would otherwise appear as literal text.
#[cfg(unix)]
pub fn try_enable_virtual_terminal() -> bool {
    // ANSI needs no enabling on Unix; an isatty is still required to be useful.
    is_stdout_terminal_raw()
}

/// Enables ANSI / virtual-terminal processing for this process' console.
#[cfg(windows)]
pub fn try_enable_virtual_terminal() -> bool {
    use windows_sys::Win32::System::Console::ENABLE_VIRTUAL_TERMINAL_PROCESSING;
    let Some(mode) = console_mode(STD_OUTPUT_HANDLE) else {
        return false;
    };
    if mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 {
        return true;
    }
    let handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    if !is_valid_handle(handle) {
        return false;
    }
    unsafe { SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0 }
}
