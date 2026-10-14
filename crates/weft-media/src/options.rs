use std::io;
use weft::{scene, timing::Rate};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameRatePolicy {
    Source,
    /// Drop source frames above this ceiling; never invent additional frames.
    Limit {
        numerator: u32,
        denominator: u32,
    },
}

#[derive(Clone, Debug)]
pub struct EncodeOptions {
    pub heights: Vec<u16>,
    pub frame_rate: FrameRatePolicy,
    pub scene: scene::Options,
    pub color_bits: u8,
    /// Preferred payload size; one complete frame may exceed this soft budget.
    pub chunk_bytes: usize,
    /// Research target, not permission to silently change fidelity or timing.
    pub target_bitrate: u32,
}

impl Default for EncodeOptions {
    fn default() -> Self {
        Self {
            heights: vec![360, 480, 720, 1080],
            frame_rate: FrameRatePolicy::Source,
            scene: scene::Options::default(),
            color_bits: 8,
            chunk_bytes: 16 * 1024 * 1024,
            target_bitrate: 1_000_000,
        }
    }
}

impl EncodeOptions {
    pub fn argument(&mut self, name: &str, value: &str) -> io::Result<()> {
        let invalid = |message: &str| io::Error::new(io::ErrorKind::InvalidInput, message);
        match name {
            "--heights" => {
                self.heights = value
                    .split(',')
                    .map(|height| {
                        height
                            .parse()
                            .map_err(|_| invalid("Invalid rendition height"))
                    })
                    .collect::<io::Result<_>>()?
            }
            "--fps" => {
                if value == "source" {
                    self.frame_rate = FrameRatePolicy::Source;
                } else {
                    let (numerator, denominator) = value.split_once('/').unwrap_or((value, "1"));
                    self.frame_rate = FrameRatePolicy::Limit {
                        numerator: numerator
                            .parse()
                            .map_err(|_| invalid("Invalid frame-rate ceiling"))?,
                        denominator: denominator
                            .parse()
                            .map_err(|_| invalid("Invalid frame-rate denominator"))?,
                    };
                }
            }
            "--quality" => {
                let quality = value
                    .parse::<u32>()
                    .map_err(|_| invalid("Quality must be 0 through 100"))?;
                if quality > 100 {
                    return Err(invalid("Quality must be 0 through 100"));
                }
                self.scene.byte_penalty = (100 - quality).pow(2) * 12;
            }
            "--layers" => {
                self.scene.layers = value
                    .parse()
                    .map_err(|_| invalid("Layers must be 1 through 4"))?
            }
            "--color-bits" => {
                self.color_bits = value
                    .parse()
                    .map_err(|_| invalid("Color precision must be 4 through 8 bits"))?;
            }
            "--chunk-bytes" => {
                self.chunk_bytes = value
                    .parse()
                    .map_err(|_| invalid("Chunk budget must be 65536 through 16777216 bytes"))?;
            }
            "--byte-penalty" => {
                self.scene.byte_penalty =
                    value.parse().map_err(|_| invalid("Invalid byte penalty"))?
            }
            "--target-bitrate" => {
                self.target_bitrate = value
                    .parse()
                    .map_err(|_| invalid("Invalid bitrate in bit/s"))?
            }
            _ => return Err(invalid("Unknown encoder option")),
        }
        self.validate()
    }
    pub fn ceiling(&self) -> io::Result<Rate> {
        match self.frame_rate {
            FrameRatePolicy::Source => Rate::new(60, 1),
            FrameRatePolicy::Limit {
                numerator,
                denominator,
            } => Rate::new(numerator, denominator),
        }
    }
    pub fn validate(&self) -> io::Result<()> {
        self.ceiling()?;
        weft::timing::qualities_for(1920, 1080, &self.heights)?;
        scene::Encoder::new(self.scene)?.set_color_bits(self.color_bits)?;
        if !(65536..=16 * 1024 * 1024).contains(&self.chunk_bytes) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Chunk budget must be 65536 through 16777216 bytes",
            ));
        }
        if self.target_bitrate == 0 || self.target_bitrate > 1_000_000_000 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Target bitrate must be between 1 and 1000000000 bit/s",
            ));
        }
        Ok(())
    }
    pub fn fingerprint(&self) -> io::Result<String> {
        self.validate()?;
        let mut heights = self.heights.clone();
        heights.sort_unstable();
        heights.dedup();
        let rate = self.ceiling()?;
        let mut fingerprint = format!(
            "{}:{}:{}:{}/{}:{}:{}",
            weft::format::MAPPER,
            heights
                .iter()
                .map(u16::to_string)
                .collect::<Vec<_>>()
                .join(","),
            self.scene.layers,
            rate.numerator(),
            rate.denominator(),
            self.scene.byte_penalty,
            self.target_bitrate
        );
        if self.color_bits != 8 {
            fingerprint.push_str(&format!(":rgb{}", self.color_bits));
        }
        if self.chunk_bytes != 16 * 1024 * 1024 {
            fingerprint.push_str(&format!(":chunks{}", self.chunk_bytes));
        }
        Ok(fingerprint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_cache_identity_survives_profile_cleanup() {
        let mut options = EncodeOptions::default();
        assert_eq!(
            options.fingerprint().unwrap(),
            "adaptive-layered-v2:360,480,720,1080:4:60/1:0:1000000"
        );
        options.heights = vec![1080, 360, 720, 480];
        assert_eq!(
            options.fingerprint().unwrap(),
            EncodeOptions::default().fingerprint().unwrap()
        );
        for (name, value) in [
            ("--layers", "1"),
            ("--fps", "30000/1001"),
            ("--color-bits", "7"),
            ("--chunk-bytes", "65536"),
            ("--quality", "75"),
            ("--target-bitrate", "2000000"),
        ] {
            let mut changed = EncodeOptions::default();
            changed.argument(name, value).unwrap();
            assert_ne!(
                changed.fingerprint().unwrap(),
                options.fingerprint().unwrap()
            );
        }
    }

    #[test]
    fn invalid_and_removed_options_are_rejected() {
        for (name, value) in [
            ("--heights", "999"),
            ("--fps", "30/0"),
            ("--fps", "61"),
            ("--layers", "0"),
            ("--layers", "5"),
            ("--color-bits", "3"),
            ("--color-bits", "9"),
            ("--chunk-bytes", "65535"),
            ("--chunk-bytes", "16777217"),
            ("--quality", "101"),
            ("--target-bitrate", "0"),
            ("--prediction", "v2"),
            ("--prediction", "v3"),
            ("--temporal-fit", "on"),
            ("--baseline", ""),
            ("--legacy-v3", ""),
        ] {
            assert!(
                EncodeOptions::default().argument(name, value).is_err(),
                "{name} {value}"
            );
        }
    }
}
