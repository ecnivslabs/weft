use weft::{format, packet, scene};

fn spec(width: usize, height: usize) -> packet::FrameSpec<'static> {
    packet::FrameSpec {
        width,
        height,
        font: format::FONT,
    }
}

fn sample() -> Vec<u8> {
    let mut cells = vec![0; 56];
    for (i, cell) in cells.as_chunks_mut::<28>().0.iter_mut().enumerate() {
        cell[3] = b' ';
        cell[4..7].copy_from_slice(&[10 + i as u8, 20 + i as u8, 30 + i as u8]);
    }
    cells[7] = 1;
    cells[8..13].copy_from_slice(&[b'#', 3, 40, 50, 60]);
    cells
}

#[test]
fn independently_specified_streams_restore_exact_cells_and_temporal_attributes() {
    let expected = sample();
    for (mode, layers, colors) in [
        (0, [1, 0], [10, 11, 20, 21, 30, 31]),
        (1, [1, 255], [10, 1, 20, 1, 30, 1]),
    ] {
        let mut payload = vec![mode, 2, 0, 0, 0, 0, 0];
        payload.extend(layers);
        payload.extend(colors);
        payload.extend([b'#', 3, 40, 50, 60]);
        let actual = packet::decode_expanded(8, &payload, None, spec(6, 4)).unwrap();
        assert_eq!(actual, expected);
    }
    let temporal = [2, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    assert_eq!(
        packet::decode_expanded(9, &temporal, Some(&expected), spec(6, 4)).unwrap(),
        expected
    );
    assert!(packet::decode_expanded(9, &temporal, None, spec(6, 4)).is_err());
}

#[test]
fn malformed_fields_fail_without_partial_output_or_unbounded_counts() {
    let valid = vec![0, 1, 0, 0, 0, 0, 1, 10, 20, 30, b'#', 3, 40, 50, 60];
    for length in 0..valid.len() {
        assert!(packet::decode_expanded(8, &valid[..length], None, spec(3, 4)).is_err());
    }
    for (offset, value) in [
        (0, 2),
        (0, 255),
        (1, 0),
        (1, 2),
        (5, 4),
        (6, 5),
        (10, 31),
        (10, 127),
        (11, 4),
    ] {
        let mut invalid = valid.clone();
        invalid[offset] = value;
        assert!(packet::decode_expanded(8, &invalid, None, spec(3, 4)).is_err());
    }
    let mut invalid = valid.clone();
    invalid[1..5].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(packet::decode_expanded(8, &invalid, None, spec(3, 4)).is_err());
    let mut trailing = valid.clone();
    trailing.push(0);
    assert!(packet::decode_expanded(8, &trailing, None, spec(3, 4)).is_err());
    assert!(packet::decode_expanded(8, &valid, None, spec(6, 4)).is_err());
    assert!(packet::decode_expanded(9, &valid, Some(&sample()), spec(6, 4)).is_err());
    scene::validate(&sample(), 6, 4).unwrap();
}

#[test]
fn specified_color_difference_streams_restore_rgb_before_temporal_prediction() {
    let expected = sample();
    for (mode, layers, colors) in [
        (0, [1, 0], [20, 21, 246, 246, 10, 10]),
        (1, [1, 255], [20, 1, 246, 0, 10, 0]),
    ] {
        let mut raw = vec![mode, 2, 0, 0, 0, 0, 0];
        raw.extend(layers);
        raw.extend(colors);
        raw.extend([b'#', 3, 50, 246, 10]);
        assert_eq!(
            packet::decode_expanded(10, &raw, None, spec(6, 4)).unwrap(),
            expected
        );
        for length in 0..raw.len() {
            assert!(packet::decode_expanded(10, &raw[..length], None, spec(6, 4)).is_err());
        }
        raw.push(0);
        assert!(packet::decode_expanded(10, &raw, None, spec(6, 4)).is_err());
    }
    // Only the first background changes; transformed differences cross modulo-256 boundaries.
    let raw = [
        2, 2, 0, 0, 0, 0, 0, 1, 0, 230, 0, 17, 0, 245, 0, 0, 0, 0, 0, 0,
    ];
    let mut updated = expected.clone();
    updated[4..7].copy_from_slice(&[1, 250, 249]);
    assert_eq!(
        packet::decode_expanded(11, &raw, Some(&expected), spec(6, 4)).unwrap(),
        updated
    );
    assert!(packet::decode_expanded(11, &raw, None, spec(6, 4)).is_err());
    assert!(packet::decode_expanded(10, &raw, None, spec(6, 4)).is_err());
}
