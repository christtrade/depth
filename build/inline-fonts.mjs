// build/inline-fonts.mjs — embeds Inter into dist/*.css as a data URI.
//
// Depth ships its own font rather than pointing at a font CDN: the bundle
// already inlines its workers, and a consumer behind a strict CSP (or building
// something offline) should not have the chart silently fall back to the
// system sans. Latin subset of the variable face only — 48KB woff2, ~64KB once
// base64'd, which is the whole reason we don't ship the other seven subsets.
//
// Run after the tailwind CLI, once per CSS variant.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');

const woff2 = await readFile(path.join(root, 'build/fonts/inter-latin-var.woff2'));

// unicode-range copied from Google's own latin slice, so a glyph outside it
// falls through to the next family in the stack instead of rendering tofu.
const face =
    `@font-face{font-family:Inter;font-style:normal;font-weight:100 900;font-display:swap;` +
    `src:url(data:font/woff2;base64,${woff2.toString('base64')}) format("woff2");` +
    `unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,` +
    `U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}\n`;

for (const file of ['depth.css', 'depth.nopreflight.css']) {
    const target = path.join(dist, file);
    const css = await readFile(target, 'utf8');
    if (css.includes('@font-face')) continue; // already inlined
    await writeFile(target, face + css);
    console.log(`inlined Inter into ${file}`);
}
