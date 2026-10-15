use super::*;

#[derive(Clone, Copy, Default)]
pub(super) struct Choice {
    layer: [u8; 5],
    rows: [u8; 4],
    error: i32,
}

pub(super) fn prepared(pixels: [[u8; 3]; 12], layers: u8) -> Cell {
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
    if cell[7] >= layers {
        refit(&pixels, &mut cell);
        return cell;
    }
    let errors = |cell: &Cell| {
        let output = paint(cell).unwrap();
        std::array::from_fn::<_, 12, _>(|i| {
            (0..3)
                .map(|c| (i32::from(pixels[i][c]) - i32::from(output[i][c])).pow(2))
                .sum::<i32>()
        })
    };
    let mut current = errors(&cell);
    if current.iter().sum::<i32>() == 0 {
        refit(&pixels, &mut cell);
        return cell;
    }
    let mut tables = [[[0_i32; 4]; 8]; 4];
    for (row, table) in tables.iter_mut().enumerate() {
        for subset in 1_usize..8 {
            let bit = subset.trailing_zeros() as usize;
            let previous = subset & (subset - 1);
            let pixel = pixels[row * 3 + bit];
            for channel in 0..3 {
                table[subset][channel] = table[previous][channel] + i32::from(pixel[channel]);
            }
            table[subset][3] = table[previous][3]
                + pixel
                    .iter()
                    .map(|&value| i32::from(value).pow(2))
                    .sum::<i32>();
        }
    }
    // Target-mask means and replacement errors are invariant across greedy layers.
    let mut choices = [Choice::default(); 94 * 4];
    for (choice, &(code, reflection, mask)) in choices.iter_mut().zip(masks()) {
        let mut sums = [0_i32; 4];
        choice.rows = std::array::from_fn(|row| ((mask >> (row * 3)) & 7) as u8);
        for (row, &subset) in choice.rows.iter().enumerate() {
            for (sum, value) in sums.iter_mut().zip(tables[row][usize::from(subset)]) {
                *sum += value;
            }
        }
        let count = mask.count_ones() as i32;
        let color: [u8; 3] = std::array::from_fn(|channel| {
            glyph_fit::mean(sums[channel] as u32, count as u32) as u8
        });
        choice.error = sums[3]
            + (0..3)
                .map(|channel| {
                    count * i32::from(color[channel]).pow(2)
                        - 2 * i32::from(color[channel]) * sums[channel]
                })
                .sum::<i32>();
        choice.layer = [code, reflection, color[0], color[1], color[2]];
    }
    while cell[7] < layers {
        let mut table = [[0_i32; 8]; 4];
        for (row, values) in table.iter_mut().enumerate() {
            for subset in 1_usize..8 {
                values[subset] = values[subset & (subset - 1)]
                    + current[row * 3 + subset.trailing_zeros() as usize];
            }
        }
        let mut best = 0;
        let mut layer = [0; 5];
        for choice in &choices[..masks().len()] {
            let prior: i32 = choice
                .rows
                .iter()
                .enumerate()
                .map(|(row, &subset)| table[row][usize::from(subset)])
                .sum();
            let gain = prior - choice.error;
            if gain > best {
                best = gain;
                layer = choice.layer;
            }
        }
        if best <= 0 {
            break;
        }
        let offset = 8 + usize::from(cell[7]) * 5;
        cell[offset..offset + 5].copy_from_slice(&layer);
        cell[7] += 1;
        if cell[7] < layers {
            current = errors(&cell);
            if current.iter().sum::<i32>() == 0 {
                break;
            }
        }
    }
    refit(&pixels, &mut cell);
    cell
}

#[test]
fn invariant_choices_preserve_all_layers_glyphs_ties_and_patch_values() {
    assert!(masks().len() <= 94 * 4);
    let mut seed = 0x1634_82e7_u32;
    let mut patches = vec![[[0; 3]; 12], [[255; 3]; 12], [[27, 171, 239]; 12]];
    for &(_, _, mask) in masks() {
        patches.push(std::array::from_fn(|pixel| {
            if mask & (1 << pixel) == 0 {
                [0, 255, 0]
            } else {
                [255, 0, 255]
            }
        }));
    }
    for _ in 0..1024 {
        patches.push(std::array::from_fn(|_| {
            std::array::from_fn(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 24) as u8
            })
        }));
    }
    for pixels in patches {
        for layers in 1..=4 {
            assert_eq!(
                prepared(pixels, layers),
                reference::original(pixels, layers)
            );
        }
    }
}

#[test]
fn prepared_kernel_preserves_mapping_cache_partitions_quantization_and_packets() {
    for options in [
        Options::default(),
        Options {
            layers: 2,
            byte_penalty: 512,
        },
    ] {
        let mut baseline = Encoder::new(options).unwrap();
        baseline.kernel = reference::original;
        let mut candidate = Encoder::new(options).unwrap();
        candidate.kernel = prepared;
        for (width, height) in [(3, 4), (27, 36), (51, 68), (27, 36)] {
            for bits in [8, 4, 4, 7, 8] {
                baseline.set_color_bits(bits).unwrap();
                candidate.set_color_bits(bits).unwrap();
                let mut rgb: Vec<_> = (0..width * height * 3)
                    .map(|i| (i * 73 + 19) as u8)
                    .collect();
                for _ in 0..3 {
                    let a = baseline.map_frame(&rgb, width, height).unwrap();
                    let b = candidate.map_frame(&rgb, width, height).unwrap();
                    assert_eq!(a, b);
                    assert_eq!(
                        super::super::packet(&a, None, width, height).unwrap(),
                        super::super::packet(&b, None, width, height).unwrap()
                    );
                    rgb[0] ^= 1;
                }
            }
        }
    }
}
