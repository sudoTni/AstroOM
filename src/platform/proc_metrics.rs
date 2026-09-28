//! Process metrics sourced from the operating system.
//!
//! On Linux these come from `/proc/self`. On Windows there is no `/proc`, so
//! the values are reported as unavailable and the statistics collector falls
//! back to its existing zero default — the same behaviour it already has on
//! any non-Linux host.

/// OS clock ticks per second, used to convert `/proc` CPU counters.
#[cfg(unix)]
pub fn clock_ticks_per_sec() -> f64 {
    let tck = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if tck > 0 {
        tck as f64
    } else {
        100.0
    }
}

/// Windows exposes no `/proc`; callers fall back to their zero default.
#[cfg(not(unix))]
pub fn clock_ticks_per_sec() -> f64 {
    100.0
}

/// `(utime, stime)` CPU ticks consumed by this process, or `None` when the
/// platform does not expose them.
#[cfg(unix)]
pub fn read_cpu_ticks() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    // `comm` is parenthesised and may itself contain ')', so split on the last.
    let after_comm = stat.rsplit(')').next()?;
    let mut fields = after_comm.split_whitespace();
    let utime: u64 = fields.nth(11)?.parse().ok()?;
    let stime: u64 = fields.next()?.parse().ok()?;
    Some((utime, stime))
}

/// Windows exposes no `/proc`; callers fall back to their zero default.
#[cfg(not(unix))]
pub fn read_cpu_ticks() -> Option<(u64, u64)> {
    None
}

#[cfg(unix)]
fn parse_proc_kb(value: &str) -> Option<u64> {
    value
        .trim()
        .strip_suffix("kB")
        .and_then(|n| n.trim().parse::<u64>().ok())
        .map(|kb| kb * 1024)
}

/// `(VmPeak, VmSize)` in bytes, or `None` when unavailable.
#[cfg(unix)]
pub fn read_peak_memory_kb() -> Option<(u64, u64)> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let mut peak = None;
    let mut size = None;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmPeak:") {
            peak = parse_proc_kb(rest);
        } else if let Some(rest) = line.strip_prefix("VmSize:") {
            size = parse_proc_kb(rest);
        }
    }
    Some((peak?, size?))
}

/// Windows exposes no `/proc`; callers fall back to their zero default.
#[cfg(not(unix))]
pub fn read_peak_memory_kb() -> Option<(u64, u64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clock_ticks_are_plausible() {
        assert!(clock_ticks_per_sec() >= 1.0);
    }

    #[cfg(unix)]
    #[test]
    fn parse_proc_kb_converts_kibibytes_to_bytes() {
        assert_eq!(parse_proc_kb("  1234 kB"), Some(1234 * 1024));
        assert_eq!(parse_proc_kb("  12 MB"), None);
        assert_eq!(parse_proc_kb("garbage"), None);
    }
}
