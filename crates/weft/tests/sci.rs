use serde_json::json;
use std::io::{self, Cursor, Read, Seek, SeekFrom};
use weft::{archive::Archive, scene};

fn fixture() -> Vec<u8> {
    fixture_codec("sci-ascii-scene-v1")
}

fn fixture_codec(codec: &str) -> Vec<u8> {
    fixture_version(codec, 4, 4)
}

fn fixture_version(codec: &str, version: u16, packet_version: u16) -> Vec<u8> {
    let packet_format = if version == 4 {
        "ascii-scene-zlib"
    } else {
        "ascii-scene-fields-zlib"
    };
    let metadata = json!({"version":version,"timebase":1000000,"chunkSeconds":1,"fps":30,"fpsNumerator":30,"fpsDenominator":1,"chunkFrames":30,"chunks":2,"frames":3,"duration":1.1,
        "video":{"codec":codec,"packetFormat":packet_format,"font":"ascii-3x4-v2","cellWidth":3,"cellHeight":4,"cellBytes":28,"glyphTransform":"reflect-xy-v1"},
        "audio":null,"qualities":[{"height":4,"columns":3,"rows":4}]});
    let metadata = serde_json::to_vec(&metadata).unwrap();
    let mut encoder = scene::Encoder::new(scene::Options::default()).unwrap();
    let a = encoder.map_frame(&[37, 119, 201].repeat(12), 3, 4).unwrap();
    let b = encoder.map_frame(&[201, 37, 119].repeat(12), 3, 4).unwrap();
    let mut first = 33333_u32.to_le_bytes().to_vec();
    first.extend(scene::packet_for_version(&a, None, 3, 4, packet_version).unwrap());
    first.extend(966667_u32.to_le_bytes());
    first.extend(scene::packet_for_version(&b, Some(&a), 3, 4, packet_version).unwrap());
    let mut last = 100000_u32.to_le_bytes().to_vec();
    last.extend(scene::packet_for_version(&b, None, 3, 4, packet_version).unwrap());
    let index = 32 + metadata.len() as u64;
    let mut archive = vec![0; 32];
    archive[..4].copy_from_slice(b"SCIV");
    archive[4..6].copy_from_slice(&version.to_le_bytes());
    archive[8..12].copy_from_slice(&(metadata.len() as u32).to_le_bytes());
    archive[12..16].copy_from_slice(&2_u32.to_le_bytes());
    archive[16..24].copy_from_slice(&index.to_le_bytes());
    archive.extend(metadata);
    let mut offset = index + 96;
    for (first_frame, count, start, end, bytes) in [
        (0_u32, 2_u16, 0_u64, 1000000_u64, &first),
        (2, 1, 1000000, 1100000, &last),
    ] {
        for value in [4_u16, 3, 4, count] {
            archive.extend(value.to_le_bytes());
        }
        archive.extend(first_frame.to_le_bytes());
        archive.extend(0_u32.to_le_bytes());
        archive.extend(offset.to_le_bytes());
        archive.extend((bytes.len() as u32).to_le_bytes());
        archive.extend(crc32fast::hash(bytes).to_le_bytes());
        archive.extend(start.to_le_bytes());
        archive.extend(end.to_le_bytes());
        offset += bytes.len() as u64;
    }
    archive.extend(first);
    archive.extend(last);
    let length = archive.len() as u64;
    archive[24..32].copy_from_slice(&length.to_le_bytes());
    archive
}

#[test]
fn current_archive_seeks_and_removed_versions_fail_explicitly() {
    let mut current = Archive::open(Cursor::new(fixture())).unwrap();
    for frame in [2, 0, 1, 2] {
        assert!(!current.frame(4, frame).unwrap().is_empty());
    }
    for codec in [
        "sci-ascii-scene-v2",
        "sci-ascii-scene-v3",
        "sci-ascii-scene-v4",
    ] {
        assert!(Archive::open(Cursor::new(fixture_codec(codec))).is_err());
    }
    for version in [1u16, 2, 3, 6] {
        let mut unsupported = fixture();
        unsupported[4..6].copy_from_slice(&version.to_le_bytes());
        assert!(Archive::open(Cursor::new(unsupported)).is_err());
    }
}

#[test]
fn compact_archives_preserve_v4_pixels_seeks_and_timestamps() {
    let mut legacy = Archive::open(Cursor::new(fixture())).unwrap();
    let mut compact =
        Archive::open(Cursor::new(fixture_version(weft::format::CODEC, 5, 5))).unwrap();
    for index in [2, 0, 1, 2] {
        assert_eq!(
            legacy.frame(4, index).unwrap(),
            compact.frame(4, index).unwrap()
        );
    }
    for chunk in [1, 0] {
        let mut a = legacy.video_chunk(4, chunk).unwrap();
        let mut b = compact.video_chunk(4, chunk).unwrap();
        loop {
            let first = a.next_frame().unwrap();
            let second = b.next_frame().unwrap();
            assert_eq!(first, second);
            assert_eq!(a.presentation(), b.presentation());
            if first.is_none() {
                break;
            }
        }
    }
    let mut disguised =
        Archive::open(Cursor::new(fixture_version(weft::format::CODEC, 4, 5))).unwrap();
    assert!(disguised.frame(4, 0).is_err());
}

struct SparseArchive {
    header: Vec<u8>,
    payload: Vec<u8>,
    offset: u64,
    position: u64,
}

impl Read for SparseArchive {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let size = self.offset + self.payload.len() as u64;
        if self.position >= size {
            return Ok(0);
        }
        let count = output
            .len()
            .min((size - self.position).min(usize::MAX as u64) as usize);
        for (index, byte) in output[..count].iter_mut().enumerate() {
            let position = self.position + index as u64;
            *byte = if position < self.header.len() as u64 {
                self.header[position as usize]
            } else if position >= self.offset {
                self.payload[(position - self.offset) as usize]
            } else {
                0
            };
        }
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for SparseArchive {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let position = match from {
            SeekFrom::Start(position) => i128::from(position),
            SeekFrom::Current(offset) => i128::from(self.position) + i128::from(offset),
            SeekFrom::End(offset) => {
                i128::from(self.offset + self.payload.len() as u64) + i128::from(offset)
            }
        };
        self.position = position
            .try_into()
            .map_err(|_| io::Error::other("Invalid sparse seek"))?;
        Ok(self.position)
    }
}

#[test]
fn large_archive_offsets_seek_without_file_sized_allocations_and_reject_the_limit() {
    for size in [17 * 1024_u64.pow(3), 64 * 1024_u64.pow(3) + 1] {
        let mut header = fixture();
        let index = u64::from_le_bytes(header[16..24].try_into().unwrap()) as usize;
        let original =
            u64::from_le_bytes(header[index + 16..index + 24].try_into().unwrap()) as usize;
        let payload = header.split_off(original);
        let offset = size - payload.len() as u64;
        for record in [index, index + 48] {
            let old = u64::from_le_bytes(header[record + 16..record + 24].try_into().unwrap());
            header[record + 16..record + 24]
                .copy_from_slice(&(old + offset - original as u64).to_le_bytes());
        }
        header[24..32].copy_from_slice(&size.to_le_bytes());
        let opened = Archive::open(SparseArchive {
            header,
            payload,
            offset,
            position: 0,
        });
        if size > 64 * 1024_u64.pow(3) {
            assert!(opened.is_err());
        } else {
            let mut archive = opened.unwrap();
            assert_eq!(
                scene::render(&archive.frame(4, 2).unwrap(), 3, 4).unwrap(),
                [201, 37, 119].repeat(12)
            );
        }
    }
}

#[test]
fn variable_timestamps_and_independent_seek_chunks_survive_decoding() {
    let mut archive = Archive::open(Cursor::new(fixture())).unwrap();
    let mut frames = archive.video_chunk(4, 0).unwrap();
    assert!(frames.next_frame().unwrap().is_some());
    assert_eq!(frames.presentation(), Some((0, 33333)));
    assert!(frames.next_frame().unwrap().is_some());
    assert_eq!(frames.presentation(), Some((33333, 966667)));
    assert!(frames.next_frame().unwrap().is_none());
    let cells = archive.frame(4, 2).unwrap();
    assert_eq!(
        scene::render(&cells, 3, 4).unwrap(),
        [201, 37, 119].repeat(12)
    );
}

#[test]
fn timeline_validation_rejects_gaps_overlaps_and_inconsistent_durations() {
    let valid = fixture();
    let index = u64::from_le_bytes(valid[16..24].try_into().unwrap()) as usize;
    for (offset, value) in [
        (index + 32, 1_u64),
        (index + 40, 0),
        (index + 48 + 32, 999999),
        (index + 48 + 40, 1100001),
    ] {
        let mut bad = valid.clone();
        bad[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        assert!(Archive::open(Cursor::new(bad)).is_err());
    }
    let mut bad = valid.clone();
    let payload = u64::from_le_bytes(bad[index + 16..index + 24].try_into().unwrap()) as usize;
    let length = u32::from_le_bytes(bad[index + 24..index + 28].try_into().unwrap()) as usize;
    bad[payload..payload + 4].copy_from_slice(&0_u32.to_le_bytes());
    let checksum = crc32fast::hash(&bad[payload..payload + length]);
    bad[index + 28..index + 32].copy_from_slice(&checksum.to_le_bytes());
    let mut archive = Archive::open(Cursor::new(bad)).unwrap();
    assert!(archive.frame(4, 0).is_err());
    for length in 0..valid.len() {
        assert!(Archive::open(Cursor::new(&valid[..length])).is_err());
    }
}

#[test]
fn spatial_and_motion_attribute_planes_reconstruct_exact_ascii_compositions() {
    let mut encoder = scene::Encoder::new(scene::Options::default()).unwrap();
    let first = encoder.map_frame(&[37, 119, 201].repeat(12), 3, 4).unwrap();
    let second = encoder.map_frame(&[201, 37, 119].repeat(12), 3, 4).unwrap();
    let mut expected = first.clone();
    expected.extend(second);
    let mut planes = Vec::new();
    for channel in 0..28 {
        planes.push(expected[channel]);
        planes.push(expected[28 + channel].wrapping_sub(expected[channel]));
    }
    assert_eq!(scene::decode(6, &planes, None, 6, 4).unwrap(), expected);
    let mut moved = expected.clone();
    moved.rotate_right(28);
    let mut data = vec![1, 0, 0, 0];
    for channel in 0..28 {
        data.push(moved[channel]);
        data.push(moved[28 + channel].wrapping_sub(expected[channel]));
    }
    assert_eq!(
        scene::decode(7, &data, Some(&expected), 6, 4).unwrap(),
        moved
    );
    assert!(scene::decode(7, &data, None, 6, 4).is_err());
    data[0] = 65;
    assert!(scene::decode(7, &data, Some(&expected), 6, 4).is_err());
}
