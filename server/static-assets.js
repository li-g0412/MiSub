import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
};

function isOutside(root, path) {
  const difference = relative(root, path);
  return difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference);
}

export async function createStaticAssets(directory) {
  const root = await realpath(directory);
  return async function fetchAsset(request) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    const segments = pathname.split(/[\\/]/);
    if (segments.some((part) => part.startsWith('.') && part !== '.well-known')) {
      return new Response('Not Found', { status: 404 });
    }
    const filename = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (isOutside(root, filename)) return new Response('Not Found', { status: 404 });

    try {
      const canonical = await realpath(filename);
      if (isOutside(root, canonical)) return new Response('Not Found', { status: 404 });
      const info = await stat(canonical);
      if (!info.isFile()) return new Response('Not Found', { status: 404 });
      const extension = extname(canonical).toLowerCase();
      const headers = {
        'Content-Type': CONTENT_TYPES[extension] || 'application/octet-stream',
        'Content-Length': String(info.size),
        'Cache-Control':
          extension === '.html'
            ? 'no-store'
            : pathname.startsWith('/assets/')
              ? 'public, max-age=31536000, immutable'
              : 'public, max-age=3600',
      };
      return new Response(
        request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(canonical)),
        { headers }
      );
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error.code)) {
        return new Response('Not Found', { status: 404 });
      }
      throw error;
    }
  };
}
