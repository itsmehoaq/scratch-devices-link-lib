//! Console progress bars & spinners via `indicatif`. All indicators detect
//! whether stderr is a TTY and fall back to plain tracing log lines when the
//! process runs headless (tray / service). This keeps log files readable.

#![allow(dead_code)]

use indicatif::{MultiProgress, ProgressBar, ProgressDrawTarget, ProgressStyle};
use std::io::IsTerminal;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static HEADLESS: AtomicBool = AtomicBool::new(false);

/// Call once at startup. When true, all bars/spinners are hidden and output
/// goes to tracing instead.
pub fn set_headless(headless: bool) {
    HEADLESS.store(headless, Ordering::Relaxed);
}

fn is_headless() -> bool {
    HEADLESS.load(Ordering::Relaxed) || !std::io::stdout().is_terminal()
}

fn make_bar(total: u64) -> ProgressBar {
    ProgressBar::with_draw_target(Some(total), ProgressDrawTarget::stdout())
}

fn make_spinner() -> ProgressBar {
    ProgressBar::with_draw_target(None, ProgressDrawTarget::stdout())
}

// ── shared style templates ────────────────────────────────────────────────

fn bar_style() -> ProgressStyle {
    ProgressStyle::with_template(
        "{spinner:.green} [{elapsed_precise}] [{wide_bar:.cyan/blue}] {bytes}/{total_bytes} ({eta})",
    )
    .unwrap()
    .progress_chars("#>-")
}

fn spinner_style() -> ProgressStyle {
    ProgressStyle::with_template("{spinner:.green} {msg}")
        .unwrap()
        .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
}

fn spinner_style_dim() -> ProgressStyle {
    ProgressStyle::with_template("  {spinner:.dim} {msg}")
        .unwrap()
        .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
}

// ── public API ────────────────────────────────────────────────────────────

/// A progress bar that tracks bytes downloaded.
pub struct DownloadBar {
    bar: Option<ProgressBar>,
}

impl DownloadBar {
    pub fn new(label: &str, total_bytes: u64) -> Self {
        if is_headless() {
            tracing::info!("[download] {label} ({total_bytes} bytes)");
            return Self { bar: None };
        }
        let bar = make_bar(total_bytes);
        bar.set_style(bar_style());
        bar.set_message(label.to_string());
        Self { bar: Some(bar) }
    }

    pub fn inc(&self, n: u64) {
        if let Some(b) = &self.bar {
            b.inc(n);
        }
    }

    pub fn finish(&self, msg: &str) {
        if let Some(b) = &self.bar {
            b.set_style(ProgressStyle::with_template("{spinner:.green} {msg}").unwrap());
            b.finish_with_message(msg.to_string());
        } else {
            tracing::info!("[download] {msg}");
        }
    }

    pub fn abandon(&self, msg: &str) {
        if let Some(b) = &self.bar {
            b.set_style(ProgressStyle::with_template("{spinner:.red} {msg}").unwrap());
            b.finish_with_message(msg.to_string());
        } else {
            tracing::error!("[download] {msg}");
        }
    }
}

/// A spinner for indeterminate operations.
pub struct Spinner {
    bar: Option<ProgressBar>,
}

impl Spinner {
    pub fn new(msg: &str) -> Self {
        if is_headless() {
            tracing::info!("[link] {msg}");
            return Self { bar: None };
        }
        let bar = make_spinner();
        bar.set_style(spinner_style());
        bar.set_message(msg.to_string());
        bar.enable_steady_tick(Duration::from_millis(80));
        Self { bar: Some(bar) }
    }

    /// Create a dimmed sub-spinner (for nested operations).
    pub fn new_dim(msg: &str) -> Self {
        if is_headless() {
            tracing::info!("[link]   {msg}");
            return Self { bar: None };
        }
        let bar = make_spinner();
        bar.set_style(spinner_style_dim());
        bar.set_message(msg.to_string());
        bar.enable_steady_tick(Duration::from_millis(100));
        Self { bar: Some(bar) }
    }

    pub fn set_message(&self, msg: &str) {
        if let Some(b) = &self.bar {
            b.set_message(msg.to_string());
        }
    }

    pub fn finish_ok(&self, msg: &str) {
        if let Some(b) = &self.bar {
            b.set_style(ProgressStyle::with_template("{spinner:.green} {msg}").unwrap());
            b.finish_with_message(msg.to_string());
        } else {
            tracing::info!("[link] ✓ {msg}");
        }
    }

    pub fn finish_warn(&self, msg: &str) {
        if let Some(b) = &self.bar {
            b.set_style(ProgressStyle::with_template("{spinner:.yellow} {msg}").unwrap());
            b.finish_with_message(msg.to_string());
        } else {
            tracing::warn!("[link] {msg}");
        }
    }

    pub fn finish_err(&self, msg: &str) {
        if let Some(b) = &self.bar {
            b.set_style(ProgressStyle::with_template("{spinner:.red} {msg}").unwrap());
            b.finish_with_message(msg.to_string());
        } else {
            tracing::error!("[link] {msg}");
        }
    }
}

impl Drop for Spinner {
    fn drop(&mut self) {
        if let Some(b) = self.bar.take() {
            if !b.is_finished() {
                b.finish_and_clear();
            }
        }
    }
}

/// A managed set of progress bars for multi-step operations.
pub struct MultiBar {
    mp: Option<MultiProgress>,
}

impl MultiBar {
    pub fn new() -> Self {
        if is_headless() {
            return Self { mp: None };
        }
        let mp = MultiProgress::new();
        Self { mp: Some(mp) }
    }

    pub fn add_bar(&self, label: &str, total: u64) -> DownloadBar {
        if let Some(mp) = &self.mp {
            let bar = mp.add(make_bar(total));
            bar.set_style(bar_style());
            bar.set_message(label.to_string());
            DownloadBar { bar: Some(bar) }
        } else {
            DownloadBar::new(label, total)
        }
    }

    pub fn add_spinner(&self, msg: &str) -> Spinner {
        if let Some(mp) = &self.mp {
            let bar = mp.add(make_spinner());
            bar.set_style(spinner_style());
            bar.set_message(msg.to_string());
            bar.enable_steady_tick(Duration::from_millis(80));
            Spinner { bar: Some(bar) }
        } else {
            Spinner::new(msg)
        }
    }
}
