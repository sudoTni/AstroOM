//! Persistent footer telemetry subsystem.
//!
//! Provides a structured, thread-safe run-state telemetry store and responsive
//! 9-row visual dashboard rendered to the right of the animated AstroOM logo.

pub mod format;
pub mod model;
pub mod store;
pub mod view;

pub use format::*;
pub use model::*;
pub use store::TelemetryStore;
pub use view::*;
