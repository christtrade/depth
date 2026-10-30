import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.out');
const port = Number(process.env.PORT ?? 4317);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };

createServer(async (req, res) => {
    const name = new URL(req.url ?? '/', 'http://x').pathname.slice(1) || 'index.html';
    const file = path.join(dir, path.normalize(name));
    if (!file.startsWith(dir)) return void res.writeHead(403).end();
    try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
        res.end(body);
    } catch {
        res.writeHead(404).end();
    }
}).listen(port);
