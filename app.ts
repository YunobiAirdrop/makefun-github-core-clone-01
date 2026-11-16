// The forge's HTTP surface: one server routing /healthz, git smart HTTP at /{owner}/{repo}.git,
// REST v3 under /api/v3, GraphQL at /api/graphql and MCP at /mcp. Every surface except
// /healthz requires `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit, type HttpResult } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { nextRequestId } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

function sendResult(res: ServerResponse, result: HttpResult, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string | number> = {
    'content-type': result.contentType,
    'content-length': result.body.length,
  };
  for (const name of Object.keys(extraHeaders)) headers[name] = extraHeaders[name] as string;
  if (result.headers !== undefined) for (const name of Object.keys(result.headers)) headers[name] = result.headers[name] as string;
  res.writeHead(result.status, headers);
  res.end(result.body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  sendResult(res, { status, contentType: JSON_TYPE, body: Buffer.from(text, 'utf8') }, extraHeaders);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** decodeURIComponent for one path segment, skipping the call entirely when nothing is escaped. */
function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  // The bearer token is fixed for the process's life (the harness sets it before the server
  // exists), so the expected Authorization header is built once instead of on every request.
  let expectedAuth: string | null = null;
  const authorized = (req: IncomingMessage): boolean => {
    if (expectedAuth === null) {
      const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
      if (token === '') return false;
      expectedAuth = `Bearer ${token}`;
    }
    return req.headers.authorization === expectedAuth;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const method = req.method ?? 'GET';
      // Split the request target by hand: a full URL parse per request buys nothing here —
      // the router needs only the raw path (still percent-encoded, exactly as URL.pathname
      // reported it) and the query parameters.
      const rawUrl = req.url ?? '/';
      const queryAt = rawUrl.indexOf('?');
      const path = queryAt < 0 ? rawUrl : rawUrl.slice(0, queryAt);
      if (!path.startsWith('/')) {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      const query = new URLSearchParams(queryAt < 0 ? '' : rawUrl.slice(queryAt + 1));

      // The env's boot probe: no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!authorized(req)) {
        const headers: Record<string, string> = {};
        if (path.startsWith('/api/v3')) headers['x-github-request-id'] = nextRequestId();
        sendJson(res, 401, { message: 'Requires authentication' }, headers);
        return;
      }

      try {
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendResult(res, handleGraphQL(body), { 'x-github-request-id': nextRequestId() });
          return;
        }

        if (path === '/mcp') {
          sendResult(res, handleMcp(method, body));
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const rawSegments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/');
          const segments = rawSegments.filter((segment) => segment !== '').map(decodeSegment);
          // A trailing slash on the API root still means the root.
          const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'localhost';
          const result = handleRest({ method, segments, query, rawBody: body, host });
          sendResult(res, result, { 'x-github-request-id': nextRequestId() });
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeSegment(gitMatch[1] as string);
          const repoName = decodeSegment(gitMatch[2] as string);
          const subPath = gitMatch[3] ?? '';
          const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? (req.headers['git-protocol'] as string) : undefined;
          sendResult(res, handleGit(owner, repoName, subPath, method, query, body, gitProtocol));
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 120_000;
  return server;
}
