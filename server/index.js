import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { onRequest } from '../functions/[[path]].js';
import { openSqliteStorage } from './sqlite-storage.js';
import { createStaticAssets } from './static-assets.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readBody(request) {
  if (Number(request.headers['content-length']) > MAX_BODY_BYTES) {
    request.resume();
    return Promise.reject(httpError(413, 'Request body too large'));
  }
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let chunks = [];
    let exceeded = false;
    request.on('data', (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        exceeded = true;
        chunks = [];
        reject(httpError(413, 'Request body too large'));
      } else {
        chunks.push(chunk);
      }
    });
    request.once('end', () => {
      if (!exceeded) resolveBody(Buffer.concat(chunks));
    });
    request.once('error', reject);
    request.once('aborted', () => reject(httpError(400, 'Request aborted')));
  });
}

function requestOrigin(request, publicOrigin) {
  if (publicOrigin) return publicOrigin;
  const trustProxy = process.env.TRUST_PROXY === 'true';
  const first = (value) =>
    String(value || '')
      .split(',')[0]
      .trim();
  const protocol =
    trustProxy && request.headers['x-forwarded-proto']
      ? first(request.headers['x-forwarded-proto'])
      : 'http';
  const host =
    trustProxy && request.headers['x-forwarded-host']
      ? first(request.headers['x-forwarded-host'])
      : request.headers.host;
  if (!['http', 'https'].includes(protocol) || !host || /[\s\\/@?#]/.test(host)) {
    throw httpError(400, 'Invalid request origin');
  }
  return new URL(`${protocol}://${host}`).origin;
}

async function sendResponse(request, response, outgoing) {
  if (!(response instanceof Response)) throw new Error('Handler returned an invalid response');
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie' && !HOP_HEADERS.has(name)) outgoing.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
  if (request.method === 'HEAD' || !response.body) {
    await response.body?.cancel();
    outgoing.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), outgoing);
}

async function main() {
  if (!process.env.ADMIN_PASSWORD?.trim()) throw new Error('ADMIN_PASSWORD is required');
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  let publicOrigin;
  if (process.env.MISUB_PUBLIC_URL) {
    const url = new URL(process.env.MISUB_PUBLIC_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('MISUB_PUBLIC_URL must be an HTTP/HTTPS URL without credentials');
    }
    publicOrigin = url.origin;
  }

  const fetchAsset = await createStaticAssets(resolve(ROOT, 'dist'));
  const filename = resolve(process.env.DATA_DIR || resolve(ROOT, 'data'), 'misub.sqlite');
  process.umask(0o077);
  const storage = openSqliteStorage(filename);
  const env = {
    ...process.env,
    MISUB_KV: storage.kv,
    MISUB_DB: storage.db,
    ASSETS: { fetch: fetchAsset },
  };
  const pending = new Set();
  const waitUntil = (promise) => {
    const task = Promise.resolve(promise)
      .catch((error) => console.error('[Background task]', error))
      .finally(() => pending.delete(task));
    pending.add(task);
  };
  const cleanup = setInterval(() => {
    try {
      storage.purgeExpired();
    } catch (error) {
      console.error('[SQLite cleanup]', error);
    }
  }, 60 * 1000);
  cleanup.unref();

  const server = createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    incoming.once('aborted', () => controller.abort());
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) controller.abort();
    });
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
        throw httpError(400, 'Invalid request target');
      }
      const body = await readBody(incoming);
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        const name = incoming.rawHeaders[i];
        if (!HOP_HEADERS.has(name.toLowerCase())) {
          headers.append(name, incoming.rawHeaders[i + 1]);
        }
      }
      if (process.env.TRUST_PROXY !== 'true') {
        headers.delete('CF-Connecting-IP');
        headers.set('X-Real-IP', incoming.socket.remoteAddress || '');
        headers.set('X-Forwarded-For', incoming.socket.remoteAddress || '');
      }
      const request = new Request(`${requestOrigin(incoming, publicOrigin)}${incoming.url}`, {
        method: incoming.method,
        headers,
        ...(body.length && !['GET', 'HEAD'].includes(incoming.method) ? { body } : {}),
        signal: controller.signal,
      });
      const response = await onRequest({ request, env, waitUntil });
      await sendResponse(request, response, outgoing);
    } catch (error) {
      if (outgoing.destroyed) return;
      if (outgoing.headersSent) {
        outgoing.destroy(error);
        return;
      }
      if (!error.status) console.error('[HTTP request]', error);
      outgoing.writeHead(error.status || 500, {
        'Content-Type': 'application/json; charset=utf-8',
        Connection: 'close',
      });
      outgoing.end(
        JSON.stringify({ error: error.status ? error.message : 'Internal Server Error' })
      );
    }
  });
  server.requestTimeout = 60 * 1000;
  server.headersTimeout = 15 * 1000;
  server.on('error', (error) => {
    console.error('[Server]', error);
    storage.close();
    process.exit(1);
  });

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(cleanup);
    const deadline = setTimeout(() => process.exit(1), 30 * 1000);
    deadline.unref();
    server.close(async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      storage.close();
      clearTimeout(deadline);
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`MiSub listening on port ${port}; SQLite: ${filename}`);
  });
}

main().catch((error) => {
  console.error('[Startup]', error.message);
  process.exit(1);
});
