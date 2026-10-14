use weft::{
    format,
    packet::{self, FrameSpec},
    scene,
};

fn spec() -> FrameSpec<'static> {
    FrameSpec {
        width: 24,
        height: 32,
        font: format::FONT,
    }
}
fn frame() -> Vec<u8> {
    let mut encoder = scene::Encoder::new(scene::Options::default()).unwrap();
    encoder
        .map_frame(
            &(0..24 * 32 * 3)
                .map(|i| ((i * 37) % 256) as u8)
                .collect::<Vec<_>>(),
            24,
            32,
        )
        .unwrap()
}
fn decode(bytes: &[u8], previous: Option<&scene::Frame>) -> std::io::Result<scene::Frame> {
    let declared = u32::from_le_bytes(bytes[1..5].try_into().unwrap()) as usize;
    packet::decode_scene(bytes[0], declared, &bytes[9..], previous, spec())
}

#[test]
fn owned_cells_retain_allocation_and_match_caller_slice_decoding() {
    let first = frame();
    let pointer = first.as_ptr();
    let owned = scene::Frame::new(first.clone(), spec()).unwrap();
    let moved = scene::Frame::new(first, spec()).unwrap();
    assert_eq!(moved.cells().as_ptr(), pointer);
    let mut changed = owned.cells().to_vec();
    for cell in changed.as_chunks_mut::<28>().0 {
        cell[4] = cell[4].wrapping_add(1);
    }
    scene::validate(&changed, 24, 32).unwrap();
    let bytes = scene::packet(&changed, Some(owned.cells()), 24, 32).unwrap();
    let decoded = decode(&bytes, Some(&owned)).unwrap();
    assert_eq!(decoded.cells(), changed);
    let declared = u32::from_le_bytes(bytes[1..5].try_into().unwrap()) as usize;
    assert_eq!(
        packet::decode(bytes[0], declared, &bytes[9..], Some(owned.cells()), spec()).unwrap(),
        changed
    );
    let mut pixels = Vec::new();
    decoded.render_rgba(&mut pixels).unwrap();
    let mut expected = Vec::new();
    scene::render_rgba(&changed, 24, 32, &mut expected).unwrap();
    assert_eq!(pixels, expected);
    assert_eq!(owned.cells(), moved.cells());
}

#[test]
fn owned_reference_rejects_wrong_configuration_and_preserves_reference_after_failure() {
    let first = frame();
    let owned = scene::Frame::new(first.clone(), spec()).unwrap();
    let bytes = scene::packet_predicted(&first, &first, 24, 32).unwrap();
    let declared = u32::from_le_bytes(bytes[1..5].try_into().unwrap()) as usize;
    let wrong = FrameSpec {
        width: 12,
        height: 64,
        ..spec()
    };
    assert!(packet::decode_scene(bytes[0], declared, &bytes[9..], Some(&owned), wrong).is_err());
    assert!(packet::decode_scene(
        bytes[0],
        declared,
        &bytes[9..],
        Some(&owned),
        FrameSpec {
            font: "ascii-3x4-v1",
            ..spec()
        }
    )
    .is_err());
    let mut corrupt = bytes.clone();
    corrupt[9] ^= 255;
    assert!(decode(&corrupt, Some(&owned)).is_err());
    assert_eq!(owned.cells(), first);
    assert_eq!(decode(&bytes, Some(&owned)).unwrap().cells(), first);
    let mut invalid = first.clone();
    invalid[3] = 0;
    assert!(scene::Frame::new(invalid, spec()).is_err());
}
