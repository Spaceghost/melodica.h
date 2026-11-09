// Design rule: no colored single side on any element (rounded cards above all). No
// border-left/right/top/bottom (or inline/block side) in a color, no thicker side,
// no inset box-shadow stripe. Use a full border, a tint or a badge. Neutral hairline
// dividers (var(--line), var(--line-2), var(--control-line)) are allowed.
//   node scripts/lint-edges.mjs file.css ...
import { readFileSync } from 'node:fs';

const SIDE = /^border-(left|right|top|bottom|inline-start|inline-end|block-start|block-end)(-color|-width|-style)?$/;
const NEUTRAL = /^(0|none|transparent|1px solid var\(--(line|line-2|control-line)(\)|,.*\))|solid|1px)$/;
let bad = 0;
for (const file of process.argv.slice(2)) {
  const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = rule.exec(css))) {
    const line = css.slice(0, m.index + m[1].length).split('\n').length;
    for (const decl of m[2].split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const value = decl.slice(i + 1).replace(/!important/, '').trim().replace(/\s+/g, ' ');
      let why = '';
      const side = prop.match(SIDE);
      if (side && side[2] === '-width' && !/^(0|1px)$/.test(value)) why = 'a thicker single side';
      else if (side && side[2] === '-color' && !/^(transparent|var\(--(line|line-2|control-line)\))$/.test(value)) why = 'a colored single side';
      else if (side && !side[2] && !NEUTRAL.test(value)) why = 'a single-side border that is not a neutral hairline';
      if (prop === 'box-shadow') {
        for (const part of value.split(/,(?![^(]*\))/)) {
          if (!/\binset\b/.test(part)) continue;
          const nums = part.replace(/\binset\b/, '').replace(/var\([^)]*\)|#[0-9a-f]+|\b(rgba?|hsla?|color-mix|oklch)\([^)]*(\([^)]*\)[^)]*)*\)/gi, '').trim().split(/\s+/).filter((t) => /^-?[0-9.]+(px|rem|em)?$/.test(t));
          if (nums.length >= 2 && (parseFloat(nums[0]) !== 0 || parseFloat(nums[1]) !== 0)) why = 'an inset box-shadow stripe on one side';
        }
      }
      if (why) { bad++; console.error(`${file}:${line}: ${m[1].trim().split('\n').pop()} { ${prop}: ${value} }: ${why}. Use a full border, a tint or a badge.`); }
    }
  }
}
if (bad) { console.error(`lint-edges: ${bad} single-side accent(s)`); process.exit(1); }
console.log('lint-edges: no single-side accents');
