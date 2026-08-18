// Smoke test for dist/ — loads the built bundle under a DOM and checks that the
// public surface survived bundling + minification. Run: npm run dist:smoke
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
// defineProperty, not assignment: Node >=21 ships its own getter-only
// globalThis.navigator, which a plain assignment throws on.
for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Blob'])
    Object.defineProperty(globalThis, k, {
        value: dom.window[k],
        configurable: true,
        writable: true,
    });
globalThis.self = dom.window;
// jsdom has no Worker/canvas; stub enough that module-level code can run.
globalThis.Worker = class { postMessage() {} terminate() {} addEventListener() {} };
globalThis.URL.createObjectURL ??= () => 'blob:stub';
globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// The declared public API — every name core/index.ts promises consumers.
const src = await readFile(path.join(root, 'src/core/index.ts'), 'utf8');
const expected = [
    ...src.matchAll(/export\s*\{([^}]*)\}/g),
]
    .filter((m) => !/export\s+type\s*\{/.test(m[0]))
    .flatMap((m) => m[1].split(','))
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !s.startsWith('type '))
    .map((s) => (s.includes(' as ') ? s.split(/\s+as\s+/)[1] : s).trim());

const bundleFile = process.argv[2] ? path.resolve(process.argv[2]) : path.join(dist, 'depth.mjs');
const mod = await import(bundleFile);
const missing = [...new Set(expected)].filter((name) => !(name in mod));

assert.strictEqual(
    missing.length,
    0,
    `missing from dist/depth.mjs: ${missing.join(', ')}`
);
assert.ok(typeof mod.DepthChart === 'function', 'DepthChart is not constructible');
assert.ok(typeof mod.Depth === 'function', 'Depth (React) missing');
assert.ok(typeof mod.useDepthChart === 'function', 'useDepthChart missing');

// Blob-inlined workers must be reachable, not dangling .ts URLs.
const bundle = await readFile(bundleFile, 'utf8');
assert.ok(!bundle.includes('.worker.ts'), 'unresolved worker URL left in bundle');
assert.ok(!/\/\/# sourceMappingURL/.test(bundle), 'source map reference left in bundle');
assert.ok(!bundle.includes('christtrade/packages/depth/src'), 'absolute source paths leaked');

const css = await readFile(path.join(dist, 'depth.css'), 'utf8');
assert.ok(css.includes('--background'), 'theme variables missing from depth.css');

// Rules the app gets from globals.css and dist has to carry itself. Each of
// these went missing once already and the failure is invisible until someone
// installs the tarball: black icons, gray-200 borders, system font.
assert.ok(bundle.includes('depth-root'), 'depth-root class stripped from bundle');
assert.ok(/\.depth-root\{[^}]*Inter/.test(css), 'depth-root does not set the font');
assert.ok(css.includes('@font-face') && css.includes('data:font/woff2'), 'Inter not inlined');
assert.ok(
    css.includes('border-color:hsl(var(--border))'),
    'preflight still resets borders to its own default'
);

console.log(`ok — ${[...new Set(expected)].length} runtime exports present, workers inlined, no source leakage`);
