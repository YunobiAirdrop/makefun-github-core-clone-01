// The MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP. Both protocol eras are
// served: modern `server/discover` (2026-07-28) and the legacy initialize handshake
// (2025-11-25 and earlier). Tools operate on the same store as REST and GraphQL.

import {
  VIEWER,
  branchTip,
  createIssue,
  createPull,
  createRepo,
  getRepo,
  mergePull,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import type { HttpResult } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

// The tools/list payload is built once so two calls are byte-identical.
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    repository: `${repo.owner}/${repo.name}`,
  };
}

function pullView(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: branchTip(repo, pull.headRef) ?? pull.headShaFallback },
    base: { ref: pull.baseRef, sha: branchTip(repo, pull.baseRef) ?? pull.baseShaFallback },
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  return {
    content: [{ type: 'text', text: JSON.stringify(record) }],
    structuredContent: record,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

class InvalidParams extends Error {}

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') throw new InvalidParams(`missing required argument: ${name}`);
  return value;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new InvalidParams(`unknown tool: ${name}`);
  switch (name) {
    case 'create_repo': {
      const repoName = requiredString(args, 'name');
      const existing = getRepo(VIEWER.login, repoName);
      if (existing !== null) return toolResult(repoView(existing));
      const repo = createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: typeof args.private === 'boolean' ? args.private : false,
      });
      if (repo === null) throw new InvalidParams(`repository ${repoName} already exists`);
      return toolResult(repoView(repo));
    }
    case 'get_repo': {
      const repo = getRepo(requiredString(args, 'owner'), requiredString(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      return toolResult(repoView(repo));
    }
    case 'create_issue': {
      const repo = getRepo(requiredString(args, 'owner'), requiredString(args, 'repo'));
      const title = requiredString(args, 'title');
      if (repo === null) return toolError('repository not found');
      const issue = createIssue(repo, { title, body: typeof args.body === 'string' ? args.body : '' });
      return toolResult(issueView(repo, issue));
    }
    case 'list_issues': {
      const repo = getRepo(requiredString(args, 'owner'), requiredString(args, 'repo'));
      if (repo === null) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.number - b.number);
      return toolResult({ issues: issues.map((issue) => issueView(repo, issue)), total_count: issues.length });
    }
    case 'create_pull_request': {
      const repo = getRepo(requiredString(args, 'owner'), requiredString(args, 'repo'));
      const title = requiredString(args, 'title');
      const head = requiredString(args, 'head');
      const base = requiredString(args, 'base');
      if (repo === null) return toolError('repository not found');
      if (branchTip(repo, head) === null) return toolError(`head branch ${head} does not exist`);
      if (branchTip(repo, base) === null) return toolError(`base branch ${base} does not exist`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) return toolResult(pullView(repo, existing));
      }
      const pull = createPull(repo, { title, body: typeof args.body === 'string' ? args.body : '', headRef: head, baseRef: base });
      return toolResult(pullView(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = getRepo(requiredString(args, 'owner'), requiredString(args, 'repo'));
      const number = args.pull_number;
      if (typeof number !== 'number' || !Number.isInteger(number)) throw new InvalidParams('missing required argument: pull_number');
      if (repo === null) return toolError('repository not found');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`pull request ${number} not found`);
      const result = mergePull(repo, pull, 'squash');
      if ('error' in result) return toolError(`pull request ${number} is not mergeable`);
      return toolResult({ ...pullView(repo, pull), sha: result.sha, merged: true });
    }
    default:
      throw new InvalidParams(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

interface RpcOutcome {
  status: number;
  payload: Record<string, unknown> | null; // null = no body (notifications)
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): RpcOutcome {
  return { status, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function handleRpc(request: Record<string, unknown>): RpcOutcome {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: SERVER_INFO,
        _meta: {
          'io.modelcontextprotocol/serverInfo': SERVER_INFO,
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, JSON.parse(TOOLS_LIST_JSON) as unknown);
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      try {
        return rpcResult(id, callTool(toolName, args));
      } catch (err) {
        if (err instanceof InvalidParams) return rpcError(id, -32602, err.message);
        return rpcError(id, -32603, err instanceof Error ? err.message : 'internal error');
      }
    }
    default:
      if (isNotification) return { status: 202, payload: null };
      if (method.startsWith('notifications/')) return { status: 202, payload: null };
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

export function handleMcp(method: string, rawBody: Buffer): HttpResult {
  if (method === 'DELETE') {
    return { status: 200, contentType: JSON_TYPE, body: Buffer.from('{}\n', 'utf8') };
  }
  if (method === 'GET') {
    return { status: 405, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } })}\n`, 'utf8') };
  }
  if (method !== 'POST') {
    return { status: 405, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify({ message: 'Method Not Allowed' })}\n`, 'utf8') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      contentType: JSON_TYPE,
      body: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`, 'utf8'),
    };
  }
  if (Array.isArray(parsed)) {
    const outcomes = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return rpcError(null, -32600, 'Invalid Request').payload;
      return handleRpc(entry as Record<string, unknown>).payload;
    }).filter((payload) => payload !== null);
    return { status: 200, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(outcomes)}\n`, 'utf8') };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      status: 400,
      contentType: JSON_TYPE,
      body: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } })}\n`, 'utf8'),
    };
  }
  const outcome = handleRpc(parsed as Record<string, unknown>);
  if (outcome.payload === null) {
    return { status: 202, contentType: JSON_TYPE, body: Buffer.alloc(0) };
  }
  return { status: outcome.status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(outcome.payload)}\n`, 'utf8') };
}
