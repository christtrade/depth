import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'e2e/.out');
mkdirSync(out, { recursive: true });

await esbuild.build({
    entryPoints: [path.join(root, 'e2e/harness/main.tsx')],
    outfile: path.join(out, 'main.js'),
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    sourcemap: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { '@christtrade/depth': path.join(root, 'dist/depth.mjs') },
    logLevel: 'warning',
});

copyFileSync(path.join(root, 'dist/depth.css'), path.join(out, 'depth.css'));
writeFileSync(
    path.join(out, 'index.html'),
    `<!doctype html>
<html class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="depth.css">
<style>html, body, #root { margin: 0; height: 100%; background: #0b0d10; color: #ddd; }</style>
</head>
<body><div id="root"></div><script type="module" src="main.js"></script></body>
</html>
`,
);
