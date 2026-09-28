//! Cross-platform primitives.
//!
//! The rest of the codebase is platform-agnostic; every OS-specific API
//! (file modes, console handles, terminal geometry, `/proc`) is funnelled
//! through this module so that the `cfg` surface stays auditable in one place.
//!
//! Behaviour is identical to the historical Unix-only implementation on
//! `x86_64-unknown-linux-gnu`; the Windows branches provide the Win32
//! equivalents so `x86_64-pc-windows-gnu` produces a working binary.

pub mod console;
pub mod private_file;
pub mod proc_metrics;
pub mod terminal;

pub use console::{is_stdout_terminal_raw, try_enable_virtual_terminal};
pub use private_file::{
    create_private_dir_all, private_writer, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE,
};
pub use proc_metrics::{clock_ticks_per_sec, read_cpu_ticks, read_peak_memory_kb};
pub use terminal::{terminal_size, MIN_BANNER_COLS, MIN_BANNER_ROWS};
