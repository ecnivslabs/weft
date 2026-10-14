//! Bounded packet inflation shared by native and WebAssembly decoders.
use crate::{cells, scene};
use flate2::bufread::ZlibDecoder;
use std::io::{self, Read};

#[derive(Clone, Copy)]
pub struct FrameSpec<'a> {
    pub width: usize,
    pub height: usize,
    pub font: &'a str,
}

pub fn decode(
    tag: u8,
    declared: usize,
    bytes: &[u8],
    previous: Option<&[u8]>,
    spec: FrameSpec<'_>,
) -> io::Result<Vec<u8>> {
    if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
        return Err(cells::invalid());
    }
    validate_declaration(tag, declared, previous, spec)?;
    let data = inflate(declared, bytes)?;
    decode_expanded(tag, &data, previous, spec)
}

fn inflate(declared: usize, bytes: &[u8]) -> io::Result<Vec<u8>> {
    let mut decoder = ZlibDecoder::new(bytes);
    let mut data = Vec::with_capacity(declared);
    decoder
        .by_ref()
        .take(declared as u64 + 1)
        .read_to_end(&mut data)?;
    if data.len() != declared || decoder.total_in() as usize != bytes.len() {
        return Err(cells::invalid());
    }
    Ok(data)
}

/// Decode a scene packet using immutable, configuration-bound reference ownership.
pub fn decode_scene(
    tag: u8,
    declared: usize,
    bytes: &[u8],
    previous: Option<&scene::Frame>,
    spec: FrameSpec<'_>,
) -> io::Result<scene::Frame> {
    scene::Frame::decode(tag, declared, bytes, previous, spec, false)
}

/// Decode an exactly bounded expanded scene packet using owned validation provenance.
pub fn decode_scene_expanded(
    tag: u8,
    data: &[u8],
    previous: Option<&scene::Frame>,
    spec: FrameSpec<'_>,
) -> io::Result<scene::Frame> {
    scene::Frame::decode(tag, data.len(), data, previous, spec, true)
}

pub(crate) fn decode_scene_inner(
    tag: u8,
    declared: usize,
    bytes: &[u8],
    previous: Option<&scene::Frame>,
    spec: FrameSpec<'_>,
    expanded: bool,
) -> io::Result<Vec<u8>> {
    if !expanded && (bytes.is_empty() || bytes.len() > 16 * 1024 * 1024) {
        return Err(cells::invalid());
    }
    let raw = previous.map(scene::Frame::cells);
    validate_declaration(tag, declared, raw, spec)?;
    let data;
    let bytes = if expanded {
        bytes
    } else {
        data = inflate(declared, bytes)?;
        &data
    };
    validate_declaration(tag, bytes.len(), raw, spec)?;
    if [5, 7].contains(&tag) {
        scene::decode_previous(
            tag,
            bytes,
            previous.map(scene::Previous::Owned),
            spec.width,
            spec.height,
        )
    } else {
        decode_expanded_inner(tag, bytes, raw, spec)
    }
}

fn validate_declaration(
    tag: u8,
    declared: usize,
    previous: Option<&[u8]>,
    spec: FrameSpec<'_>,
) -> io::Result<()> {
    let FrameSpec {
        width,
        height,
        font,
    } = spec;
    let count = cells::dimensions(width, height)?;
    if declared == 0
        || declared > count * 38 + 1024
        || ![4, 5, 6, 7].contains(&tag)
        || ([5, 7].contains(&tag) && previous.is_none())
        || font != "ascii-3x4-v2"
    {
        return Err(cells::invalid());
    }
    Ok(())
}

/// Decodes an exactly bounded packet already expanded by the caller's zlib implementation.
pub fn decode_expanded(
    tag: u8,
    data: &[u8],
    previous: Option<&[u8]>,
    spec: FrameSpec<'_>,
) -> io::Result<Vec<u8>> {
    validate_declaration(tag, data.len(), previous, spec)?;
    decode_expanded_inner(tag, data, previous, spec)
}

fn decode_expanded_inner(
    tag: u8,
    data: &[u8],
    previous: Option<&[u8]>,
    spec: FrameSpec<'_>,
) -> io::Result<Vec<u8>> {
    let FrameSpec {
        width,
        height,
        font,
    } = spec;
    if font != "ascii-3x4-v2" {
        return Err(cells::invalid());
    }
    scene::decode(tag, data, previous, width, height)
}
