use std::io;
use std::sync::OnceLock;

use crate::format::reflect;

type GlyphMasks = [[i16; 4]; 128];

pub(crate) fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid SCI ASCII frame")
}

pub fn dimensions(width: usize, height: usize) -> io::Result<usize> {
    if width == 0
        || height == 0
        || width > 4096
        || height > 1080
        || !width.is_multiple_of(3)
        || !height.is_multiple_of(4)
    {
        return Err(invalid());
    }
    Ok(width / 3 * (height / 4))
}

pub fn mask(character: u8, font: &str) -> io::Result<u16> {
    glyph(character, font, 0)
}

pub(crate) fn glyph(character: u8, font: &str, transform: u8) -> io::Result<u16> {
    static GLYPHS: OnceLock<GlyphMasks> = OnceLock::new();
    let current = GLYPHS.get_or_init(|| {
        let glyphs: serde_json::Value =
            serde_json::from_str(crate::FONT_JSON).expect("Built-in font");
        let mut current = [[-1; 4]; 128];
        for glyph in glyphs["glyphs"].as_array().unwrap() {
            let shape = glyph[1].as_u64().unwrap() as u16;
            current[glyph[0].as_u64().unwrap() as usize] =
                std::array::from_fn(|transform| reflect(shape, transform as u8).unwrap() as i16);
        }
        current
    });
    if font != "ascii-3x4-v2" {
        return Err(invalid());
    }
    current
        .get(usize::from(character))
        .and_then(|masks| masks.get(usize::from(transform)))
        .copied()
        .filter(|mask| *mask >= 0)
        .map(|mask| mask as u16)
        .ok_or_else(invalid)
}
