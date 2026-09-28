//! Persistent animated banner footer (Unix terminals with a scrolling region).
//!
//! # Why a scrolling region and not a full-screen TUI
//!
//! The requirement is two panes *and* complete terminal history. Those pull in
//! opposite directions for every screen-buffer-based design: the alternate
//! screen buffer (`ESC[?1049h`, which is what ratatui/crossterm and every
//! conventional TUI uses) has **no** scrollback, and everything printed on it
//! is discarded on exit. A design that "produces two panes" by entering the
//! alternate screen therefore fails the history requirement.
//!
//! DECSTBM (`ESC[{top};{bottom}r`) splits the *screen* without touching the
//! *history*. Setting the scroll region to rows `1..=app_bottom` and painting
//! the banner into the rows below it means:
//!
//! * application output written at the cursor scrolls the region up and pushes
//!   the top line into the terminal's native scrollback buffer, exactly like
//!   ordinary output — so the user can scroll back to the very first line;
//! * the banner is outside the region, so it is never scrolled away and never
//!   overwrites history.
//!
//! # Platform scope
//!
//! Unix only, and only when the terminal actually supports the sequences. See
//! [`is_supported`] for the capability gate. Windows is deliberately excluded:
//! legacy conhost either ignores DECSTBM or leaves the region set after the
//! process exits, which is exactly the "user's terminal is left broken"
//! failure mode to avoid. Windows keeps the existing bounded in-place banner.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use super::console_output;
use crate::utils::{render_strike_frame_custom, ASTRO_LOGO_RAW};

/// Rows reserved for the footer when the terminal is tall enough.
const FULL_FOOTER_ROWS: u16 = ASTRO_LOGO_RAW.len() as u16;
/// Rows reserved on a short terminal, where a 9-row footer would be unusable.
const COMPACT_FOOTER_ROWS: u16 = 1;
/// Below this many rows the full logo footer is not drawn.
const MIN_ROWS_FOR_FULL_FOOTER: u16 = 30;
/// Minimum usable width for the full logo footer.
const MIN_COLS_FOR_FOOTER: u16 = 64;
/// Frame interval for the animated footer.
const FRAME_INTERVAL: Duration = Duration::from_millis(1000 / 30);

// --- terminal control sequences ------------------------------------------

const HIDE_CURSOR: &str = "\x1b[?25l";
const SHOW_CURSOR: &str = "\x1b[?25h";
const SAVE_CURSOR: &str = "\x1b7";
const RESTORE_CURSOR: &str = "\x1b8";
/// Erase from the cursor to the end of the current line (EL 0).
///
/// Per-line `EL` is used rather than a single erase-to-end-of-display (`ED 0`)
/// because `ED`'s interaction with an active scrolling region is not portable:
/// xterm, VTE and Windows Terminal erase to the end of the whole display,
/// while other emulators confine the erase to the scroll region. With a
/// permanent footer that difference decides whether stale frames accumulate
/// below the region. `EL 0` has the same meaning everywhere.
const ERASE_TO_END_OF_LINE: &str = "\x1b[K";

/// Erase from the cursor to the end of the display (ED 0).
///
/// Only used during teardown, *after* the scrolling region has been reset,
/// where every terminal agrees on its scope. While a region is still active
/// the scope is implementation-defined, which is why the animation uses
/// per-line [`ERASE_TO_END_OF_LINE`] instead.
const ERASE_TO_END_OF_DISPLAY: &str = "\x1b[0J";
const RESET_SCROLL_REGION: &str = "\x1b[r";

fn set_scroll_region(bottom: u16) -> String {
    format!("\x1b[1;{bottom}r")
}

fn move_to(row: u16, column: u16) -> String {
    format!("\x1b[{row};{column}H")
}

// --- capability gate -----------------------------------------------------

/// Why the footer is or is not available, for diagnostics and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    Supported,
    /// Not an interactive terminal: redirected, piped, or run from CI.
    NotATerminal,
    /// `TERM` unset or `dumb`, or `NO_COLOR`/`CI` set.
    TerminalDeclines,
    /// Interactive, but too small to hold a usable footer.
    TooSmall,
    /// A `DisplayConfig` rule suppressed the banner outright.
    Suppressed,
}

/// The environment facts the footer gate needs, gathered once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalEnvironment {
    pub is_terminal: bool,
    pub size: Option<(u16, u16)>,
    /// `TERM` is set and is not `dumb`.
    pub term_usable: bool,
    /// `NO_COLOR` or `CI` is set.
    pub declines: bool,
}

impl TerminalEnvironment {
    /// Reads the current process environment and terminal geometry.
    pub fn detect() -> Self {
        let term = std::env::var_os("TERM");
        let term_usable = match term.as_deref() {
            None => false,
            Some(value) => value != "dumb",
        };
        Self {
            is_terminal: super::execution_log::is_stdout_terminal(),
            size: crate::platform::terminal_size(super::execution_log::console_stdout_fd()),
            term_usable,
            declines: std::env::var_os("NO_COLOR").is_some() || std::env::var_os("CI").is_some(),
        }
    }
}

/// Whether the terminal can host a persistent animated footer.
///
/// This is deliberately stricter than the existing in-place banner check: a
/// permanent footer occupies the screen for the whole run, so the bar for
/// enabling it is higher than for a 9-line intro flourish. Kept pure so the
/// decision table is testable without a real terminal.
pub fn evaluate_support(use_color: bool, environment: TerminalEnvironment) -> Support {
    if !use_color {
        return Support::Suppressed;
    }
    if !environment.is_terminal {
        return Support::NotATerminal;
    }
    // The footer emits a continuous stream of cursor-control sequences, so it
    // must not run where those would land in a file or a pipe, or where the
    // terminal has declared itself incapable of them.
    if !environment.term_usable || environment.declines {
        return Support::TerminalDeclines;
    }
    match environment.size {
        None => Support::NotATerminal,
        Some((rows, cols)) if rows < MIN_ROWS_FOR_FULL_FOOTER || cols < MIN_COLS_FOR_FOOTER => {
            Support::TooSmall
        }
        Some(_) => Support::Supported,
    }
}

/// Convenience wrapper used at startup.
pub fn is_supported(use_color: bool) -> bool {
    evaluate_support(use_color, TerminalEnvironment::detect()) == Support::Supported
}

// --- footer state --------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Layout {
    Full,
    Compact,
}

#[derive(Clone, Copy)]
struct FooterState {
    /// Last row of the application scroll region.
    app_bottom: u16,
    /// First row of the footer.
    footer_top: u16,
    layout: Layout,
}

static STATE: OnceLock<Mutex<Option<FooterState>>> = OnceLock::new();
static RUNNING: AtomicBool = AtomicBool::new(false);

fn state() -> &'static Mutex<Option<FooterState>> {
    STATE.get_or_init(|| Mutex::new(None))
}

/// Restores the terminal on drop, on every exit path including a panic.
pub struct FooterGuard {
    installed: bool,
}

impl FooterGuard {
    /// A guard that owns no terminal state: used for the suppressed-banner and
    /// non-Unix paths, where `Drop` must be a no-op.
    pub fn disabled() -> Self {
        Self { installed: false }
    }
}

impl Drop for FooterGuard {
    fn drop(&mut self) {
        if self.installed {
            uninstall();
        }
    }
}

/// Installs the scrolling region, draws the first footer frame, and starts the
/// animation thread.
///
/// Returns a guard even when the footer is unavailable, so the caller's exit
/// path needs no conditional cleanup.
pub fn install(use_color: bool) -> FooterGuard {
    if !is_supported(use_color) {
        return FooterGuard { installed: false };
    }
    match install_inner() {
        Ok(()) => {
            spawn_animation_thread();
            FooterGuard { installed: true }
        }
        Err(error) => {
            crate::logging::debug(
                "AstroOM",
                &format!("Persistent banner footer unavailable: {error}"),
            );
            FooterGuard { installed: false }
        }
    }
}

fn install_inner() -> std::io::Result<()> {
    let Some((rows, _cols)) = current_terminal_size() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "terminal size unavailable",
        ));
    };
    let layout = if rows >= MIN_ROWS_FOR_FULL_FOOTER {
        Layout::Full
    } else {
        Layout::Compact
    };
    let footer_rows = match layout {
        Layout::Full => FULL_FOOTER_ROWS,
        Layout::Compact => COMPACT_FOOTER_ROWS,
    };
    if rows <= footer_rows {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "terminal too short for a footer",
        ));
    }
    let app_bottom = rows - footer_rows;
    let footer_top = app_bottom + 1;
    write_stdout(&install_sequence(app_bottom, footer_top, layout))?;

    *state().lock().unwrap_or_else(|e| e.into_inner()) = Some(FooterState {
        app_bottom,
        footer_top,
        layout,
    });
    Ok(())
}

/// The full install sequence, as a pure function so its ordering can be tested.
///
/// The order is load-bearing, and getting it wrong is subtle but total:
///
/// 1. hide the cursor;
/// 2. confine scrolling to the application region;
/// 3. draw the footer — which leaves the cursor at the **bottom of the
///    screen**, outside that region;
/// 4. park the cursor back inside the region.
///
/// Omitting step 4 is what makes application output appear beside the banner
/// instead of scrolling above it: the cursor sits on the last screen row, so
/// the linefeed at the bottom scrolls the **whole screen** rather than the
/// region, dragging the banner out of its footer.
///
/// Step 4 parks the cursor on the region's **last** line, not its first. That
/// anchors output to the bottom: the first line written lands directly above
/// the banner and every subsequent line pushes the previous ones upward and
/// out into the terminal's native scrollback. Parking at the top instead would
/// make output appear to grow *downward* from the top of the frame, which
/// reads as a separate console pane rather than a live log.
fn install_sequence(app_bottom: u16, footer_top: u16, layout: Layout) -> String {
    let mut sequence = String::new();
    sequence.push_str(HIDE_CURSOR);
    sequence.push_str(&set_scroll_region(app_bottom));
    sequence.push_str(&draw_footer(layout, footer_top, 0.0));
    sequence.push_str(&move_to(app_bottom, 1));
    sequence
}

/// Restores the full-screen scroll region, the cursor, and the saved position.
pub fn uninstall() {
    let taken = {
        let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
        RUNNING.store(false, Ordering::SeqCst);
        guard.take()
    };
    let Some(previous) = taken else {
        return;
    };
    let _ = write_stdout(&uninstall_sequence(&previous));
}

/// The teardown sequence, as a pure function so its ordering can be tested.
///
/// The banner is transient chrome, so it is erased rather than left on screen:
/// otherwise the user's shell prompt would appear *above* a stray logo that
/// then scrolls away as they type. The cursor is positioned explicitly rather
/// than restored, because `install` never issued a save and a stale restore
/// would jump it somewhere unexpected.
fn uninstall_sequence(previous: &FooterState) -> String {
    let mut sequence = String::new();
    // Reset the scrolling region *first*. That matters for the erase that
    // follows: with no region set, an erase-to-end-of-display is unambiguous on
    // every terminal, whereas while a region is active some emulators confine
    // it to that region. The reset also comes first so a terminal that applies
    // it lazily cannot leave a region behind on exit.
    sequence.push_str(RESET_SCROLL_REGION);
    // Erase the banner: it is transient chrome, and leaving it would put the
    // user's shell prompt above a stray logo that scrolls away as they type.
    //
    // No line feeds are emitted, so this cannot scroll the screen even if the
    // terminal was resized smaller while AstroOM was running.
    sequence.push_str(&move_to(previous.footer_top, 1));
    sequence.push_str(ERASE_TO_END_OF_DISPLAY);
    // Park the cursor where the log output ended, then hand the terminal back.
    sequence.push_str(&move_to(previous.app_bottom, 1));
    sequence.push_str(SHOW_CURSOR);
    sequence
}

/// Repaints after the terminal geometry changed.
///
/// Two things have to be handled, and both were bugs first:
///
/// * **The old footer area is erased.** Growing the window leaves the previous
///   banner stranded on rows the new footer no longer occupies; shrinking it
///   leaves stale log text beside the relocated banner. Clearing from the
///   higher of the two footer positions covers both directions.
/// * **The cursor is re-anchored to the bottom of the new region.** `DECSTBM`
///   moves the cursor to the home position (row 1), so bracketing the repaint
///   with save/restore would capture row 1 and restore it — leaving the banner
///   pinned while application output silently reverts to growing downward from
///   the top. The pre-resize cursor position is meaningless anyway, since the
///   terminal has just reflowed.
///
/// The erase runs *after* resetting the scroll region, so no margins are
/// active and its scope is unambiguous on every terminal.
fn resize_sequence(current: &FooterState, desired: &FooterState, time_sec: f64) -> String {
    let clear_top = current.footer_top.min(desired.footer_top);
    let mut sequence = String::new();
    sequence.push_str(RESET_SCROLL_REGION);
    sequence.push_str(&move_to(clear_top, 1));
    sequence.push_str(ERASE_TO_END_OF_DISPLAY);
    sequence.push_str(&set_scroll_region(desired.app_bottom));
    sequence.push_str(&draw_footer(desired.layout, desired.footer_top, time_sec));
    // Park the cursor last. Drawing the footer leaves it at the end of the
    // footer's final row, which is outside the region; without this the next
    // application line would be written into the banner. The steady-state
    // path gets this from the save/restore bracket instead, which is why the
    // asymmetry here is easy to miss.
    sequence.push_str(&move_to(desired.app_bottom, 1));
    sequence
}

fn current_terminal_size() -> Option<(u16, u16)> {
    crate::platform::terminal_size(super::execution_log::console_stdout_fd())
}

fn spawn_animation_thread() {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("astroom-banner".to_string())
        .spawn(|| {
            let start = Instant::now();
            loop {
                if !RUNNING.load(Ordering::SeqCst) {
                    return;
                }
                let elapsed = start.elapsed().as_secs_f64();
                repaint(elapsed);
                std::thread::sleep(FRAME_INTERVAL);
            }
        })
        .ok();
}

/// Re-evaluates the layout for a resize and repaints. Cheap and side-effect
/// free when the footer is not installed.
pub fn repaint(time_sec: f64) {
    let current = {
        let guard = state().lock().unwrap_or_else(|e| e.into_inner());
        *guard
    };
    let Some(current) = current else {
        return;
    };

    let desired = current_terminal_size().and_then(|(rows, cols)| {
        if cols < MIN_COLS_FOR_FOOTER || rows <= FULL_FOOTER_ROWS {
            return None;
        }
        let layout = if rows >= MIN_ROWS_FOR_FULL_FOOTER {
            Layout::Full
        } else {
            Layout::Compact
        };
        let footer_rows = match layout {
            Layout::Full => FULL_FOOTER_ROWS,
            Layout::Compact => COMPACT_FOOTER_ROWS,
        };
        Some(FooterState {
            app_bottom: rows - footer_rows,
            footer_top: rows - footer_rows + 1,
            layout,
        })
    });

    let Some(desired) = desired else {
        // Too small to keep a footer: restore the terminal and let the plain
        // output path continue.
        uninstall();
        return;
    };

    let resized = desired.app_bottom != current.app_bottom || desired.layout != current.layout;
    let sequence = if resized {
        *state().lock().unwrap_or_else(|e| e.into_inner()) = Some(desired);
        resize_sequence(&current, &desired, time_sec)
    } else {
        // Steady state: bracket the footer write so the animation never
        // disturbs the application's cursor position.
        let mut sequence = String::new();
        sequence.push_str(SAVE_CURSOR);
        sequence.push_str(&draw_footer(desired.layout, desired.footer_top, time_sec));
        sequence.push_str(RESTORE_CURSOR);
        sequence
    };
    let _ = write_stdout(&sequence);
}

/// Renders the footer frame, positioned at `top`.
///
/// `time_sec` drives the same wave equation the startup banner uses, so the
/// footer animates identically to the intro animation rather than being a
/// different-looking effect.
///
/// The frame must **not** end with a newline. The footer occupies the last rows
/// of the screen, so a trailing linefeed lands the cursor on the bottom row —
/// outside the scroll region, where a further linefeed scrolls the entire
/// screen and tears the banner out of its footer. Each frame therefore ends
/// with the last glyph, and the cursor is repositioned explicitly.
fn draw_footer(layout: Layout, top: u16, time_sec: f64) -> String {
    // The frame is emitted one row at a time, each terminated by `EL 0` before
    // the line feed, so no stale pixels survive to the right of the logo and no
    // dependence is placed on how a terminal scopes an erase relative to the
    // scrolling region. The final row deliberately has **no** trailing newline:
    // the footer occupies the last rows of the screen, and a linefeed there
    // would scroll the whole screen rather than the application region.
    let rows: Vec<String> = match layout {
        Layout::Full => render_strike_frame_custom(
            false,
            time_sec,
            0.08 * (time_sec * 2.5).sin(),
            0.92 + 0.08 * (time_sec * 3.2).sin(),
            0.22,
        )
        .trim_end_matches('\n')
        .split('\n')
        .map(str::to_owned)
        .collect(),
        Layout::Compact => vec![format!("  ASTROOM {}", crate::constants::APP_VERSION)],
    };

    let mut sequence = String::new();
    sequence.push_str(&move_to(top, 1));
    let last = rows.len().saturating_sub(1);
    for (index, row) in rows.iter().enumerate() {
        sequence.push_str(row.trim_end_matches('\r'));
        sequence.push_str(ERASE_TO_END_OF_LINE);
        if index != last {
            sequence.push('\n');
        }
    }
    sequence
}

fn write_stdout(text: &str) -> std::io::Result<()> {
    console_output::write_console_fragment(text);
    std::io::stdout().flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scroll_region_and_cursor_sequences_are_well_formed() {
        assert_eq!(set_scroll_region(20), "\x1b[1;20r");
        assert_eq!(move_to(3, 1), "\x1b[3;1H");
        assert_eq!(RESET_SCROLL_REGION, "\x1b[r");
    }

    // --- Protocol invariants -------------------------------------------------
    //
    // These guard the exact failure reported from a live terminal: application
    // output appearing beside the banner instead of scrolling above it. That
    // happens if the cursor is left below the scroll region, or if the footer
    // frame ends with a newline (which scrolls the whole screen instead of the
    // region). Both are invisible in unit tests and obvious on screen, so they
    // are pinned here.

    #[test]
    fn install_sequence_anchors_the_cursor_to_the_bottom_of_the_region() {
        let app_bottom = 31u16;
        let footer_top = 32u16;
        for layout in [Layout::Full, Layout::Compact] {
            let sequence = install_sequence(app_bottom, footer_top, layout);
            // Bottom-anchored, not top-anchored: output must appear directly
            // above the banner and push older lines upward into scrollback.
            assert!(
                sequence.ends_with(&move_to(app_bottom, 1)),
                "{layout:?}: install must park the cursor on the region's last line, got {sequence:?}"
            );
            let region_at = sequence
                .find(&set_scroll_region(app_bottom))
                .expect("scroll region set");
            let park_at = sequence
                .find(&move_to(app_bottom, 1))
                .expect("cursor parked");
            assert!(
                region_at < park_at,
                "{layout:?}: the scroll region must be set before the cursor is parked"
            );
            assert!(
                !sequence.ends_with(&move_to(1, 1)),
                "{layout:?}: parking at the top makes output grow downward from the frame top"
            );
        }
    }

    #[test]
    fn the_parked_cursor_row_is_inside_the_region_for_any_geometry() {
        // The park row and the scroll region must stay consistent as the
        // terminal is resized, or output would land outside the region and
        // scroll the whole screen.
        for rows in [MIN_ROWS_FOR_FULL_FOOTER, 31, 40, 60, 200] {
            for (footer_rows, expected_bottom) in [
                (FULL_FOOTER_ROWS, rows - FULL_FOOTER_ROWS),
                (COMPACT_FOOTER_ROWS, rows - COMPACT_FOOTER_ROWS),
            ] {
                assert_eq!(expected_bottom, rows - footer_rows);
                assert!(
                    expected_bottom < rows,
                    "the region must leave room for the footer"
                );
            }
        }
    }

    #[test]
    fn the_footer_frame_never_ends_with_a_newline() {
        // A linefeed on the last screen row scrolls the whole screen, not the
        // region, which tears the banner out of its footer.
        for layout in [Layout::Full, Layout::Compact] {
            let frame = draw_footer(layout, 32, 0.0);
            assert!(
                !frame.ends_with('\n'),
                "{layout:?}: footer frame must not end with a newline: {frame:?}"
            );
            assert!(
                !frame.trim_end().ends_with('\n'),
                "{layout:?}: no trailing newline after trimming either"
            );
        }
    }

    #[test]
    fn every_footer_row_is_cleared_individually() {
        // Per-line EL is used rather than one erase-to-end-of-display, because
        // how a terminal scopes an erase relative to an active scrolling region
        // is not portable. The logo is narrower than the terminal, so a stale
        // frame would otherwise persist to the right of the glyphs.
        for (layout, expected_rows) in [
            (Layout::Full, FULL_FOOTER_ROWS as usize),
            (Layout::Compact, 1),
        ] {
            let frame = draw_footer(layout, 32, 0.0);
            assert_eq!(
                frame.matches(ERASE_TO_END_OF_LINE).count(),
                expected_rows,
                "{layout:?}: every footer row needs its own erase"
            );
            assert_eq!(
                frame.matches('\n').count(),
                expected_rows - 1,
                "{layout:?}: one line feed between rows, none after the last"
            );
        }
    }

    #[test]
    fn repaint_saves_and_restores_the_cursor_around_the_footer() {
        // Without DECSC/DECRC the animation would leave the cursor in the
        // footer and the next application line would be written down there.
        let mut sequence = String::new();
        sequence.push_str(SAVE_CURSOR);
        sequence.push_str(&draw_footer(Layout::Full, 32, 0.0));
        sequence.push_str(RESTORE_CURSOR);
        assert!(sequence.starts_with(SAVE_CURSOR));
        assert!(sequence.ends_with(RESTORE_CURSOR));
        let save_at = sequence.find(SAVE_CURSOR).expect("save emitted");
        let restore_at = sequence.find(RESTORE_CURSOR).expect("restore emitted");
        assert!(save_at < restore_at, "save must precede restore");
    }

    #[test]
    fn uninstall_erases_the_footer_and_restores_a_usable_terminal() {
        for layout in [Layout::Full, Layout::Compact] {
            let previous = FooterState {
                app_bottom: 31,
                footer_top: 32,
                layout,
            };
            let sequence = uninstall_sequence(&previous);
            assert!(
                sequence.starts_with(RESET_SCROLL_REGION),
                "{layout:?}: the scroll region must be reset first"
            );
            assert!(
                sequence.ends_with(SHOW_CURSOR),
                "{layout:?}: the cursor must be made visible again"
            );
            assert!(
                sequence.contains(&move_to(previous.app_bottom, 1)),
                "{layout:?}: the cursor must return to the end of the log output"
            );
            let region_at = sequence.find(RESET_SCROLL_REGION).expect("region reset");
            let erase_at = sequence
                .find(ERASE_TO_END_OF_DISPLAY)
                .expect("footer erased");
            assert!(
                region_at < erase_at,
                "{layout:?}: the region must be reset before the erase, or the erase scope is undefined"
            );
            assert_eq!(
                sequence.matches(ERASE_TO_END_OF_LINE).count(),
                0,
                "{layout:?}: teardown must not rely on per-line erases"
            );
            assert!(
                !sequence.contains('\n'),
                "{layout:?}: teardown must emit no line feeds, so it cannot scroll the screen"
            );
        }
    }

    #[test]
    fn resize_sequence_parks_the_cursor_in_the_region_after_drawing() {
        // Drawing the footer leaves the cursor at the end of the footer's last
        // row, which is outside the region. The park must therefore come last,
        // or the next application line is written into the banner.
        for layout in [Layout::Full, Layout::Compact] {
            let current = FooterState {
                app_bottom: 31,
                footer_top: 32,
                layout,
            };
            let desired = FooterState {
                app_bottom: 41,
                footer_top: 42,
                layout,
            };
            let sequence = resize_sequence(&current, &desired, 0.0);
            assert!(
                sequence.ends_with(&move_to(desired.app_bottom, 1)),
                "{layout:?}: the resize sequence must end by parking the cursor in the region"
            );
            let draw_at = sequence
                .find(&move_to(desired.footer_top, 1))
                .expect("footer drawn");
            let park_at = sequence
                .find(&move_to(desired.app_bottom, 1))
                .expect("cursor parked");
            assert!(
                draw_at < park_at,
                "{layout:?}: the cursor must be parked after the footer is drawn, not before"
            );
            assert!(
                !sequence.contains(SAVE_CURSOR) && !sequence.contains(RESTORE_CURSOR),
                "{layout:?}: the resize path must not save/restore, or the park would be undone"
            );
            let region_at = sequence.find(RESET_SCROLL_REGION).expect("region reset");
            let set_at = sequence
                .find(&set_scroll_region(desired.app_bottom))
                .expect("region set");
            let erase_at = sequence
                .find(ERASE_TO_END_OF_DISPLAY)
                .expect("stale footer erased");
            assert!(
                region_at < erase_at && erase_at < set_at,
                "{layout:?}: reset, then erase the old footer, then set the new region"
            );
        }
    }

    /// The resize must clear whichever of the two footer positions is higher,
    /// so a grown window does not strand the old banner and a shrunken one does
    /// not leave stale log text beside the relocated banner.
    #[test]
    fn resize_clears_from_the_higher_of_the_two_footer_positions() {
        let full = FooterState {
            app_bottom: 31,
            footer_top: 32,
            layout: Layout::Full,
        };
        let grown = FooterState {
            app_bottom: 41,
            footer_top: 42,
            layout: Layout::Full,
        };
        let shrink = FooterState {
            app_bottom: 21,
            footer_top: 22,
            layout: Layout::Full,
        };
        for (current, desired) in [(full, grown), (full, shrink)] {
            let sequence = resize_sequence(&current, &desired, 0.0);
            let clear_top = current.footer_top.min(desired.footer_top);
            assert!(
                sequence.contains(&move_to(clear_top, 1)),
                "clearing must start at row {clear_top} when the footer moves \
                 from {} to {}",
                current.footer_top,
                desired.footer_top
            );
        }
    }

    #[test]
    fn compact_layout_reserves_a_single_row() {
        let sequence = draw_footer(Layout::Compact, 24, 0.0);
        assert!(sequence.starts_with("\x1b[24;1H"));
        assert!(sequence.contains("ASTROOM"));
        assert!(sequence.contains(crate::constants::APP_VERSION));
    }

    #[test]
    fn full_footer_is_nine_rows_tall() {
        assert_eq!(FULL_FOOTER_ROWS, 9);
    }

    fn env(
        is_terminal: bool,
        size: Option<(u16, u16)>,
        term_usable: bool,
        declines: bool,
    ) -> TerminalEnvironment {
        TerminalEnvironment {
            is_terminal,
            size,
            term_usable,
            declines,
        }
    }

    #[test]
    fn a_large_capable_terminal_supports_the_footer() {
        assert_eq!(
            evaluate_support(true, env(true, Some((40, 120)), true, false)),
            Support::Supported
        );
    }

    #[test]
    fn colour_suppression_disables_the_footer() {
        assert_eq!(
            evaluate_support(false, env(true, Some((40, 120)), true, false)),
            Support::Suppressed
        );
    }

    #[test]
    fn non_interactive_disables_the_footer() {
        assert_eq!(
            evaluate_support(true, env(false, Some((40, 120)), true, false)),
            Support::NotATerminal
        );
        assert_eq!(
            evaluate_support(true, env(true, None, true, false)),
            Support::NotATerminal
        );
    }

    #[test]
    fn small_terminals_disable_the_footer() {
        // A 24-row terminal cannot give 9 rows to a permanent footer.
        assert_eq!(
            evaluate_support(true, env(true, Some((24, 120)), true, false)),
            Support::TooSmall
        );
        assert_eq!(
            evaluate_support(true, env(true, Some((40, 40)), true, false)),
            Support::TooSmall
        );
    }

    #[test]
    fn terminals_that_declare_themselves_incapable_are_refused() {
        // TERM unset or "dumb", NO_COLOR set, CI set.
        assert_eq!(
            evaluate_support(true, env(true, Some((40, 120)), false, false)),
            Support::TerminalDeclines
        );
        assert_eq!(
            evaluate_support(true, env(true, Some((40, 120)), true, true)),
            Support::TerminalDeclines
        );
    }

    #[test]
    fn the_test_harness_never_installs_a_footer() {
        // The harness has no controlling terminal, so the gate must be closed
        // regardless of what TERM happens to be set to in CI.
        assert!(!is_supported(true));
    }
}
