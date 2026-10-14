use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub struct Catalog {
    pub json: String,
    path: Option<PathBuf>,
    lock: Option<File>,
}

impl Default for Catalog {
    fn default() -> Self {
        Self {
            json: "[]".into(),
            path: None,
            lock: None,
        }
    }
}

impl Catalog {
    pub fn open(&mut self, path: &Path) -> io::Result<()> {
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path.with_extension("lock"))?;
        lock.try_lock().map_err(|error| {
            io::Error::other(format!(
                "Library is already in use or cannot be locked: {error}"
            ))
        })?;
        self.json = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => "[]".into(),
            Err(error) => return Err(error),
        };
        self.path = Some(path.to_owned());
        self.lock = Some(lock);
        Ok(())
    }

    pub fn swap(&mut self, expected: &str, replacement: &str) -> io::Result<bool> {
        if self.json != expected {
            return Ok(false);
        }
        if let Some(path) = &self.path {
            atomic_write(path, replacement)?;
        }
        self.json = replacement.to_owned();
        Ok(true)
    }
}

fn atomic_write(path: &Path, text: &str) -> io::Result<()> {
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        replace(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let source: Vec<_> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<_> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 1 | 8) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_swap_is_durable_and_rejects_stale_writers() {
        let path = std::env::temp_dir().join(format!("weft-catalog-{}.json", std::process::id()));
        let mut catalog = Catalog::default();
        catalog.open(&path).unwrap();
        let original = catalog.json.clone();
        assert!(catalog.swap(&original, "[1]").unwrap());
        assert!(!catalog.swap("[]", "[2]").unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "[1]");
        let mut loaded = Catalog::default();
        assert!(loaded.open(&path).is_err());
        drop(catalog);
        loaded.open(&path).unwrap();
        assert_eq!(loaded.json, "[1]");
        drop(loaded);
        fs::remove_file(&path).unwrap();
        fs::remove_file(path.with_extension("lock")).unwrap();
    }
}
