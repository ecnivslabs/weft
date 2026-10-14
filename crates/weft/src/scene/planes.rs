use super::{invalid, validate, CELL_BYTES};
use std::io;

pub(super) fn paeth(left: u8, above: u8, corner: u8) -> u8 {
    let prediction = i32::from(left) + i32::from(above) - i32::from(corner);
    let distances = [
        (prediction - i32::from(left)).abs(),
        (prediction - i32::from(above)).abs(),
        (prediction - i32::from(corner)).abs(),
    ];
    if distances[0] <= distances[1] && distances[0] <= distances[2] {
        left
    } else if distances[1] <= distances[2] {
        above
    } else {
        corner
    }
}

fn source(index: usize, columns: usize, rows: usize, dx: i16, dy: i16) -> Option<usize> {
    let x = index as isize % columns as isize - dx as isize;
    let y = index as isize / columns as isize - dy as isize;
    if x < 0 || y < 0 || x >= columns as isize || y >= rows as isize {
        None
    } else {
        Some(y as usize * columns + x as usize)
    }
}

pub(super) fn encode(
    frame: &[u8],
    previous: Option<&[u8]>,
    columns: usize,
    motion: (i16, i16),
) -> Vec<u8> {
    let count = frame.len() / CELL_BYTES;
    let mut output = Vec::with_capacity(frame.len() + 4);
    if previous.is_some() {
        output.extend(motion.0.to_le_bytes());
        output.extend(motion.1.to_le_bytes());
    }
    for channel in 0..CELL_BYTES {
        let plane: Vec<u8> = frame
            .as_chunks::<CELL_BYTES>()
            .0
            .iter()
            .map(|cell| cell[channel])
            .collect();
        if previous.is_none() && plane.iter().all(|&value| value == plane[0]) {
            output.push(plane[0]);
            output.resize(output.len() + count - 1, 0);
            continue;
        }
        for (y, row) in plane.chunks_exact(columns).enumerate() {
            let mut left = 0;
            let mut corner = 0;
            for (x, &value) in row.iter().enumerate() {
                let prediction = if let Some(previous) = previous {
                    source(
                        y * columns + x,
                        columns,
                        count / columns,
                        motion.0,
                        motion.1,
                    )
                    .map_or(0, |source| previous[source * CELL_BYTES + channel])
                } else {
                    let above = if y > 0 {
                        plane[(y - 1) * columns + x]
                    } else {
                        0
                    };
                    let prediction = paeth(left, above, corner);
                    corner = above;
                    left = value;
                    prediction
                };
                output.push(value.wrapping_sub(prediction));
            }
        }
    }
    output
}

pub(super) fn decode_previous(
    tag: u8,
    data: &[u8],
    previous: Option<super::Previous<'_>>,
    width: usize,
    height: usize,
) -> io::Result<Vec<u8>> {
    let count = crate::cells::dimensions(width, height)?;
    let columns = width / 3;
    let rows = height / 4;
    let (dx, dy, data) = if tag == 7 {
        if data.len() != count * CELL_BYTES + 4 || previous.is_none() {
            return Err(invalid());
        }
        (
            i16::from_le_bytes(data[..2].try_into().unwrap()),
            i16::from_le_bytes(data[2..4].try_into().unwrap()),
            &data[4..],
        )
    } else {
        if data.len() != count * CELL_BYTES {
            return Err(invalid());
        }
        (0, 0, data)
    };
    if dx.unsigned_abs() > 64 || dy.unsigned_abs() > 64 {
        return Err(invalid());
    }
    let previous = if tag == 7 {
        Some(previous.unwrap().validated(width, height)?)
    } else {
        None
    };
    let frame = if tag == 7 {
        let mut frame = transpose(data, count);
        let previous = previous.unwrap();
        let left = i32::from(dx).max(0) as usize;
        let right = (columns as i32 + i32::from(dx)).clamp(0, columns as i32) as usize;
        if left < right {
            for y in 0..rows {
                let source_y = y as isize - dy as isize;
                if !(0..rows as isize).contains(&source_y) {
                    continue;
                }
                let begin = (y * columns + left) * CELL_BYTES;
                let end = (y * columns + right) * CELL_BYTES;
                let source = (source_y as usize * columns + (left as isize - dx as isize) as usize)
                    * CELL_BYTES;
                for (value, &prediction) in frame[begin..end]
                    .iter_mut()
                    .zip(&previous[source..source + end - begin])
                {
                    *value = value.wrapping_add(prediction);
                }
            }
        }
        frame
    } else {
        let mut planes = data.to_vec();
        for plane in planes.chunks_exact_mut(count) {
            if plane[1..].iter().all(|&value| value == 0) {
                plane.fill(plane[0]);
                continue;
            }
            for y in 0..rows {
                let mut left = 0;
                let mut corner = 0;
                for x in 0..columns {
                    let index = y * columns + x;
                    let above = if y > 0 { plane[index - columns] } else { 0 };
                    let prediction = paeth(left, above, corner);
                    corner = above;
                    let value = plane[index].wrapping_add(prediction);
                    plane[index] = value;
                    left = value;
                }
            }
        }
        transpose(&planes, count)
    };
    validate(&frame, width, height)?;
    Ok(frame)
}

pub(super) fn transpose(planes: &[u8], count: usize) -> Vec<u8> {
    let mut frame = vec![0; count * CELL_BYTES];
    // Keep one output block hot while gathering its attributes from contiguous planes.
    for (block, output) in frame.chunks_mut(256 * CELL_BYTES).enumerate() {
        let first = block * 256;
        let length = output.len() / CELL_BYTES;
        for channel in 0..CELL_BYTES {
            let plane = &planes[channel * count + first..channel * count + first + length];
            for (cell, &value) in output.as_chunks_mut::<CELL_BYTES>().0.iter_mut().zip(plane) {
                cell[channel] = value;
            }
        }
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plane_predictors_preserve_scaled_geometry_and_motion_edges() {
        let mut encoder = crate::scene::Encoder::new(crate::scene::Options::default()).unwrap();
        let (width, height) = (27, 36);
        let previous = encoder
            .map_frame(&[37, 127, 217].repeat(width * height), width, height)
            .unwrap();
        let rgb: Vec<_> = (0..width * height * 3)
            .map(|index| (index * 41) as u8)
            .collect();
        let frame = encoder.map_frame(&rgb, width, height).unwrap();
        for value in [&previous, &frame] {
            let spatial = encode(value, None, width / 3, (0, 0));
            assert_eq!(
                decode_previous(6, &spatial, None, width, height).unwrap(),
                *value
            );
            for motion in [(0, 0), (1, 1), (-1, -1), (64, -64), (-64, 64)] {
                let temporal = encode(value, Some(&previous), width / 3, motion);
                assert_eq!(
                    decode_previous(
                        7,
                        &temporal,
                        Some(super::super::Previous::Caller(&previous)),
                        width,
                        height
                    )
                    .unwrap(),
                    *value
                );
            }
        }
        let spatial = encode(&frame, None, width / 3, (0, 0));
        assert_eq!(
            decode_previous(
                6,
                &spatial,
                Some(super::super::Previous::Caller(&[])),
                width,
                height
            )
            .unwrap(),
            frame
        );
        assert!(decode_previous(
            7,
            &[0; 4],
            Some(super::super::Previous::Caller(&previous)),
            width,
            height
        )
        .is_err());
    }
    #[test]
    fn blocked_transpose_and_temporal_rows_preserve_partial_blocks_and_all_edges() {
        for (width, height) in [(3, 4), (255, 36), (768, 32)] {
            let count = crate::cells::dimensions(width, height).unwrap();
            let mut seed = 0x4183_7251_u32;
            let mut frame = vec![0; count * CELL_BYTES];
            let mut previous = frame.clone();
            for bytes in [&mut frame, &mut previous] {
                for (index, cell) in bytes.as_chunks_mut::<CELL_BYTES>().0.iter_mut().enumerate() {
                    cell[3] = b' ';
                    cell[7] = (index % 5) as u8;
                    for value in &mut cell[4..7] {
                        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                        *value = (seed >> 24) as u8;
                    }
                    for layer in 0..usize::from(cell[7]) {
                        let offset = 8 + layer * 5;
                        cell[offset] = b'#';
                        cell[offset + 1] = (layer % 4) as u8;
                        for value in &mut cell[offset + 2..offset + 5] {
                            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                            *value = (seed >> 24) as u8;
                        }
                    }
                }
            }
            let spatial = encode(&frame, None, width / 3, (0, 0));
            assert_eq!(
                decode_previous(6, &spatial, None, width, height).unwrap(),
                frame
            );
            for dx in [-64, -2, -1, 0, 1, 2, 64] {
                for dy in [-64, -2, -1, 0, 1, 2, 64] {
                    let data = encode(&frame, Some(&previous), width / 3, (dx, dy));
                    assert_eq!(
                        decode_previous(
                            7,
                            &data,
                            Some(super::super::Previous::Caller(&previous)),
                            width,
                            height
                        )
                        .unwrap(),
                        frame
                    );
                }
            }
            let planes: Vec<_> = (0..CELL_BYTES)
                .flat_map(|channel| {
                    frame
                        .as_chunks::<CELL_BYTES>()
                        .0
                        .iter()
                        .map(move |cell| cell[channel])
                })
                .collect();
            assert_eq!(transpose(&planes, count), frame);
        }
    }
}
