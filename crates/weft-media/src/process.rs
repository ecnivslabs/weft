use std::io::{self, Read};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

pub struct Decoder {
    child: Arc<Mutex<Child>>,
    monitor: Option<JoinHandle<io::Result<()>>>,
    errors: Option<JoinHandle<io::Result<String>>>,
    pub(super) activity: Arc<Mutex<Instant>>,
    pub stdout: ChildStdout,
    pub stdin: Option<ChildStdin>,
}

impl Decoder {
    pub fn spawn(arguments: &[String], input: bool) -> io::Result<Self> {
        Self::spawn_program("ffmpeg", arguments, input)
    }
    pub fn spawn_program(program: &str, arguments: &[String], input: bool) -> io::Result<Self> {
        let mut child = Command::new(program)
            .args(arguments)
            .stdin(if input { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdout = child.stdout.take().unwrap();
        let stdin = child.stdin.take();
        let mut stderr = child.stderr.take().unwrap();
        let errors = thread::spawn(move || {
            let mut buffer = [0; 4096];
            let mut tail = Vec::new();
            loop {
                let n = stderr.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&buffer[..n]);
                if tail.len() > 16384 {
                    tail.drain(..tail.len() - 16384);
                }
            }
            Ok(String::from_utf8_lossy(&tail).into_owned())
        });
        let shared = Arc::new(Mutex::new(child));
        let watcher = shared.clone();
        let activity = Arc::new(Mutex::new(Instant::now()));
        let progress = activity.clone();
        let monitor = thread::spawn(move || loop {
            {
                let mut child = watcher.lock().unwrap();
                if let Some(status) = child.try_wait()? {
                    return if status.success() {
                        Ok(())
                    } else {
                        Err(io::Error::other("Media subprocess failed"))
                    };
                }
                if progress.lock().unwrap().elapsed() > Duration::from_secs(1800) {
                    child.kill()?;
                    child.wait()?;
                    return Err(io::Error::other(
                        "Media subprocess made no I/O progress for 30 minutes",
                    ));
                }
            }
            thread::sleep(Duration::from_millis(20));
        });
        Ok(Self {
            child: shared,
            monitor: Some(monitor),
            errors: Some(errors),
            activity,
            stdout,
            stdin,
        })
    }

    pub fn frame(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let mut position = 0;
        while position < buffer.len() {
            *self.activity.lock().unwrap() = Instant::now();
            let count = self.stdout.read(&mut buffer[position..])?;
            if count == 0 {
                break;
            }
            position += count;
        }
        *self.activity.lock().unwrap() = Instant::now();
        Ok(position)
    }

    pub fn finish(mut self) -> io::Result<()> {
        self.stdin.take();
        let result = self
            .monitor
            .take()
            .unwrap()
            .join()
            .map_err(|_| io::Error::other("Encoder monitor failed"))?;
        let details = self
            .errors
            .take()
            .unwrap()
            .join()
            .map_err(|_| io::Error::other("Encoder stderr reader failed"))??;
        result.map_err(|error| io::Error::other(format!("{error}: {details}")))
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        if self.monitor.is_some() {
            {
                let mut child = self.child.lock().unwrap();
                if matches!(child.try_wait(), Ok(None)) {
                    if let Err(error) = child.kill().and_then(|()| child.wait().map(|_| ())) {
                        eprintln!("Cannot stop FFmpeg: {error}");
                    }
                }
            }
            if let Some(monitor) = self.monitor.take() {
                if monitor.join().is_err() {
                    eprintln!("Encoder monitor failed during cleanup");
                }
            }
            if let Some(errors) = self.errors.take() {
                if errors.join().is_err() {
                    eprintln!("Encoder stderr reader failed during cleanup");
                }
            }
        }
    }
}

pub fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}
