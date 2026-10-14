use std::{io, sync::Arc, thread};
use weft::{cells, scene};

mod identity;
use identity::Action;

pub(crate) struct Stager {
    pub(crate) workers: Vec<scene::Encoder>,
    width: usize,
    height: usize,
}

impl Stager {
    pub(crate) fn new(
        width: usize,
        height: usize,
        options: scene::Options,
        color_bits: u8,
    ) -> io::Result<Self> {
        let threads = thread::available_parallelism()
            .map_or(1, usize::from)
            .min(8);
        let mut stager = Self::with_threads(width, height, options, threads)?;
        for worker in &mut stager.workers {
            worker.set_color_bits(color_bits)?;
        }
        Ok(stager)
    }

    fn with_threads(
        width: usize,
        height: usize,
        options: scene::Options,
        threads: usize,
    ) -> io::Result<Self> {
        cells::dimensions(width, height)?;
        let workers = (0..threads)
            .map(|_| scene::Encoder::new(options))
            .collect::<io::Result<_>>()?;
        Ok(Self {
            workers,
            width,
            height,
        })
    }

    pub(crate) fn encode(
        &mut self,
        frames: &[Arc<Vec<u8>>],
    ) -> io::Result<Vec<(Vec<u8>, Vec<u8>)>> {
        if frames.is_empty()
            || frames.len() > self.workers.len()
            || frames
                .iter()
                .any(|rgb| rgb.len() != self.width * self.height * 3)
        {
            return Err(io::Error::other("Invalid source frame batch"));
        }
        let width = self.width;
        let height = self.height;
        let actions = identity::plan(frames);
        let mut mapped = thread::scope(|scope| {
            let handles: Vec<_> = self
                .workers
                .iter_mut()
                .zip(frames)
                .enumerate()
                .map(|(index, (encoder, pixels))| {
                    (actions[index] == Action::Fit).then(|| {
                        scope.spawn(move || {
                            let cells = encoder.map_frame(pixels, width, height)?;
                            let packet = scene::packet(&cells, None, width, height)?;
                            if packet.len() + 4 > 16 * 1024 * 1024 {
                                return Err(io::Error::other("SCI frame exceeds 16 MiB"));
                            }
                            Ok((cells, packet))
                        })
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .map(|handle| {
                            handle
                                .join()
                                .map_err(|_| io::Error::other("ASCII staging worker failed"))?
                        })
                        .transpose()
                })
                .collect::<io::Result<Vec<Option<(Vec<u8>, Vec<u8>)>>>>()
        })?;
        for (index, action) in actions.iter().enumerate() {
            if let Action::Clone(first) = action {
                mapped[index] = mapped[*first].clone();
            }
        }
        Ok(mapped.into_iter().map(Option::unwrap).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_parallel_fitting_preserves_sequential_cells_packets_and_source_identity() {
        let (width, height) = (24, 32);
        let frames: Vec<Arc<Vec<u8>>> = (0..4)
            .map(|offset| {
                Arc::new(
                    (0..width * height * 3)
                        .map(|index| ((index * 37 + offset * 19) % 256) as u8)
                        .collect(),
                )
            })
            .collect();
        let mut input = frames.clone();
        input[1] = input[0].clone();
        let options = scene::Options::default();
        let mut parallel = Stager::with_threads(width, height, options, 4).unwrap();
        let mut sequential = scene::Encoder::new(options).unwrap();
        for _ in 0..2 {
            let actual = parallel.encode(&input).unwrap();
            for (source, (cells, packet)) in input.iter().zip(actual) {
                let expected = sequential.map_frame(source, width, height).unwrap();
                assert_eq!(cells, expected);
                assert_eq!(
                    packet,
                    scene::packet(&expected, None, width, height).unwrap()
                );
            }
        }
        assert!(parallel.encode(&[]).is_err());
        assert!(parallel.encode(&[Arc::new(vec![0; 3])]).is_err());
    }
}
