use super::*;

pub(super) fn original(pixels: [[u8; 3]; 12], layers: u8) -> Cell {
    let baseline = glyph_fit::fit(&pixels);
    let mut cell = [0; CELL_BYTES];
    cell[3] = b' ';
    cell[4..7].copy_from_slice(&baseline[4..7]);
    if baseline[0] != b' ' {
        cell[7] = 1;
        cell[8] = baseline[0];
        cell[9] = baseline[7];
        cell[10..13].copy_from_slice(&baseline[1..4]);
    }
    while cell[7] < layers {
        let output = paint(&cell).unwrap();
        let errors: [i32; 12] = std::array::from_fn(|i| {
            (0..3)
                .map(|c| (i32::from(pixels[i][c]) - i32::from(output[i][c])).pow(2))
                .sum()
        });
        if errors.iter().sum::<i32>() == 0 {
            break;
        }
        let mut tables = [[[0_i32; 5]; 8]; 4];
        for row in 0..4 {
            for subset in 1_usize..8 {
                let bit = subset.trailing_zeros() as usize;
                let previous = subset & (subset - 1);
                for channel in 0..3 {
                    tables[row][subset][channel] =
                        tables[row][previous][channel] + i32::from(pixels[row * 3 + bit][channel]);
                }
                tables[row][subset][3] = tables[row][previous][3] + errors[row * 3 + bit];
                tables[row][subset][4] = tables[row][previous][4]
                    + pixels[row * 3 + bit]
                        .iter()
                        .map(|&v| i32::from(v).pow(2))
                        .sum::<i32>();
            }
        }
        let mut best = 0_i32;
        let mut layer = [0; 5];
        for &(code, transform, mask) in masks() {
            let mut sum = [0_i32; 5];
            for (row, table) in tables.iter().enumerate() {
                let values = table[usize::from((mask >> (row * 3)) & 7)];
                for c in 0..5 {
                    sum[c] += values[c];
                }
            }
            let count = mask.count_ones() as i32;
            let color: [u8; 3] = std::array::from_fn(|c| ((sum[c] + count / 2) / count) as u8);
            let error = sum[4]
                + (0..3)
                    .map(|c| count * i32::from(color[c]).pow(2) - 2 * i32::from(color[c]) * sum[c])
                    .sum::<i32>();
            let gain = sum[3] - error;
            if gain > best {
                best = gain;
                layer = [code, transform, color[0], color[1], color[2]];
            }
        }
        if best <= 0 {
            break;
        }
        let offset = 8 + usize::from(cell[7]) * 5;
        cell[offset..offset + 5].copy_from_slice(&layer);
        cell[7] += 1;
    }
    refit(&pixels, &mut cell);
    cell
}

fn region(
    encoder: &mut Encoder,
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
    let mut candidate = None;
    if fits {
        let cell = encoder.patch(rgb, width, x * 3, y * 4, exponent);
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
        let bytes = 6 + u64::from(cell[7]) * 5;
        if error == 0 || exponent == 0 {
            super::super::place(frame, columns, y * columns + x, cell)?;
            return Ok((error, bytes));
        }
        candidate = Some((cell, error, bytes));
    }
    let half = scale / 2;
    let mut children = (0, 0);
    for (dx, dy) in [(0, 0), (half, 0), (0, half), (half, half)] {
        let child = region(
            encoder,
            rgb,
            width,
            height,
            (x + dx, y + dy),
            exponent - 1,
            frame,
        )?;
        children.0 += child.0;
        children.1 += child.1;
    }
    if let Some((cell, error, bytes)) = candidate {
        let penalty = u64::from(encoder.options.byte_penalty);
        if error + penalty * bytes <= children.0 + penalty * children.1 {
            for sy in 0..scale {
                for sx in 0..scale {
                    let offset = ((y + sy) * columns + x + sx) * CELL_BYTES;
                    frame[offset..offset + CELL_BYTES].fill(0);
                }
            }
            super::super::place(frame, columns, y * columns + x, cell)?;
            return Ok((error, bytes));
        }
    }
    Ok(children)
}

#[test]
fn error_bounds_preserve_parent_first_partitions_and_all_attributes() {
    for layers in 1..=4 {
        for byte_penalty in [0, 512, 100_000] {
            let options = Options {
                layers,
                byte_penalty,
            };
            let mut baseline = Encoder::new(options).unwrap();
            let mut candidate = Encoder::new(options).unwrap();
            for bits in [8, 4, 7] {
                baseline.set_color_bits(bits).unwrap();
                candidate.set_color_bits(bits).unwrap();
                for (width, height) in [(3, 4), (24, 32), (27, 36), (51, 68)] {
                    for pattern in 0..4 {
                        let rgb: Vec<_> = (0..width * height * 3)
                            .map(|index| match pattern {
                                0 => 137,
                                1 => ((index / (width * 3) / 8 + index / 3 / 8) % 2 * 127) as u8,
                                2 => (index * 73 + index / 29 * 17) as u8,
                                _ => ((index / 3 % width) * 255 / width) as u8,
                            })
                            .collect();
                        let mut expected = vec![0; width / 3 * (height / 4) * CELL_BYTES];
                        for y in (0..height / 4).step_by(8) {
                            for x in (0..width / 3).step_by(8) {
                                region(
                                    &mut baseline,
                                    &rgb,
                                    width,
                                    height,
                                    (x, y),
                                    3,
                                    &mut expected,
                                )
                                .unwrap();
                            }
                        }
                        assert_eq!(candidate.map_frame(&rgb, width, height).unwrap(), expected,
                            "layers={layers} penalty={byte_penalty} bits={bits} size={width}x{height} pattern={pattern}");
                    }
                }
            }
        }
    }
}
