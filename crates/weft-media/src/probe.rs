use serde_json::{json, Value};
use std::{io, path::Path, time::Duration};

pub fn probe(path: &Path) -> io::Result<Value> {
    let arguments = vec![
        "-v".into(),
        "error".into(),
        "-show_entries".into(),
        "format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation"
            .into(),
        "-of".into(),
        "json".into(),
        path.to_str()
            .ok_or_else(|| io::Error::other("Source path must be UTF-8"))?
            .into(),
    ];
    let info: Value = serde_json::from_str(&crate::command::execute(
        "ffprobe",
        &arguments,
        Duration::from_secs(60),
    )?)?;
    let streams = info["streams"]
        .as_array()
        .ok_or_else(|| io::Error::other("FFprobe returned invalid streams"))?;
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .ok_or_else(|| io::Error::other("Source has no video stream"))?;
    let mut width = video["width"].as_u64().unwrap_or(0);
    let mut height = video["height"].as_u64().unwrap_or(0);
    if video["side_data_list"].as_array().is_some_and(|items| {
        items.iter().any(|item| {
            item["rotation"]
                .as_i64()
                .is_some_and(|rotation| rotation.rem_euclid(180) == 90)
        })
    }) {
        std::mem::swap(&mut width, &mut height);
    }
    let duration = info["format"]["duration"]
        .as_str()
        .unwrap_or("0")
        .parse::<f64>()
        .unwrap_or(0.0);
    if width < 2 || height < 4 || !duration.is_finite() || duration <= 0.0 || duration > 21600.0 {
        return Err(io::Error::other(
            "Source must contain a finite video stream no longer than six hours",
        ));
    }
    let peak = frame_rate(&video["r_frame_rate"]).unwrap_or((0, 1));
    let rate = frame_rate(&video["avg_frame_rate"])
        .or_else(|| frame_rate(&video["r_frame_rate"]))
        .ok_or_else(|| io::Error::other("Source has no usable nominal frame rate"))?;
    Ok(json!({"width":width,"height":height,"duration":duration,
        "audio":streams.iter().any(|stream| stream["codec_type"] == "audio"),
        "peakNumerator":peak.0,"peakDenominator":peak.1,
        "fpsNumerator":rate.0,"fpsDenominator":rate.1}))
}

fn frame_rate(value: &Value) -> Option<(u32, u32)> {
    let (numerator, denominator) = value.as_str()?.split_once('/')?;
    let numerator = numerator.parse::<u32>().ok()?;
    let denominator = denominator.parse::<u32>().ok()?;
    (numerator > 0 && denominator > 0).then_some((numerator, denominator))
}
