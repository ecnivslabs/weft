use super::{draw, validate, CELL_BYTES};
use std::io;

/// A bounded RGBA surface whose cached pixels always correspond to its owned ASCII frame.
#[derive(Default)]
pub struct Surface {
    frame: Vec<u8>,
    pixels: Vec<u8>,
    size: (usize, usize),
}

impl Surface {
    pub fn cells(&self) -> Option<&[u8]> {
        (!self.frame.is_empty()).then_some(self.frame.as_slice())
    }

    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    pub fn update(&mut self, frame: Vec<u8>, width: usize, height: usize) -> io::Result<()> {
        validate(&frame, width, height)?;
        let reuse = self.size == (width, height) && self.frame.len() == frame.len();
        let previous = if reuse {
            let count = frame.len() / CELL_BYTES;
            let step = (count / 128).max(1);
            let samples = (0..count).step_by(step);
            let mut matches = 0;
            let mut total = 0;
            for index in samples {
                let offset = index * CELL_BYTES;
                matches += usize::from(
                    frame[offset..offset + CELL_BYTES] == self.frame[offset..offset + CELL_BYTES],
                );
                total += 1;
            }
            // Dense changes use a full redraw, avoiding a comparison for every composition.
            (matches * 5 >= total).then_some(self.frame.as_slice())
        } else {
            None
        };
        self.pixels.resize(width * height * 4, 255);
        draw::<4>(&frame, width, &mut self.pixels, previous)?;
        self.size = (width, height);
        self.frame = frame;
        Ok(())
    }
}
