use crate::{
    catalog::{self, text, Library},
    files,
    http::{self, Request},
    media, streaming,
};
use serde_json::{json, Value};
use std::{io, path::Path};

fn error(request: &mut Request, status: u16, message: &str) -> io::Result<()> {
    http::text(
        request,
        status,
        "application/json",
        &json!({"error":message}).to_string(),
    )
}
fn respond(request: &mut Request, status: u16, value: Value) -> io::Result<()> {
    http::text(request, status, "application/json", &value.to_string())
}

pub fn handle(mut request: Request, web: &Path, library: &Library) -> io::Result<()> {
    let path = request.target.split('?').next().unwrap_or("").to_owned();
    let read = matches!(request.method.as_str(), "GET" | "HEAD");
    if !read && request.method != "POST" {
        return error(&mut request, 405, "Method not allowed.");
    }
    if path == "/health" && read {
        return respond(&mut request, 200, json!({"status":"ok"}));
    }
    if path == "/api/queue" && read {
        return respond(&mut request, 200, library.queue()?);
    }
    if request.method == "POST" {
        let payload: Value = match serde_json::from_str(&request.body) {
            Ok(value) => value,
            Err(_) => return error(&mut request, 400, "Invalid JSON body."),
        };
        if path == "/api/queue/remove" {
            let Some(id) = payload["id"].as_str() else {
                return error(&mut request, 400, "A video ID is required.");
            };
            return match library.remove(id) {
                Ok(true) => respond(&mut request, 200, library.queue()?),
                Ok(false) => error(&mut request, 404, "Video not found."),
                Err(failure) => error(&mut request, 503, &failure.to_string()),
            };
        }
        if path == "/api/queue/add" {
            let Some(source) = payload["video"]
                .as_str()
                .map(str::trim)
                .filter(|source| !source.is_empty() && source.len() <= 4096)
            else {
                return error(&mut request, 400, "A video path or URL is required.");
            };
            let entries = match media::entries(source, &library.videos) {
                Ok(entries) => entries,
                Err(failure) => return error(&mut request, 400, &failure.to_string()),
            };
            let single = if entries.len() == 1 {
                Some(text(&entries[0], "id").to_owned())
            } else {
                None
            };
            let added = match library.append(entries) {
                Ok(added) => added,
                Err(failure) => return error(&mut request, 503, &failure.to_string()),
            };
            if let Some(id) = single {
                if let Err(failure) = streaming::ensure(library, &id) {
                    return error(&mut request, failure.status, &failure.message);
                }
            }
            let mut queue = library.queue()?;
            queue["added"] = added.into();
            return respond(&mut request, 201, queue);
        }
        if let Some(id) = path
            .strip_prefix("/api/videos/")
            .and_then(|path| path.strip_suffix("/prepare"))
        {
            return match streaming::ensure(library, id) {
                Ok(entry) => respond(&mut request, 200, catalog::public(&entry)),
                Err(failure) => error(&mut request, failure.status, &failure.message),
            };
        }
        return error(&mut request, 405, "Method not allowed.");
    }
    if let Some(id) = path.strip_prefix("/thumbnails/") {
        let Some(entry) = library.find(id)?.filter(|entry| entry["status"] == "ready") else {
            return error(&mut request, 404, "Video not found.");
        };
        return files::serve(
            &mut request,
            &Path::new(text(&entry, "path")).with_extension("jpg"),
            "image/jpeg",
        );
    }
    if let Some(path) = path.strip_prefix("/media/") {
        let parts: Vec<_> = path.split('/').collect();
        if parts.len() != 3 || parts[2] != "video.sci" {
            return error(&mut request, 404, "Not found.");
        }
        let Some(entry) = library
            .find(parts[0])?
            .filter(|entry| entry["status"] == "ready" && entry["revision"] == parts[1])
        else {
            return error(&mut request, 404, "Video not found.");
        };
        return files::serve(
            &mut request,
            Path::new(text(&entry, "path")),
            "application/vnd.weft.sci",
        );
    }
    if path == "/glyphs.json" {
        return http::text(&mut request, 200, "application/json", weft::FONT_JSON);
    }
    let name = path.strip_prefix('/').unwrap_or("");
    let (name, mime) = match name {
        "" => ("player.html", "text/html; charset=utf-8"),
        "style.css" | "landing.css" | "frame-theme.css" | "player.css" => (name, "text/css"),
        "favicon.svg" => (name, "image/svg+xml"),
        "assets/poster.png" => (name, "image/png"),
        "sample.json" => (name, "application/json"),
        "sample.sci" => (name, "application/vnd.weft.sci"),
        "fonts/inter-latin-wght-normal.woff2"
        | "fonts/space-grotesk-latin-wght-normal.woff2"
        | "fonts/geist-mono-latin-wght-normal.woff2" => (name, "font/woff2"),
        "app.js"
        | "player.js"
        | "renderer.js"
        | "stream.js"
        | "sci.js"
        | "audio.js"
        | "frames.js"
        | "ascii.js"
        | "storage.js"
        | "time.js"
        | "worker.js"
        | "decoder-worker.js"
        | "wasm.js"
        | "opus.js"
        | "gpu.js"
        | "delivery.js"
        | "checksum.js"
        | "integrity-worker.js"
        | "calibration.js"
        | "decode-pool.js" => (name, "text/javascript"),
        "decoder.wasm" => (name, "application/wasm"),
        _ => return error(&mut request, 404, "Not found."),
    };
    files::serve(&mut request, &web.join(name), mime)
}
