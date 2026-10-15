use super::{invalid, validate, validate_cell, Previous, CELL_BYTES};
use std::io;

const CHANNELS: [usize; 25] = [
    0, 7, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
];

pub(super) fn encode(frame: &[u8], previous: Option<&[u8]>, mode: u8) -> Vec<u8> {
    let roots: Vec<_> = frame
        .as_chunks::<CELL_BYTES>()
        .0
        .iter()
        .enumerate()
        .filter(|(_, cell)| cell[1] == 0 && cell[2] == 0)
        .collect();
    let mut output = Vec::with_capacity(5 + roots.len() * 25);
    output.push(mode);
    output.extend_from_slice(&(roots.len() as u32).to_le_bytes());
    for channel in CHANNELS {
        let mut prior = 0;
        for &(index, cell) in &roots {
            if channel >= 8 && (channel - 8) / 5 >= usize::from(cell[7]) {
                continue;
            }
            let prediction = match mode {
                1 => prior,
                2 if channel != 0 && channel != 7 => {
                    previous.unwrap()[index * CELL_BYTES + channel]
                }
                _ => 0,
            };
            output.push(cell[channel].wrapping_sub(prediction));
            prior = cell[channel];
        }
    }
    output
}

pub(super) fn decode_previous(
    tag: u8,
    data: &[u8],
    previous: Option<Previous<'_>>,
    width: usize,
    height: usize,
) -> io::Result<Vec<u8>> {
    let count = crate::cells::dimensions(width, height)?;
    if data.len() < 5 {
        return Err(invalid());
    }
    let mode = data[0];
    if !matches!((tag, mode), (8, 0 | 1) | (9, 2)) {
        return Err(invalid());
    }
    let length = u32::from_le_bytes(data[1..5].try_into().unwrap()) as usize;
    if length == 0 || length > count || data.len() < 5 + 5 * length || data.len() > 5 + 25 * length
    {
        return Err(invalid());
    }
    match mode {
        0 => decode::<0>(data, &[], width, height, count, length),
        1 => decode::<1>(data, &[], width, height, count, length),
        _ => decode::<2>(
            data,
            previous.ok_or_else(invalid)?.validated(width, height)?,
            width,
            height,
            count,
            length,
        ),
    }
}

fn decode<const MODE: u8>(
    data: &[u8],
    previous: &[u8],
    width: usize,
    height: usize,
    count: usize,
    length: usize,
) -> io::Result<Vec<u8>> {
    let columns = width / 3;
    let mut covered = vec![false; count];
    let mut roots = Vec::with_capacity(length);
    let mut scales = Vec::with_capacity(length);
    let mut next = 0;
    let mut filled = 0;
    let mut prior = 0;
    for &byte in &data[5..5 + length] {
        let exponent = byte.wrapping_add(if MODE == 1 { prior } else { 0 });
        if exponent > 3 || next == count {
            return Err(invalid());
        }
        prior = exponent;
        let scale = 1 << exponent;
        if next % columns + scale > columns || next / columns + scale > height / 4 {
            return Err(invalid());
        }
        for y in 0..scale {
            let row = &mut covered[next + y * columns..next + y * columns + scale];
            if row.iter().any(|&value| value) {
                return Err(invalid());
            }
            row.fill(true);
        }
        roots.push(next);
        scales.push(exponent);
        filled += scale * scale;
        while next < count && covered[next] {
            next += 1;
        }
    }
    if filled != count {
        return Err(invalid());
    }
    let mut layers = Vec::with_capacity(length);
    let mut active = [0; 4];
    let mut prior = 0;
    for &byte in &data[5 + length..5 + length * 2] {
        let value = byte.wrapping_add(if MODE == 1 { prior } else { 0 });
        if value > 4 {
            return Err(invalid());
        }
        for count in &mut active[..usize::from(value)] {
            *count += 1;
        }
        layers.push(value);
        prior = value;
    }
    if data.len() != 5 + 5 * length + 5 * active.iter().sum::<usize>() {
        return Err(invalid());
    }
    let mut position = 5 + length * 2;
    let mut streams: [std::slice::Iter<'_, u8>; 23] = std::array::from_fn(|_| [].iter());
    for (stream, channel) in streams.iter_mut().zip(&CHANNELS[2..]) {
        let entries = if *channel < 8 {
            length
        } else {
            active[(channel - 8) / 5]
        };
        *stream = data[position..position + entries].iter();
        position += entries;
    }
    let mut frame = vec![0; count * CELL_BYTES];
    let mut prior = [0; 23];
    // Gather fields into one hot composition instead of scattering each stream across the raster.
    for ((index, exponent), layers) in roots.into_iter().zip(scales).zip(layers) {
        let mut cell = [0; CELL_BYTES];
        cell[0] = exponent;
        cell[3] = b' ';
        cell[7] = layers;
        let reference = if MODE == 2 {
            &previous[index * CELL_BYTES..(index + 1) * CELL_BYTES]
        } else {
            &[]
        };
        for (field, &channel) in CHANNELS[2..].iter().enumerate() {
            if channel >= 8 && (channel - 8) / 5 >= usize::from(layers) {
                continue;
            }
            let prediction = match MODE {
                1 => prior[field],
                2 => reference[channel],
                _ => 0,
            };
            let value = streams[field].next().unwrap().wrapping_add(prediction);
            cell[channel] = value;
            prior[field] = value;
        }
        validate_cell(&cell)?;
        let scale = 1 << exponent;
        for y in 0..scale {
            for x in 0..scale {
                let offset = (index + y * columns + x) * CELL_BYTES;
                frame[offset..offset + CELL_BYTES].copy_from_slice(&cell);
                frame[offset + 1] = x as u8;
                frame[offset + 2] = y as u8;
            }
        }
    }
    debug_assert!(streams.iter().all(|stream| stream.len() == 0));
    debug_assert!(validate(&frame, width, height).is_ok());
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn random(state: &mut u32) -> u8 {
        *state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        (*state >> 24) as u8
    }

    fn composition(width: usize, height: usize, mut state: u32) -> Vec<u8> {
        let columns = width / 3;
        let rows = height / 4;
        let mut frame = vec![0; columns * rows * CELL_BYTES];
        for index in 0..columns * rows {
            if frame[index * CELL_BYTES + 3] != 0 {
                continue;
            }
            let mut cell = [0; CELL_BYTES];
            cell[0] = random(&mut state) % 4;
            loop {
                let scale = 1 << cell[0];
                if index % columns + scale <= columns
                    && index / columns + scale <= rows
                    && (0..scale).all(|y| {
                        (0..scale).all(|x| frame[(index + y * columns + x) * CELL_BYTES + 3] == 0)
                    })
                {
                    break;
                }
                cell[0] -= 1;
            }
            cell[3] = b' ';
            for value in &mut cell[4..7] {
                *value = random(&mut state);
            }
            cell[7] = random(&mut state) % 5;
            for layer in 0..usize::from(cell[7]) {
                let offset = 8 + layer * 5;
                cell[offset] = 32 + random(&mut state) % 95;
                cell[offset + 1] = random(&mut state) % 4;
                for value in &mut cell[offset + 2..offset + 5] {
                    *value = random(&mut state);
                }
            }
            super::super::place(&mut frame, columns, index, cell).unwrap();
        }
        frame
    }

    #[test]
    fn field_streams_preserve_partitions_colors_symbols_and_changed_reference_geometry() {
        for (width, height) in [(3, 4), (6, 8), (24, 32), (27, 36), (51, 68)] {
            for seed in 1..=32 {
                let frame = composition(width, height, seed);
                let previous = composition(width, height, seed + 731);
                for (tag, mode) in [(8, 0), (8, 1), (9, 2)] {
                    let raw = encode(&frame, Some(&previous), mode);
                    let decoded = decode_previous(
                        tag,
                        &raw,
                        Some(Previous::Caller(&previous)),
                        width,
                        height,
                    )
                    .unwrap();
                    assert_eq!(decoded, frame);
                    if tag == 9 {
                        let owned = super::super::Frame::new(
                            previous.clone(),
                            crate::packet::FrameSpec {
                                width,
                                height,
                                font: crate::format::FONT,
                            },
                        )
                        .unwrap();
                        assert_eq!(
                            decode_previous(
                                tag,
                                &raw,
                                Some(Previous::Owned(&owned)),
                                width,
                                height
                            )
                            .unwrap(),
                            frame
                        );
                        assert!(decode_previous(
                            tag,
                            &raw,
                            Some(Previous::Caller(&[])),
                            width,
                            height
                        )
                        .is_err());
                    } else {
                        assert_eq!(
                            decode_previous(tag, &raw, Some(Previous::Caller(&[])), width, height)
                                .unwrap(),
                            frame
                        );
                    }
                }
                let current = super::super::packet(&frame, Some(&previous), width, height).unwrap();
                let legacy =
                    super::super::packet_for_version(&frame, Some(&previous), width, height, 4)
                        .unwrap();
                assert!(current.len() <= legacy.len());
                assert!([4, 5, 6, 7].contains(&legacy[0]));
                let declared = u32::from_le_bytes(current[1..5].try_into().unwrap()) as usize;
                assert_eq!(
                    crate::packet::decode(
                        current[0],
                        declared,
                        &current[9..],
                        Some(&previous),
                        crate::packet::FrameSpec {
                            width,
                            height,
                            font: crate::format::FONT
                        }
                    )
                    .unwrap(),
                    frame
                );
            }
        }
    }

    #[test]
    fn invalid_geometry_and_mutated_streams_never_escape_validation() {
        // A square placed below a single cell intersects its taller right neighbor.
        let mut overlap = vec![0, 4, 0, 0, 0, 0, 1, 0, 1];
        overlap.resize(25, 0);
        assert!(decode_previous(8, &overlap, None, 12, 16).is_err());
        let frame = composition(27, 36, 115);
        let previous = composition(27, 36, 219);
        for (tag, mode) in [(8, 0), (8, 1), (9, 2)] {
            let raw = encode(&frame, Some(&previous), mode);
            for length in 0..raw.len() {
                assert!(decode_previous(
                    tag,
                    &raw[..length],
                    Some(Previous::Caller(&previous)),
                    27,
                    36
                )
                .is_err());
            }
            for offset in 0..raw.len() {
                let mut mutated = raw.clone();
                mutated[offset] ^= 255;
                if let Ok(decoded) =
                    decode_previous(tag, &mutated, Some(Previous::Caller(&previous)), 27, 36)
                {
                    validate(&decoded, 27, 36).unwrap();
                }
            }
        }
    }
}
