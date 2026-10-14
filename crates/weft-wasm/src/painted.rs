use std::{io, sync::Arc};
use weft::scene;

#[derive(Default)]
pub(crate) struct Painted {
    frame: Option<Arc<scene::Frame>>,
    prepared: Option<Arc<scene::Frame>>,
    dimensions: Option<(usize, usize)>,
    pub full: bool,
    pub changed: Option<u32>,
    pub rectangles: Vec<[u32; 4]>,
    dirty: Vec<u8>,
}

impl Painted {
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn invalidate_plan(&mut self) {
        self.prepared = None;
        self.rectangles.clear();
        self.full = false;
        self.changed = None;
    }

    fn full(&mut self, columns: usize, rows: usize, changed: Option<u32>) {
        self.full = true;
        self.changed = changed;
        self.rectangles.clear();
        self.rectangles.push([0, 0, columns as u32, rows as u32]);
    }

    pub fn prepare(
        &mut self,
        frame: &Arc<scene::Frame>,
        width: usize,
        height: usize,
    ) -> io::Result<()> {
        self.invalidate_plan();
        if !(3..=4096).contains(&width)
            || !(4..=1080).contains(&height)
            || !width.is_multiple_of(3)
            || !height.is_multiple_of(4)
            || width * height > 4423680
            || frame.cells().len() != width / 3 * (height / 4) * 28
            || frame.spec().width != width
            || frame.spec().height != height
        {
            return Err(io::Error::other("Invalid painted ASCII dimensions"));
        }
        let columns = width / 3;
        let rows = height / 4;
        let count = columns * rows;
        self.prepared = Some(Arc::clone(frame));
        if self.dimensions != Some((width, height)) || self.frame.is_none() {
            self.full(columns, rows, Some(count as u32));
            return Ok(());
        }
        let previous = self.frame.as_ref().unwrap();
        let stride = count.div_ceil(128);
        let mut sampled = 0;
        let mut sampled_changes = 0;
        for index in (0..count).step_by(stride) {
            sampled += 1;
            sampled_changes += usize::from(
                frame.cells()[index * 28..(index + 1) * 28]
                    != previous.cells()[index * 28..(index + 1) * 28],
            );
        }
        if sampled_changes * 2 >= sampled {
            self.full(columns, rows, None);
            return Ok(());
        }
        let tile_columns = columns.div_ceil(32);
        let tile_rows = rows.div_ceil(8);
        self.dirty.resize(tile_columns * tile_rows, 0);
        self.dirty.fill(0);
        let mut changed = 0;
        for (index, (current, old)) in frame
            .cells()
            .as_chunks::<28>()
            .0
            .iter()
            .zip(previous.cells().as_chunks::<28>().0.iter())
            .enumerate()
        {
            if current != old {
                changed += 1;
                let x = index % columns;
                let y = index / columns;
                self.dirty[y / 8 * tile_columns + x / 32] = 1;
            }
        }
        self.changed = Some(changed);
        if changed as usize * 2 >= count {
            self.full(columns, rows, Some(changed));
            return Ok(());
        }
        let mut previous_row = Vec::<usize>::with_capacity(32);
        let mut current_row = Vec::<usize>::with_capacity(32);
        for y in 0..tile_rows {
            current_row.clear();
            let mut x = 0;
            while x < tile_columns {
                if self.dirty[y * tile_columns + x] == 0 {
                    x += 1;
                    continue;
                }
                let first = x;
                x += 1;
                while x < tile_columns && self.dirty[y * tile_columns + x] != 0 {
                    x += 1;
                }
                let left = first * 32;
                let top = y * 8;
                let extent = columns.min(x * 32) - left;
                let height = 8.min(rows - top);
                let adjacent = previous_row.iter().copied().find(|&index| {
                    let rectangle = self.rectangles[index];
                    rectangle[0] as usize == left
                        && rectangle[2] as usize == extent
                        && (rectangle[1] + rectangle[3]) as usize == top
                });
                let index = if let Some(index) = adjacent {
                    self.rectangles[index][3] += height as u32;
                    index
                } else {
                    if self.rectangles.len() == 32 {
                        self.full(columns, rows, Some(changed));
                        return Ok(());
                    }
                    self.rectangles
                        .push([left as u32, top as u32, extent as u32, height as u32]);
                    self.rectangles.len() - 1
                };
                current_row.push(index);
            }
            std::mem::swap(&mut previous_row, &mut current_row);
        }
        let covered: u32 = self
            .rectangles
            .iter()
            .map(|rectangle| rectangle[2] * rectangle[3])
            .sum();
        if covered as usize * 2 >= count {
            self.full(columns, rows, Some(changed));
        }
        Ok(())
    }

    pub fn commit(
        &mut self,
        frame: &Arc<scene::Frame>,
        width: usize,
        height: usize,
    ) -> io::Result<()> {
        if !self
            .prepared
            .as_ref()
            .is_some_and(|prepared| Arc::ptr_eq(prepared, frame))
        {
            self.clear();
            return Err(io::Error::other("Painted ASCII plan is missing or stale"));
        }
        self.frame = Some(Arc::clone(frame));
        self.dimensions = Some((width, height));
        self.prepared = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(cells: Vec<u8>, columns: usize, rows: usize) -> Arc<scene::Frame> {
        Arc::new(
            scene::Frame::new(
                cells,
                weft::packet::FrameSpec {
                    width: columns * 3,
                    height: rows * 4,
                    font: "ascii-3x4-v2",
                },
            )
            .unwrap(),
        )
    }

    fn frame(columns: usize, rows: usize) -> Arc<scene::Frame> {
        let mut cells = vec![0; columns * rows * 28];
        for cell in cells.as_chunks_mut::<28>().0 {
            cell[3] = b' ';
        }
        owned(cells, columns, rows)
    }

    #[test]
    fn painted_ownership_survives_deferred_frames_without_copying() {
        let first = frame(128, 24);
        let mut painted = Painted::default();
        painted.prepare(&first, 384, 96).unwrap();
        assert!(painted.full);
        painted.commit(&first, 384, 96).unwrap();
        assert!(Arc::ptr_eq(painted.frame.as_ref().unwrap(), &first));
        let mut deferred = first.cells().to_vec();
        deferred[28 * 33 + 4] = 3;
        painted.invalidate_plan();
        let mut selected = first.cells().to_vec();
        selected[28 * 33 + 5] = 7;
        let selected = owned(selected, 128, 24);
        painted.prepare(&selected, 384, 96).unwrap();
        assert!(!painted.full);
        assert_eq!(painted.changed, Some(1));
        assert_eq!(painted.rectangles, [[32, 0, 32, 8]]);
        painted.commit(&selected, 384, 96).unwrap();
        painted.prepare(&selected, 384, 96).unwrap();
        assert_eq!(painted.changed, Some(0));
        assert!(painted.rectangles.is_empty());
        assert_eq!(deferred[28 * 33 + 4], 3);
    }

    #[test]
    fn tiles_merge_vertically_clip_edges_and_bound_fragmentation() {
        let first = frame(129, 25);
        let mut painted = Painted::default();
        painted.prepare(&first, 387, 100).unwrap();
        painted.commit(&first, 387, 100).unwrap();
        let mut next = first.cells().to_vec();
        for (x, y) in [(128, 0), (128, 8), (128, 24)] {
            next[(y * 129 + x) * 28 + 4] = 1;
        }
        painted.prepare(&owned(next, 129, 25), 387, 100).unwrap();
        assert_eq!(painted.rectangles, [[128, 0, 1, 16], [128, 24, 1, 1]]);
        let first = frame(1365, 270);
        painted.clear();
        painted.prepare(&first, 4095, 1080).unwrap();
        painted.commit(&first, 4095, 1080).unwrap();
        let mut next = first.cells().to_vec();
        for y in (0..270).step_by(16) {
            for x in (0..1365).step_by(64) {
                next[(y * 1365 + x) * 28 + 4] = 1;
            }
        }
        painted
            .prepare(&owned(next, 1365, 270), 4095, 1080)
            .unwrap();
        assert!(painted.full);
        assert_eq!(painted.rectangles.len(), 1);
    }

    #[test]
    fn dense_sampling_only_selects_full_and_stale_commit_rejects() {
        let first = frame(128, 24);
        let mut painted = Painted::default();
        painted.prepare(&first, 384, 96).unwrap();
        painted.commit(&first, 384, 96).unwrap();
        let mut next = first.cells().to_vec();
        for cell in next.as_chunks_mut::<28>().0 {
            cell[4] = 1;
        }
        let next = owned(next, 128, 24);
        painted.prepare(&next, 384, 96).unwrap();
        assert!(painted.full);
        assert_eq!(painted.changed, None);
        assert!(painted.commit(&first, 384, 96).is_err());
        assert!(painted.frame.is_none());
        assert!(painted.prepare(&next, usize::MAX, 96).is_err());
        painted.prepare(&next, 384, 96).unwrap();
        assert!(painted.full);
    }
}
