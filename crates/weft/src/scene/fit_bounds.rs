pub(super) fn uniform(
    rgb: &[u8],
    width: usize,
    x: usize,
    y: usize,
    scale: usize,
) -> Option<[u8; 3]> {
    let first = (y * width + x) * 3;
    let color: [u8; 3] = rgb[first..first + 3].try_into().unwrap();
    for row in y..y + scale * 4 {
        let start = (row * width + x) * 3;
        if rgb[start..start + scale * 9]
            .as_chunks::<3>()
            .0
            .iter()
            .any(|pixel| pixel != &color)
        {
            return None;
        }
    }
    Some(color)
}

pub(super) fn error(rgb: &[u8], width: usize, x: usize, y: usize, scale: usize) -> u64 {
    let count = (scale * scale) as u32;
    let mut error = 0_i64;
    for py in 0..4 {
        for px in 0..3 {
            let mut sums = [0_u32; 3];
            let mut squares = 0_u32;
            for dy in 0..scale {
                let start = ((y + py * scale + dy) * width + x + px * scale) * 3;
                for pixel in rgb[start..start + scale * 3].as_chunks::<3>().0 {
                    for channel in 0..3 {
                        let value = u32::from(pixel[channel]);
                        sums[channel] += value;
                        squares += value * value;
                    }
                }
            }
            error += i64::from(squares);
            for sum in sums {
                let mean = (sum + count / 2) / count;
                error += i64::from(count * mean * mean) - i64::from(2 * mean * sum);
            }
        }
    }
    error as u64
}
