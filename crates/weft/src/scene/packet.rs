use super::{invalid, validate, validate_cell, Cell, CELL_BYTES};
use flate2::{write::ZlibEncoder, Compression};
use std::{
    collections::HashMap,
    io::{self, Write},
};

fn roots(frame: &[u8]) -> impl Iterator<Item = (usize, Cell)> + '_ {
    frame
        .as_chunks::<CELL_BYTES>()
        .0
        .iter()
        .enumerate()
        .filter(|(_, cell)| cell[1] == 0 && cell[2] == 0)
        .map(|(index, cell)| (index, *cell))
}

fn palette(frame: &[u8]) -> Vec<[u8; 3]> {
    let mut frequencies = HashMap::<[u8; 3], usize>::new();
    for (_, cell) in roots(frame) {
        *frequencies
            .entry(cell[4..7].try_into().unwrap())
            .or_default() += 1;
        for layer in cell[8..8 + usize::from(cell[7]) * 5]
            .as_chunks::<5>()
            .0
            .iter()
        {
            *frequencies
                .entry(layer[2..5].try_into().unwrap())
                .or_default() += 1;
        }
    }
    let mut sorted: Vec<_> = frequencies
        .into_iter()
        .filter(|(_, count)| *count > 3)
        .collect();
    sorted.sort_unstable_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    sorted
        .into_iter()
        .take(255)
        .map(|(color, _)| color)
        .collect()
}

fn color(bytes: &mut Vec<u8>, value: &[u8], palette: &HashMap<[u8; 3], u8>) {
    if let Some(&index) = palette.get::<[u8; 3]>(&value.try_into().unwrap()) {
        bytes.push(index);
    } else {
        bytes.push(255);
        bytes.extend_from_slice(value);
    }
}

fn literal(bytes: &mut Vec<u8>, cell: &Cell, palette: &HashMap<[u8; 3], u8>) {
    bytes.extend([0, cell[0], b' ']);
    color(bytes, &cell[4..7], palette);
    bytes.push(cell[7]);
    for layer in cell[8..8 + usize::from(cell[7]) * 5]
        .as_chunks::<5>()
        .0
        .iter()
    {
        bytes.extend_from_slice(&layer[..2]);
        color(bytes, &layer[2..5], palette);
    }
}

fn commands(frame: &[u8], previous: Option<&[u8]>) -> Vec<u8> {
    let colors = palette(frame);
    let mut bytes = vec![colors.len() as u8];
    for color in &colors {
        bytes.extend(color);
    }
    let colors: HashMap<_, _> = colors
        .into_iter()
        .enumerate()
        .map(|(i, c)| (c, i as u8))
        .collect();
    let mut reference = HashMap::new();
    if let Some(previous) = previous {
        for (index, cell) in roots(previous) {
            reference.entry(cell).or_insert(index);
        }
    }
    let leaves: Vec<_> = roots(frame).collect();
    let mut i = 0;
    while i < leaves.len() {
        let (index, cell) = leaves[i];
        let matching = previous.and_then(|previous| {
            if previous[index * CELL_BYTES..(index + 1) * CELL_BYTES] == cell {
                Some(index)
            } else {
                reference.get(&cell).copied()
            }
        });
        if let Some(source) = matching {
            let mut run = 1;
            if cell[0] == 0 {
                while run < usize::from(u16::MAX) && i + run < leaves.len() {
                    let (next, value) = leaves[i + run];
                    let source_offset = (source + run) * CELL_BYTES;
                    let previous = previous.unwrap();
                    if value[0] != 0
                        || next != index + run
                        || source_offset + CELL_BYTES > previous.len()
                        || previous[source_offset..source_offset + CELL_BYTES] != value
                    {
                        break;
                    }
                    run += 1;
                }
            }
            if run > 1 {
                bytes.push(2);
                bytes.extend_from_slice(&(run as u16).to_le_bytes());
            } else {
                bytes.push(1);
            }
            bytes.extend_from_slice(&(source as u32).to_le_bytes());
            i += run;
        } else {
            literal(&mut bytes, &cell, &colors);
            i += 1;
        }
    }
    bytes
}

pub(super) fn deflate(data: &[u8]) -> io::Result<Vec<u8>> {
    let mut compressor = ZlibEncoder::new(Vec::new(), Compression::new(3));
    compressor.write_all(data)?;
    compressor.finish()
}

pub(super) fn compressed(tag: u8, data: &[u8]) -> io::Result<Vec<u8>> {
    let compressed = deflate(data)?;
    let mut output = vec![tag];
    output.extend_from_slice(&(data.len() as u32).to_le_bytes());
    output.extend_from_slice(&(compressed.len() as u32).to_le_bytes());
    output.extend(compressed);
    Ok(output)
}

pub fn packet(
    frame: &[u8],
    previous: Option<&[u8]>,
    width: usize,
    height: usize,
) -> io::Result<Vec<u8>> {
    validate(frame, width, height)?;
    if let Some(previous) = previous {
        validate(previous, width, height)?;
    }
    let mut best = compressed(4, &commands(frame, None))?;
    let spatial = compressed(6, &super::planes::encode(frame, None, width / 3, (0, 0)))?;
    if spatial.len() < best.len() {
        best = spatial;
    }
    if let Some(previous) = previous {
        let predicted = predicted(frame, previous, width)?;
        if predicted.len() < best.len() {
            best = predicted;
        }
    }
    Ok(best)
}

/// Encode reference-dependent candidates without recomputing a staged independent packet.
pub fn packet_predicted(
    frame: &[u8],
    previous: &[u8],
    width: usize,
    height: usize,
) -> io::Result<Vec<u8>> {
    validate(frame, width, height)?;
    validate(previous, width, height)?;
    predicted(frame, previous, width)
}

fn predicted(frame: &[u8], previous: &[u8], width: usize) -> io::Result<Vec<u8>> {
    let mut best = compressed(5, &commands(frame, Some(previous)))?;
    let temporal = compressed(
        7,
        &super::planes::encode(frame, Some(previous), width / 3, (0, 0)),
    )?;
    if temporal.len() < best.len() {
        best = temporal;
    }
    let motion = motion(frame, previous, width / 3);
    if motion != (0, 0) {
        let moved = compressed(
            7,
            &super::planes::encode(frame, Some(previous), width / 3, motion),
        )?;
        if moved.len() < best.len() {
            best = moved;
        }
    }
    Ok(best)
}

fn motion(frame: &[u8], previous: &[u8], columns: usize) -> (i16, i16) {
    let reference: HashMap<_, _> = roots(previous).map(|(index, cell)| (cell, index)).collect();
    let mut votes = HashMap::<(i16, i16), usize>::new();
    for (index, cell) in roots(frame).step_by(16) {
        let source = if previous[index * CELL_BYTES..(index + 1) * CELL_BYTES] == cell {
            Some(index)
        } else {
            reference.get(&cell).copied()
        };
        if let Some(source) = source {
            let dx = index as isize % columns as isize - source as isize % columns as isize;
            let dy = index as isize / columns as isize - source as isize / columns as isize;
            if dx.abs() <= 64 && dy.abs() <= 64 {
                *votes.entry((dx as i16, dy as i16)).or_default() += 1;
            }
        }
    }
    votes
        .into_iter()
        .max_by(|a, b| {
            a.1.cmp(&b.1).then_with(|| {
                let order = |(x, y): (i16, i16)| (x.unsigned_abs() + y.unsigned_abs(), x, y);
                order(b.0).cmp(&order(a.0))
            })
        })
        .map_or((0, 0), |(motion, _)| motion)
}

struct Input<'a> {
    data: &'a [u8],
    offset: usize,
}
impl Input<'_> {
    fn take(&mut self, length: usize) -> io::Result<&[u8]> {
        let end = self.offset.checked_add(length).ok_or_else(invalid)?;
        let bytes = self.data.get(self.offset..end).ok_or_else(invalid)?;
        self.offset = end;
        Ok(bytes)
    }
    fn byte(&mut self) -> io::Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn color(&mut self, palette: &[[u8; 3]]) -> io::Result<[u8; 3]> {
        let index = self.byte()?;
        if index == 255 {
            return Ok(self.take(3)?.try_into().unwrap());
        }
        palette.get(usize::from(index)).copied().ok_or_else(invalid)
    }
    fn cell(&mut self, palette: &[[u8; 3]]) -> io::Result<Cell> {
        let mut cell = [0; CELL_BYTES];
        cell[0] = self.byte()?;
        cell[3] = self.byte()?;
        cell[4..7].copy_from_slice(&self.color(palette)?);
        cell[7] = self.byte()?;
        if cell[7] > 4 {
            return Err(invalid());
        }
        for layer in 0..usize::from(cell[7]) {
            let offset = 8 + layer * 5;
            cell[offset..offset + 2].copy_from_slice(self.take(2)?);
            cell[offset + 2..offset + 5].copy_from_slice(&self.color(palette)?);
        }
        validate_cell(&cell)?;
        Ok(cell)
    }
}

pub fn decode(
    tag: u8,
    data: &[u8],
    previous: Option<&[u8]>,
    width: usize,
    height: usize,
) -> io::Result<Vec<u8>> {
    decode_previous(
        tag,
        data,
        previous.map(super::Previous::Caller),
        width,
        height,
    )
}

pub(crate) fn decode_previous(
    tag: u8,
    data: &[u8],
    previous: Option<super::Previous<'_>>,
    width: usize,
    height: usize,
) -> io::Result<Vec<u8>> {
    if [6, 7].contains(&tag) {
        return super::planes::decode_previous(tag, data, previous, width, height);
    }
    if ![4, 5].contains(&tag) || (tag == 5 && previous.is_none()) {
        return Err(invalid());
    }
    let count = crate::cells::dimensions(width, height)?;
    if data.is_empty() || data.len() > count * 38 + 1024 {
        return Err(invalid());
    }
    let previous = if tag == 5 {
        Some(previous.unwrap().validated(width, height)?)
    } else {
        None
    };
    let mut input = Input { data, offset: 0 };
    let entries = usize::from(input.byte()?);
    let palette: Vec<[u8; 3]> = input.take(entries * 3)?.as_chunks::<3>().0.to_vec();
    let mut frame = vec![0; count * CELL_BYTES];
    let columns = width / 3;
    let mut index = 0;
    while index < count {
        let command = input.byte()?;
        if command == 0 {
            let cell = input.cell(&palette)?;
            super::place(&mut frame, columns, index, cell)?;
        } else if tag == 5 && [1, 2].contains(&command) {
            let run = if command == 2 {
                u16::from_le_bytes(input.take(2)?.try_into().unwrap()) as usize
            } else {
                1
            };
            let source = u32::from_le_bytes(input.take(4)?.try_into().unwrap()) as usize;
            if run == 0
                || index + run > count
                || source.checked_add(run).is_none_or(|end| end > count)
            {
                return Err(invalid());
            }
            let previous = previous.ok_or_else(invalid)?;
            for offset in 0..run {
                let cell: Cell = previous
                    [(source + offset) * CELL_BYTES..(source + offset + 1) * CELL_BYTES]
                    .try_into()
                    .unwrap();
                if command == 2 && cell[0] != 0 {
                    return Err(invalid());
                }
                super::place(&mut frame, columns, index + offset, cell)?;
            }
            if command == 2 {
                index += run - 1;
            }
        } else {
            return Err(invalid());
        }
        while index < count && frame[index * CELL_BYTES + 3] != 0 {
            index += 1;
        }
    }
    if input.offset != data.len() {
        return Err(invalid());
    }
    validate(&frame, width, height)?;
    Ok(frame)
}
