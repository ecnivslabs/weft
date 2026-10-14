//! Single-instance bounded decoder ABI for browser workers.
//! Output buffers are borrowed read-only views. Host writes to output cells invalidate
//! their owned validation provenance; hostile-host linear-memory protection is not provided.
use std::{cell::RefCell, sync::Arc};
use weft::{packet, scene};
mod painted;

#[derive(Default)]
struct State {
    input: Vec<u8>,
    previous: Option<Arc<scene::Frame>>,
    painted: painted::Painted,
    output: Vec<u8>,
    surface: scene::Surface,
    error: Vec<u8>,
    configuration: Option<(usize, usize, u32, bool)>,
}

thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn reserve(length: u32) -> usize {
    STATE.with_borrow_mut(|state| {
        state.error.clear();
        if length == 0 || length > 16 * 1024 * 1024 {
            state.painted.clear();
            state
                .error
                .extend_from_slice(b"Invalid compressed packet length");
            return 0;
        }
        state.input.resize(length as usize, 0);
        state.input.as_mut_ptr() as usize
    })
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn decode(
    width: u32,
    height: u32,
    format: u32,
    font: u32,
    tag: u32,
    declared: u32,
    reset: u32,
) -> u32 {
    decode_input(
        width, height, format, font, tag, declared, reset, false, true,
    )
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn decode_expanded(
    width: u32,
    height: u32,
    format: u32,
    font: u32,
    tag: u32,
    declared: u32,
    reset: u32,
) -> u32 {
    decode_input(
        width, height, format, font, tag, declared, reset, true, true,
    )
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn decode_cells(
    width: u32,
    height: u32,
    format: u32,
    font: u32,
    tag: u32,
    declared: u32,
    reset: u32,
) -> u32 {
    decode_input(
        width, height, format, font, tag, declared, reset, false, false,
    )
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn decode_cells_expanded(
    width: u32,
    height: u32,
    format: u32,
    font: u32,
    tag: u32,
    declared: u32,
    reset: u32,
) -> u32 {
    decode_input(
        width, height, format, font, tag, declared, reset, true, false,
    )
}

#[allow(clippy::too_many_arguments)]
fn decode_input(
    width: u32,
    height: u32,
    format: u32,
    font: u32,
    tag: u32,
    declared: u32,
    reset: u32,
    expanded: bool,
    render: bool,
) -> u32 {
    STATE.with_borrow_mut(|state| {
        state.error.clear();
        state.painted.invalidate_plan();
        let result = (|| {
            if format != 28 {
                return Err(std::io::Error::other("Unsupported SCI representation"));
            }
            if reset > 1 || tag > 255 {
                return Err(std::io::Error::other("Invalid decoder arguments"));
            }
            let width = width as usize;
            let height = height as usize;
            if font != 1 {
                return Err(std::io::Error::other("Unsupported SCI font"));
            }
            let font_name = "ascii-3x4-v2";
            let configuration = (width, height, font, render);
            if reset == 1 {
                if state.configuration != Some(configuration) {
                    state.painted.clear();
                }
                state.previous = None;
                state.configuration = Some(configuration);
            }
            if state.configuration != Some(configuration) {
                return Err(std::io::Error::other(
                    "Decoder dimensions changed without reset",
                ));
            }
            let previous = if render {
                if reset == 0 {
                    state.surface.cells()
                } else {
                    None
                }
            } else {
                state.previous.as_ref().map(|frame| frame.cells())
            };
            let spec = packet::FrameSpec {
                width,
                height,
                font: font_name,
            };
            if !render {
                let previous = state.previous.as_ref().map(Arc::as_ref);
                let frame = if expanded {
                    if state.input.len() != declared as usize {
                        return Err(std::io::Error::other(
                            "Expanded packet length does not match declaration",
                        ));
                    }
                    packet::decode_scene_expanded(tag as u8, &state.input, previous, spec)?
                } else {
                    packet::decode_scene(
                        tag as u8,
                        declared as usize,
                        &state.input,
                        previous,
                        spec,
                    )?
                };
                state.previous = Some(Arc::new(frame));
                state.output.clear();
                state.surface = scene::Surface::default();
                return Ok(());
            }
            let frame = if expanded {
                if state.input.len() != declared as usize {
                    return Err(std::io::Error::other(
                        "Expanded packet length does not match declaration",
                    ));
                }
                packet::decode_expanded(tag as u8, &state.input, previous, spec)?
            } else {
                packet::decode(tag as u8, declared as usize, &state.input, previous, spec)?
            };
            state.output.clear();
            state.surface.update(frame, width, height)?;
            state.previous = None;
            Ok::<(), std::io::Error>(())
        })();
        if let Err(error) = result {
            state.output.clear();
            state.surface = scene::Surface::default();
            state.previous = None;
            state.painted.clear();
            state.configuration = None;
            state.error.extend_from_slice(error.to_string().as_bytes());
            0
        } else {
            1
        }
    })
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn pixels() -> usize {
    STATE.with_borrow(|state| {
        if state.surface.cells().is_some() {
            state.surface.pixels().as_ptr() as usize
        } else {
            state.output.as_ptr() as usize
        }
    })
}
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn pixels_length() -> usize {
    STATE.with_borrow(|state| {
        if state.surface.cells().is_some() {
            state.surface.pixels().len()
        } else {
            state.output.len()
        }
    })
}
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn render_current_cells() -> u32 {
    STATE.with_borrow_mut(|state| {
        state.error.clear();
        let result = (|| {
            let Some((width, height, font, false)) = state.configuration else {
                return Err(std::io::Error::other(
                    "Decoder does not own a cell-output frame",
                ));
            };
            let frame = state
                .previous
                .as_ref()
                .ok_or_else(|| std::io::Error::other("Decoder has no current ASCII cells"))?;
            let spec = frame.spec();
            if spec.width != width || spec.height != height || font != 1 {
                return Err(std::io::Error::other("Owned frame configuration changed"));
            }
            frame.render_rgba(&mut state.output)
        })();
        match result {
            Ok(()) => 1,
            Err(error) => {
                state.output.clear();
                state.painted.clear();
                state.error.extend_from_slice(error.to_string().as_bytes());
                0
            }
        }
    })
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn frame() -> usize {
    STATE.with_borrow(|state| {
        state
            .previous
            .as_ref()
            .map_or(0, |frame| frame.cells().as_ptr() as usize)
    })
}
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn frame_length() -> usize {
    STATE.with_borrow(|state| {
        state
            .previous
            .as_ref()
            .map_or(0, |frame| frame.cells().len())
    })
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn dirty_plan() -> u32 {
    STATE.with_borrow_mut(|state| {
        state.error.clear();
        let result = (|| {
            let Some((width, height, _, false)) = state.configuration else {
                return Err(std::io::Error::other(
                    "Decoder does not own a cell-output frame",
                ));
            };
            let frame = state
                .previous
                .as_ref()
                .ok_or_else(|| std::io::Error::other("Decoder has no current ASCII cells"))?;
            state.painted.prepare(frame, width, height)
        })();
        match result {
            Ok(()) => 1,
            Err(error) => {
                state.painted.clear();
                state.error.extend_from_slice(error.to_string().as_bytes());
                0
            }
        }
    })
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn dirty_flags() -> u32 {
    STATE.with_borrow(|state| u32::from(state.painted.full))
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn dirty_changed_cells() -> u32 {
    STATE.with_borrow(|state| state.painted.changed.unwrap_or(u32::MAX))
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn dirty_rectangles() -> usize {
    STATE.with_borrow(|state| state.painted.rectangles.as_ptr() as usize)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn dirty_rectangles_length() -> usize {
    STATE.with_borrow(|state| state.painted.rectangles.len() * 4)
}

#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn commit_painted() -> u32 {
    STATE.with_borrow_mut(|state| {
        state.error.clear();
        let result = (|| {
            let Some((width, height, _, false)) = state.configuration else {
                return Err(std::io::Error::other(
                    "Decoder does not own a cell-output frame",
                ));
            };
            let frame = state
                .previous
                .as_ref()
                .ok_or_else(|| std::io::Error::other("Decoder has no current ASCII cells"))?;
            state.painted.commit(frame, width, height)
        })();
        match result {
            Ok(()) => 1,
            Err(error) => {
                state.painted.clear();
                state.error.extend_from_slice(error.to_string().as_bytes());
                0
            }
        }
    })
}
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn error() -> usize {
    STATE.with_borrow(|state| state.error.as_ptr() as usize)
}
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn error_length() -> usize {
    STATE.with_borrow(|state| state.error.len())
}
#[cfg_attr(target_arch = "wasm32", no_mangle)]
pub extern "C" fn reset() {
    STATE.with_borrow_mut(|state| *state = State::default());
}

#[cfg(test)]
mod tests;
