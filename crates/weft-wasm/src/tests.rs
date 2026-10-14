fn frame() -> Vec<u8> {
    let mut cells = vec![0; 128 * 24 * 28];
    for cell in cells.as_chunks_mut::<28>().0 {
        cell[3] = 32;
    }
    cells
}

fn load(cells: &[u8], reset: u32) -> u32 {
    let count = cells.len() / 28;
    let mut input = vec![0; cells.len()];
    for channel in 0..28 {
        for index in 0..count {
            let left = if index % 128 != 0 {
                cells[(index - 1) * 28 + channel]
            } else {
                0
            };
            let above = if index >= 128 {
                cells[(index - 128) * 28 + channel]
            } else {
                0
            };
            let corner = if index >= 128 && index % 128 != 0 {
                cells[(index - 129) * 28 + channel]
            } else {
                0
            };
            let value = i16::from(left) + i16::from(above) - i16::from(corner);
            let distances = [
                (value - i16::from(left)).abs(),
                (value - i16::from(above)).abs(),
                (value - i16::from(corner)).abs(),
            ];
            let prediction = if distances[0] <= distances[1] && distances[0] <= distances[2] {
                left
            } else if distances[1] <= distances[2] {
                above
            } else {
                corner
            };
            input[channel * count + index] = cells[index * 28 + channel].wrapping_sub(prediction);
        }
    }
    let declared = input.len() as u32;
    super::STATE.with_borrow_mut(|state| state.input = input);
    super::decode_cells_expanded(384, 96, 28, 1, 6, declared, reset)
}

#[test]
fn abi_rejects_oversized_inputs_and_invalid_parameters_without_output() {
    super::reset();
    assert_eq!(super::reserve(16 * 1024 * 1024 + 1), 0);
    assert!(super::error_length() > 0);
    assert_ne!(super::reserve(16), 0);
    assert_eq!(super::decode(3, 4, 28, 1, 5, 1, 0), 0);
    assert_eq!(super::pixels_length(), 0);
    assert_eq!(super::decode(u32::MAX, 4, 28, 1, 4, 1, 1), 0);
    super::reset();
    assert_eq!(super::error_length(), 0);
}

#[test]
fn painted_abi_preserves_presentation_reference_across_decode_reset_and_deferred_events() {
    super::reset();
    let first = frame();
    assert_eq!(load(&first, 1), 1);
    assert_eq!(super::dirty_plan(), 1);
    assert_eq!(super::dirty_flags(), 1);
    assert_eq!(super::commit_painted(), 1);
    super::STATE.with_borrow(|state| {
        assert_eq!(
            std::sync::Arc::strong_count(state.previous.as_ref().unwrap()),
            2
        )
    });
    assert_eq!(load(&first, 1), 1);
    assert_eq!(super::dirty_plan(), 1);
    assert_eq!(super::dirty_flags(), 0);
    assert_eq!(super::dirty_changed_cells(), 0);
    assert_eq!(super::commit_painted(), 1);
    let mut deferred = first.clone();
    deferred[33 * 28 + 4] = 17;
    assert_eq!(load(&deferred, 0), 1);
    let mut selected = first.clone();
    selected[100 * 28 + 6] = 23;
    assert_eq!(load(&selected, 0), 1);
    assert_eq!(super::dirty_plan(), 1);
    assert_eq!(super::dirty_changed_cells(), 1);
    assert_eq!(super::dirty_rectangles_length(), 4);
    super::STATE.with_borrow(|state| assert_eq!(state.painted.rectangles, [[96, 0, 32, 8]]));
    assert_eq!(super::commit_painted(), 1);
    assert_eq!(super::dirty_plan(), 1);
    assert_eq!(super::dirty_changed_cells(), 0);
    super::reset();
}

#[test]
fn painted_abi_rejects_stale_commits_and_clears_after_failed_decode_or_render() {
    super::reset();
    let first = frame();
    assert_eq!(super::dirty_plan(), 0);
    assert_eq!(super::commit_painted(), 0);
    assert_eq!(load(&first, 1), 1);
    assert_eq!(super::dirty_plan(), 1);
    assert_eq!(load(&first, 1), 1);
    assert_eq!(super::commit_painted(), 0);
    assert_eq!(super::dirty_plan(), 1);
    assert_eq!(super::dirty_flags(), 1);
    assert_eq!(super::commit_painted(), 1);
    let mut invalid = first.clone();
    invalid[3] = 1;
    assert_eq!(load(&invalid, 0), 0);
    assert_eq!(super::frame_length(), 0);
    assert_eq!(super::dirty_rectangles_length(), 0);
    assert_eq!(load(&first, 1), 1);
    assert_eq!(super::dirty_plan(), 1);
    assert_eq!(super::dirty_flags(), 1);
    assert_eq!(super::commit_painted(), 1);
    assert_eq!(
        super::decode_expanded(384, 96, 28, 1, 6, first.len() as u32, 1),
        1
    );
    assert_eq!(super::render_current_cells(), 0);
    assert_eq!(super::commit_painted(), 0);
    assert_eq!(load(&first, 1), 1);
    assert_eq!(super::dirty_plan(), 1);
    assert_eq!(super::dirty_flags(), 1);
    super::reset();
}

#[test]
fn owned_temporal_cells_preserve_configuration_and_invalidate_after_errors() {
    super::reset();
    let first = frame();
    assert_eq!(load(&first, 1), 1);
    let length = first.len() + 4;
    super::STATE.with_borrow_mut(|state| state.input = vec![0; length]);
    assert_eq!(
        super::decode_cells_expanded(384, 96, 28, 1, 7, length as u32, 0),
        1
    );
    super::STATE.with_borrow(|state| assert_eq!(state.previous.as_ref().unwrap().cells(), first));
    assert_eq!(
        super::decode_cells_expanded(384, 96, 29, 1, 7, length as u32, 0),
        0
    );
    assert_eq!(super::frame_length(), 0);
    assert_eq!(
        super::decode_cells_expanded(384, 96, 28, 1, 7, length as u32, 0),
        0
    );
    assert_eq!(load(&first, 1), 1);
    super::STATE.with_borrow_mut(|state| {
        state.input = vec![0; length];
        state.input[4 + 3 * (first.len() / 28)] = 1;
    });
    assert_eq!(
        super::decode_cells_expanded(384, 96, 28, 1, 7, length as u32, 0),
        0
    );
    assert_eq!(super::frame_length(), 0);
    assert_eq!(super::dirty_rectangles_length(), 0);
    assert_eq!(load(&first, 1), 1);
    assert_eq!(super::render_current_cells(), 1);
    assert_eq!(super::pixels_length(), 384 * 96 * 4);
    super::reset();
}

#[test]
fn owned_render_rejects_configuration_mismatch_and_removed_profiles() {
    for (width, height, font) in [(387, 96, 1), (384, 100, 1), (384, 96, 0)] {
        super::reset();
        assert_eq!(load(&frame(), 1), 1);
        super::STATE
            .with_borrow_mut(|state| state.configuration = Some((width, height, font, false)));
        assert_eq!(super::render_current_cells(), 0);
        assert_eq!(super::pixels_length(), 0);
        assert_eq!(super::commit_painted(), 0);
    }
    for format in [7, 8, 29, 30] {
        super::reset();
        assert_eq!(load(&frame(), 1), 1);
        assert_eq!(super::decode_cells_expanded(384, 96, format, 1, 6, 1, 1), 0);
        assert_eq!(super::frame_length(), 0);
    }
    super::reset();
}
