mod catalog;
mod files;
mod http;
mod media;
mod routes;
mod store;
mod streaming;

use std::{
    env, fs, io,
    net::TcpListener,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
};

fn run() -> io::Result<()> {
    let mut host = "127.0.0.1".to_owned();
    let mut port = 8000_u16;
    let mut data = PathBuf::from("data");
    let mut folder = None;
    let mut playlist = None;
    let mut web = PathBuf::from("website/web");
    let mut sources = Vec::new();
    let mut options = weft_media::EncodeOptions::default();
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "-h" | "--help" => {
                println!("Usage: weft-website [SOURCE] [--host ADDRESS] [--port PORT] [--folder DIRECTORY] [--playlist FILE] [--data-dir DIRECTORY] [--web-dir DIRECTORY] [--heights 360,480,720,1080] [--fps source|NUM/DEN] [--quality 0..100] [--layers 1..4] [--color-bits 4..8] [--chunk-bytes BYTES] [--byte-penalty VALUE] [--target-bitrate BITS_PER_SECOND]");
                return Ok(());
            }
            "--heights" | "--fps" | "--quality" | "--target-bitrate" | "--layers"
            | "--color-bits" | "--chunk-bytes" | "--byte-penalty" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| io::Error::other(format!("Missing value for {argument}")))?;
                options.argument(&argument, &value)?;
            }
            "--host" | "--port" | "--folder" | "--playlist" | "--data-dir" | "--web-dir" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| io::Error::other(format!("Missing value for {argument}")))?;
                match argument.as_str() {
                    "--host" => host = value,
                    "--port" => {
                        port = value.parse().map_err(io::Error::other)?;
                        if port == 0 {
                            return Err(io::Error::other("Port must be between 1 and 65535"));
                        }
                    }
                    "--folder" => folder = Some(PathBuf::from(value)),
                    "--playlist" => playlist = Some(PathBuf::from(value)),
                    "--data-dir" => data = value.into(),
                    _ => web = value.into(),
                }
            }
            option if option.starts_with('-') => {
                return Err(io::Error::other(format!("Unknown option: {option}")))
            }
            _ => sources.push(argument),
        }
    }
    if !web.join("player.html").is_file() {
        return Err(io::Error::other(
            "Run from the repository root or supply the website web directory",
        ));
    }
    if !web.join("decoder.wasm").is_file() {
        return Err(io::Error::other("SCI worker decoder missing. Run npm run build:web --prefix website (requires rustup target add wasm32-unknown-unknown)."));
    }
    let videos = env::current_dir()?.join("videos");
    let discover = !data.join("catalog.json").exists()
        && sources.is_empty()
        && folder.is_none()
        && playlist.is_none();
    let library = Arc::new(catalog::Library::open(&data, videos, options)?);
    if let Some(folder) = folder {
        add_folder(&folder, &mut sources)?;
    }
    if let Some(playlist) = playlist {
        let entries: Vec<serde_json::Value> = serde_json::from_str(&fs::read_to_string(playlist)?)?;
        for entry in entries {
            sources.push(
                entry["video"]
                    .as_str()
                    .ok_or_else(|| {
                        io::Error::other("Each playlist entry must contain a video path or URL")
                    })?
                    .to_owned(),
            );
        }
    }
    if discover {
        add_folder(&library.videos, &mut sources)?;
    }
    for source in sources {
        library.append(media::entries(&source, &library.videos)?)?;
    }
    streaming::startup(&library, &data.join("media"))?;
    let listener = Arc::new(TcpListener::bind((host.as_str(), port))?);
    println!("weft listening at http://{}", listener.local_addr()?);
    let mut workers = Vec::new();
    for _ in 0..8 {
        let listener = listener.clone();
        let library = library.clone();
        let web = web.clone();
        workers.push(thread::spawn(move || -> io::Result<()> {
            loop {
                let (stream, _) = listener.accept()?;
                if let Ok(request) = http::read_request(stream) {
                    if let Err(error) = routes::handle(request, &web, &library) {
                        eprintln!("Request failed: {error}");
                    }
                }
            }
        }));
    }
    for worker in workers {
        worker
            .join()
            .map_err(|_| io::Error::other("HTTP worker failed"))??;
    }
    Ok(())
}

fn add_folder(folder: &Path, sources: &mut Vec<String>) -> io::Result<()> {
    for file in fs::read_dir(folder)? {
        let file = file?;
        if file.file_type()?.is_file() && media::supported(&file.path()) {
            sources.push(
                file.path()
                    .to_str()
                    .ok_or_else(|| io::Error::other("Source path must be UTF-8"))?
                    .to_owned(),
            );
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
