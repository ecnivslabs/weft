use std::{
    env,
    fs::File,
    io::{self, Write},
    path::Path,
};
use weft::archive::Archive;

fn run() -> io::Result<()> {
    let arguments: Vec<_> = env::args().skip(1).collect();
    match arguments.first().map(String::as_str) {
        Some("encode") if arguments.len() >= 3 => {
            let source = Path::new(&arguments[1]).canonicalize()?;
            let metadata = weft_media::probe(&source)?;
            let mut options = weft_media::EncodeOptions::default();
            let mut index = 3;
            while index < arguments.len() {
                let value = arguments
                    .get(index + 1)
                    .ok_or_else(|| io::Error::other("Missing encoder option value"))?;
                options.argument(&arguments[index], value)?;
                index += 2;
            }
            let encoded = weft_media::encode_with_options(
                source
                    .to_str()
                    .ok_or_else(|| io::Error::other("Source path must be UTF-8"))?,
                Path::new(&arguments[2]),
                &metadata,
                &options,
            )?;
            println!("{}", serde_json::to_string_pretty(&encoded)?);
        }
        Some("inspect") if arguments.len() == 2 => {
            let archive = Archive::open(File::open(&arguments[1])?)?;
            println!("{}", serde_json::to_string_pretty(archive.metadata())?);
        }
        Some("decode")
            if arguments.len() == 4 || (arguments.len() == 6 && arguments[4] == "--height") =>
        {
            let frame = arguments[2].parse::<u32>().map_err(io::Error::other)?;
            let mut archive = Archive::open(File::open(&arguments[1])?)?;
            let requested = if arguments.len() == 6 {
                Some(arguments[5].parse::<u64>().map_err(io::Error::other)?)
            } else {
                None
            };
            let quality = archive.metadata()["qualities"]
                .as_array()
                .unwrap()
                .iter()
                .find(|quality| {
                    requested.is_none_or(|height| quality["height"].as_u64() == Some(height))
                })
                .ok_or_else(|| io::Error::other("Requested rendition is unavailable"))?;
            let width = quality["columns"].as_u64().unwrap() as usize;
            let height = quality["rows"].as_u64().unwrap() as usize;
            let pixels = weft::scene::render(&archive.frame(height as u16, frame)?, width, height)?;
            let mut output = File::create(&arguments[3])?;
            write!(output, "P6\n{width} {height}\n255\n")?;
            output.write_all(&pixels)?;
        }
        None | Some("help" | "-h" | "--help") => {
            println!("Usage: weft encode SOURCE OUTPUT.sci [--heights 360,480,720,1080] [--fps source|NUM/DEN] [--quality 0..100] [--target-bitrate BITS_PER_SECOND] [--layers 1..4] [--color-bits 4..8] [--chunk-bytes BYTES] [--byte-penalty VALUE]\n       weft inspect INPUT.sci\n       weft decode INPUT.sci FRAME OUTPUT.ppm [--height HEIGHT]\nFPS options cap source cadence; lower-rate sources are never interpolated. Bitrate is a measured research target.");
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid command. Use weft help.",
            ))
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
