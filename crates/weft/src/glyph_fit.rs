use std::sync::OnceLock;

use crate::format::reflect;
const CELL_BYTES: usize = 8;
struct Atlas {
    glyphs: Vec<Glyph>,
}

struct Glyph {
    character: u8,
    shape: u16,
    transform: u8,
    rows: [usize; 4],
    count: u32,
}

fn atlas() -> &'static Atlas {
    static ATLAS: OnceLock<Atlas> = OnceLock::new();
    ATLAS.get_or_init(|| {
        let font: serde_json::Value =
            serde_json::from_str(crate::FONT_JSON).expect("Built-in ASCII font must be valid");
        let original: Vec<_> = font["glyphs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| (g[0].as_u64().unwrap() as u8, g[1].as_u64().unwrap() as u16))
            .collect();
        let mut glyphs = Vec::new();
        for transform in 0..4 {
            for &(character, shape) in &original {
                let shape = reflect(shape, transform).unwrap();
                if !glyphs.iter().any(|previous: &Glyph| {
                    previous.shape == shape || previous.shape == shape ^ 4095
                }) {
                    glyphs.push(Glyph {
                        character,
                        shape,
                        transform,
                        rows: std::array::from_fn(|row| usize::from((shape >> (row * 3)) & 7)),
                        count: shape.count_ones(),
                    });
                }
            }
        }
        Atlas { glyphs }
    })
}

pub(crate) fn mean(sum: u32, count: u32) -> u32 {
    // Rounded means of at most twelve bytes are exact with these 16-bit reciprocals.
    const RECIPROCALS: [u32; 13] = [
        0, 65536, 32768, 21846, 16384, 13108, 10923, 9363, 8192, 7282, 6554, 5958, 5462,
    ];
    ((sum + count / 2) * RECIPROCALS[count as usize]) >> 16
}

pub(crate) fn fit(pixels: &[[u8; 3]; 12]) -> [u8; CELL_BYTES] {
    let mut total = [0_u32; 3];
    let mut squares = 0_i32;
    let mut rows = [[[0_u16; 3]; 8]; 4];
    for (row, table) in rows.iter_mut().enumerate() {
        for subset in 1_usize..8 {
            let pixel = pixels[row * 3 + subset.trailing_zeros() as usize];
            let previous = subset & (subset - 1);
            for (channel, &value) in pixel.iter().enumerate() {
                table[subset][channel] = table[previous][channel] + u16::from(value);
            }
        }
        for channel in 0..3 {
            total[channel] += u32::from(table[7][channel]);
        }
    }
    for pixel in pixels {
        for &value in pixel {
            squares += i32::from(value).pow(2);
        }
    }
    let mut best_error = i32::MAX;
    let mut best = [0; CELL_BYTES];
    for glyph in &atlas().glyphs {
        let count = glyph.count;
        let background_count = 12 - count;
        let mut cell = [glyph.character, 0, 0, 0, 0, 0, 0, glyph.transform];
        let mut error = squares;
        for channel in 0..3 {
            let foreground: u32 = rows
                .iter()
                .enumerate()
                .map(|(row, table)| u32::from(table[glyph.rows[row]][channel]))
                .sum();
            let background = total[channel] - foreground;
            let fg = mean(foreground, count);
            let bg = mean(background, background_count);
            cell[channel + 1] = fg as u8;
            cell[channel + 4] = bg as u8;
            error += (count * fg * fg + background_count * bg * bg) as i32
                - (2 * fg * foreground + 2 * bg * background) as i32;
        }
        if error < best_error {
            best_error = error;
            best = cell;
            if error == 0 {
                break;
            }
        }
    }
    best
}

#[test]
fn reciprocal_means_match_integer_division_for_every_valid_sum() {
    assert_eq!(mean(0, 0), 0);
    for count in 1..=12 {
        for sum in 0..=255 * count {
            assert_eq!(mean(sum, count), (sum + count / 2) / count);
        }
    }
}
