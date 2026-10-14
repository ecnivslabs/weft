use std::io::{self, Read};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const MAX_CAPTURE: usize = 8 * 1024 * 1024;

fn capture(mut reader: impl Read) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    let mut exceeded = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        if bytes.len() + count >= MAX_CAPTURE {
            exceeded = true;
        }
        if !exceeded {
            bytes.extend_from_slice(&buffer[..count]);
        }
    }
    if exceeded {
        Err(io::Error::other(
            "Process output exceeded the supported limit",
        ))
    } else {
        Ok(bytes)
    }
}

/// Capture a subprocess with bounded output, a deadline, and concurrent pipe draining.
pub fn execute(program: &str, arguments: &[String], timeout: Duration) -> io::Result<String> {
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || capture(stdout));
    let err = thread::spawn(move || capture(stderr));
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("{program} timed out"),
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error);
            }
        }
    };
    let output = out
        .join()
        .map_err(|_| io::Error::other("Process stdout reader failed"))?;
    let errors = err
        .join()
        .map_err(|_| io::Error::other("Process stderr reader failed"))?;
    let status = status?;
    let errors = errors?;
    if !status.success() {
        let details = String::from_utf8_lossy(&errors);
        let tail: String = details
            .chars()
            .rev()
            .take(800)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(io::Error::other(format!("{program}: {tail}")));
    }
    String::from_utf8(output?).map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}
