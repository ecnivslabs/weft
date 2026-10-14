use crate::{process::Decoder, EncodeOptions};
use std::{
    io::{self, BufRead, BufReader, Read},
    time::Instant,
};
use weft::timing::Rate;

#[derive(Clone, Debug)]
pub struct Chunk {
    pub first: usize,
    pub frames: usize,
    pub start_us: u64,
    pub end_us: u64,
}

pub struct Timeline {
    pub durations: Vec<u32>,
    pub sources: Vec<usize>,
    pub source_frames: usize,
    pub chunks: Vec<Chunk>,
    pub duration_us: u64,
    pub first_pts: f64,
    pub rate: Rate,
    pub select_filter: String,
}

pub fn samples(time: u64) -> usize {
    (u128::from(time) * 48000 / 1_000_000) as usize
}

pub fn probe(
    source: &str,
    input: &serde_json::Value,
    options: &EncodeOptions,
) -> io::Result<Timeline> {
    let ceiling = options.ceiling()?;
    let source_rate = Rate::from_metadata(input);
    let source_fps = input["fpsNumerator"].as_u64().unwrap_or(30) as f64
        / input["fpsDenominator"].as_u64().unwrap_or(1) as f64;
    if !source_fps.is_finite() || source_fps <= 0.0 {
        return Err(io::Error::other("Source cadence is invalid"));
    }
    let rate = if source_fps > ceiling.fps() {
        ceiling
    } else if source_fps < 1.0 {
        Rate::new(1, 1)?
    } else {
        source_rate
    };
    let peak = input["peakNumerator"].as_u64().unwrap_or(0) as f64
        / input["peakDenominator"].as_u64().unwrap_or(1) as f64;
    let capped = source_fps.max(if peak.is_finite() { peak } else { 0.0 }) > ceiling.fps();
    let arguments = [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time,duration_time,pkt_duration_time:frame_side_data=",
        "-of",
        "compact=p=0:nk=0",
        source,
    ]
    .map(str::to_owned);
    let mut process = Decoder::spawn_program("ffprobe", &arguments, false)?;
    let activity = process.activity.clone();
    let mut reader = BufReader::new(&mut process.stdout);
    let mut selected = Vec::<u64>::new();
    let mut first = None;
    let mut previous = None;
    let mut end = 0;
    let mut scanned = 0;
    loop {
        let mut line = String::new();
        let n = Read::by_ref(&mut reader).take(1024).read_line(&mut line)?;
        if n == 0 {
            break;
        }
        *activity.lock().unwrap() = Instant::now();
        if n == 1024 {
            return Err(io::Error::other("FFprobe frame record exceeds limit"));
        }
        let fields: Vec<_> = line.trim().split('|').collect();
        let Some(timestamp) = fields
            .iter()
            .find_map(|field| field.strip_prefix("best_effort_timestamp_time="))
        else {
            continue;
        };
        let pts = timestamp
            .parse::<f64>()
            .map_err(|_| io::Error::other("Source frame has no valid timestamp"))?;
        if !pts.is_finite() || pts.abs() > 86400.0 {
            return Err(io::Error::other("Unsupported source timestamp"));
        }
        let origin = *first.get_or_insert(pts);
        let time = ((pts - origin) * 1_000_000.0).round();
        if !(0.0..=21_600_000_000.0).contains(&time) {
            return Err(io::Error::other("Source timeline exceeds six hours"));
        }
        let time = time as u64;
        if previous.is_some_and(|previous| time <= previous) {
            return Err(io::Error::other("Source timestamps must increase strictly"));
        }
        previous = Some(time);
        let duration = fields
            .iter()
            .find_map(|field| {
                field
                    .strip_prefix("duration_time=")
                    .or_else(|| field.strip_prefix("pkt_duration_time="))
            })
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(1.0 / source_fps);
        let duration_us = (duration * 1_000_000.0).round() as u64;
        end = time
            .checked_add(duration_us)
            .ok_or_else(|| io::Error::other("Source timestamp overflow"))?;
        let bucket = |time: u64| {
            u128::from(time) * u128::from(ceiling.numerator())
                / (1_000_000 * u128::from(ceiling.denominator()))
        };
        if !capped
            || selected
                .last()
                .is_none_or(|&previous| bucket(time) > bucket(previous))
        {
            selected.push(time);
        }
        scanned += 1;
        if scanned % 3600 == 0 {
            eprintln!("Timestamp scan: {scanned} source frames");
        }
        if scanned > 5_184_000 || selected.len() > 1_296_000 {
            return Err(io::Error::other("Source frame count exceeds limit"));
        }
    }
    drop(reader);
    process.finish()?;
    if selected.is_empty() || end > 21_600_000_000 {
        return Err(io::Error::other(
            "Source has no supported presentation timeline",
        ));
    }
    let source_frames = selected.len();
    let mut times = Vec::new();
    let mut durations = Vec::new();
    let mut sources = Vec::new();
    for (i, &time) in selected.iter().enumerate() {
        let next = selected.get(i + 1).copied().unwrap_or(end);
        let mut cursor = time;
        while cursor < next {
            let duration = (next - cursor).min(1_000_000) as u32;
            times.push(cursor);
            durations.push(duration);
            sources.push(i);
            cursor += u64::from(duration);
            if durations.len() > 1_296_000 {
                return Err(io::Error::other("Presentation event count exceeds limit"));
            }
        }
    }
    let selected = times;
    let mut chunks = Vec::new();
    let mut first_frame = 0;
    while first_frame < selected.len() {
        let start_us = selected[first_frame];
        let mut next = first_frame + 1;
        while next < selected.len() && selected[next] - start_us < 1_000_000 {
            next += 1;
        }
        if next - first_frame > 240 {
            return Err(io::Error::other("Delivery chunk exceeds frame limit"));
        }
        chunks.push(Chunk {
            first: first_frame,
            frames: next - first_frame,
            start_us,
            end_us: selected.get(next).copied().unwrap_or(end),
        });
        first_frame = next;
    }
    Ok(Timeline {
        durations,
        sources,
        source_frames,
        chunks,
        duration_us: end,
        first_pts: first.unwrap(),
        rate,
        select_filter: if capped {
            let origin = (first.unwrap() * 1_000_000.0).round() as i64;
            let bucket = |t: &str| {
                format!(
                    "floor((round({t}*1000000)-{origin})*{}/(1000000*{}))",
                    ceiling.numerator(),
                    ceiling.denominator()
                )
            };
            format!(
                "select='isnan(prev_selected_t)+gt({},{})',",
                bucket("t"),
                bucket("prev_selected_t")
            )
        } else {
            String::new()
        },
    })
}
