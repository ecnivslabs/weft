use super::{draw, Frame, CELL_BYTES};
use std::{io, sync::Arc};

/// A bounded RGBA surface whose cached pixels always correspond to its owned ASCII frame.
#[derive(Default)]
pub struct Surface {
    frame: Option<Arc<Frame>>,
    pixels: Vec<u8>,
    size: (usize, usize),
}

impl Surface {
    pub fn cells(&self) -> Option<&[u8]> {
        self.frame.as_ref().map(|frame| frame.cells())
    }

    pub fn pixels(&self) -> &[u8] {
        &self.pixels
    }

    pub fn update(&mut self, frame: Vec<u8>, width: usize, height: usize) -> io::Result<()> {
        self.update_owned(Arc::new(Frame::new(
            frame,
            crate::packet::FrameSpec {
                width,
                height,
                font: crate::format::FONT,
            },
        )?))
    }

    /// Retain validated ownership so deferred frames need no copy or repeated validation.
    pub fn update_owned(&mut self, frame: Arc<Frame>) -> io::Result<()> {
        let spec = frame.spec();
        let (width, height) = (spec.width, spec.height);
        let cells = frame.cells();
        let reuse = self.size == (width, height) && self.frame.is_some();
        let previous = if reuse {
            let old = self.frame.as_ref().unwrap().cells();
            let count = cells.len() / CELL_BYTES;
            let step = (count / 128).max(1);
            let samples = (0..count).step_by(step);
            let mut matches = 0;
            let mut total = 0;
            for index in samples {
                let offset = index * CELL_BYTES;
                matches += usize::from(
                    cells[offset..offset + CELL_BYTES] == old[offset..offset + CELL_BYTES],
                );
                total += 1;
            }
            // Dense changes use a full redraw, avoiding a comparison for every composition.
            (matches * 5 >= total).then_some(old)
        } else {
            None
        };
        self.pixels.resize(width * height * 4, 255);
        draw::<4>(cells, width, &mut self.pixels, previous)?;
        self.size = (width, height);
        self.frame = Some(frame);
        Ok(())
    }
}
