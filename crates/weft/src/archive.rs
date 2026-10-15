use std::collections::BTreeMap;
use std::io::{self, Read, Seek, SeekFrom};

use serde_json::Value;

const MAX_CHUNK: usize = 16 * 1024 * 1024;

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid SCI archive")
}

fn number(value: &Value) -> io::Result<u64> {
    value.as_u64().ok_or_else(invalid)
}
fn u16_at(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}
fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

#[derive(Clone, Debug)]
pub struct Record {
    pub quality: u16,
    pub width: u16,
    pub height: u16,
    pub frames: u16,
    pub first: u32,
    pub samples: u32,
    pub offset: u64,
    pub length: u32,
    pub checksum: u32,
    pub chunk: u32,
    pub start_us: u64,
    pub end_us: u64,
}

/// Seekable SCI reader. Metadata and index are validated before any payload allocation.
pub struct Archive<R> {
    reader: R,
    metadata: Value,
    records: BTreeMap<(u16, u32), Record>,
    size: u64,
}

impl<R: Read + Seek> Archive<R> {
    pub fn open(mut reader: R) -> io::Result<Self> {
        let size = reader.seek(SeekFrom::End(0))?;
        reader.seek(SeekFrom::Start(0))?;
        let mut header = [0; 32];
        reader.read_exact(&mut header)?;
        let audio = u16_at(&header, 6);
        let length = u32_at(&header, 8) as usize;
        let count = u32_at(&header, 12) as usize;
        let index = u64_at(&header, 16);
        let version = u16_at(&header, 4);
        let record_bytes = 48;
        if &header[..4] != b"SCIV"
            || crate::format::packet_format(version).is_none()
            || audio > 1
            || !(2..=4096).contains(&length)
            || !(1..=100000).contains(&count)
            || size != u64_at(&header, 24)
            || size > 64 * 1024_u64.pow(3)
            || index < 32 + length as u64
            || index > 65536
            || index + count as u64 * record_bytes >= size
        {
            return Err(invalid());
        }
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes)?;
        let metadata: Value = serde_json::from_slice(&bytes)?;
        if metadata["version"] != version {
            return Err(invalid());
        }
        crate::archive_timing::validate_metadata(&metadata, audio)?;
        let frames = number(&metadata["frames"])? as u32;
        let chunks = number(&metadata["chunks"])? as u32;
        let qualities = metadata["qualities"].as_array().ok_or_else(invalid)?;
        if count != chunks as usize * (qualities.len() + usize::from(audio)) {
            return Err(invalid());
        }
        reader.seek(SeekFrom::Start(index))?;
        let mut records = BTreeMap::new();
        let mut end = index + count as u64 * record_bytes;
        let mut counters = BTreeMap::<u16, u32>::new();
        for _ in 0..count {
            let mut bytes = vec![0; record_bytes as usize];
            reader.read_exact(&mut bytes)?;
            let quality = u16_at(&bytes, 0);
            let chunk = *counters.entry(quality).or_default();
            *counters.get_mut(&quality).unwrap() += 1;
            let record = Record {
                quality: u16_at(&bytes, 0),
                width: u16_at(&bytes, 2),
                height: u16_at(&bytes, 4),
                frames: u16_at(&bytes, 6),
                first: u32_at(&bytes, 8),
                samples: u32_at(&bytes, 12),
                offset: u64_at(&bytes, 16),
                length: u32_at(&bytes, 24),
                checksum: u32_at(&bytes, 28),
                chunk,
                start_us: u64_at(&bytes, 32),
                end_us: u64_at(&bytes, 40),
            };
            if record.offset < end
                || record.length == 0
                || record.length as usize > MAX_CHUNK
                || record
                    .offset
                    .checked_add(u64::from(record.length))
                    .is_none_or(|end| end > size)
                || record.first >= frames
            {
                return Err(invalid());
            }
            end = record.offset + u64::from(record.length);
            if record.quality == 0 {
                let expected = crate::archive_timing::samples(record.end_us)?
                    .checked_sub(crate::archive_timing::samples(record.start_us)?)
                    .ok_or_else(invalid)?;
                if audio == 0
                    || record.width != 0
                    || record.height != 0
                    || record.frames != 0
                    || record.samples as usize != expected
                {
                    return Err(invalid());
                }
            } else {
                let quality = qualities
                    .iter()
                    .find(|value| value["height"].as_u64() == Some(u64::from(record.quality)))
                    .ok_or_else(invalid)?;
                if number(&quality["columns"])? != u64::from(record.width)
                    || number(&quality["rows"])? != u64::from(record.height)
                    || record.frames == 0
                    || record.frames > 240
                    || record.samples != 0
                {
                    return Err(invalid());
                }
            }
            if records
                .insert((record.quality, record.chunk), record)
                .is_some()
            {
                return Err(invalid());
            }
        }
        crate::archive_timing::validate_records(&metadata, &records)?;
        if end != size {
            return Err(invalid());
        }
        Ok(Self {
            reader,
            metadata,
            records,
            size,
        })
    }

    pub fn metadata(&self) -> &Value {
        &self.metadata
    }
    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn records(&self) -> impl Iterator<Item = &Record> {
        self.records.values()
    }

    /// Load only the requested chunk and verify its checksum.
    pub fn payload(&mut self, quality: u16, chunk: u32) -> io::Result<Vec<u8>> {
        let record = self.records.get(&(quality, chunk)).ok_or_else(invalid)?;
        self.reader.seek(SeekFrom::Start(record.offset))?;
        let mut bytes = vec![0; record.length as usize];
        self.reader.read_exact(&mut bytes)?;
        if crc32fast::hash(&bytes) != record.checksum {
            return Err(invalid());
        }
        Ok(bytes)
    }

    /// Return a sequential decoder holding one compressed chunk and one reference frame.
    pub fn video_chunk(&mut self, quality: u16, chunk: u32) -> io::Result<Frames> {
        let record = self
            .records
            .get(&(quality, chunk))
            .cloned()
            .ok_or_else(invalid)?;
        if quality == 0 {
            return Err(invalid());
        }
        let font = self.metadata["video"]["font"]
            .as_str()
            .ok_or_else(invalid)?
            .to_owned();
        Ok(Frames {
            payload: self.payload(quality, chunk)?,
            record,
            font,
            offset: 0,
            decoded: 0,
            previous: None,
            time_us: 0,
            last_timing: None,
            version: self.metadata["version"].as_u64().unwrap() as u16,
        })
    }

    /// Seek by frame number. Each chunk begins with an independently decodable frame.
    pub fn frame(&mut self, quality: u16, frame: u32) -> io::Result<Vec<u8>> {
        if u64::from(frame) >= number(&self.metadata["frames"])? {
            return Err(invalid());
        }
        let record = self
            .records
            .values()
            .find(|record| {
                record.quality == quality
                    && frame >= record.first
                    && frame < record.first + u32::from(record.frames)
            })
            .ok_or_else(invalid)?;
        let skip = frame - record.first;
        let mut chunk = self.video_chunk(quality, record.chunk)?;
        for _ in 0..skip {
            chunk.next_frame()?.ok_or_else(invalid)?;
        }
        chunk.next_frame()?.ok_or_else(invalid)
    }
}

pub struct Frames {
    payload: Vec<u8>,
    record: Record,
    font: String,
    offset: usize,
    decoded: u16,
    previous: Option<Vec<u8>>,
    time_us: u64,
    last_timing: Option<(u64, u32)>,
    version: u16,
}

impl Frames {
    pub fn record(&self) -> &Record {
        &self.record
    }
    /// Presentation timestamp and duration of the last decoded SCI frame, in microseconds.
    pub fn presentation(&self) -> Option<(u64, u32)> {
        self.last_timing
    }

    pub fn next_frame(&mut self) -> io::Result<Option<Vec<u8>>> {
        if self.decoded == self.record.frames {
            if self.offset != self.payload.len() {
                return Err(invalid());
            }
            return Ok(None);
        }
        let duration = {
            let bytes = self
                .payload
                .get(self.offset..self.offset + 4)
                .ok_or_else(invalid)?;
            self.offset += 4;
            let duration = u32_at(bytes, 0);
            if duration == 0
                || duration > 1_000_000
                || self.time_us + u64::from(duration) > self.record.end_us - self.record.start_us
            {
                return Err(invalid());
            }
            duration
        };
        let header = self
            .payload
            .get(self.offset..self.offset + 9)
            .ok_or_else(invalid)?;
        let tag = header[0];
        if !crate::format::supports_tag(self.version, tag) {
            return Err(invalid());
        }
        let declared = u32_at(header, 1) as usize;
        let length = u32_at(header, 5) as usize;
        self.offset += 9;
        let bytes = self
            .payload
            .get(self.offset..self.offset + length)
            .ok_or_else(invalid)?;
        let cells = crate::packet::decode(
            tag,
            declared,
            bytes,
            self.previous.as_deref(),
            crate::packet::FrameSpec {
                width: usize::from(self.record.width),
                height: usize::from(self.record.height),
                font: &self.font,
            },
        )?;
        self.last_timing = Some((self.record.start_us + self.time_us, duration));
        self.time_us += u64::from(duration);
        self.offset += length;
        self.decoded += 1;
        if self.decoded == self.record.frames
            && (self.offset != self.payload.len()
                || self.time_us != self.record.end_us - self.record.start_us)
        {
            return Err(invalid());
        }
        self.previous = Some(cells.clone());
        Ok(Some(cells))
    }
}
