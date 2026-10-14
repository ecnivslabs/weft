use std::{
    io::{self, Write},
    time::Duration,
};
use weft_media::command::execute;

fn child(name: &str, timeout: Duration) -> io::Result<String> {
    let program = std::env::current_exe()?;
    execute(
        program.to_str().unwrap(),
        &[
            "--exact".into(),
            name.into(),
            "--ignored".into(),
            "--nocapture".into(),
        ],
        timeout,
    )
}

#[test]
fn subprocesses_drain_both_pipes_bound_capture_and_propagate_failures() {
    assert!(child("fixture_small", Duration::from_secs(10))
        .unwrap()
        .contains("capture works"));
    assert!(child("fixture_large", Duration::from_secs(10))
        .unwrap_err()
        .to_string()
        .contains("exceeded"));
    assert!(child("fixture_failure", Duration::from_secs(10))
        .unwrap_err()
        .to_string()
        .contains("capture failure"));
    assert_eq!(
        child("fixture_deadline", Duration::from_millis(100))
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
}

#[test]
#[ignore = "subprocess fixture"]
fn fixture_small() {
    println!("capture works");
}

#[test]
#[ignore = "subprocess fixture"]
fn fixture_large() {
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr().lock();
    let bytes = [b'x'; 4096];
    for _ in 0..2048 {
        stdout.write_all(&bytes).unwrap();
        stderr.write_all(&bytes).unwrap();
    }
}

#[test]
#[ignore = "subprocess fixture"]
fn fixture_failure() {
    panic!("capture failure");
}

#[test]
#[ignore = "subprocess fixture"]
fn fixture_deadline() {
    std::thread::sleep(Duration::from_secs(10));
}
