// build/probe-script-runtime.mjs - proves `@christtrade/depth/script-runtime`
// stays importable from a host with no DOM.
//
// The strategy runner bundles this entry on a server (a Cloudflare isolate or a
// container), where a stray `import { X } from '../core'` for a *type* silently
// drags the whole chart - React, the renderers, the canvas layer - into the
// bundle, or fails the build outright. That regression is invisible in the
// browser, where everything resolves fine, so it needs its own check.
//
// Two assertions:
//   1. the module graph contains only the pure-compute files (plus luxon), and
//   2. the bundle evaluates and runs a user script in a scope with no DOM.
//
// Run: node build/probe-script-runtime.mjs

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// every first-party file allowed in the graph. adding one here should be a
// deliberate decision about what a server has to carry, not a reflex.
const ALLOWED_SRC = new Set([
    'src/core/script-runtime.ts',
    'src/core/script-dsl.ts',
    'src/lib/indicator-stdlib.ts',
]);

// identifiers that mean the DOM leaked in. checked against the *bundle text*
// after minification, which is why they are all globals rather than local names
// a minifier would rename.
const DOM_MARKERS = ['document.createElement', 'window.', 'HTMLCanvasElement', 'react/jsx-runtime'];

const result = await esbuild.build({
    entryPoints: [path.join(root, 'src/core/script-runtime.ts')],
    bundle: true,
    write: false,
    minify: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    metafile: true,
    logLevel: 'silent',
});

const failures = [];

// 1. module graph
const inputs = Object.keys(result.metafile.inputs).map((p) => p.replace(/\\/g, '/'));
const firstParty = inputs.filter((p) => !p.includes('node_modules'));
const thirdParty = [...new Set(inputs.filter((p) => p.includes('node_modules')).map(pkgOf))];

for (const f of firstParty) {
    if (!ALLOWED_SRC.has(f)) failures.push(`unexpected source in the graph: ${f}`);
}

const bundle = result.outputFiles[0].text;
for (const marker of DOM_MARKERS) {
    if (bundle.includes(marker)) failures.push(`DOM leaked into the bundle: ${marker}`);
}

// 2. it actually runs
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(bundle).toString('base64');
let mod;
try {
    mod = await import(dataUrl);
} catch (err) {
    failures.push(`bundle will not evaluate: ${err.message}`);
}

if (mod) {
    const bars = [1, 2, 3, 4, 5, 6].map((n, i) => ({
        ts: BigInt(i) * 60_000_000_000n,
        open: n,
        high: n + 1,
        low: n - 1,
        close: n,
        volume: 10,
    }));

    let registered = null;
    try {
        mod.evalScriptInScope(
            `const s = plugin({ name: "probe", type: PluginType.indicator })
             s.init = ({ data }) => ({ ma: sma(data.ohlcv, 3) })`,
            { plugin: (decl) => ((registered = { decl }), registered), shadowNetwork: true },
        );
    } catch (err) {
        failures.push(`a script that only touches the stdlib threw: ${err.message}`);
    }

    if (!registered) failures.push('plugin() never fired - registration is broken');

    // the scope has to hand a script the stdlib and withhold the network
    const scope = mod.buildScriptScope({ plugin: () => ({}), shadowNetwork: true });
    if (typeof scope.sma !== 'function') failures.push('sma missing from the script scope');
    if (scope.fetch !== undefined) failures.push('fetch survived shadowNetwork');
    const values = mod.STDLIB.sma(bars, 3);
    if (!(Math.abs(values[5] - 5) < 1e-9)) {
        failures.push(`sma computed ${values[5]}, expected 5`);
    }
    if (!/^[0-9a-f]{8}$/.test(mod.STDLIB_SIGNATURE)) {
        failures.push(`STDLIB_SIGNATURE is not an 8-char hash: ${mod.STDLIB_SIGNATURE}`);
    }
}

const kb = (bundle.length / 1024).toFixed(1);
console.log(`script-runtime: ${kb} KB minified`);
console.log(`  sources:  ${firstParty.join(', ')}`);
console.log(`  packages: ${thirdParty.join(', ') || '(none)'}`);
if (mod) console.log(`  stdlib:   ${Object.keys(mod.STDLIB).length} helpers, sig ${mod.STDLIB_SIGNATURE}`);

if (failures.length) {
    console.error('\nprobe failed:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}
console.log('  ok - no DOM, runs a script');

function pkgOf(p) {
    const parts = p.split('node_modules/').pop().split('/');
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}
