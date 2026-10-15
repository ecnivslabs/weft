use super::{Atlas, Glyph, CELL_BYTES, RECIPROCALS};
#[cfg(target_arch = "x86")]
use std::arch::x86::*;
#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;

pub(super) struct Batch {
    rows: [[i32; 8]; 4],
    counts: [i32; 8],
    foreground_reciprocals: [i32; 8],
    background_reciprocals: [i32; 8],
    length: usize,
}

impl Batch {
    pub(super) fn new(glyphs: &[Glyph]) -> Self {
        assert!(!glyphs.is_empty() && glyphs.len() <= 8);
        let counts =
            std::array::from_fn(|lane| glyphs.get(lane).map_or(0, |glyph| glyph.count as i32));
        Self {
            rows: std::array::from_fn(|row| {
                std::array::from_fn(|lane| {
                    glyphs.get(lane).map_or(0, |glyph| glyph.rows[row] as i32)
                })
            }),
            foreground_reciprocals: counts.map(|count| RECIPROCALS[count as usize] as i32),
            background_reciprocals: counts.map(|count| RECIPROCALS[12 - count as usize] as i32),
            counts,
            length: glyphs.len(),
        }
    }
}

#[target_feature(enable = "avx2")]
pub(super) unsafe fn fit(pixels: &[[u8; 3]; 12], atlas: &Atlas) -> [u8; CELL_BYTES] {
    let mut rows = [[[0_i32; 8]; 4]; 3];
    let mut totals = [0; 3];
    let mut squares = 0;
    for (channel, tables) in rows.iter_mut().enumerate() {
        for (row, table) in tables.iter_mut().enumerate() {
            for subset in 1_usize..8 {
                let value = i32::from(pixels[row * 3 + subset.trailing_zeros() as usize][channel]);
                table[subset] = table[subset & (subset - 1)] + value;
            }
            totals[channel] += table[7];
        }
        for pixel in pixels {
            squares += i32::from(pixel[channel]).pow(2);
        }
    }
    let mut best_error = i32::MAX;
    let mut best = [0; CELL_BYTES];
    for (index, batch) in atlas.batches.iter().enumerate() {
        // Every load/store covers a complete eight-i32 array; batch rows index eight-entry tables.
        let (errors, colors) = unsafe {
            let counts = _mm256_loadu_si256(batch.counts.as_ptr().cast());
            let background_counts = _mm256_sub_epi32(_mm256_set1_epi32(12), counts);
            let foreground_reciprocals =
                _mm256_loadu_si256(batch.foreground_reciprocals.as_ptr().cast());
            let background_reciprocals =
                _mm256_loadu_si256(batch.background_reciprocals.as_ptr().cast());
            let selectors = batch
                .rows
                .map(|row| _mm256_loadu_si256(row.as_ptr().cast()));
            let mut error = _mm256_set1_epi32(squares);
            let mut colors = [[_mm256_setzero_si256(); 2]; 3];
            for channel in 0..3 {
                let mut foreground = _mm256_setzero_si256();
                for (row, selector) in selectors.iter().enumerate() {
                    let table = _mm256_loadu_si256(rows[channel][row].as_ptr().cast());
                    foreground =
                        _mm256_add_epi32(foreground, _mm256_permutevar8x32_epi32(table, *selector));
                }
                let background = _mm256_sub_epi32(_mm256_set1_epi32(totals[channel]), foreground);
                let fg = _mm256_srli_epi32::<16>(_mm256_mullo_epi32(
                    _mm256_add_epi32(foreground, _mm256_srli_epi32::<1>(counts)),
                    foreground_reciprocals,
                ));
                let bg = _mm256_srli_epi32::<16>(_mm256_mullo_epi32(
                    _mm256_add_epi32(background, _mm256_srli_epi32::<1>(background_counts)),
                    background_reciprocals,
                ));
                let quadratic = _mm256_add_epi32(
                    _mm256_mullo_epi32(counts, _mm256_mullo_epi32(fg, fg)),
                    _mm256_mullo_epi32(background_counts, _mm256_mullo_epi32(bg, bg)),
                );
                let linear = _mm256_slli_epi32::<1>(_mm256_add_epi32(
                    _mm256_mullo_epi32(fg, foreground),
                    _mm256_mullo_epi32(bg, background),
                ));
                error = _mm256_add_epi32(error, _mm256_sub_epi32(quadratic, linear));
                colors[channel] = [fg, bg];
            }
            let mut errors = [0; 8];
            _mm256_storeu_si256(errors.as_mut_ptr().cast(), error);
            (errors, colors)
        };
        let mut winner = None;
        for (lane, &error) in errors[..batch.length].iter().enumerate() {
            if error < best_error {
                best_error = error;
                winner = Some(lane);
            }
        }
        if let Some(lane) = winner {
            let glyph = &atlas.glyphs[index * 8 + lane];
            best[0] = glyph.character;
            best[7] = glyph.transform;
            for (channel, colors) in colors.iter().enumerate() {
                let mut foreground = [0_i32; 8];
                let mut background = [0_i32; 8];
                // Both destinations contain all eight lanes of their vector.
                unsafe {
                    _mm256_storeu_si256(foreground.as_mut_ptr().cast(), colors[0]);
                    _mm256_storeu_si256(background.as_mut_ptr().cast(), colors[1]);
                }
                best[channel + 1] = foreground[lane] as u8;
                best[channel + 4] = background[lane] as u8;
            }
            if best_error == 0 {
                break;
            }
        }
    }
    best
}

#[test]
fn every_partial_batch_preserves_first_minimum_and_ignores_padded_lanes() {
    if !std::is_x86_feature_detected!("avx2") {
        return;
    }
    let original = super::atlas();
    for length in 1..=original.glyphs.len().min(16) {
        let glyphs: Vec<_> = original.glyphs[..length]
            .iter()
            .map(|glyph| Glyph {
                character: glyph.character,
                shape: glyph.shape,
                transform: glyph.transform,
                rows: glyph.rows,
                count: glyph.count,
            })
            .collect();
        let atlas = Atlas {
            batches: glyphs.chunks(8).map(Batch::new).collect(),
            glyphs,
        };
        for offset in 0..128 {
            let pixels = std::array::from_fn(|pixel| {
                std::array::from_fn(|channel| (offset * 73 + pixel * 19 + channel * 131) as u8)
            });
            // SAFETY: AVX2 was detected, and the atlas uses the production batch constructor.
            assert_eq!(
                unsafe { fit(&pixels, &atlas) },
                super::scalar(&pixels, &atlas)
            );
        }
    }
}
