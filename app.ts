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
  res.writeHead(result.status, {
    'content-type': result.contentType,
    'content-length': result.body.length,
    ...extraHeaders,
    ...(result.headers ?? {}),
  });
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

function authorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return false;
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer ${token}`;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      const path = url.pathname;

      // The env's boot probe: no auth.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const isApi = path === '/api/v3' || path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp' || /^\/[^/]+\/[^/]+\.git(\/|$)/.test(path);

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
          const segments = rawSegments.filter((segment) => segment !== '').map((segment) => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          });
          // A trailing slash on the API root still means the root.
          const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'localhost';
          const result = handleRest({ method, segments, query: url.searchParams, rawBody: body, host });
          sendResult(res, result, { 'x-github-request-id': nextRequestId() });
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const subPath = gitMatch[3] ?? '';
          const gitProtocol = typeof req.headers['git-protocol'] === 'string' ? (req.headers['git-protocol'] as string) : undefined;
          sendResult(res, handleGit(owner, repoName, subPath, method, url.searchParams, body, gitProtocol));
          return;
        }

        void isApi;
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
