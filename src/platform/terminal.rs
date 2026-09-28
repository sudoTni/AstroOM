//! Terminal geometry and capabilities.
//!
//! Unix uses `TIOCGWINSZ`; Windows uses `GetConsoleScreenBufferInfo` on the
//! standard output handle. Both return `None` when the stream is not a
//! terminal, which the banner renderer already treats as "fall back to a
//! static frame".

/// Minimum terminal size accepted before the animated banner is drawn.
pub const MIN_BANNER_ROWS: u16 = 10;
/// Minimum terminal width accepted before the animated banner is drawn.
pub const MIN_BANNER_COLS: u16 = 64;

/// `(rows, cols)` of the controlling terminal, or `None` when there is none.
///
/// `console_fd` overrides which descriptor to interrogate. This matters
/// because AstroOM's execution log redirects file descriptors 1 and 2 through
/// pipes: after that redirect, `TIOCGWINSZ` on fd 1 returns `ENOTTY` and the
/// size looks unavailable. Callers pass the descriptor saved before the
/// redirect (see `logging::execution_log::console_stdout_fd`).
pub fn terminal_size(console_fd: Option<i32>) -> Option<(u16, u16)> {
    #[cfg(unix)]
    {
        unix_terminal_size(console_fd)
    }
    #[cfg(windows)]
    {
        let _ = console_fd;
        windows_terminal_size()
    }
}

#[cfg(unix)]
fn unix_terminal_size(console_fd: Option<i32>) -> Option<(u16, u16)> {
    use std::os::raw::c_int;

    fn query(fd: c_int) -> Option<(u16, u16)> {
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) } != 0 {
            return None;
        }
        if ws.ws_row > 0 && ws.ws_col > 0 {
            Some((ws.ws_row, ws.ws_col))
        } else {
            None
        }
    }

    // Prefer the caller's saved descriptor, then stdout, then stderr, so the
    // size is still discovered when only one of the streams is a terminal.
    console_fd
        .and_then(query)
        .or_else(|| query(libc::STDOUT_FILENO))
        .or_else(|| query(libc::STDERR_FILENO))
}

#[cfg(windows)]
fn windows_terminal_size() -> Option<(u16, u16)> {
    use windows_sys::Win32::System::Console::{
        GetConsoleScreenBufferInfo, GetStdHandle, CONSOLE_SCREEN_BUFFER_INFO, STD_OUTPUT_HANDLE,
    };
    // A redirected handle has no console screen buffer to describe.
    super::console::console_mode(STD_OUTPUT_HANDLE)?;
    let handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
    if unsafe { GetConsoleScreenBufferInfo(handle, &mut info) } == 0 {
        return None;
    }
    // Rows below the cursor are the usable window; the rest of the buffer is
    // scrollback the terminal will replay.
    let rows = i32::from(info.dwSize.Y) - i32::from(info.dwCursorPosition.Y);
    let cols = i32::from(info.dwSize.X);
    if rows <= 0 || cols <= 0 {
        return None;
    }
    Some((rows as u16, cols as u16))
}
