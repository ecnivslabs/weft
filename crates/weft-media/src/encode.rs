use crate::{
    output::{append, permit, publish, thumbnail, write_record, Record, Temporary},
    process::{strings, Decoder},
    timeline::{self, Chunk, Timeline},
    EncodeOptions,
};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Instant,
};
use weft::timing::Quality;

mod delivery;

struct TimedRecord {
    record: Record,
    start_us: u64,
    end_us: u64,
}
fn record(
    file: &mut std::fs::File,
    quality: Option<&Quality>,
    chunk: &Chunk,
    samples: u32,
    bytes: &[u8],
) -> io::Result<TimedRecord> {
    Ok(TimedRecord {
        record: append(
            file,
            quality,
            if quality.is_some() {
                chunk.frames as u16
            } else {
                0
            },
            chunk.first as u32,
            samples,
            bytes,
        )?,
        start_us: chunk.start_us,
        end_us: chunk.end_us,
    })
}

fn audio(
    source: &str,
    file: &mut std::fs::File,
    temporary: &Path,
    timeline: &Timeline,
) -> io::Result<Vec<TimedRecord>> {
    let filter = format!(
        "asetpts=PTS-{}/TB,aresample=async=1:first_pts=0,apad",
        timeline.first_pts
    );
    let duration = timeline.duration_us as f64 / 1_000_000.0;
    let mut arguments = strings(&[
        "-nostdin",
        "-v",
        "error",
        "-copyts",
        "-i",
        source,
        "-map",
        "0:a:0",
        "-vn",
        "-af",
        &filter,
        "-t",
        &duration.to_string(),
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "s16le",
        "pipe:1",
    ]);
    let mut decoder = Decoder::spawn(&arguments, false)?;
    let mut records = Vec::new();
    for (index, chunk) in timeline.chunks.iter().enumerate() {
        let samples = timeline::samples(chunk.end_us) - timeline::samples(chunk.start_us);
        let mut pcm = vec![0; samples * 4];
        if decoder.frame(&mut pcm)? != pcm.len() {
            return Err(io::Error::other("Incomplete synchronized audio"));
        }
        arguments = strings(&[
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "s16le",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-i",
            "pipe:0",
            "-c:a",
            "libopus",
            "-b:a",
            "96k",
            "-vbr",
            "on",
            "-compression_level",
            "10",
            "-f",
            "ogg",
        ]);
        arguments.push(temporary.to_string_lossy().into_owned());
        let mut encoder = Decoder::spawn(&arguments, true)?;
        encoder.stdin.take().unwrap().write_all(&pcm)?;
        encoder.finish()?;
        records.push(record(
            file,
            None,
            chunk,
            samples as u32,
            &fs::read(temporary)?,
        )?);
        if index % 10 == 0 || index + 1 == timeline.chunks.len() {
            eprintln!("Audio: {}/{} chunks", index + 1, timeline.chunks.len());
        }
    }
    decoder.finish()?;
    Ok(records)
}

pub fn encode_with_options(
    source: &str,
    destination: &Path,
    input: &Value,
    options: &EncodeOptions,
) -> io::Result<Value> {
    options.validate()?;
    if destination.try_exists()? || destination.with_extension("jpg").try_exists()? {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "SCI output or thumbnail already exists",
        ));
    }
    let _permit = permit()?;
    let width = input["width"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0);
    let height = input["height"]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0);
    let qualities = weft::timing::qualities_for(width, height, &options.heights)?;
    eprintln!("Reading source presentation timestamps");
    let mut timeline = timeline::probe(source, input, options)?;
    let has_audio = input["audio"].as_bool().unwrap_or(false);
    let reserved =
        (timeline.durations.len() * (qualities.len() + usize::from(has_audio))).min(100000);
    let count = timeline.chunks.len() * (qualities.len() + usize::from(has_audio));
    if count == 0 || count > 100000 {
        return Err(io::Error::other("SCI index exceeds limit"));
    }
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let suffix = format!(
        "{}.v4.{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let temporary = destination.with_extension(format!("{suffix}.sci.tmp"));
    let audio_path = destination.with_extension(format!("{suffix}.ogg"));
    let picture = destination.with_extension(format!("{suffix}.jpg"));
    let index_offset = 4128_u64;
    let mut cleanup = Temporary(Vec::new());
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    cleanup.0.push(temporary.clone());
    cleanup.reserve(&audio_path)?;
    cleanup.reserve(&picture)?;
    file.seek(SeekFrom::Start(index_offset + reserved as u64 * 48))?;
    let mut staged = Vec::new();
    let mut staging_size = 0_u64;
    let mut first_frame = None;
    let started = Instant::now();
    for quality in &qualities {
        let path = destination.with_extension(format!("{suffix}.{}.frames.tmp", quality.height));
        cleanup.reserve(&path)?;
        let mut stage = OpenOptions::new().write(true).open(&path)?;
        staged.push(path);
        let filter = format!(
            "{}scale={}:{}:flags=lanczos",
            timeline.select_filter, quality.columns, quality.rows
        );
        let arguments = strings(&[
            "-nostdin",
            "-v",
            "error",
            "-filter_threads",
            "1",
            "-threads",
            "2",
            "-copyts",
            "-i",
            source,
            "-map",
            "0:v:0",
            "-an",
            "-vf",
            &filter,
            "-fps_mode",
            "passthrough",
            "-pix_fmt",
            "rgb24",
            "-f",
            "rawvideo",
            "pipe:1",
        ]);
        let mut decoder = Decoder::spawn(&arguments, false)?;
        let w = usize::from(quality.columns);
        let h = usize::from(quality.rows);
        let mut stager = crate::staging::Stager::new(w, h, options.scene, options.color_bits)?;
        let mut loaded = None;
        let mut last_pixels = None;
        for (index, chunk) in timeline.chunks.iter().enumerate() {
            let mut frame = chunk.first;
            while frame < chunk.first + chunk.frames {
                let count = stager.workers.len().min(chunk.first + chunk.frames - frame);
                let mut frames = Vec::with_capacity(count);
                for source in &timeline.sources[frame..frame + count] {
                    if loaded != Some(*source) {
                        let mut rgb = vec![0; w * h * 3];
                        if decoder.frame(&mut rgb)? != rgb.len() {
                            return Err(io::Error::other("Source pixels and timestamps disagree"));
                        }
                        loaded = Some(*source);
                        last_pixels = Some(Arc::new(rgb));
                    }
                    frames.push(last_pixels.as_ref().unwrap().clone());
                }
                for (cells, packet) in stager.encode(&frames)? {
                    if first_frame.is_none() {
                        first_frame = Some(cells);
                    }
                    staging_size += packet.len() as u64;
                    if staging_size > 64 * 1024_u64.pow(3) {
                        return Err(io::Error::other("ASCII staging exceeds 64 GiB"));
                    }
                    stage.write_all(&packet)?;
                }
                frame += count;
            }

            eprintln!(
                "{}p: {}/{} frames, {}/{} chunks, {:.1}s elapsed",
                quality.height,
                chunk.first + chunk.frames,
                timeline.durations.len(),
                index + 1,
                timeline.chunks.len(),
                started.elapsed().as_secs_f64()
            );
        }
        let mut extra = [0; 1];
        if decoder.stdout.read(&mut extra)? != 0 {
            return Err(io::Error::other(
                "Source has more pixels than timestamped frames",
            ));
        }
        decoder.finish()?;
    }
    let mut records = delivery::pack(
        &mut file,
        &staged,
        &qualities,
        &mut timeline,
        options,
        16 * 1024 * 1024,
    )?;
    let count = timeline.chunks.len() * (qualities.len() + usize::from(has_audio));
    if count > reserved {
        return Err(io::Error::other("SCI index exceeds 100000 records"));
    }
    thumbnail(first_frame.as_ref().unwrap(), &qualities[0], &picture)?;
    if has_audio {
        records.extend(audio(source, &mut file, &audio_path, &timeline)?);
    }
    let total_size = file.stream_position()?;
    if total_size > 64 * 1024_u64.pow(3) || records.len() != count {
        return Err(io::Error::other("SCI archive exceeds limits"));
    }
    let duration = timeline.duration_us as f64 / 1_000_000.0;
    let shared_bytes = index_offset
        + count as u64 * 48
        + records
            .iter()
            .filter(|r| r.record.quality == 0)
            .map(|r| u64::from(r.record.length))
            .sum::<u64>();
    let independent_sizes: Vec<_> = staged
        .iter()
        .map(|path| {
            path.metadata()
                .map(|metadata| metadata.len() + timeline.durations.len() as u64 * 4)
        })
        .collect::<io::Result<_>>()?;
    let mut metadata = json!({"version":weft::format::VERSION, "timebase":1_000_000, "chunkSeconds":1, "chunks":timeline.chunks.len(), "chunkFrames":timeline.rate.fps().round() as u32,
        "fps":timeline.rate.fps(), "fpsNumerator":timeline.rate.numerator(), "fpsDenominator":timeline.rate.denominator(), "averageFps":timeline.source_frames as f64 / duration, "sourceFrames":timeline.source_frames,
        "duration":duration, "frames":timeline.durations.len(), "encoderProfile":options.fingerprint()?, "targetBitrate":options.target_bitrate,
        "video":{"codec":weft::format::CODEC,"mapper":weft::format::MAPPER,"packetFormat":weft::format::PACKET_FORMAT,"font":"ascii-3x4-v2","cellWidth":3,"cellHeight":4,"cellBytes":weft::scene::CELL_BYTES,"glyphTransform":"reflect-xy-v1"},
        "source":{"width":width,"height":height,"selectionCeilingNumerator":options.ceiling()?.numerator(),"selectionCeilingDenominator":options.ceiling()?.denominator(),"firstPts":timeline.first_pts}, "audio":if has_audio {json!({"codec":"opus","sampleRate":48000,"channels":2})} else {Value::Null},
        "qualities":qualities.iter().zip(&independent_sizes).map(|(q,independent)| {
            let bytes = records.iter().filter(|r| r.record.quality == q.height).map(|r| u64::from(r.record.length)).sum::<u64>();
            json!({"height":q.height,"columns":q.columns,"rows":q.rows,"videoBytes":bytes,"independentVideoBytes":independent,"deliveryBitrate":(bytes + shared_bytes) as f64 * 8.0 / duration})
        }).collect::<Vec<_>>()});
    metadata["video"]["colorBits"] = options.color_bits.into();
    metadata["deliveryChunkBytes"] = options.chunk_bytes.into();
    let json = serde_json::to_vec(&metadata)?;
    if json.len() > 4096 {
        return Err(io::Error::other("SCI metadata exceeds 4096 bytes"));
    }
    file.seek(SeekFrom::Start(0))?;
    file.write_all(b"SCIV")?;
    file.write_all(&weft::format::VERSION.to_le_bytes())?;
    file.write_all(&u16::from(has_audio).to_le_bytes())?;
    file.write_all(&(json.len() as u32).to_le_bytes())?;
    file.write_all(&(count as u32).to_le_bytes())?;
    file.write_all(&index_offset.to_le_bytes())?;
    file.write_all(&total_size.to_le_bytes())?;
    file.write_all(&json)?;
    file.seek(SeekFrom::Start(index_offset))?;
    for record in &records {
        write_record(&mut file, &record.record)?;
        file.write_all(&record.start_us.to_le_bytes())?;
        file.write_all(&record.end_us.to_le_bytes())?;
    }
    publish(file, &picture, &temporary, destination)?;
    Ok(metadata)
}
