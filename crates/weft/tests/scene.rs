use std::io::Read;
use weft::scene;

fn squared(a: &[u8], b: &[u8]) -> u64 {
    a.iter()
        .zip(b)
        .map(|(&a, &b)| (i32::from(a) - i32::from(b)).pow(2) as u64)
        .sum()
}

#[test]
fn layered_compositions_improve_detail_without_arbitrary_masks() {
    let mut encoder = scene::Encoder::new(scene::Options::default()).unwrap();
    let mut seed = 0x2714_ae55_u32;
    let mut improved = 0;
    for _ in 0..64 {
        let rgb: Vec<_> = (0..36)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 24) as u8
            })
            .collect();
        let mut baseline = scene::Encoder::new(scene::Options {
            layers: 1,
            ..scene::Options::default()
        })
        .unwrap();
        let baseline = baseline.map_frame(&rgb, 3, 4).unwrap();
        let baseline = scene::render(&baseline, 3, 4).unwrap();
        let frame = encoder.map_frame(&rgb, 3, 4).unwrap();
        let output = scene::render(&frame, 3, 4).unwrap();
        assert!(squared(&rgb, &output) <= squared(&rgb, &baseline));
        improved += usize::from(squared(&rgb, &output) < squared(&rgb, &baseline));
        assert_eq!(frame[3], b' ');
        for layer in frame[8..8 + usize::from(frame[7]) * 5]
            .as_chunks::<5>()
            .0
            .iter()
        {
            assert!((32..=126).contains(&layer[0]));
        }
    }
    assert!(improved > 50);
}

#[test]
fn spatial_merging_and_motion_reference_round_trip_exactly() {
    let mut encoder = scene::Encoder::new(scene::Options::default()).unwrap();
    let rgb = [37, 119, 201].repeat(24 * 32);
    let first = encoder.map_frame(&rgb, 24, 32).unwrap();
    assert_eq!(first[0], 3);
    assert_eq!(scene::render(&first, 24, 32).unwrap(), rgb);
    for reference in [None, Some(first.as_slice())] {
        let packet = scene::packet(&first, reference, 24, 32).unwrap();
        let declared = u32::from_le_bytes(packet[1..5].try_into().unwrap()) as usize;
        let output = weft::packet::decode(
            packet[0],
            declared,
            &packet[9..],
            reference,
            weft::packet::FrameSpec {
                width: 24,
                height: 32,
                font: "ascii-3x4-v2",
            },
        )
        .unwrap();
        assert_eq!(output, first);
    }
    let rgb: Vec<_> = (0..24 * 4 * 3).map(|i| (i * 37) as u8).collect();
    let first = encoder.map_frame(&rgb, 24, 4).unwrap();
    let mut shifted = first.clone();
    shifted.rotate_right(scene::CELL_BYTES);
    let packet = scene::packet(&shifted, Some(&first), 24, 4).unwrap();
    let mut data = Vec::new();
    flate2::read::ZlibDecoder::new(&packet[9..])
        .read_to_end(&mut data)
        .unwrap();
    assert_eq!(
        scene::decode(packet[0], &data, Some(&first), 24, 4).unwrap(),
        shifted
    );
    assert!(scene::decode(5, &data, None, 24, 4).is_err());
}

#[test]
fn composition_decoder_rejects_malformed_geometry_layers_references_and_lengths() {
    let mut encoder = scene::Encoder::new(scene::Options::default()).unwrap();
    let frame = encoder.map_frame(&[19, 179, 242].repeat(12), 3, 4).unwrap();
    let packet = scene::packet(&frame, None, 3, 4).unwrap();
    let mut data = Vec::new();
    flate2::read::ZlibDecoder::new(&packet[9..])
        .read_to_end(&mut data)
        .unwrap();
    for length in 0..data.len() {
        assert!(scene::decode(4, &data[..length], None, 3, 4).is_err());
    }
    let mut extra = data.clone();
    extra.push(0);
    assert!(scene::decode(4, &extra, None, 3, 4).is_err());
    for offset in [0, 1, 2, 3, 7, 8] {
        let mut bad = frame.clone();
        bad[offset] = 255;
        assert!(scene::validate(&bad, 3, 4).is_err());
    }
    assert!(scene::decode(5, &[0, 1, 255, 255, 255, 255], Some(&frame), 3, 4).is_err());
    assert!(scene::decode(5, &[0, 2, 0, 0, 0, 0, 0, 0], Some(&frame), 3, 4).is_err());
    assert!(scene::decode(4, &[0, 0, 3, 32, 255, 0, 0, 0, 0], None, 3, 4).is_err());
    assert!(scene::Encoder::new(scene::Options {
        layers: 5,
        byte_penalty: 0
    })
    .is_err());
}

#[test]
fn scaled_children_cannot_override_validated_root_attributes() {
    let mut encoder = scene::Encoder::new(scene::Options::default()).unwrap();
    let frame = encoder
        .map_frame(&[11, 73, 219].repeat(24 * 32), 24, 32)
        .unwrap();
    for offset in 0..frame.len() {
        let mut corrupted = frame.clone();
        corrupted[offset] ^= 1;
        assert!(
            scene::validate(&corrupted, 24, 32).is_err(),
            "byte {offset}"
        );
    }
}

#[test]
fn rgba_render_matches_rgb_and_overwrites_reused_alpha() {
    let mut encoder = scene::Encoder::new(scene::Options::default()).unwrap();
    for rgb in [
        vec![119; 24 * 32 * 3],
        (0..24 * 32 * 3).map(|index| (index * 19) as u8).collect(),
    ] {
        let frame = encoder.map_frame(&rgb, 24, 32).unwrap();
        let expected = scene::render(&frame, 24, 32).unwrap();
        let mut output = vec![0; 24 * 32 * 4];
        scene::render_rgba(&frame, 24, 32, &mut output).unwrap();
        for (rgb, rgba) in expected
            .as_chunks::<3>()
            .0
            .iter()
            .zip(output.as_chunks::<4>().0)
        {
            assert_eq!(rgb, &rgba[..3]);
            assert_eq!(rgba[3], 255);
        }
    }
}

#[test]
fn color_precision_quantizes_attributes_and_invalidates_patch_cache() {
    let rgb: Vec<_> = (0..24 * 32 * 3)
        .map(|index| (index * 23 + 11) as u8)
        .collect();
    let mut encoder = scene::Encoder::new(scene::Options::default()).unwrap();
    let original = encoder.map_frame(&rgb, 24, 32).unwrap();
    for bits in 4..=8 {
        encoder.set_color_bits(bits).unwrap();
        let frame = encoder.map_frame(&rgb, 24, 32).unwrap();
        scene::validate(&frame, 24, 32).unwrap();
        let levels = (1_u32 << bits) - 1;
        let palette: Vec<_> = (0..=levels)
            .map(|index| ((index * 255 + levels / 2) / levels) as u8)
            .collect();
        for cell in frame.as_chunks::<{ scene::CELL_BYTES }>().0 {
            for color in std::iter::once(&cell[4..7]).chain(
                cell[8..8 + usize::from(cell[7]) * 5]
                    .as_chunks::<5>()
                    .0
                    .iter()
                    .map(|layer| &layer[2..5]),
            ) {
                assert!(color.iter().all(|value| palette.contains(value)));
            }
        }
        if bits == 8 {
            assert_eq!(frame, original);
        }
    }
    for bits in [0, 3, 9, 255] {
        assert!(encoder.set_color_bits(bits).is_err());
    }
    assert_eq!(encoder.map_frame(&rgb, 24, 32).unwrap(), original);
}

#[test]
fn incremental_surface_preserves_pixels_across_geometry_changes_and_errors() {
    let mut encoder = scene::Encoder::new(scene::Options::default()).unwrap();
    let mut surface = scene::Surface::default();
    for (width, height, variation) in [
        (24, 32, 0),
        (24, 32, 1),
        (24, 32, 1),
        (24, 32, 2),
        (27, 36, 0),
        (24, 32, 0),
    ] {
        let mut rgb = [31, 137, 231].repeat(width * height);
        if variation == 1 {
            rgb[..36].fill(179);
        }
        if variation == 2 {
            for (index, value) in rgb.iter_mut().enumerate() {
                *value = (index * 31) as u8;
            }
        }
        let frame = encoder.map_frame(&rgb, width, height).unwrap();
        let expected = scene::render(&frame, width, height).unwrap();
        surface.update(frame.clone(), width, height).unwrap();
        assert_eq!(surface.cells().unwrap(), frame);
        for (rgb, rgba) in expected
            .as_chunks::<3>()
            .0
            .iter()
            .zip(surface.pixels().as_chunks::<4>().0)
        {
            assert_eq!(rgb, &rgba[..3]);
            assert_eq!(rgba[3], 255);
        }
        let before = surface.pixels().to_vec();
        let mut bad = frame.clone();
        bad[0] = 255;
        assert!(surface.update(bad, width, height).is_err());
        assert_eq!(surface.pixels(), before);
        assert_eq!(surface.cells().unwrap(), frame);
    }
}
