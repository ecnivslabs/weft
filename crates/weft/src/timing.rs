use serde_json::Value;
use std::io;

#[derive(Clone)]
pub struct Quality {
    pub height: u16,
    pub columns: u16,
    pub rows: u16,
}

#[derive(Clone, Copy)]
pub struct Rate {
    numerator: u32,
    denominator: u32,
}

impl Rate {
    pub fn new(numerator: u32, denominator: u32) -> io::Result<Self> {
        if numerator > 240000
            || denominator == 0
            || denominator > 10000
            || !(1.0..=60.0).contains(&(f64::from(numerator) / f64::from(denominator)))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Unsupported frame rate",
            ));
        }
        Ok(Self {
            numerator,
            denominator,
        })
    }
    pub fn numerator(self) -> u32 {
        self.numerator
    }
    pub fn denominator(self) -> u32 {
        self.denominator
    }

    pub fn from_metadata(input: &Value) -> Self {
        let numerator = input["fpsNumerator"].as_u64().unwrap_or(30);
        let denominator = input["fpsDenominator"].as_u64().unwrap_or(1);
        let fps = numerator as f64 / denominator as f64;
        if numerator > 240000
            || denominator == 0
            || denominator > 10000
            || !(1.0..=60.0).contains(&fps)
        {
            return Self {
                numerator: 30,
                denominator: 1,
            };
        }
        Self {
            numerator: numerator as u32,
            denominator: denominator as u32,
        }
    }
    pub fn fps(self) -> f64 {
        f64::from(self.numerator) / f64::from(self.denominator)
    }
    pub fn chunk_frames(self) -> usize {
        self.fps().round() as usize * 2
    }
    pub fn chunk_seconds(self) -> f64 {
        self.chunk_frames() as f64 / self.fps()
    }
    pub fn samples(self, frames: usize) -> io::Result<usize> {
        let samples =
            frames as u128 * 48000 * u128::from(self.denominator) / u128::from(self.numerator);
        samples.try_into().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Audio timeline exceeds addressable memory",
            )
        })
    }
}

pub fn qualities(width: u32, height: u32) -> io::Result<Vec<Quality>> {
    qualities_for(width, height, &[360, 480, 720, 1080])
}

pub fn qualities_for(width: u32, height: u32, requested: &[u16]) -> io::Result<Vec<Quality>> {
    if width < 2 || height < 4 || width > 16384 || height > 16384 {
        return Err(io::Error::other("Unsupported source dimensions"));
    }
    if requested.is_empty()
        || requested.len() > 4
        || requested.iter().any(|h| ![360, 480, 720, 1080].contains(h))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Choose heights from 360,480,720,1080",
        ));
    }
    let mut heights: Vec<u16> = requested
        .iter()
        .copied()
        .filter(|&h| u32::from(h) <= height)
        .collect();
    if heights.is_empty() {
        if height >= 360 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Source cannot provide the requested rendition heights",
            ));
        }
        heights.push((height / 4 * 4) as u16);
    }
    heights.sort_unstable();
    heights.dedup();
    heights
        .into_iter()
        .map(|h| {
            let columns =
                ((f64::from(width) / f64::from(height) * f64::from(h) / 3.0).round() as u32 * 3)
                    .max(3);
            if columns > 4096 {
                return Err(io::Error::other("Unsupported source aspect ratio"));
            }
            Ok(Quality {
                height: h,
                columns: columns as u16,
                rows: h,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_resolutions_and_fractional_audio_timeline() {
        let resolutions = qualities(1280, 720).unwrap();
        assert_eq!(
            resolutions.iter().map(|q| q.height).collect::<Vec<_>>(),
            vec![360, 480, 720]
        );
        assert_eq!(resolutions[0].rows, 360);
        assert_eq!(resolutions[0].columns, 639);
        assert_eq!(qualities(240, 360).unwrap()[0].columns, 240);
        let rate = Rate {
            numerator: 30000,
            denominator: 1001,
        };
        assert_eq!(rate.samples(60).unwrap(), 96096);
        assert_eq!(
            rate.samples(120).unwrap() - rate.samples(60).unwrap(),
            96096
        );
        assert!(rate.samples(usize::MAX).is_err());
        assert!(Rate::new(30, 0).is_err());
        assert!(qualities_for(1280, 720, &[1080]).is_err());
        assert_eq!(qualities_for(320, 181, &[360]).unwrap()[0].height, 180);
    }
}
