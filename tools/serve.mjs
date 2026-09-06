// Tiny static dev server for web/, plus a /log sink so the browser can post
// diagnostics somewhere the terminal can read them.
//
//   node tools/serve.mjs [port]
//
// Logs land in tools/dev.log.

import { createServer } from 'node:http';
import { readFile, appendFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web');
const logFile = join(fileURLToPath(new URL('.', import.meta.url)), 'dev.log');
const port = Number(process.argv[2] || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/log') {
    let body = '';
    for await (const c of req) body += c;
    await appendFile(logFile, `${new Date().toISOString()} ${body}\n`);
    res.writeHead(204).end();
    return;
  }
  let path = decodeURIComponent(req.url.split('?')[0]);
  if (path === '/') path = '/index.html';
  const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(port, () => console.log(`serving web/ on http://localhost:${port}`));
