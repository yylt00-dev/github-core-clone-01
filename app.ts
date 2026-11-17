// The forge's HTTP server: routing, auth and wire discipline shared by
// every surface. The surfaces themselves live in githttp.ts (git smart
// HTTP), rest.ts (REST v3), graphql.ts (GraphQL v4) and mcp.ts (MCP).
//
//   GET  /healthz                          the env's boot probe, no auth
//   *    /<owner>/<repo>.git/...           git smart HTTP
//   *    /api/v3/...                       REST v3 (Bearer token required)
//   POST /api/graphql                      GraphQL v4 (Bearer token required)
//   POST /mcp                              MCP streamable HTTP (token required)
//   *    anything else                     404 {"message":"Not Found"}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { infoRefs, receivePack, uploadPack } from './githttp.ts';
import { handleRest, type RestResult } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `MAKEFUN-${(++requestCounter).toString(16).toUpperCase().padStart(6, '0')}`,
    ...headers,
  });
  res.end(text);
}

function sendResult(res: ServerResponse, result: RestResult): void {
  sendJson(res, result.status, result.body, result.headers);
}

/** The bearer token is valid when it matches the env-issued shop token. */
export function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (!token) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  return expected ? token === expected : true;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const store = new Store();
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await route(store, req, res);
    } catch (err) {
      console.error('[entry] request failed:', err);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    }
  });
}

async function route(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const path = url.pathname;
  const segments = path.split('/').filter((s) => s.length > 0).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // git smart HTTP: /<owner>/<repo>.git/<endpoint> (info/refs is two segments)
  if (segments.length >= 3 && segments[1].endsWith('.git')) {
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    const endpoint = segments.slice(2).join('/');
    res.setHeader('x-github-request-id', `MAKEFUN-${(++requestCounter).toString(16).toUpperCase().padStart(6, '0')}`);
    if (endpoint === 'info/refs' && method === 'GET') {
      await infoRefs(store, req, res, owner, repoName, url.searchParams.get('service') ?? '');
      return;
    }
    if (endpoint === 'git-upload-pack' && method === 'POST') {
      await uploadPack(store, req, res, owner, repoName);
      return;
    }
    if (endpoint === 'git-receive-pack' && method === 'POST') {
      await receivePack(store, req, res, owner, repoName);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL v4
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const out = await handleGraphql(store, parsed);
    // GraphQL answers 200 with {data} / {errors} bodies (arrays batch).
    res.writeHead(200, {
      'content-type': JSON_TYPE,
      'x-github-request-id': `MAKEFUN-${(++requestCounter).toString(16).toUpperCase().padStart(6, '0')}`,
    });
    res.end(JSON.stringify(out));
    return;
  }

  // MCP
  if (path === '/mcp') {
    await handleMcp(store, req, res, authorized(req), sendJson);
    return;
  }

  // REST v3
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    let body: Record<string, unknown> | null = null;
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          const parsed = JSON.parse(raw.toString('utf8'));
          body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      } else {
        body = {};
      }
    }
    const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
    const result = await handleRest(
      { store, method, url, body, baseUrl },
      segments.slice(2),
    );
    if (result === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    sendResult(res, result);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
