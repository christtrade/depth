// build/build.mjs - produces a redistributable, source-free build of `depth`.
//
//   dist/depth.mjs   ESM  (for Vite / Next / any bundler)
//   dist/depth.cjs   CJS  (for older toolchains)
//   dist/depth.css   compiled Tailwind + theme variables
//   dist/index.d.ts  types (emitted separately by `npm run build:types`)
//
// react / react-dom stay external so the consumer's copy is used - bundling a
// second React would break hooks the moment the chart renders.

import * as esbuild from 'esbuild';
import { rm, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { inlineWorkers } from './inline-workers.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');

// Identity comes from the workspace manifest, never a second copy of it here -
// a hardcoded version publishes the same number twice and npm rejects the
// second one.
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const TARGET = ['es2020', 'chrome100', 'firefox100', 'safari16'];

const shared = {
    entryPoints: [path.join(root, 'src/core/index.ts')],
    plugins: [inlineWorkers({ minify: true, target: TARGET })],
    bundle: true,
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    target: TARGET,
    jsx: 'automatic',
    platform: 'browser',
    // Everything else (radix, lucide, sonner, luxon, nanoid, ...) is bundled in
    // so the consumer only needs react + react-dom installed.
    //
    // @web3icons/react is 12.5MB of the ~14MB output: its "dynamic" entry is a
    // statically-imported registry of every token icon, so no bundler can tree
    // shake it. SLIM=1 externalises it (consumer must then install it too) and
    // drops the bundle to ~1.5MB.
    external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react-dom/client',
        ...(process.env.SLIM === '1' ? ['@web3icons/react/dynamic', '@web3icons/react'] : []),
    ],
    // Depth components are client-side; keep the directive for Next consumers.
    banner: { js: "'use client';" },
    logOverride: { 'ignored-directive': 'silent' },
};

const results = await Promise.all([
    esbuild.build({ ...shared, format: 'esm', outfile: path.join(dist, 'depth.mjs') }),
    esbuild.build({ ...shared, format: 'cjs', outfile: path.join(dist, 'depth.cjs') }),
]);

for (const r of results) {
    for (const w of r.warnings) console.warn('[warn]', w.text, w.location?.file ?? '');
}

// Root type entry -`npm run build:types` emits the tree under dist/types.
await writeFile(path.join(dist, 'index.d.ts'), "export * from './types/core/index';\n");

// package.json the consumer actually installs - no source, no build config.
await writeFile(
    path.join(dist, 'package.json'),
    JSON.stringify(
        {
            name: pkg.name,
            version: pkg.version,
            description: pkg.description,
            author: pkg.author,
            // npm resolves the README's relative links against this. without it
            // the SECURITY.md / NOTICE links 404 on npmjs.com.
            repository: pkg.repository,
            homepage: pkg.homepage,
            main: './depth.cjs',
            module: './depth.mjs',
            types: './index.d.ts',
            exports: {
                '.': { types: './index.d.ts', import: './depth.mjs', require: './depth.cjs' },
                './depth.css': './depth.css',
                './depth.nopreflight.css': './depth.nopreflight.css',
                // Some tooling reads this directly; without it they get
                // ERR_PACKAGE_PATH_NOT_EXPORTED.
                './package.json': './package.json',
            },
            sideEffects: ['*.css'],
            peerDependencies: {
                // 19 included deliberately: `npm create vite` scaffolds React 19,
                // and a ^18-only range makes a fresh app fail ERESOLVE on install.
                // Verified rendering + interaction on both 18 and 19.
                react: '^18 || ^19',
                'react-dom': '^18 || ^19',
                // SLIM=1 leaves the icon pack out of the bundle, so the
                // consumer has to supply it.
                ...(process.env.SLIM === '1' ? { '@web3icons/react': '^4' } : {}),
            },
            license: 'Apache-2.0',
        },
        null,
        2
    ) + '\n'
);

// the repo README is the published one. a second consumer-facing copy under
// build/ only ever drifted out of date.
await copyFile(path.join(root, 'README.md'), path.join(dist, 'README.md'));

// Apache-2.0 4(a) and 4(d): the published tarball has to carry both, not just
// the repo.
await copyFile(path.join(root, 'LICENSE.md'), path.join(dist, 'LICENSE.md'));
await copyFile(path.join(root, 'NOTICE'), path.join(dist, 'NOTICE'));

console.log('built dist/depth.mjs + dist/depth.cjs');
