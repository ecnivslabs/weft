use super::{invalid, validate, validate_cell, Previous, CELL_BYTES};
use std::io;

const CHANNELS: [usize; 25] = [
    0, 7, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
];
const COLOR_CHANNELS: [usize; 25] = [
    0, 7, 5, 4, 6, 8, 9, 11, 10, 12, 13, 14, 16, 15, 17, 18, 19, 21, 20, 22, 23, 24, 26, 25, 27,
];

fn channels<const COLOR: bool>() -> &'static [usize; 25] {
    if COLOR {
        &COLOR_CHANNELS
    } else {
        &CHANNELS
    }
}

fn green(channel: usize) -> Option<usize> {
    match channel {
        4 | 6 => Some(5),
        10..=27 if (channel - 10).is_multiple_of(5) => Some(channel + 1),
        10..=27 if (channel - 10) % 5 == 2 => Some(channel - 1),
        _ => None,
    }
}

fn value<const COLOR: bool>(cell: &[u8], channel: usize) -> u8 {
    if COLOR {
        if let Some(green) = green(channel) {
            return cell[channel].wrapping_sub(cell[green]);
        }
    }
    cell[channel]
}

pub(super) fn encode<const COLOR: bool>(
    frame: &[u8],
    previous: Option<&[u8]>,
    mode: u8,
) -> Vec<u8> {
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
    for &channel in channels::<COLOR>() {
        let mut prior = 0;
        for &(index, cell) in &roots {
            if channel >= 8 && (channel - 8) / 5 >= usize::from(cell[7]) {
                continue;
            }
            let prediction = match mode {
                1 => prior,
                2 if channel != 0 && channel != 7 => value::<COLOR>(
                    &previous.unwrap()[index * CELL_BYTES..(index + 1) * CELL_BYTES],
                    channel,
                ),
                _ => 0,
            };
            let current = value::<COLOR>(cell, channel);
            output.push(current.wrapping_sub(prediction));
            prior = current;
        }
    }
    output
}

pub(super) fn decorrelate(data: &mut [u8]) {
    let count = u32::from_le_bytes(data[1..5].try_into().unwrap()) as usize;
    let mut active = [0; 4];
    let mut prior = 0;
    for &byte in &data[5 + count..5 + count * 2] {
        let layers = byte.wrapping_add(if data[0] == 1 { prior } else { 0 });
        for count in &mut active[..usize::from(layers)] {
            *count += 1;
        }
        prior = layers;
    }
    let mut offset = 5 + count * 2;
    // Modulo-256 color differences commute with the field predictors, including temporal residuals.
    for (prefix, entries) in std::iter::once((0, count)).chain(active.map(|count| (2, count))) {
        offset += prefix * entries;
        let (red, rest) = data[offset..offset + entries * 3].split_at_mut(entries);
        let (green, blue) = rest.split_at_mut(entries);
        for ((red, green), blue) in red.iter_mut().zip(green).zip(blue) {
            let original_red = *red;
            *red = *green;
            *blue = blue.wrapping_sub(*green);
            *green = original_red.wrapping_sub(*green);
        }
        offset += entries * 3;
    }
    debug_assert_eq!(offset, data.len());
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
    if !matches!((tag, mode), (8 | 10, 0 | 1) | (9 | 11, 2)) {
        return Err(invalid());
    }
    let length = u32::from_le_bytes(data[1..5].try_into().unwrap()) as usize;
    if length == 0 || length > count || data.len() < 5 + 5 * length || data.len() > 5 + 25 * length
    {
        return Err(invalid());
    }
    let reference = if mode == 2 {
        previous.ok_or_else(invalid)?.validated(width, height)?
    } else {
        &[]
    };
    match (mode, tag >= 10) {
        (0, false) => decode::<0, false>(data, reference, width, height, count, length),
        (1, false) => decode::<1, false>(data, reference, width, height, count, length),
        (2, false) => decode::<2, false>(data, reference, width, height, count, length),
        (0, true) => decode::<0, true>(data, reference, width, height, count, length),
        (1, true) => decode::<1, true>(data, reference, width, height, count, length),
        _ => decode::<2, true>(data, reference, width, height, count, length),
    }
}

fn decode<const MODE: u8, const COLOR: bool>(
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
    for (stream, channel) in streams.iter_mut().zip(&channels::<COLOR>()[2..]) {
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
        for (field, &channel) in channels::<COLOR>()[2..5 + usize::from(layers) * 5]
            .iter()
            .enumerate()
        {
            let prediction = match MODE {
                1 => prior[field],
                2 => reference[channel],
                _ => 0,
            };
            let value = streams[field].next().unwrap().wrapping_add(prediction);
            prior[field] = value;
            cell[channel] = value;
        }
        if COLOR {
            // Undo temporal color residuals after adding RGB references, without transforming a copy.
            for offset in
                std::iter::once(4).chain((0..usize::from(layers)).map(|layer| 10 + layer * 5))
            {
                let green = cell[offset + 1].wrapping_sub(if MODE == 2 {
                    reference[offset + 1]
                } else {
                    0
                });
                cell[offset] = cell[offset].wrapping_add(green);
                cell[offset + 2] = cell[offset + 2].wrapping_add(green);
            }
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
                for (tag, mode) in [(8, 0), (8, 1), (9, 2), (10, 0), (10, 1), (11, 2)] {
                    let raw = if tag >= 10 {
                        encode::<true>(&frame, Some(&previous), mode)
                    } else {
                        encode::<false>(&frame, Some(&previous), mode)
                    };
                    if tag >= 10 {
                        let mut transformed = encode::<false>(&frame, Some(&previous), mode);
                        decorrelate(&mut transformed);
                        assert_eq!(transformed, raw);
                    }
                    let decoded = decode_previous(
                        tag,
                        &raw,
                        Some(Previous::Caller(&previous)),
                        width,
                        height,
                    )
                    .unwrap();
                    assert_eq!(decoded, frame);
                    if [9, 11].contains(&tag) {
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
        for (tag, mode) in [(8, 0), (8, 1), (9, 2), (10, 0), (10, 1), (11, 2)] {
            let raw = if tag >= 10 {
                encode::<true>(&frame, Some(&previous), mode)
            } else {
                encode::<false>(&frame, Some(&previous), mode)
            };
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
