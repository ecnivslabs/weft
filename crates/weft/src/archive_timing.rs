use crate::{archive::Record, cells};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    io,
};

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid SCI timeline")
}
fn number(value: &Value) -> io::Result<u64> {
    value.as_u64().ok_or_else(invalid)
}

pub(crate) fn samples(time_us: u64) -> io::Result<usize> {
    if time_us > 21_600_000_000 {
        return Err(invalid());
    }
    (u128::from(time_us) * 48000 / 1_000_000)
        .try_into()
        .map_err(|_| invalid())
}

pub(crate) fn validate_metadata(metadata: &Value, audio: u16) -> io::Result<()> {
    let video = &metadata["video"];
    crate::format::validate_video(video)?;
    if metadata["timebase"] != 1_000_000
        || metadata["chunkSeconds"] != 1
        || video["packetFormat"] != "ascii-scene-zlib"
        || video["cellWidth"] != 3
        || video["cellHeight"] != 4
        || video["font"] != "ascii-3x4-v2"
    {
        return Err(invalid());
    }
    cells::mask(b' ', video["font"].as_str().ok_or_else(invalid)?)?;
    let numerator = number(&metadata["fpsNumerator"])?;
    let denominator = number(&metadata["fpsDenominator"])?;
    if numerator == 0 || numerator > 240000 || denominator == 0 || denominator > 10000 {
        return Err(invalid());
    }
    let fps = numerator as f64 / denominator as f64;
    let frames = number(&metadata["frames"])?;
    let chunks = number(&metadata["chunks"])?;
    let duration = metadata["duration"].as_f64().ok_or_else(invalid)?;
    if !(1.0..=60.0).contains(&fps)
        || metadata["fps"].as_f64() != Some(fps)
        || number(&metadata["chunkFrames"])? != fps.round() as u64
        || frames == 0
        || frames > 1296000
        || chunks == 0
        || chunks > frames
        || !duration.is_finite()
        || duration <= 0.0
        || duration > 21600.0
    {
        return Err(invalid());
    }
    let qualities = metadata["qualities"].as_array().ok_or_else(invalid)?;
    if qualities.is_empty() || qualities.len() > 6 {
        return Err(invalid());
    }
    let mut heights = BTreeSet::new();
    for quality in qualities {
        let height = number(&quality["height"])?;
        let width = number(&quality["columns"])?;
        if height != number(&quality["rows"])? || !heights.insert(height) {
            return Err(invalid());
        }
        cells::dimensions(
            width.try_into().map_err(|_| invalid())?,
            height.try_into().map_err(|_| invalid())?,
        )?;
    }
    if (audio == 1) == metadata["audio"].is_null() {
        return Err(invalid());
    }
    if audio == 1
        && (metadata["audio"]["codec"] != "opus"
            || metadata["audio"]["sampleRate"] != 48000
            || metadata["audio"]["channels"] != 2)
    {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn validate_records(
    metadata: &Value,
    records: &BTreeMap<(u16, u32), Record>,
) -> io::Result<()> {
    let chunks = number(&metadata["chunks"])? as u32;
    let frames = number(&metadata["frames"])?;
    let duration_us =
        (metadata["duration"].as_f64().ok_or_else(invalid)? * 1_000_000.0).round() as u64;
    let qualities = metadata["qualities"].as_array().ok_or_else(invalid)?;
    let reference_quality = number(&qualities[0]["height"])? as u16;
    let mut previous_frame = 0;
    let mut previous_end = 0;
    for chunk in 0..chunks {
        let reference = records
            .get(&(reference_quality, chunk))
            .ok_or_else(invalid)?;
        if reference.first != previous_frame
            || reference.start_us != previous_end
            || reference.end_us <= reference.start_us
            || reference.end_us > duration_us
            || reference.end_us - reference.start_us > 2_000_000
        {
            return Err(invalid());
        }
        previous_frame += u32::from(reference.frames);
        previous_end = reference.end_us;
        for quality in qualities {
            let record = records
                .get(&(number(&quality["height"])? as u16, chunk))
                .ok_or_else(invalid)?;
            if record.first != reference.first
                || record.frames != reference.frames
                || record.start_us != reference.start_us
                || record.end_us != reference.end_us
            {
                return Err(invalid());
            }
        }
        if !metadata["audio"].is_null() {
            let audio = records.get(&(0, chunk)).ok_or_else(invalid)?;
            if audio.first != reference.first
                || audio.start_us != reference.start_us
                || audio.end_us != reference.end_us
            {
                return Err(invalid());
            }
        }
    }
    if u64::from(previous_frame) != frames || previous_end != duration_us {
        return Err(invalid());
    }
    Ok(())
}
