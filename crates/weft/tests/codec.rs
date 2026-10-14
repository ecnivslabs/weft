use flate2::{write::ZlibEncoder, Compression};
use serde_json::json;
use std::io::Write;
use weft::{
    cells, format,
    packet::{self, FrameSpec},
    scene,
};

#[test]
fn every_printable_glyph_reflection_reconstructs_the_normative_mask() {
    let font: serde_json::Value = serde_json::from_str(weft::FONT_JSON).unwrap();
    assert_eq!(font["glyphs"].as_array().unwrap().len(), 95);
    for entry in font["glyphs"].as_array().unwrap() {
        let code = entry[0].as_u64().unwrap() as u8;
        let mask = entry[1].as_u64().unwrap() as u16;
        for transform in 0..4 {
            let mut frame = vec![0; 28];
            frame[3] = b' ';
            frame[4..7].copy_from_slice(&[21, 43, 65]);
            frame[7] = 1;
            frame[8..13].copy_from_slice(&[code, transform, 198, 212, 234]);
            let pixels = scene::render(&frame, 3, 4).unwrap();
            for y in 0..4 {
                for x in 0..3 {
                    let sx = if transform & 1 != 0 { 2 - x } else { x };
                    let sy = if transform & 2 != 0 { 3 - y } else { y };
                    let expected = if mask & (1 << (sy * 3 + sx)) != 0 {
                        [198, 212, 234]
                    } else {
                        [21, 43, 65]
                    };
                    assert_eq!(&pixels[(y * 3 + x) * 3..(y * 3 + x + 1) * 3], expected);
                }
            }
        }
    }
    assert!(cells::mask(b' ', "ascii-3x4-v1").is_err());
    assert!(format::reflect(1, 4).is_err());
}

#[test]
fn only_current_symbol_metadata_and_packets_are_accepted() {
    let current = json!({"codec":format::CODEC,"cellBytes":28,"font":format::FONT,"glyphTransform":"reflect-xy-v1"});
    format::validate_video(&current).unwrap();
    for codec in [
        "sci-ascii-v1",
        "sci-ascii-v2",
        "sci-ascii-scene-v2",
        "sci-ascii-scene-v3",
        "h264",
    ] {
        let mut removed = current.clone();
        removed["codec"] = codec.into();
        assert!(format::validate_video(&removed).is_err());
    }
    for (key, value) in [
        ("font", json!("ascii-3x4-v1")),
        ("cellBytes", json!(8)),
        ("glyphTransform", json!("unknown")),
    ] {
        let mut removed = current.clone();
        removed[key] = value;
        assert!(format::validate_video(&removed).is_err());
    }
    let spec = FrameSpec {
        width: 3,
        height: 4,
        font: format::FONT,
    };
    let mut expanded = vec![0; 28];
    expanded[3] = b' ';
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&expanded).unwrap();
    let compressed = encoder.finish().unwrap();
    for tag in [0, 1, 2, 3, 8, 9, 255] {
        assert!(packet::decode(tag, 28, &compressed, None, spec).is_err());
    }
    for length in 0..compressed.len() {
        assert!(packet::decode(6, 28, &compressed[..length], None, spec).is_err());
    }
    let mut trailing = compressed.clone();
    trailing.push(0);
    assert!(packet::decode(6, 28, &trailing, None, spec).is_err());
    assert!(packet::decode(6, 27, &compressed, None, spec).is_err());
}
