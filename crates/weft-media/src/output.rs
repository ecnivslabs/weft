use crate::process::{strings, Decoder};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use weft::timing::Quality;

static ENCODING: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static FILE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

pub(super) struct Permit;
impl Drop for Permit {
    fn drop(&mut self) {
        ENCODING.fetch_sub(1, Ordering::Relaxed);
    }
}

pub(super) struct Temporary(pub(super) Vec<PathBuf>);
impl Temporary {
    pub(super) fn reserve(&mut self, path: &Path) -> io::Result<()> {
        OpenOptions::new().write(true).create_new(true).open(path)?;
        self.0.push(path.to_owned());
        Ok(())
    }
}

impl Drop for Temporary {
    fn drop(&mut self) {
        for path in &self.0 {
            if let Err(error) = fs::remove_file(path) {
                if error.kind() != io::ErrorKind::NotFound {
                    eprintln!("Cannot remove {}: {error}", path.display());
                }
            }
        }
    }
}

pub(super) struct Record {
    pub(super) quality: u16,
    pub(super) columns: u16,
    pub(super) rows: u16,
    pub(super) frames: u16,
    pub(super) first: u32,
    pub(super) decoded: u32,
    pub(super) offset: u64,
    pub(super) length: u32,
    pub(super) checksum: u32,
}

pub(super) fn append(
    file: &mut File,
    quality: Option<&Quality>,
    frames: u16,
    first: u32,
    decoded: u32,
    payload: &[u8],
) -> io::Result<Record> {
    let offset = file.stream_position()?;
    file.write_all(payload)?;
    Ok(Record {
        quality: quality.map_or(0, |q| q.height),
        columns: quality.map_or(0, |q| q.columns),
        rows: quality.map_or(0, |q| q.rows),
        frames,
        first,
        decoded,
        offset,
        length: payload
            .len()
            .try_into()
            .map_err(|_| io::Error::other("SCI chunk too large"))?,
        checksum: crc32fast::hash(payload),
    })
}

pub(super) fn write_record(file: &mut File, record: &Record) -> io::Result<()> {
    file.write_all(&record.quality.to_le_bytes())?;
    file.write_all(&record.columns.to_le_bytes())?;
    file.write_all(&record.rows.to_le_bytes())?;
    file.write_all(&record.frames.to_le_bytes())?;
    file.write_all(&record.first.to_le_bytes())?;
    file.write_all(&record.decoded.to_le_bytes())?;
    file.write_all(&record.offset.to_le_bytes())?;
    file.write_all(&record.length.to_le_bytes())?;
    file.write_all(&record.checksum.to_le_bytes())
}

pub(super) fn thumbnail(cells: &[u8], quality: &Quality, path: &Path) -> io::Result<()> {
    let rgb = weft::scene::render(
        cells,
        usize::from(quality.columns),
        usize::from(quality.rows),
    )?;
    let mut arguments = strings(&[
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-filter_threads",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
    ]);
    arguments.push(format!("{}x{}", quality.columns, quality.rows));
    arguments.extend(strings(&[
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-vf",
        "scale=256:-2:flags=lanczos",
    ]));
    arguments.push(path.to_string_lossy().into_owned());
    let mut encoder = Decoder::spawn(&arguments, true)?;
    encoder.stdin.take().unwrap().write_all(&rgb)?;
    encoder.finish()
}

pub(super) fn permit() -> io::Result<Permit> {
    let mut count = ENCODING.load(Ordering::Relaxed);
    while count < 2 {
        match ENCODING.compare_exchange_weak(count, count + 1, Ordering::Relaxed, Ordering::Relaxed)
        {
            Ok(_) => return Ok(Permit),
            Err(current) => count = current,
        }
    }
    Err(io::Error::other(
        "Two videos are already being prepared. Retry shortly.",
    ))
}

pub(super) fn publish(
    file: File,
    picture: &Path,
    temporary: &Path,
    destination: &Path,
) -> io::Result<()> {
    file.sync_all()?;
    drop(file);
    OpenOptions::new().write(true).open(picture)?.sync_all()?;
    let thumbnail = destination.with_extension("jpg");
    fs::hard_link(picture, &thumbnail)?;
    if let Err(error) = fs::hard_link(temporary, destination) {
        fs::remove_file(thumbnail)?;
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_preparation_never_exceeds_two_permits() {
        let barrier = std::sync::Barrier::new(4);
        let accepted = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    barrier.wait();
                    let permit = permit().ok();
                    if permit.is_some() {
                        accepted.fetch_add(1, Ordering::Relaxed);
                    }
                    barrier.wait();
                    assert_eq!(ENCODING.load(Ordering::Relaxed), 2);
                    barrier.wait();
                    drop(permit);
                });
            }
        });
        assert_eq!(accepted.load(Ordering::Relaxed), 2);
        assert_eq!(ENCODING.load(Ordering::Relaxed), 0);
        assert!(permit().is_ok());
    }

    #[test]
    fn temporary_guard_removes_only_successfully_reserved_paths() {
        let directory = std::env::temp_dir().join(format!(
            "weft-reservation-{}-{}",
            std::process::id(),
            FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        let foreign = directory.join("foreign");
        let owned = directory.join("owned");
        fs::write(&foreign, b"preserve").unwrap();
        {
            let mut guard = Temporary(Vec::new());
            guard.reserve(&owned).unwrap();
            assert_eq!(
                guard.reserve(&foreign).unwrap_err().kind(),
                io::ErrorKind::AlreadyExists
            );
        }
        assert!(!owned.exists());
        assert_eq!(fs::read(&foreign).unwrap(), b"preserve");
        fs::remove_dir_all(directory).unwrap();
    }
}
