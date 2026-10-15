use crate::catalog::{hash, revision, text, Library};
use serde_json::{json, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};
use weft_media::command::execute;

pub fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mp4" | "mkv" | "mov" | "avi" | "webm" | "m4v"
            )
        })
}

pub fn video_id_valid(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn youtube_source(input: &str) -> String {
    let source = input.trim();
    let lower = source.to_ascii_lowercase();
    let address = if lower.starts_with("https://") {
        &source[8..]
    } else if lower.starts_with("http://") {
        &source[7..]
    } else {
        source.strip_prefix("//").unwrap_or(source)
    };
    let host = address.split('/').next().unwrap_or("").to_ascii_lowercase();
    if !matches!(
        host.as_str(),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtu.be"
    ) {
        return source.into();
    }
    let normalized = format!("https://{host}{}", &address[host.len()..]);
    let base = normalized
        .split(['?', '#'])
        .next()
        .unwrap()
        .trim_end_matches('/');
    let path = base.strip_prefix(&format!("https://{host}/")).unwrap_or("");
    let parts: Vec<_> = path.split('/').collect();
    if host != "youtu.be"
        && ((parts.len() == 1 && parts[0].starts_with('@'))
            || (parts.len() == 2 && matches!(parts[0], "channel" | "c" | "user")))
    {
        format!("{base}/videos")
    } else {
        normalized
    }
}

pub fn entries(input: &str, videos: &Path) -> io::Result<Vec<Value>> {
    let source = youtube_source(input);
    if !source.starts_with("https://") && !source.starts_with("http://") {
        return Ok(vec![crate::catalog::local_entry(
            Path::new(&source),
            videos,
        )?]);
    }
    if ![
        "https://www.youtube.com/",
        "https://youtube.com/",
        "https://m.youtube.com/",
        "https://youtu.be/",
    ]
    .iter()
    .any(|prefix| source.starts_with(prefix))
    {
        return Err(io::Error::other(
            "Use a local video or an HTTPS YouTube video, playlist, or channel URL.",
        ));
    }
    let output = execute(
        "yt-dlp",
        &strings(&[
            "--ignore-config",
            "--flat-playlist",
            "--playlist-end",
            "50",
            "--dump-single-json",
            "--",
            &source,
        ]),
        Duration::from_secs(60),
    )?;
    let info: Value = serde_json::from_str(&output)?;
    let items = if info["_type"] == "playlist" {
        info["entries"]
            .as_array()
            .cloned()
            .ok_or_else(|| io::Error::other("Invalid playlist"))?
    } else {
        vec![info]
    };
    let mut entries = Vec::new();
    for item in items.into_iter().take(50) {
        let id = text(&item, "id");
        if !video_id_valid(id)
            || item["is_live"] == true
            || matches!(text(&item, "live_status"), "is_live" | "is_upcoming")
        {
            continue;
        }
        entries.push(json!({"id":hash(&format!("youtube:{id}")),"title":item["title"].as_str().unwrap_or("Untitled video"),"source":format!("https://www.youtube.com/watch?v={id}"),"path":"","status":"queued","duration":item["duration"].as_f64().unwrap_or(0.0),"width":0,"height":0,"error":""}));
    }
    if entries.is_empty() {
        return Err(io::Error::other("No finite videos found in this source."));
    }
    Ok(entries)
}

pub fn retained(entry: &Value, library: &Library) -> Option<PathBuf> {
    let id = text(entry, "source").strip_prefix("https://www.youtube.com/watch?v=")?;
    video_id_valid(id).then(|| library.videos.join(format!("youtube-{id}.mp4")))
}

pub fn strings(arguments: &[&str]) -> Vec<String> {
    arguments
        .iter()
        .map(|argument| (*argument).into())
        .collect()
}

struct Staging<'a> {
    library: &'a Library,
    prefix: String,
}
impl Drop for Staging<'_> {
    fn drop(&mut self) {
        if let Err(error) = clean_prefix(&self.library.staging, &self.prefix) {
            eprintln!("Cannot clean download: {error}");
        }
    }
}

pub fn clean_prefix(directory: &Path, prefix: &str) -> io::Result<()> {
    for file in fs::read_dir(directory)? {
        let file = file?;
        if file.file_type()?.is_file()
            && file
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("{prefix}."))
        {
            fs::remove_file(file.path())?;
        }
    }
    Ok(())
}

pub fn acquire(entry: &Value, library: &Library) -> io::Result<(PathBuf, Value)> {
    let Some(destination) = retained(entry, library) else {
        let source = Path::new(text(entry, "source")).canonicalize()?;
        return Ok((source.clone(), weft_media::probe(&source)?));
    };
    fs::create_dir_all(&library.videos)?;
    if !destination.is_file() {
        let prefix = format!("{}.{}", text(entry, "id"), revision());
        let temporary = library.staging.join(format!("{prefix}.source.mp4"));
        let _cleanup = Staging {
            library,
            prefix: prefix.clone(),
        };
        let original = Path::new(text(entry, "original"));
        if original.is_file()
            && original
                .extension()
                .is_some_and(|extension| extension == "mp4")
        {
            fs::copy(original, &temporary)?;
        } else {
            execute(
                "yt-dlp",
                &strings(&[
                    "--ignore-config",
                    "--no-playlist",
                    "--no-part",
                    "--max-filesize",
                    "2G",
                    "-f",
                    "bv*[height<=1080]+ba/b[height<=1080]",
                    "--merge-output-format",
                    "mp4",
                    "--remux-video",
                    "mp4",
                    "-o",
                    library
                        .staging
                        .join(format!("{prefix}.source.%(ext)s"))
                        .to_str()
                        .ok_or_else(|| io::Error::other("Download path must be UTF-8"))?,
                    "--",
                    text(entry, "source"),
                ]),
                Duration::from_secs(900),
            )?;
        }
        if temporary.metadata()?.len() > 2 * 1024_u64.pow(3) {
            return Err(io::Error::other("Source download exceeds 2 GiB"));
        }
        weft_media::probe(&temporary)?;
        // Publication never exposes an incomplete ingestion input.
        if !destination.exists() {
            fs::rename(&temporary, &destination)?;
        }
    }
    let path = destination.canonicalize()?;
    Ok((path.clone(), weft_media::probe(&path)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channel_roots_and_host_spoofing() {
        for input in [
            "youtube.com/@test",
            "  WWW.YouTube.COM/@test/?view=0#top  ",
            "//m.youtube.com/@test",
            "http://youtube.com/@test",
        ] {
            assert!(youtube_source(input).ends_with("/@test/videos"));
        }
        for input in [
            "https://youtube.com.evil.test/@test",
            "https://youtube.com@evil.test/@test",
            "https://evil.test/youtube.com/@test",
        ] {
            assert_eq!(youtube_source(input), input);
        }
        assert_eq!(
            youtube_source("youtu.be/abcdefghijk?t=10"),
            "https://youtu.be/abcdefghijk?t=10"
        );
        assert!(video_id_valid("abc_def-123"));
        assert!(!video_id_valid("abc/def1234"));
    }
}
