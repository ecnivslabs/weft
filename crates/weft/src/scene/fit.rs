use super::{paint, Cell, CELL_BYTES};
use crate::{cells, glyph_fit};
use std::{collections::HashMap, io, sync::OnceLock};

#[path = "fit_bounds.rs"]
mod bounds;
#[path = "fit_kernel.rs"]
mod kernel;
use kernel::prepared as fit;
#[cfg(test)]
#[path = "fit_reference.rs"]
mod reference;

#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub layers: u8,
    /// Squared RGB error permitted per byte saved by spatial merging.
    pub byte_penalty: u32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            layers: 4,
            byte_penalty: 0,
        }
    }
}

fn masks() -> &'static Vec<(u8, u8, u16)> {
    static MASKS: OnceLock<Vec<(u8, u8, u16)>> = OnceLock::new();
    MASKS.get_or_init(|| {
        let mut entries = Vec::new();
        for transform in 0..4 {
            for code in 33..=126 {
                let mask = cells::glyph(code, "ascii-3x4-v2", transform).unwrap();
                if mask != 0 && !entries.iter().any(|&(_, _, previous)| previous == mask) {
                    entries.push((code, transform, mask));
                }
            }
        }
        entries
    })
}

pub(super) fn owners(cell: &Cell) -> [usize; 12] {
    let layers = usize::from(cell[7]);
    let mut owners = [0; 12];
    for layer in 0..layers {
        let offset = 8 + layer * 5;
        let mask = cells::glyph(cell[offset], "ascii-3x4-v2", cell[offset + 1]).unwrap();
        for (pixel, owner) in owners.iter_mut().enumerate() {
            if mask & (1 << pixel) != 0 {
                *owner = layer + 1;
            }
        }
    }
    owners
}

fn refit(pixels: &[[u8; 3]; 12], cell: &mut Cell) {
    let owners = owners(cell);
    let mut sums = [[0_u32; 3]; 5];
    let mut counts = [0_u32; 5];
    for (pixel, &owner) in pixels.iter().zip(&owners) {
        counts[owner] += 1;
        for channel in 0..3 {
            sums[owner][channel] += u32::from(pixel[channel]);
        }
    }
    refit_colors(cell, sums, counts);
}

pub(super) fn refit_colors(cell: &mut Cell, sums: [[u32; 3]; 5], counts: [u32; 5]) {
    let layers = usize::from(cell[7]);
    let colors: [[u8; 3]; 5] = std::array::from_fn(|owner| {
        std::array::from_fn(|channel| {
            (sums[owner][channel] + counts[owner] / 2)
                .checked_div(counts[owner])
                .unwrap_or(0) as u8
        })
    });
    cell[4..7].copy_from_slice(&colors[0]);
    let original = *cell;
    cell[8..].fill(0);
    cell[7] = 0;
    for layer in 0..layers {
        if counts[layer + 1] == 0 {
            continue;
        }
        let source = 8 + layer * 5;
        let target = 8 + usize::from(cell[7]) * 5;
        cell[target..target + 2].copy_from_slice(&original[source..source + 2]);
        cell[target + 2..target + 5].copy_from_slice(&colors[layer + 1]);
        cell[7] += 1;
    }
}

pub(super) fn quantize(value: u8, bits: u8) -> u8 {
    if bits == 8 {
        return value;
    }
    let levels = (1_u32 << bits) - 1;
    let index = (u32::from(value) * levels + 127) / 255;
    ((index * 255 + levels / 2) / levels) as u8
}

pub(super) fn quantize_cell(cell: &mut Cell, bits: u8) {
    if bits < 8 {
        for value in &mut cell[4..7] {
            *value = quantize(*value, bits);
        }
        for layer in 0..usize::from(cell[7]) {
            for value in &mut cell[10 + layer * 5..13 + layer * 5] {
                *value = quantize(*value, bits);
            }
        }
        let output = paint(cell).unwrap();
        for layer in (0..usize::from(cell[7])).rev() {
            let mut candidate = *cell;
            candidate.copy_within(13 + layer * 5..8 + usize::from(cell[7]) * 5, 8 + layer * 5);
            candidate[7] -= 1;
            let end = 8 + usize::from(candidate[7]) * 5;
            candidate[end..].fill(0);
            if paint(&candidate).unwrap() == output {
                *cell = candidate;
            }
        }
    }
}

/// Bounded patch cache persists across source frames, including moving repeated patches.
pub struct Encoder {
    options: Options,
    color_bits: u8,
    cache: HashMap<[[u8; 3]; 12], Cell>,
    #[cfg(test)]
    kernel: fn([[u8; 3]; 12], u8) -> Cell,
}

impl Encoder {
    pub fn new(options: Options) -> io::Result<Self> {
        if !(1..=4).contains(&options.layers) {
            return Err(super::invalid());
        }
        Ok(Self {
            options,
            color_bits: 8,
            cache: HashMap::new(),
            #[cfg(test)]
            kernel: fit,
        })
    }

    /// Quantize fitted RGB attributes and patch-cache keys; eight bits preserves full precision.
    pub fn set_color_bits(&mut self, bits: u8) -> io::Result<()> {
        if !(4..=8).contains(&bits) {
            return Err(super::invalid());
        }
        if bits != self.color_bits {
            self.cache.clear();
            self.color_bits = bits;
        }
        Ok(())
    }

    fn patch(&mut self, rgb: &[u8], width: usize, x: usize, y: usize, exponent: u8) -> Cell {
        let scale = 1_usize << exponent;
        let samples = (scale * scale) as u32;
        let pixels = std::array::from_fn(|i| {
            let mut sum = [0_u32; 3];
            for dy in 0..scale {
                for dx in 0..scale {
                    let offset = ((y + i / 3 * scale + dy) * width + x + i % 3 * scale + dx) * 3;
                    for c in 0..3 {
                        sum[c] += u32::from(rgb[offset + c]);
                    }
                }
            }
            std::array::from_fn(|c| {
                quantize(((sum[c] + samples / 2) / samples) as u8, self.color_bits)
            })
        });
        let mut cell = if let Some(&cell) = self.cache.get(&pixels) {
            cell
        } else {
            #[cfg(test)]
            let mut cell = (self.kernel)(pixels, self.options.layers);
            #[cfg(not(test))]
            let mut cell = fit(pixels, self.options.layers);
            quantize_cell(&mut cell, self.color_bits);
            if self.cache.len() >= 32768 {
                self.cache.clear();
            }
            self.cache.insert(pixels, cell);
            cell
        };
        cell[0] = exponent;
        cell
    }

    fn candidate(
        &mut self,
        rgb: &[u8],
        width: usize,
        x: usize,
        y: usize,
        exponent: u8,
    ) -> io::Result<(Cell, u64, u64)> {
        let scale = 1 << exponent;
        let cell = self.patch(rgb, width, x * 3, y * 4, exponent);
        let pixels = paint(&cell)?;
        let mut error = 0;
        for sy in 0..scale * 4 {
            for sx in 0..scale * 3 {
                let offset = ((y * 4 + sy) * width + x * 3 + sx) * 3;
                for c in 0..3 {
                    error += (i32::from(rgb[offset + c])
                        - i32::from(pixels[sy / scale * 3 + sx / scale][c]))
                    .pow(2) as u64;
                }
            }
        }
        Ok((cell, error, 6 + u64::from(cell[7]) * 5))
    }

    fn region(
        &mut self,
        rgb: &[u8],
        width: usize,
        height: usize,
        origin: (usize, usize),
        exponent: u8,
        frame: &mut [u8],
    ) -> io::Result<(u64, u64)> {
        let (x, y) = origin;
        let columns = width / 3;
        let rows = height / 4;
        if x >= columns || y >= rows {
            return Ok((0, 0));
        }
        let scale = 1 << exponent;
        let fits = x + scale <= columns && y + scale <= rows;
        if fits {
            if let Some(color) = bounds::uniform(rgb, width, x * 3, y * 4, scale) {
                let mut cell = [0; CELL_BYTES];
                cell[0] = exponent;
                cell[3] = b' ';
                for channel in 0..3 {
                    cell[4 + channel] = quantize(color[channel], self.color_bits);
                }
                let error = color
                    .iter()
                    .zip(&cell[4..7])
                    .map(|(&source, &value)| (i32::from(source) - i32::from(value)).pow(2) as u64)
                    .sum::<u64>()
                    * (12 * scale * scale) as u64;
                super::place(frame, columns, y * columns + x, cell)?;
                return Ok((error, 6));
            }
        }
        let lower_bound = if fits && exponent > 0 {
            bounds::error(rgb, width, x * 3, y * 4, scale)
        } else {
            0
        };
        let mut candidate = None;
        if fits && lower_bound == 0 {
            let (cell, error, bytes) = self.candidate(rgb, width, x, y, exponent)?;
            if error == 0 || exponent == 0 {
                super::place(frame, columns, y * columns + x, cell)?;
                return Ok((error, bytes));
            }
            candidate = Some((cell, error, bytes));
        }
        let half = scale / 2;
        let mut children = (0, 0);
        for (dx, dy) in [(0, 0), (half, 0), (0, half), (half, half)] {
            let child = self.region(rgb, width, height, (x + dx, y + dy), exponent - 1, frame)?;
            children.0 += child.0;
            children.1 += child.1;
        }
        let penalty = u64::from(self.options.byte_penalty);
        if fits && candidate.is_none() {
            // Even unconstrained block colors cannot beat the children below this bound.
            if lower_bound + penalty * 6 > children.0 + penalty * children.1 {
                return Ok(children);
            }
            candidate = Some(self.candidate(rgb, width, x, y, exponent)?);
        }
        if let Some((cell, error, bytes)) = candidate {
            if error + penalty * bytes <= children.0 + penalty * children.1 {
                for sy in 0..scale {
                    for sx in 0..scale {
                        let offset = ((y + sy) * columns + x + sx) * CELL_BYTES;
                        frame[offset..offset + CELL_BYTES].fill(0);
                    }
                }
                super::place(frame, columns, y * columns + x, cell)?;
                return Ok((error, bytes));
            }
        }
        Ok(children)
    }

    pub fn map_frame(&mut self, rgb: &[u8], width: usize, height: usize) -> io::Result<Vec<u8>> {
        let count = cells::dimensions(width, height)?;
        if rgb.len() != width * height * 3 {
            return Err(super::invalid());
        }
        let mut frame = vec![0; count * CELL_BYTES];
        for y in (0..height / 4).step_by(8) {
            for x in (0..width / 3).step_by(8) {
                self.region(rgb, width, height, (x, y), 3, &mut frame)?;
            }
        }
        Ok(frame)
    }
}
