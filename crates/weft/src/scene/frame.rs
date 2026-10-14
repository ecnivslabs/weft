use super::{invalid, validate};
use crate::packet::FrameSpec;
use std::io;

/// An immutable, validated ASCII composition bound to its decoding configuration.
pub struct Frame {
    cells: Vec<u8>,
    width: usize,
    height: usize,
}

impl Frame {
    /// Validate caller-owned cells and retain their existing allocation.
    pub fn new(cells: Vec<u8>, spec: FrameSpec<'_>) -> io::Result<Self> {
        check_spec(spec)?;
        validate(&cells, spec.width, spec.height)?;
        Ok(Self {
            cells,
            width: spec.width,
            height: spec.height,
        })
    }

    pub fn cells(&self) -> &[u8] {
        &self.cells
    }

    /// Render the owned composition using its validated geometry.
    pub fn render_rgba(&self, output: &mut Vec<u8>) -> io::Result<()> {
        output.resize(self.width * self.height * 4, 255);
        super::draw::<4>(&self.cells, self.width, output, None)
    }

    pub fn spec(&self) -> FrameSpec<'static> {
        FrameSpec {
            width: self.width,
            height: self.height,
            font: "ascii-3x4-v2",
        }
    }

    /// Consume the validation proof and transfer the cell allocation to the caller.
    pub fn into_cells(self) -> Vec<u8> {
        self.cells
    }

    pub(crate) fn decode(
        tag: u8,
        declared: usize,
        bytes: &[u8],
        previous: Option<&Self>,
        spec: FrameSpec<'_>,
        expanded: bool,
    ) -> io::Result<Self> {
        check_spec(spec)?;
        if previous.is_some_and(|frame| !frame.matches(spec)) {
            return Err(invalid());
        }
        let cells =
            crate::packet::decode_scene_inner(tag, declared, bytes, previous, spec, expanded)?;
        // The shared reconstructors retain their complete current-frame checks.
        Ok(Self {
            cells,
            width: spec.width,
            height: spec.height,
        })
    }

    fn matches(&self, spec: FrameSpec<'_>) -> bool {
        self.width == spec.width && self.height == spec.height && spec.font == "ascii-3x4-v2"
    }
}

fn check_spec(spec: FrameSpec<'_>) -> io::Result<()> {
    if spec.font != "ascii-3x4-v2" {
        return Err(invalid());
    }
    crate::cells::dimensions(spec.width, spec.height)?;
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) enum Previous<'a> {
    Caller(&'a [u8]),
    Owned(&'a Frame),
}

impl<'a> Previous<'a> {
    pub(crate) fn validated(self, width: usize, height: usize) -> io::Result<&'a [u8]> {
        match self {
            Self::Caller(cells) => {
                validate(cells, width, height)?;
                Ok(cells)
            }
            Self::Owned(frame) => {
                if frame.width != width || frame.height != height {
                    return Err(invalid());
                }
                Ok(frame.cells())
            }
        }
    }
}
