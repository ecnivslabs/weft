//! Source ingestion through FFprobe and FFmpeg. Visual encoding uses weft ASCII cells.

pub mod command;
mod encode;
mod options;
mod output;
pub mod probe;
mod process;
mod staging;
mod timeline;

pub use encode::encode_with_options;
pub use options::{EncodeOptions, FrameRatePolicy};
pub use probe::probe;
