//! Adaptive, layered compositions of fixed ASCII glyphs.

mod fields;
mod fit;
mod frame;
mod packet;
mod planes;
mod surface;

use crate::cells;
use std::io;

pub use fit::{Encoder, Options};
pub use frame::Frame;
pub(crate) use frame::Previous;
pub(crate) use packet::decode_previous;
pub use packet::{decode, packet, packet_for_version, packet_predicted};
pub use surface::Surface;

pub const CELL_BYTES: usize = 28;
pub type Cell = [u8; CELL_BYTES];

pub(crate) fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid SCI ASCII composition")
}

pub(crate) fn validate_cell(cell: &[u8]) -> io::Result<()> {
    if cell.len() != CELL_BYTES || cell[0] > 3 || cell[3] != b' ' || cell[7] > 4 {
        return Err(invalid());
    }
    let scale = 1 << cell[0];
    if usize::from(cell[1]) >= scale || usize::from(cell[2]) >= scale {
        return Err(invalid());
    }
    for layer in 0..usize::from(cell[7]) {
        let offset = 8 + layer * 5;
        cells::glyph(cell[offset], "ascii-3x4-v2", cell[offset + 1])?;
    }
    if cell[8 + usize::from(cell[7]) * 5..]
        .iter()
        .any(|&byte| byte != 0)
    {
        return Err(invalid());
    }
    Ok(())
}

pub fn validate(frame: &[u8], width: usize, height: usize) -> io::Result<()> {
    let count = cells::dimensions(width, height)?;
    if frame.len() != count * CELL_BYTES {
        return Err(invalid());
    }
    let columns = width / 3;
    let rows = height / 4;
    for (index, cell) in frame.as_chunks::<CELL_BYTES>().0.iter().enumerate() {
        if cell[0] == 0 {
            validate_cell(cell)?;
            continue;
        }
        if cell[0] > 3 {
            return Err(invalid());
        }
        let x = index % columns;
        let y = index / columns;
        let dx = usize::from(cell[1]);
        let dy = usize::from(cell[2]);
        let scale = 1 << cell[0];
        if x < dx || y < dy || x - dx + scale > columns || y - dy + scale > rows {
            return Err(invalid());
        }
        let root = ((y - dy) * columns + x - dx) * CELL_BYTES;
        let origin = &frame[root..root + CELL_BYTES];
        if origin[1] != 0 || origin[2] != 0 || origin[0] != cell[0] || origin[3..] != cell[3..] {
            return Err(invalid());
        }
        if dx == 0 && dy == 0 {
            validate_cell(cell)?;
            for sy in 0..scale {
                for sx in 0..scale {
                    let offset = ((y + sy) * columns + x + sx) * CELL_BYTES;
                    let child = &frame[offset..offset + CELL_BYTES];
                    if child[0] != cell[0]
                        || usize::from(child[1]) != sx
                        || usize::from(child[2]) != sy
                        || child[3..] != cell[3..]
                    {
                        return Err(invalid());
                    }
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn paint(cell: &[u8]) -> io::Result<[[u8; 3]; 12]> {
    paint_channels::<3>(cell)
}

fn paint_channels<const CHANNELS: usize>(cell: &[u8]) -> io::Result<[[u8; CHANNELS]; 12]> {
    let mut background = [255; CHANNELS];
    background[..3].copy_from_slice(&cell[4..7]);
    let mut pixels = [background; 12];
    let mut uncovered = 4095;
    for layer in cell[8..8 + usize::from(cell[7]) * 5]
        .as_chunks::<5>()
        .0
        .iter()
        .rev()
    {
        let mask = cells::glyph(layer[0], "ascii-3x4-v2", layer[1])?;
        let mut color = [255; CHANNELS];
        color[..3].copy_from_slice(&layer[2..5]);
        let mut visible = mask & uncovered;
        while visible != 0 {
            pixels[visible.trailing_zeros() as usize] = color;
            visible &= visible - 1;
        }
        uncovered &= !mask;
        if uncovered == 0 {
            break;
        }
    }
    Ok(pixels)
}

pub fn render(frame: &[u8], width: usize, height: usize) -> io::Result<Vec<u8>> {
    let mut rgb = Vec::new();
    render_into::<3>(frame, width, height, &mut rgb)?;
    Ok(rgb)
}

pub fn render_rgba(
    frame: &[u8],
    width: usize,
    height: usize,
    output: &mut Vec<u8>,
) -> io::Result<()> {
    render_into::<4>(frame, width, height, output)
}

fn render_into<const CHANNELS: usize>(
    frame: &[u8],
    width: usize,
    height: usize,
    output: &mut Vec<u8>,
) -> io::Result<()> {
    validate(frame, width, height)?;
    output.resize(width * height * CHANNELS, 255);
    draw::<CHANNELS>(frame, width, output, None)
}

fn draw<const CHANNELS: usize>(
    frame: &[u8],
    width: usize,
    output: &mut [u8],
    previous: Option<&[u8]>,
) -> io::Result<()> {
    let columns = width / 3;
    for (index, cell) in frame.as_chunks::<CELL_BYTES>().0.iter().enumerate() {
        if cell[1] != 0 || cell[2] != 0 {
            continue;
        }
        if previous
            .is_some_and(|previous| previous[index * CELL_BYTES..(index + 1) * CELL_BYTES] == *cell)
        {
            continue;
        }
        let pixels = paint_channels::<CHANNELS>(cell)?;
        let scale = 1 << cell[0];
        let x = index % columns * 3;
        let y = index / columns * 4;
        if scale == 1 {
            for (sy, row) in pixels.as_chunks::<3>().0.iter().enumerate() {
                let offset = ((y + sy) * width + x) * CHANNELS;
                output[offset..offset + 3 * CHANNELS].copy_from_slice(row.as_flattened());
            }
            continue;
        }
        for sy in 0..4 * scale {
            for sx in 0..3 * scale {
                let offset = ((y + sy) * width + x + sx) * CHANNELS;
                output[offset..offset + CHANNELS]
                    .copy_from_slice(&pixels[(sy >> cell[0]) * 3 + (sx >> cell[0])]);
            }
        }
    }
    Ok(())
}

pub(crate) fn place(frame: &mut [u8], columns: usize, index: usize, cell: Cell) -> io::Result<()> {
    validate_cell(&cell)?;
    if cell[1] != 0 || cell[2] != 0 {
        return Err(invalid());
    }
    let scale = 1 << cell[0];
    let x = index % columns;
    let y = index / columns;
    if x + scale > columns || (y + scale) * columns > frame.len() / CELL_BYTES {
        return Err(invalid());
    }
    for dy in 0..scale {
        for dx in 0..scale {
            let offset = ((y + dy) * columns + x + dx) * CELL_BYTES;
            if frame[offset + 3] != 0 {
                return Err(invalid());
            }
            frame[offset..offset + CELL_BYTES].copy_from_slice(&cell);
            frame[offset + 1] = dx as u8;
            frame[offset + 2] = dy as u8;
        }
    }
    Ok(())
}
