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
