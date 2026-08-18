// esbuild plugin: inline `new Worker(new URL('./x.worker.ts', import.meta.url))`.
//
// esbuild does not resolve `new URL(..., import.meta.url)` the way Vite/webpack
// do, so those specifiers would survive into dist as dead references to .ts
// files we never ship. Instead each worker is bundled on its own and embedded as
// a string; at runtime it becomes a Blob URL. Result: dist is a single self
// contained file with no sidecar worker assets for the consumer to host.

import * as esbuild from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const WORKER_URL = /new URL\(\s*(['"])([^'"]+?\.worker\.ts|[^'"]+?-worker\.ts)\1\s*,\s*import\.meta\.url\s*\)/g;
const NAMESPACE = 'depth-inline-worker';

export function inlineWorkers({ minify = true, target } = {}) {
    return {
        name: 'inline-workers',
        setup(build) {
            const cache = new Map();

            const bundleWorker = async (file) => {
                if (cache.has(file)) return cache.get(file);
                const result = await esbuild.build({
                    entryPoints: [file],
                    bundle: true,
                    write: false,
                    minify,
                    target,
                    // IIFE is valid source for both classic and `type: 'module'`
                    // workers, so one build covers every call site.
                    format: 'iife',
                    platform: 'browser',
                    legalComments: 'none',
                    logLevel: 'silent',
                });
                const code = result.outputFiles[0].text;
                cache.set(file, code);
                return code;
            };

            build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
                if (args.path.includes('node_modules')) return null;
                const source = await readFile(args.path, 'utf8');
                if (!WORKER_URL.test(source)) return null;
                WORKER_URL.lastIndex = 0;

                const imports = [];
                const seen = new Map();
                const code = source.replace(WORKER_URL, (_m, _q, spec) => {
                    const abs = path.resolve(path.dirname(args.path), spec);
                    if (!seen.has(abs)) {
                        const ident = `__depthWorker${seen.size}`;
                        seen.set(abs, ident);
                        imports.push(`import ${ident} from ${JSON.stringify(NAMESPACE + ':' + abs)};`);
                    }
                    return `${seen.get(abs)}()`;
                });

                return {
                    contents: imports.join('\n') + '\n' + code,
                    loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
                    resolveDir: path.dirname(args.path),
                };
            });

            build.onResolve({ filter: new RegExp(`^${NAMESPACE}:`) }, (args) => ({
                path: args.path.slice(NAMESPACE.length + 1),
                namespace: NAMESPACE,
            }));

            build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async (args) => {
                const code = await bundleWorker(args.path);
                return {
                    loader: 'js',
                    contents: `
const __src = ${JSON.stringify(code)};
let __url;
export default function () {
  if (!__url) __url = URL.createObjectURL(new Blob([__src], { type: 'text/javascript' }));
  return __url;
}
`,
                };
            });
        },
    };
}
