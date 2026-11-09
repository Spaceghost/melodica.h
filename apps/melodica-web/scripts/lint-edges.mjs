#!/usr/bin/env node
// Design rule (Jack, 2026-11-08): never a colored single side on a rounded element.
// Fails on any rule that gives a rounded element (border-radius > 0, in any rule for
// the same class) a one-side colored border, an inset box-shadow stripe, or a
// ::before/::after edge bar. Use a full border, a background tint or a badge.
// Usage: node scripts/lint-edges.mjs <file.css>...
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
// Innermost rule blocks: selector { declarations } (at-rules are walked into).
function rules(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1].trim();
    if (sel.startsWith('@')) continue;
    out.push({ sel, decl: m[2] });
  }
  return out;
}
const decls = (d) => Object.fromEntries(d.split(';').map((x) => x.split(':')).filter((x) => x.length >= 2).map(([k, ...v]) => [k.trim().toLowerCase(), v.join(':').trim()]));
const lastCompound = (s) => s.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() || '';
const classesOf = (compound) => (compound.replace(/::?[a-z-]+(\([^)]*\))?/g, '').match(/\.[\w-]+/g) || []);
const noColor = (v) => /^(none|0|0px|transparent|inherit|initial|unset)$/i.test(v.trim()) || /\btransparent\b/i.test(v) || /^0(px)?\s/.test(v.trim()) || /\bnone\b/.test(v);
const rounded = (v) => v && !/^(0|0px|0%)(\s+(0|0px|0%))*$/.test(v.trim());

let bad = 0;
for (const f of files) {
  const rs = rules(strip(readFileSync(f, 'utf8'))).flatMap((r) => r.sel.split(',').map((sel) => ({ sel: sel.trim(), d: decls(r.decl) })));
  const roundedClasses = new Set();
  const roundedSels = new Set();
  const norm = (sel) => sel.replace(/::?[a-z-]+(\([^)]*\))?/g, '').replace(/\s+/g, ' ').trim();
  for (const r of rs) {
    if (!rounded(r.d['border-radius'])) continue;
    roundedSels.add(norm(r.sel));
    for (const c of classesOf(lastCompound(r.sel))) roundedClasses.add(c);
  }
  // `.list li.active` is rounded when `.list li` (or `.list li.x`, or a class of it) is.
  const viaBase = (sel) => {
    let s = norm(sel);
    for (let i = 0; i < 6; i++) {
      if (roundedSels.has(s)) return true;
      const t = s.replace(/(\.[\w-]+|\[[^\]]*\])$/, '');
      if (t === s || !t || /\s$/.test(t)) break;
      s = t;
    }
    return false;
  };
  for (const r of rs) {
    const cls = classesOf(lastCompound(r.sel));
    const isRounded = rounded(r.d['border-radius']) || cls.some((c) => roundedClasses.has(c)) || viaBase(r.sel);
    if (!isRounded) continue;
    const pseudo = /::?(before|after)\b/.test(r.sel);
    const why = [];
    if (!pseudo) {
      for (const side of ['left', 'right', 'top', 'bottom']) {
        const w = r.d[`border-${side}-width`];
        if (w && r.d.border && !/^0/.test(w)) why.push(`border-${side}-width: ${w} (one heavier side)`);
        for (const k of [`border-${side}`, `border-${side}-color`, `border-inline-${side === 'left' ? 'start' : side === 'right' ? 'end' : ''}`.replace(/-$/, '')]) {
          const v = r.d[k];
          if (v && !noColor(v) && !(k.endsWith('-color') && !r.d[`border-${side}-width`] && !r.d[`border-${side}`] && r.d.border)) why.push(`${k}: ${v}`);
        }
      }
      const sh = r.d['box-shadow'];
      if (sh && /inset/.test(sh) && /inset\s+(-?\d+(\.\d+)?(px|rem|em)?)\s+(-?\d+(\.\d+)?(px|rem|em)?)\s+0(px)?\s/.test(sh)) {
        const [, x, , , y] = /inset\s+(-?\d+(\.\d+)?(px|rem|em)?)\s+(-?\d+(\.\d+)?(px|rem|em)?)/.exec(sh);
        if (parseFloat(x) !== 0 || parseFloat(y) !== 0) why.push(`box-shadow: ${sh}`);
      }
    } else {
      const d = r.d;
      const thin = (v) => v && /^(\d+(\.\d+)?)(px)$/.test(v) && parseFloat(v) <= 6 || (v && /^0?\.\d+rem$|^[0-3](\.\d+)?px$/.test(v));
      const edge = d.position === 'absolute' && ((thin(d.width) && (d.top !== undefined || d.inset !== undefined) && (d.bottom !== undefined || d.inset !== undefined || d.height === '100%'))
        || (thin(d.height) && (d.left !== undefined || d.inset !== undefined) && (d.right !== undefined || d.width === '100%')));
      if (edge && (d.background || d['background-color'])) why.push('an edge bar');
    }
    if (why.length) { bad++; console.error(`${f}: ${r.sel} { ${why.join('; ')} } on a rounded element`); }
  }
}
if (bad) { console.error(`lint-edges: ${bad} single-side accent(s) on rounded elements`); process.exit(1); }
console.log(`lint-edges: ok (${files.length} file(s))`);
