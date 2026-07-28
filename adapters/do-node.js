/**
 * DigitalOcean App Platform adapter. THIS FILE IS DISPOSABLE.
 *
 * It exists only because Contentstack Launch is not available until end of
 * year. Its entire job is to translate Node's http primitives into the Fetch
 * API objects that `src/handler.js` already speaks, and to stand in for the
 * origin by serving static files.
 *
 * Deploy as an App Platform WEB SERVICE, not a static site. A static site
 * component cannot set a cookie or see a request, which would force assignment
 * back into the client and reproduce every defect in the post-mortem.
 *
 * When Launch arrives: delete this file, delete `public/`, and point the
 * handler's `fetch(request)` at the real origin. Nothing in `src/` changes.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import handler from '../src/handler.js';

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = resolve(process.cwd(), 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Stand in for the origin.
 *
 * The handler calls `fetch(request)` to reach the origin, exactly as it will on
 * Launch. Here that call has to resolve to the local filesystem instead of the
 * network, so we install a global fetch shim for same-origin requests and
 * delegate everything else to the real fetch.
 */
function installOriginShim() {
  const realFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);

    if (url.hostname !== 'origin.local') {
      return realFetch(input, init);
    }

    // Resolve inside PUBLIC_DIR only. Without this check, `..` in a path walks
    // out of the served directory and reads arbitrary files off the container.
    const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
    const candidate = normalize(join(PUBLIC_DIR, decodeURIComponent(requestedPath)));
    if (candidate !== PUBLIC_DIR && !candidate.startsWith(PUBLIC_DIR + sep)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const info = await stat(candidate);
      // A SPA serves index.html for unknown routes so client-side routing works.
      const file = info.isDirectory() ? join(candidate, 'index.html') : candidate;
      const body = await readFile(file);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': MIME_TYPES[extname(file)] || 'application/octet-stream' },
      });
    } catch {
      try {
        const fallback = await readFile(join(PUBLIC_DIR, 'index.html'));
        return new Response(fallback, {
          status: 200,
          headers: { 'content-type': MIME_TYPES['.html'] },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
  };
}

function toFetchRequest(req) {
  // `origin.local` marks requests the shim above should serve from disk. On
  // Launch there is no shim and no marker — the handler forwards to the real
  // origin unchanged.
  const url = new URL(req.url, 'https://origin.local');

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value != null) headers.set(key, value);
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

async function sendFetchResponse(response, res) {
  const headers = {};
  for (const [key, value] of response.headers) {
    // getSetCookie preserves multiple Set-Cookie headers, which the plain
    // iterator folds into one comma-joined string that browsers mis-parse.
    if (key.toLowerCase() === 'set-cookie') continue;
    headers[key] = value;
  }
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length) headers['set-cookie'] = setCookies;

  res.writeHead(response.status, headers);
  if (response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  } else {
    res.end();
  }
}

installOriginShim();

const server = createServer(async (req, res) => {
  try {
    const response = await handler(toFetchRequest(req), { env: process.env });
    await sendFetchResponse(response, res);
  } catch (error) {
    console.error('[bread] unhandled error', error);
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`[bread] listening on :${PORT} (spec=${process.env.BREAD_SPEC || 'legacy'})`);
});
