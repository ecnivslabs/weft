import { createServer } from 'node:http';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.sci': 'application/vnd.weft.sci',
  '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

function byteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !size || (!match[1] && !match[2])) return null;
  const suffix = !match[1];
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = suffix || !match[2] ? size - 1 : Math.min(size - 1, Number(match[2]));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return null;
  return { start, end };
}

export function createStaticServer(directory) {
  const root = realpathSync(directory);
  return createServer((request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return;
    }
    let path, size;
    try {
      const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      path = realpathSync(resolve(root, '.' + (name.endsWith('/') ? name + 'index.html' : name)));
      const metadata = statSync(path);
      if (!path.startsWith(root + sep) || !metadata.isFile()) {
        response.writeHead(404).end(); return;
      }
      size = metadata.size;
    } catch (error) {
      const missing = ['ENOENT', 'ENOTDIR'].includes(error.code);
      response.writeHead(missing ? 404 : error instanceof URIError || error instanceof TypeError ? 400 : 500).end();
      return;
    }
    const requested = request.headers.range;
    const range = requested ? byteRange(requested, size) : { start: 0, end: size - 1 };
    if (!range) {
      response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return;
    }
    const { start, end } = range;
    response.writeHead(requested ? 206 : 200, {
      'Content-Type': types[extname(path)] ?? 'text/plain',
      'Content-Length': size ? end - start + 1 : 0,
      'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...(requested ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (request.method === 'HEAD' || !size) response.end();
    else {
      const stream = createReadStream(path, { start, end });
      stream.on('error', error => response.destroy(error));
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    }
  });
}
