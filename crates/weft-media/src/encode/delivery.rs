use super::{record, Chunk, TimedRecord, Timeline};
use crate::EncodeOptions;
use std::{
    fs::File,
    io::{self, BufReader, Read, Seek},
    path::PathBuf,
    thread,
};
use weft::{
    packet::{self, FrameSpec},
    scene,
    timing::Quality,
};

const LIMIT: usize = 16 * 1024 * 1024;

fn flush(
    file: &mut File,
    payloads: &mut [Vec<u8>],
    qualities: &[Quality],
    chunk: Chunk,
    records: &mut Vec<TimedRecord>,
    chunks: &mut Vec<Chunk>,
) -> io::Result<()> {
    for (payload, quality) in payloads.iter_mut().zip(qualities) {
        records.push(record(file, Some(quality), &chunk, 0, payload)?);
        payload.clear();
    }
    if file.stream_position()? > 64 * 1024_u64.pow(3) || records.len() > 100000 {
        return Err(io::Error::other("SCI archive or index exceeds limits"));
    }
    eprintln!(
        "Packed delivery: {} frames, {} chunks",
        chunk.first + chunk.frames,
        chunks.len() + 1
    );
    chunks.push(chunk);
    Ok(())
}

pub(super) fn pack(
    file: &mut File,
    paths: &[PathBuf],
    qualities: &[Quality],
    timeline: &mut Timeline,
    options: &EncodeOptions,
    maximum: usize,
) -> io::Result<Vec<TimedRecord>> {
    if maximum == 0 || maximum > LIMIT {
        return Err(io::Error::other("Invalid delivery bound"));
    }
    let mut readers: Vec<_> = paths
        .iter()
        .map(|path| File::open(path).map(BufReader::new))
        .collect::<io::Result<_>>()?;
    let mut previous = vec![None; qualities.len()];
    let mut payloads = vec![Vec::new(); qualities.len()];
    let mut records = Vec::new();
    let mut chunks = Vec::new();
    let mut first = 0;
    let mut start_us = 0;
    let mut time_us = 0;
    for (frame, &duration) in timeline.durations.iter().enumerate() {
        let mut cells = Vec::new();
        let mut independent = Vec::new();
        let mut packets = Vec::new();
        let encoded = thread::scope(|scope| {
            let handles: Vec<_> = readers
                .iter_mut()
                .zip(qualities)
                .zip(&previous)
                .map(|((reader, quality), previous)| {
                    scope.spawn(move || {
                        let mut header = [0; 9];
                        reader.read_exact(&mut header)?;
                        let declared =
                            u32::from_le_bytes(header[1..5].try_into().unwrap()) as usize;
                        let length = u32::from_le_bytes(header[5..9].try_into().unwrap()) as usize;
                        if length == 0 || length + 13 > LIMIT {
                            return Err(io::Error::other("Invalid staged ASCII packet"));
                        }
                        let mut bytes = vec![0; length];
                        reader.read_exact(&mut bytes)?;
                        let width = usize::from(quality.columns);
                        let height = usize::from(quality.rows);
                        let decoded = packet::decode(
                            header[0],
                            declared,
                            &bytes,
                            None,
                            FrameSpec {
                                width,
                                height,
                                font: "ascii-3x4-v2",
                            },
                        )?;
                        let mut original = header.to_vec();
                        original.extend(bytes);
                        let encoded = if let Some(previous) = previous.as_deref() {
                            let predicted =
                                scene::packet_predicted(&decoded, previous, width, height)?;
                            if predicted.len() < original.len() {
                                predicted
                            } else {
                                original.clone()
                            }
                        } else {
                            original.clone()
                        };
                        Ok::<_, io::Error>((decoded, original, encoded))
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .map_err(|_| io::Error::other("ASCII packing worker failed"))?
                })
                .collect::<io::Result<Vec<_>>>()
        })?;
        for (decoded, original, encoded) in encoded {
            cells.push(decoded);
            independent.push(original);
            packets.push(encoded);
        }
        let exceeds = |budget| {
            packets
                .iter()
                .zip(&payloads)
                .any(|(packet, payload)| payload.len() + packet.len() + 4 > budget)
        };
        let full = frame > first
            && (time_us - start_us >= 1_000_000
                || exceeds(maximum)
                || (time_us - start_us >= 20_000 && exceeds(options.chunk_bytes.min(maximum))));
        if full {
            flush(
                file,
                &mut payloads,
                qualities,
                Chunk {
                    first,
                    frames: frame - first,
                    start_us,
                    end_us: time_us,
                },
                &mut records,
                &mut chunks,
            )?;
            first = frame;
            start_us = time_us;
            packets = independent;
        }
        for (index, packet) in packets.into_iter().enumerate() {
            payloads[index].extend_from_slice(&duration.to_le_bytes());
            payloads[index].extend(packet);
            if payloads[index].len() > maximum {
                return Err(io::Error::other("SCI frame exceeds delivery bound"));
            }
        }
        previous = cells.into_iter().map(Some).collect();
        time_us += u64::from(duration);
    }
    flush(
        file,
        &mut payloads,
        qualities,
        Chunk {
            first,
            frames: timeline.durations.len() - first,
            start_us,
            end_us: time_us,
        },
        &mut records,
        &mut chunks,
    )?;
    for reader in &mut readers {
        if reader.read(&mut [0; 1])? != 0 {
            return Err(io::Error::other("Staged ASCII timeline disagrees"));
        }
    }
    timeline.chunks = chunks;
    Ok(records)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{SeekFrom, Write};
    use weft::timing::Rate;

    #[test]
    fn byte_bound_splits_all_renditions_without_changing_frames_or_seek_references() {
        let directory = std::env::temp_dir().join(format!("weft-delivery-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let qualities = vec![
            Quality {
                height: 4,
                columns: 6,
                rows: 4,
            },
            Quality {
                height: 8,
                columns: 6,
                rows: 8,
            },
        ];
        let mut paths = Vec::new();
        let mut expected = Vec::new();
        for (index, quality) in qualities.iter().enumerate() {
            let path = directory.join(format!("{index}.frames"));
            let mut file = File::create(&path).unwrap();
            let mut frames = Vec::new();
            for frame in 0..12 {
                let mut cells = Vec::new();
                for cell in 0..(quality.columns / 3) * (quality.rows / 4) {
                    let mut composition = [0; 28];
                    composition[3] = b' ';
                    composition[4..7].copy_from_slice(&[frame * 19, cell as u8 * 31, 37]);
                    composition[7] = 1;
                    composition[8..13].copy_from_slice(&[b'/', 0, 121, frame * 13, 200]);
                    cells.extend_from_slice(&composition);
                }
                file.write_all(
                    &scene::packet(
                        &cells,
                        None,
                        usize::from(quality.columns),
                        usize::from(quality.rows),
                    )
                    .unwrap(),
                )
                .unwrap();
                frames.push(cells);
            }
            paths.push(path);
            expected.push(frames);
        }
        let mut timeline = Timeline {
            durations: vec![16667; 12],
            sources: (0..12).collect(),
            source_frames: 12,
            chunks: Vec::new(),
            duration_us: 200004,
            first_pts: 0.0,
            rate: Rate::new(60, 1).unwrap(),
            select_filter: String::new(),
        };
        for (maximum, preferred) in [(160, 16 * 1024 * 1024), (10000, 80)] {
            let mut file = File::create(directory.join("delivery")).unwrap();
            let options = EncodeOptions {
                chunk_bytes: preferred,
                ..EncodeOptions::default()
            };
            let records = pack(
                &mut file,
                &paths,
                &qualities,
                &mut timeline,
                &options,
                maximum,
            )
            .unwrap();
            drop(file);
            assert!(timeline.chunks.len() > 1);
            if preferred == 80 {
                assert!(timeline.chunks[..timeline.chunks.len() - 1]
                    .iter()
                    .all(|chunk| chunk.frames >= 2));
            }
            assert_eq!(records.len(), timeline.chunks.len() * qualities.len());
            let mut file = File::open(directory.join("delivery")).unwrap();
            for (chunk_index, chunk) in timeline.chunks.iter().enumerate() {
                for (quality_index, quality) in qualities.iter().enumerate() {
                    let record = &records[chunk_index * qualities.len() + quality_index];
                    assert!(record.record.length as usize <= maximum);
                    assert_eq!(record.start_us, chunk.start_us);
                    assert_eq!(record.end_us, chunk.end_us);
                    file.seek(SeekFrom::Start(record.record.offset)).unwrap();
                    let mut payload = vec![0; record.record.length as usize];
                    file.read_exact(&mut payload).unwrap();
                    let mut offset = 0;
                    let mut previous = None;
                    for expected_frame in
                        &expected[quality_index][chunk.first..chunk.first + chunk.frames]
                    {
                        assert_eq!(
                            u32::from_le_bytes(payload[offset..offset + 4].try_into().unwrap()),
                            16667
                        );
                        offset += 4;
                        let tag = payload[offset];
                        let declared =
                            u32::from_le_bytes(payload[offset + 1..offset + 5].try_into().unwrap())
                                as usize;
                        let length =
                            u32::from_le_bytes(payload[offset + 5..offset + 9].try_into().unwrap())
                                as usize;
                        offset += 9;
                        let decoded = packet::decode(
                            tag,
                            declared,
                            &payload[offset..offset + length],
                            previous.as_deref(),
                            FrameSpec {
                                width: 6,
                                height: usize::from(quality.rows),
                                font: "ascii-3x4-v2",
                            },
                        )
                        .unwrap();
                        assert_eq!(&decoded, expected_frame);
                        previous = Some(decoded);
                        offset += length;
                    }
                    assert_eq!(offset, payload.len());
                }
            }
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
