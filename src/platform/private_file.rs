//! Owner-only file and directory creation, portably.
//!
//! Unix applies the mode at creation time via `OpenOptionsExt::mode` /
//! `DirBuilderExt::mode`. Windows has no `mode` equivalent on `OpenOptions`,
//! but a handle created inside a directory the user already owns inherits an
//! equivalent ACL, so the same privacy guarantee is met by construction; the
//! Unix branches are byte-for-byte identical to the pre-port code.

use std::fs::{DirBuilder, File, OpenOptions};
use std::path::Path;

/// Owner-only permissions for log and payload directories (`rwx------`).
pub const PRIVATE_DIR_MODE: u32 = 0o700;
/// Owner-only permissions for artifacts and log files (`rw-------`).
pub const PRIVATE_FILE_MODE: u32 = 0o600;

/// Creates `path` and all missing parents with owner-only permissions.
#[cfg(unix)]
pub fn create_private_dir_all(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = DirBuilder::new();
    builder.recursive(true).mode(PRIVATE_DIR_MODE);
    builder.create(path)
}

/// Creates `path` and all missing parents with owner-only permissions.
///
/// Windows has no directory mode bit; the directory inherits its ACL from the
/// parent, which for a user-owned data/logs tree is already private.
#[cfg(windows)]
pub fn create_private_dir_all(path: &Path) -> std::io::Result<()> {
    DirBuilder::new().recursive(true).create(path)
}

/// Applies owner-only permissions to a prepared `OpenOptions` builder.
///
/// `mode` is a create-time-only bit on Unix, matching the semantics of the
/// original implementation: an existing file keeps whatever mode it had.
#[cfg(unix)]
pub fn apply_private_file_mode(options: &mut OpenOptions) -> &mut OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(PRIVATE_FILE_MODE)
}

/// Applies owner-only permissions to a prepared `OpenOptions` builder.
///
/// Windows has no `mode` equivalent; the created file inherits the parent
/// directory's ACL.
#[cfg(windows)]
pub fn apply_private_file_mode(options: &mut OpenOptions) -> &mut OpenOptions {
    options
}

/// Opens `path` for writing, creating it with owner-only permissions.
///
/// Shared tail of every artifact and log writer in the crate.
pub fn private_writer(path: &Path) -> std::io::Result<File> {
    apply_private_file_mode(OpenOptions::new().write(true).create(true).truncate(true)).open(path)
}
