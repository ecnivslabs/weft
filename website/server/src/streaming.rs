use crate::{
    catalog::{text, Library},
    media,
};
use serde_json::Value;
use std::{fs, io, path::Path};

pub struct Failure {
    pub status: u16,
    pub message: String,
}
impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self {
            status: 400,
            message: error.to_string(),
        }
    }
}
fn fail(status: u16, message: &str) -> Failure {
    Failure {
        status,
        message: message.into(),
    }
}

pub fn ensure(library: &Library, id: &str) -> Result<Value, Failure> {
    let mut existing = library
        .find(id)?
        .ok_or_else(|| fail(404, "Video not found."))?;
    if existing["status"] == "ready" {
        if media::retained(&existing, library).is_some_and(|path| !path.is_file()) {
            let (path, _) = media::acquire(&existing, library)?;
            existing["original"] = path.to_string_lossy().into_owned().into();
            if !library.replace(existing.clone())? {
                return Err(fail(
                    409,
                    "Video was removed or changed during preparation.",
                ));
            }
        }
        return Ok(existing);
    }
    let mut entry = library
        .claim(id)?
        .ok_or_else(|| fail(409, "Video is being prepared."))?;
    let prefix = format!("{}.{}", id, text(&entry, "revision"));
    let result = (|| -> io::Result<()> {
        let (source, metadata) = media::acquire(&entry, library)?;
        let path = library.cache.join(format!("{prefix}.sci"));
        let encoded = weft_media::encode_with_options(
            source
                .to_str()
                .ok_or_else(|| io::Error::other("Source path must be UTF-8"))?,
            &path,
            &metadata,
            &library.options,
        )?;
        entry["path"] = path.to_string_lossy().into_owned().into();
        entry["original"] = source.to_string_lossy().into_owned().into();
        entry["format"] = "sci-v4".into();
        entry["encoder"] = weft::format::MAPPER.into();
        entry["encoderProfile"] = library.options.fingerprint()?.into();
        entry["qualities"] = encoded["qualities"]
            .as_array()
            .unwrap()
            .iter()
            .map(|quality| quality["height"].clone())
            .collect();
        entry["status"] = "ready".into();
        entry["duration"] = encoded["duration"].clone();
        entry["width"] = metadata["width"].clone();
        entry["height"] = metadata["height"].clone();
        entry["error"] = "".into();
        Ok(())
    })();
    if let Err(error) = result {
        media::clean_prefix(&library.cache, &prefix)?;
        entry["status"] = "error".into();
        entry["error"] = error.to_string().into();
        if !library.replace(entry)? {
            return Err(fail(
                409,
                "Video was removed or changed during preparation.",
            ));
        }
        return Err(error.into());
    }
    if !library.replace(entry.clone())? {
        media::clean_prefix(&library.cache, &prefix)?;
        return Err(fail(
            409,
            "Video was removed or changed during preparation.",
        ));
    }
    Ok(entry)
}

pub fn startup(library: &Library, legacy: &Path) -> io::Result<()> {
    for mut entry in library.snapshot()? {
        let prefix = format!("{}.{}", text(&entry, "id"), text(&entry, "revision"));
        let original = legacy.join(format!("{prefix}.source.mp4"));
        if original.is_file()
            && media::retained(&entry, library).is_some_and(|path| !path.is_file())
        {
            entry["original"] = original.to_string_lossy().into_owned().into();
            let (retained, _) = media::acquire(&entry, library)?;
            entry["original"] = retained.to_string_lossy().into_owned().into();
            library.replace(entry.clone())?;
            fs::remove_file(original)?;
        }
        if entry["status"] == "ready" {
            let source = Path::new(text(&entry, "path"));
            let destination = library.cache.join(format!("{prefix}.sci"));
            if source != destination {
                let temporary = destination.with_extension("sci.tmp");
                fs::copy(source, &temporary)?;
                fs::rename(&temporary, &destination)?;
                let picture = source.with_extension("jpg");
                if picture.is_file() {
                    fs::copy(&picture, destination.with_extension("jpg"))?;
                }
                let source = source.to_owned();
                entry["path"] = destination.to_string_lossy().into_owned().into();
                if !library.replace(entry.clone())? {
                    return Err(io::Error::other("Cannot save relocated archive"));
                }
                fs::remove_file(source)?;
                if picture.is_file() {
                    fs::remove_file(picture)?;
                }
            }
        }
        if entry["status"] != "ready"
            || media::retained(&entry, library).is_some_and(|path| !path.is_file())
        {
            eprintln!("Preparing ASCII video: {}", text(&entry, "title"));
            if let Err(error) = ensure(library, text(&entry, "id")) {
                eprintln!("{}: {}", text(&entry, "title"), error.message);
            }
        }
    }
    for file in fs::read_dir(&library.staging)? {
        let file = file?;
        if file.file_type()?.is_file() {
            fs::remove_file(file.path())?;
        }
    }
    let entries = library.snapshot()?;
    for file in fs::read_dir(&library.cache)? {
        let file = file?;
        if !file.file_type()?.is_file() {
            continue;
        }
        let name = file.file_name().to_string_lossy().into_owned();
        if !entries.iter().any(|entry| {
            entry["status"] == "ready"
                && (Path::new(text(entry, "path")) == file.path()
                    || Path::new(text(entry, "path")).with_extension("jpg") == file.path())
        }) && name
            .split('.')
            .next()
            .is_some_and(|id| id.len() == 20 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            fs::remove_file(file.path())?;
        }
    }
    Ok(())
}
