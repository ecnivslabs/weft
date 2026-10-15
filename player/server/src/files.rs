use crate::http;
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    time::UNIX_EPOCH,
};

pub fn serve(request: &mut http::Request, path: &Path, mime: &str) -> io::Result<()> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return http::text(request, 404, "text/plain", "File not found"),
    };
    let metadata = file.metadata()?;
    let size = metadata.len();
    let modified = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let etag = format!("\"{size:x}-{modified:x}\"");
    if request
        .headers
        .get("if-none-match")
        .is_some_and(|value| value == &etag || value == "*")
    {
        return http::head(
            request,
            304,
            mime,
            0,
            &format!("ETag: {etag}\r\nCache-Control: no-cache\r\n"),
        );
    }
    if request
        .headers
        .get("if-range")
        .is_some_and(|value| value != &etag)
    {
        request.headers.remove("range");
    }
    let (start, end, status) = match request.headers.get("range") {
        Some(value) => match http::byte_range(value, size) {
            Some((start, end)) => (start, end, 206),
            None => {
                return http::head(
                    request,
                    416,
                    "text/plain",
                    0,
                    &format!("Content-Range: bytes */{size}\r\n"),
                )
            }
        },
        None => (0, size.saturating_sub(1), 200),
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    let cache_control = if request.target.starts_with("/media/") {
        "private, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut extra =
        format!("Accept-Ranges: bytes\r\nCache-Control: {cache_control}\r\nETag: {etag}\r\n");
    if status == 206 {
        extra.push_str(&format!("Content-Range: bytes {start}-{end}/{size}\r\n"));
    }
    http::head(request, status, mime, length, &extra)?;
    if request.method != "HEAD" {
        file.seek(SeekFrom::Start(start))?;
        std::io::copy(&mut file.take(length), &mut request.stream)?;
    }
    Ok(())
}
