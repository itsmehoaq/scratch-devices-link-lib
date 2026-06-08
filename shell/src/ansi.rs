//! Raw SGR escape sequences mirroring the npm `ansi-string` constants used in
//! the original JS streaming logs. These are streamed verbatim to the client in
//! `uploadStdout` notifications.

pub const CLEAR: &str = "\u{1b}[0m";
pub const RED: &str = "\u{1b}[31m";
pub const GREEN_DARK: &str = "\u{1b}[32m";
pub const YELLOW_DARK: &str = "\u{1b}[33m";
