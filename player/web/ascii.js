import font from './glyphs.json' with { type: 'json' };

export const CELL_BYTES = 28;
export const masks = new Int16Array(128).fill(-1);
for (const [character, mask] of font.glyphs) masks[character] = mask;
export const glyphMasks = new Map([[font.name, masks]]);
export { font };

export function reflectMask(mask, transform) {
  invalid(!Number.isInteger(transform) || transform < 0 || transform > 3);
  let output = 0;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 3; x++) {
      const sourceX = transform & 1 ? 2 - x : x;
      const sourceY = transform & 2 ? 3 - y : y;
      output |= ((mask >> (sourceY * 3 + sourceX)) & 1) << (y * 3 + x);
    }
  }
  return output;
}


function invalid(condition) {
  if (condition) throw new Error('Invalid SCI ASCII frame.');
}
