use serde_json::Value;
use std::io;

pub const CODEC: &str = "sci-ascii-scene-v1";
pub const MAPPER: &str = "adaptive-layered-v2";
pub const FONT: &str = "ascii-3x4-v2";

pub fn validate_video(video: &Value) -> io::Result<()> {
    if video["codec"] == CODEC
        && video["cellBytes"] == crate::scene::CELL_BYTES
        && video["font"] == FONT
        && video["glyphTransform"] == "reflect-xy-v1"
    {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Unsupported SCI representation",
        ))
    }
}

/// Bit zero reflects columns; bit one reflects rows. Other bits are invalid.
pub fn reflect(mask: u16, transform: u8) -> io::Result<u16> {
    if transform > 3 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid ASCII glyph reflection",
        ));
    }
    let mut output = 0;
    for y in 0..4 {
        for x in 0..3 {
            let source_x = if transform & 1 != 0 { 2 - x } else { x };
            let source_y = if transform & 2 != 0 { 3 - y } else { y };
            output |= ((mask >> (source_y * 3 + source_x)) & 1) << (y * 3 + x);
        }
    }
    Ok(output)
}
