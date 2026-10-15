use flate2::{write::ZlibEncoder, Compression};
use std::io::{self, Write};

struct Output {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > self.limit {
            self.exceeded = true;
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "SCI packet candidate exceeds best size",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(super) fn select(best: &mut Vec<u8>, tag: u8, data: &[u8]) -> io::Result<()> {
    let length = u32::try_from(data.len()).map_err(|_| super::invalid())?;
    let limit = if best.is_empty() {
        usize::MAX
    } else {
        best.len()
    };
    if limit <= 9 {
        return Ok(());
    }
    let output = Output {
        bytes: Vec::new(),
        limit: limit - 10,
        exceeded: false,
    };
    let mut encoder = ZlibEncoder::new(output, Compression::new(3));
    // Appended zlib bytes cannot shrink; losing candidates can stop before consuming all input.
    if let Err(error) = encoder.write_all(data).and_then(|_| encoder.try_finish()) {
        return if encoder.get_ref().exceeded {
            Ok(())
        } else {
            Err(error)
        };
    }
    let compressed = encoder.finish()?.bytes;
    best.clear();
    best.push(tag);
    best.extend_from_slice(&length.to_le_bytes());
    best.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
    best.extend(compressed);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_candidates_match_complete_zlib_streams_and_preserve_strict_ties() {
        let mut state = 8173_u32;
        for count in [0, 1, 100, 32768, 262144] {
            for random in [false, true] {
                let data: Vec<_> = (0..count)
                    .map(|_| {
                        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                        if random {
                            (state >> 24) as u8
                        } else {
                            87
                        }
                    })
                    .collect();
                let mut reference = ZlibEncoder::new(Vec::new(), Compression::new(3));
                reference.write_all(&data).unwrap();
                let mut packet = vec![10];
                packet.extend((data.len() as u32).to_le_bytes());
                let bytes = reference.finish().unwrap();
                packet.extend((bytes.len() as u32).to_le_bytes());
                packet.extend(bytes);
                let mut initial = Vec::new();
                select(&mut initial, 10, &data).unwrap();
                assert_eq!(initial, packet);
                for limit in [1, 9, 10, packet.len() - 1, packet.len(), packet.len() + 1] {
                    let mut best = vec![123; limit];
                    let previous = best.clone();
                    select(&mut best, 10, &data).unwrap();
                    assert_eq!(
                        best,
                        if packet.len() < limit {
                            &packet
                        } else {
                            &previous
                        }
                        .as_slice()
                    );
                }
            }
        }
    }
}
