use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

pub struct Request {
    pub stream: TcpStream,
    pub method: String,
    pub target: String,
    pub body: String,
    pub headers: HashMap<String, String>,
}

pub fn read_request(mut stream: TcpStream) -> io::Result<Request> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(30)))?;
    let mut data = Vec::new();
    let header_end = loop {
        let mut chunk = [0; 2048];
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        data.extend_from_slice(&chunk[..n]);
        if let Some(end) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            if end > 16384 {
                return reject(stream, 431, "Request headers too large");
            }
            break end + 4;
        }
        if data.len() > 16384 {
            return reject(stream, 431, "Request headers too large");
        }
    };
    let header = std::str::from_utf8(&data[..header_end])
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
    let mut lines = header.split("\r\n");
    let parts: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if parts.len() != 3 || parts[2] != "HTTP/1.1" || !parts[1].starts_with('/') {
        return reject(stream, 400, "Invalid request line");
    }
    let method = parts[0].to_owned();
    let target = parts[1].to_owned();
    let mut headers = HashMap::new();
    for line in lines.filter(|s| !s.is_empty()) {
        let Some((key, value)) = line.split_once(':') else {
            return reject(stream, 400, "Invalid header");
        };
        let key = key.to_ascii_lowercase();
        if headers.insert(key, value.trim().to_owned()).is_some() {
            return reject(stream, 400, "Duplicate header");
        }
    }
    let Some(host) = headers.get("host") else {
        return reject(stream, 400, "Host header required");
    };
    if headers.contains_key("transfer-encoding") {
        return reject(stream, 400, "Chunked request bodies are not supported");
    }
    // Loopback binds reject DNS rebinding even when no Origin header is sent.
    if stream.local_addr()?.ip().is_loopback() {
        let hostname = host.split(':').next().unwrap_or("");
        if !matches!(hostname, "127.0.0.1" | "localhost" | "[") {
            return reject(stream, 403, "Host is not allowed");
        }
        if hostname == "[" && !host.starts_with("[::1]") {
            return reject(stream, 403, "Host is not allowed");
        }
    }
    if method == "POST" {
        let allowed = headers
            .get("origin")
            .is_none_or(|s| s == &format!("http://{host}"));
        let cross_site = headers
            .get("sec-fetch-site")
            .is_some_and(|s| s == "cross-site");
        if !allowed || cross_site {
            return reject(stream, 403, "Same-origin requests required");
        }
    }
    let length = match headers.get("content-length") {
        Some(s) => match s.parse::<usize>() {
            Ok(n) if n <= 8192 => n,
            _ => return reject(stream, 413, "Request body too large"),
        },
        None => 0,
    };
    while data.len() - header_end < length {
        let mut chunk = [0; 2048];
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        data.extend_from_slice(&chunk[..n]);
    }
    let body = match String::from_utf8(data[header_end..header_end + length].to_vec()) {
        Ok(s) if !s.contains('\0') => s,
        _ => return reject(stream, 400, "Request body must be UTF-8 text"),
    };
    Ok(Request {
        stream,
        method,
        target,
        body,
        headers,
    })
}

fn reject(stream: TcpStream, status: u16, message: &str) -> io::Result<Request> {
    let mut request = Request {
        stream,
        method: String::new(),
        target: String::new(),
        body: String::new(),
        headers: HashMap::new(),
    };
    text(&mut request, status, "text/plain; charset=utf-8", message)?;
    Err(io::ErrorKind::InvalidData.into())
}

pub fn head(
    request: &mut Request,
    status: u16,
    mime: &str,
    length: u64,
    extra: &str,
) -> io::Result<()> {
    let reason = match status {
        200 => "OK",
        201 => "Created",
        206 => "Partial Content",
        304 => "Not Modified",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Content Too Large",
        416 => "Range Not Satisfiable",
        431 => "Request Header Fields Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Error",
    };
    write!(request.stream, "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: same-origin\r\nContent-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'none'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'\r\n{extra}\r\n")
}

pub fn text(request: &mut Request, status: u16, mime: &str, body: &str) -> io::Result<()> {
    head(
        request,
        status,
        mime,
        body.len() as u64,
        "Cache-Control: no-store\r\n",
    )?;
    if request.method != "HEAD" {
        request.stream.write_all(body.as_bytes())?;
    }
    Ok(())
}

pub fn byte_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?;
    let (start, end) = value.split_once('-')?;
    if size == 0 || value.contains(',') {
        return None;
    }
    if start.is_empty() {
        let count = end.parse::<u64>().ok()?;
        return (count > 0).then_some((size.saturating_sub(count), size - 1));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };
    (start <= end && start < size).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::byte_range;
    #[test]
    fn ranges_cover_seeks_and_invalid_input() {
        assert_eq!(byte_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(byte_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(byte_range("bytes=-20", 100), Some((80, 99)));
        assert_eq!(byte_range("bytes=-200", 100), Some((0, 99)));
        assert_eq!(byte_range("bytes=0-200", 100), Some((0, 99)));
        for value in [
            "bytes=100-",
            "bytes=20-10",
            "bytes=-0",
            "bytes=0-1,3-4",
            "bytes=x-y",
        ] {
            assert_eq!(byte_range(value, 100), None);
        }
        assert_eq!(byte_range("bytes=0-", 0), None);
    }
}
