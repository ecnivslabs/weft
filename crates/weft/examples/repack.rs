use std::{
    fs::{self, File, OpenOptions},
    io::{self, Seek, SeekFrom, Write},
    path::Path,
    time::Instant,
};
use weft::{archive::Archive, scene};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if arguments.len() != 3 || !["4", "5", "6"].contains(&arguments[2].as_str()) {
        return Err(
            "Supply input SCI, new output SCI, and output container version (4, 5 or 6)".into(),
        );
    }
    let destination = Path::new(&arguments[1]);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let result = repack(&arguments[0], &mut output, arguments[2].parse()?);
    drop(output);
    match result {
        Ok(report) => println!("{report}"),
        Err(error) => {
            if let Err(cleanup) = fs::remove_file(destination) {
                return Err(io::Error::new(
                    error.kind(),
                    format!("{error}; cannot remove incomplete output: {cleanup}"),
                )
                .into());
            }
            return Err(error.into());
        }
    }
    Ok(())
}

fn repack(source: &str, output: &mut File, version: u16) -> io::Result<serde_json::Value> {
    let started = Instant::now();
    let mut archive = Archive::open(File::open(source)?)?;
    let mut metadata = archive.metadata().clone();
    let mut records: Vec<_> = archive.records().cloned().collect();
    let index = 32 + 4096;
    output.seek(SeekFrom::Start(index + records.len() as u64 * 48))?;
    let mut checksum = crc32fast::Hasher::new();
    let mut events = 0;
    for record in &mut records {
        let payload = if record.quality == 0 {
            archive.payload(0, record.chunk)?
        } else {
            let mut chunk = archive.video_chunk(record.quality, record.chunk)?;
            let mut previous: Option<Vec<u8>> = None;
            let mut payload = Vec::new();
            while let Some(cells) = chunk.next_frame()? {
                let (_, duration) = chunk.presentation().unwrap();
                let packet = scene::packet_for_version(
                    &cells,
                    previous.as_deref(),
                    usize::from(record.width),
                    usize::from(record.height),
                    version,
                )?;
                payload.extend(duration.to_le_bytes());
                payload.extend(packet);
                if payload.len() > 16 * 1024 * 1024 {
                    return Err(io::Error::other("Repacked chunk exceeds 16 MiB"));
                }
                checksum.update(&duration.to_le_bytes());
                checksum.update(&cells);
                events += 1;
                previous = Some(cells);
            }
            payload
        };
        record.offset = output.stream_position()?;
        record.length = payload.len() as u32;
        record.checksum = crc32fast::hash(&payload);
        output.write_all(&payload)?;
    }
    let size = output.stream_position()?;
    metadata["version"] = version.into();
    metadata["video"]["packetFormat"] = weft::format::packet_format(version).unwrap().into();
    let audio: u64 = records
        .iter()
        .filter(|r| r.quality == 0)
        .map(|r| u64::from(r.length))
        .sum();
    let visual: u64 = records
        .iter()
        .filter(|r| r.quality != 0)
        .map(|r| u64::from(r.length))
        .sum();
    let shared = size - visual;
    let duration = metadata["duration"].as_f64().unwrap();
    for quality in metadata["qualities"].as_array_mut().unwrap() {
        let bytes: u64 = records
            .iter()
            .filter(|r| Some(u64::from(r.quality)) == quality["height"].as_u64())
            .map(|r| u64::from(r.length))
            .sum();
        quality["videoBytes"] = bytes.into();
        quality["deliveryBitrate"] = ((bytes + shared) as f64 * 8.0 / duration).into();
        quality
            .as_object_mut()
            .unwrap()
            .remove("independentVideoBytes");
    }
    let json = serde_json::to_vec(&metadata)?;
    if json.len() > 4096 || size > 64 * 1024_u64.pow(3) {
        return Err(io::Error::other("Repacked archive exceeds SCI limits"));
    }
    output.seek(SeekFrom::Start(0))?;
    output.write_all(b"SCIV")?;
    output.write_all(&version.to_le_bytes())?;
    output.write_all(&u16::from(!metadata["audio"].is_null()).to_le_bytes())?;
    output.write_all(&(json.len() as u32).to_le_bytes())?;
    output.write_all(&(records.len() as u32).to_le_bytes())?;
    output.write_all(&index.to_le_bytes())?;
    output.write_all(&size.to_le_bytes())?;
    output.write_all(&json)?;
    output.seek(SeekFrom::Start(index))?;
    for record in records {
        for value in [record.quality, record.width, record.height, record.frames] {
            output.write_all(&value.to_le_bytes())?;
        }
        output.write_all(&record.first.to_le_bytes())?;
        output.write_all(&record.samples.to_le_bytes())?;
        output.write_all(&record.offset.to_le_bytes())?;
        output.write_all(&record.length.to_le_bytes())?;
        output.write_all(&record.checksum.to_le_bytes())?;
        output.write_all(&record.start_us.to_le_bytes())?;
        output.write_all(&record.end_us.to_le_bytes())?;
    }
    output.sync_all()?;
    Ok(
        serde_json::json!({"inputBytes":archive.size(),"outputBytes":size,"visualBytes":visual,"audioBytes":audio,"events":events,"presentationCrc32":checksum.finalize(),"seconds":started.elapsed().as_secs_f64()}),
    )
}
