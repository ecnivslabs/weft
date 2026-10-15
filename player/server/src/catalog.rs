use crate::store::Catalog;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};

pub fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))[..20].into()
}

pub fn revision() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let bytes = Sha256::digest(
        format!(
            "{:?}:{}:{}",
            SystemTime::now(),
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )
        .as_bytes(),
    );
    let value = format!("{:x}", bytes);
    format!(
        "{}-{}-4{}-8{}-{}",
        &value[..8],
        &value[8..12],
        &value[13..16],
        &value[17..20],
        &value[20..32]
    )
}

pub fn text<'a>(entry: &'a Value, key: &str) -> &'a str {
    entry[key].as_str().unwrap_or("")
}

pub fn public(entry: &Value) -> Value {
    let id = text(entry, "id");
    json!({"id":id,"title":entry["title"],"duration":entry["duration"],"width":entry["width"],"height":entry["height"],
        "status":entry["status"],"error":text(entry,"error"),"qualities":entry["qualities"].as_array().cloned().unwrap_or_default(),
        "thumbnail":format!("/thumbnails/{id}"),"media":if entry["status"] == "ready" {format!("/media/{id}/{}/video.sci",text(entry,"revision"))}else{String::new()}})
}

pub struct Library {
    catalog: Mutex<Catalog>,
    pub cache: PathBuf,
    pub videos: PathBuf,
    pub staging: PathBuf,
    pub options: weft_media::EncodeOptions,
}

impl Library {
    pub fn open(
        data: &Path,
        videos: PathBuf,
        options: weft_media::EncodeOptions,
    ) -> io::Result<Self> {
        options.validate()?;
        let fingerprint = options.fingerprint()?;
        fs::create_dir_all(data)?;
        let data = data.canonicalize()?;
        let library = hash(
            data.to_str()
                .ok_or_else(|| io::Error::other("Data path must be UTF-8"))?,
        );
        let cache = videos.join("sci").join(&library);
        let staging = videos.join(".staging").join(&library);
        fs::create_dir_all(&cache)?;
        fs::create_dir_all(&staging)?;
        let mut catalog = Catalog::default();
        catalog.open(&data.join("catalog.json"))?;
        let before = catalog.json.clone();
        let mut entries: Vec<Value> = serde_json::from_str(&before)?;
        for entry in &mut entries {
            let id = text(entry, "id");
            if id.len() != 20
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                || !entry["source"].is_string()
                || !entry["title"].is_string()
            {
                return Err(io::Error::other("Invalid library entry"));
            }
            if entry["status"] == "preparing"
                || !matches!(entry["format"].as_str(), Some("sci-v4" | "sci-v5"))
                || entry["encoderProfile"] != fingerprint
                || !Path::new(text(entry, "path")).is_file()
            {
                entry["status"] = "queued".into();
            }
        }
        catalog.swap(&before, &serde_json::to_string(&entries)?)?;
        Ok(Self {
            catalog: Mutex::new(catalog),
            cache,
            videos,
            staging,
            options,
        })
    }

    pub fn snapshot(&self) -> io::Result<Vec<Value>> {
        let catalog = self
            .catalog
            .lock()
            .map_err(|_| io::Error::other("Library lock failed"))?;
        Ok(serde_json::from_str(&catalog.json)?)
    }

    pub fn queue(&self) -> io::Result<Value> {
        Ok(json!({"queue":self.snapshot()?.iter().map(public).collect::<Vec<_>>()}))
    }

    pub fn find(&self, id: &str) -> io::Result<Option<Value>> {
        Ok(self.snapshot()?.into_iter().find(|entry| entry["id"] == id))
    }

    fn update<T>(&self, operation: impl FnOnce(&mut Vec<Value>) -> T) -> io::Result<T> {
        let mut catalog = self
            .catalog
            .lock()
            .map_err(|_| io::Error::other("Library lock failed"))?;
        let before = catalog.json.clone();
        let mut entries: Vec<Value> = serde_json::from_str(&before)?;
        let result = operation(&mut entries);
        catalog.swap(&before, &serde_json::to_string(&entries)?)?;
        Ok(result)
    }

    pub fn append(&self, entries: Vec<Value>) -> io::Result<usize> {
        self.update(|queue| {
            let mut added = 0;
            for entry in entries {
                if !queue.iter().any(|current| current["id"] == entry["id"]) {
                    queue.push(entry);
                    added += 1;
                }
            }
            added
        })
    }

    pub fn remove(&self, id: &str) -> io::Result<bool> {
        self.update(|queue| {
            let before = queue.len();
            queue.retain(|entry| entry["id"] != id);
            before != queue.len()
        })
    }

    pub fn replace(&self, entry: Value) -> io::Result<bool> {
        self.update(|queue| {
            if let Some(current) = queue.iter_mut().find(|current| {
                current["id"] == entry["id"] && current["revision"] == entry["revision"]
            }) {
                *current = entry;
                true
            } else {
                false
            }
        })
    }

    pub fn claim(&self, id: &str) -> io::Result<Option<Value>> {
        self.update(|queue| {
            let entry = queue.iter_mut().find(|entry| {
                entry["id"] == id && entry["status"] != "ready" && entry["status"] != "preparing"
            })?;
            entry["status"] = "preparing".into();
            entry["revision"] = revision().into();
            entry["error"] = "".into();
            Some(entry.clone())
        })
    }
}

pub fn local_entry(path: &Path, videos: &Path) -> io::Result<Value> {
    let path = path.canonicalize()?;
    if !path.is_file() || !crate::media::supported(&path) {
        return Err(io::Error::other(
            "Video file not found or unsupported format",
        ));
    }
    let metadata = weft_media::probe(&path)?;
    let stat = path.metadata()?;
    let modified = stat
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let source = path
        .to_str()
        .ok_or_else(|| io::Error::other("Source path must be UTF-8"))?;
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("Untitled video");
    let mut id = hash(&format!("{source}{}{modified}", stat.len()));
    let mut source = source.to_owned();
    if let Some(video) = stem
        .strip_prefix("youtube-")
        .filter(|id| crate::media::video_id_valid(id))
    {
        if path.parent() == videos.canonicalize().ok().as_deref()
            && path.extension().is_some_and(|ext| ext == "mp4")
        {
            source = format!("https://www.youtube.com/watch?v={video}");
            id = hash(&format!("youtube:{video}"));
        }
    }
    Ok(
        json!({"id":id,"title":stem,"source":source,"original":path,"path":"","status":"queued","duration":metadata["duration"],"width":metadata["width"],"height":metadata["height"],"error":""}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compatible_archives_keep_ready_status_across_packing_versions() {
        let root = std::env::temp_dir().join(format!("weft-library-{}", revision()));
        let data = root.join("data");
        let videos = root.join("videos");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&videos).unwrap();
        let archive = videos.join("ready.sci");
        fs::write(&archive, []).unwrap();
        let options = weft_media::EncodeOptions::default();
        let fingerprint = options.fingerprint().unwrap();
        let entries: Vec<_> = ["sci-v4", "sci-v5", "sci-v3"].into_iter().enumerate().map(|(index, format)| {
            json!({"id":format!("{index:020x}"),"source":"retained.nut","title":"Retained","status":"ready","format":format,"encoderProfile":fingerprint,"path":archive})
        }).collect();
        fs::write(
            data.join("catalog.json"),
            serde_json::to_vec(&entries).unwrap(),
        )
        .unwrap();
        let library = Library::open(&data, videos, options).unwrap();
        let entries = library.snapshot().unwrap();
        assert_eq!(entries[0]["status"], "ready");
        assert_eq!(entries[1]["status"], "ready");
        assert_eq!(entries[2]["status"], "queued");
        drop(library);
        fs::remove_dir_all(root).unwrap();
    }
}
