use flate2::read::ZlibDecoder;
use std::{fs::File, io::Read, time::Instant};
use weft::{archive::Archive, cells, scene};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args().skip(1);
    let path = arguments
        .next()
        .ok_or("Supply an SCI archive and rendition height")?;
    let height = arguments
        .next()
        .ok_or("Supply rendition height")?
        .parse::<u16>()?;
    let mut archive = Archive::open(File::open(path)?)?;
    let record = archive
        .records()
        .find(|record| record.quality == height)
        .ok_or("Rendition missing")?
        .clone();
    let mut frames = archive.video_chunk(height, record.chunk)?;
    while frames.next_frame()?.is_some() {}
    let payload = archive.payload(height, record.chunk)?;
    let mut packets = Vec::new();
    let mut offset = 0;
    while offset < payload.len() {
        offset += 4;
        let header = payload
            .get(offset..offset + 9)
            .ok_or("Truncated packet header")?;
        let tag = header[0];
        let declared = u32::from_le_bytes(header[1..5].try_into()?) as usize;
        let length = u32::from_le_bytes(header[5..9].try_into()?) as usize;
        if declared > cells::dimensions(record.width as usize, record.height as usize)? * 38 + 1024
        {
            return Err("Oversized packet".into());
        }
        offset += 9;
        let bytes = payload
            .get(offset..offset + length)
            .ok_or("Truncated packet")?;
        packets.push((tag, declared, bytes));
        offset += length;
    }
    let mut samples = Vec::new();
    for iteration in 0..4 {
        let mut previous = None;
        let mut times = [0.0; 3];
        for &(tag, declared, bytes) in &packets {
            let begin = Instant::now();
            let mut data = Vec::new();
            ZlibDecoder::new(bytes)
                .take(declared as u64 + 1)
                .read_to_end(&mut data)?;
            times[0] += begin.elapsed().as_secs_f64();
            assert_eq!(data.len(), declared);
            let begin = Instant::now();
            let frame = scene::decode(
                tag,
                &data,
                previous.as_deref(),
                record.width as usize,
                record.height as usize,
            )?;
            times[1] += begin.elapsed().as_secs_f64();
            let begin = Instant::now();
            let rgb = scene::render(&frame, record.width as usize, record.height as usize)?;
            times[2] += begin.elapsed().as_secs_f64();
            std::hint::black_box(rgb);
            previous = Some(frame);
        }
        if iteration > 0 {
            samples.push(times.map(|seconds| seconds * 1000.0 / packets.len() as f64));
        }
    }
    println!(
        "{}",
        serde_json::json!({"frames":packets.len(), "tags":packets.iter().map(|packet|packet.0).collect::<Vec<_>>(), "stages":["inflate","compositionDecode","rgbRender"], "millisecondsPerFrame":samples})
    );
    Ok(())
}
