//! Portable ASCII frame encoding, reconstruction, and bounded SCI archive decoding.
//!
//! This crate operates on RGB input and ASCII cells without launching media tools.
//! Use `weft-media` for source ingestion and synchronized audio encoding.
//!
//! ```
//! use weft::{packet, scene};
//!
//! let mut encoder = scene::Encoder::new(scene::Options::default())?;
//! let frame = encoder.map_frame(&[120; 36], 3, 4)?;
//! let encoded = scene::packet(&frame, None, 3, 4)?;
//! let length = u32::from_le_bytes(encoded[1..5].try_into()?) as usize;
//! let decoded = packet::decode(encoded[0], length, &encoded[9..], None,
//!     packet::FrameSpec { width: 3, height: 4, font: "ascii-3x4-v2" })?;
//! assert_eq!(scene::render(&decoded, 3, 4)?, vec![120; 36]);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```

pub mod archive;
mod archive_timing;
pub mod cells;
pub mod format;
mod glyph_fit;
pub mod packet;
pub mod scene;
pub mod timing;

/// Versioned glyph definitions shared with browser decoders.
pub const FONT_JSON: &str = include_str!("glyphs.json");
