// The GitHub REST v3 surface under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, all backed by the shared store and the repo's git objects.

import { dirEntries, flattenTree, parseCommit, parseTree, peelToCommit } from './gitcore.ts';
import {
  VIEWER,
  addComment,
  branchTip,
  commitFileChange,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  deleteRepo,
  flatAtBranch,
  getRepo,
  isoAt,
  listRepos,
  mergePull,
  nextSeq,
  pullBaseSha,
  pullChanges,
  pullHeadSha,
  renameRepo,
  resolveRefToCommit,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import type { HttpResult } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, value: unknown, headers: Record<string, string> = {}): HttpResult {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), headers };
}

function notFound(): HttpResult {
  return json(404, { message: 'Not Found' });
}

function unprocessable(message: string): HttpResult {
  return json(422, { message });
}

// ---------------------------------------------------------------- serializers

function userJson(): Record<string, unknown> {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', site_admin: false, name: VIEWER.name, email: VIEWER.email };
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User', site_admin: false },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: isoAt(repo.seq),
    updated_at: isoAt(repo.seq),
    pushed_at: isoAt(repo.seq),
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
  };
}

function labelJson(label: LabelRec): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color, description: label.description, default: false, url: '' };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label === undefined ? { id: 0, name, color: 'ededed', description: null, default: false, url: '' } : labelJson(label);
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: isoAt(issue.seq),
    updated_at: isoAt(issue.seq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

// The serialized body of one issue, memoised on the issue record. A cached body is served only
// when every input of issueJson is provably unchanged: title/body/state by value, the labels
// array by identity (every mutation path replaces it), the comment count, and each label's
// record by identity (label records are never mutated in place — they are created or deleted,
// both of which change what repo.labels.get returns). Any doubt falls through to a fresh build,
// so the bytes served are always the bytes issueJson would have produced now.
interface IssueBodyCache {
  title: string;
  body: string;
  state: string;
  labelsRef: string[];
  labelRecs: (LabelRec | undefined)[];
  comments: number;
  payload: Buffer;
}

const issueBodyCache = new WeakMap<IssueRec, IssueBodyCache>();

function issueResult(repo: RepoRec, issue: IssueRec): HttpResult {
  const cached = issueBodyCache.get(issue);
  if (
    cached !== undefined &&
    cached.title === issue.title &&
    cached.body === issue.body &&
    cached.state === issue.state &&
    cached.labelsRef === issue.labels &&
    cached.comments === issue.comments.length &&
    cached.labelRecs.every((rec, index) => repo.labels.get(issue.labels[index] as string) === rec)
  ) {
    return { status: 200, contentType: JSON_TYPE, body: cached.payload };
  }
  const payload = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
  issueBodyCache.set(issue, {
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labelsRef: issue.labels,
    labelRecs: issue.labels.map((name) => repo.labels.get(name)),
    comments: issue.comments.length,
    payload,
  });
  return { status: 200, contentType: JSON_TYPE, body: payload };
}

function commentJson(comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoAt(comment.seq),
    updated_at: isoAt(comment.seq),
  };
}

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: refJson(pull.headRef, pullHeadSha(repo, pull)),
    base: refJson(pull.baseRef, pullBaseSha(repo, pull)),
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : isoAt(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoAt(pull.seq),
    updated_at: isoAt(pull.mergedSeq ?? pull.seq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function identJson(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: isoAt(0) };
  return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return { sha: oid };
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      author: identJson(commit.author),
      committer: identJson(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    author: null,
    committer: null,
  };
}

// ---------------------------------------------------------------- pagination

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(items: readonly T[], query: URLSearchParams, host: string, path: string): Page<T> {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  const url = (p: number): string => `http://${host}${path}?per_page=${perPage}&page=${p}`;
  if (page < lastPage) {
    links.push(`<${url(page + 1)}>; rel="next"`, `<${url(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${url(page - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
  }
  return { items: slice, link: links.length > 0 ? links.join(', ') : null };
}

function listResult<T>(items: readonly T[], query: URLSearchParams, host: string, path: string, serialize: (item: T) => unknown): HttpResult {
  const page = paginate(items, query, host, path);
  const headers: Record<string, string> = {};
  if (page.link !== null) headers.link = page.link;
  return json(200, page.items.map(serialize), headers);
}

// ---------------------------------------------------------------- request context

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  rawBody: Buffer;
  host: string;
}

function parseBody(req: RestRequest): { body: Record<string, unknown> } | { error: HttpResult } {
  const text = req.rawBody.toString('utf8').trim();
  if (text === '') return { body: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { body: {} };
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { error: json(400, { message: 'Problems parsing JSON' }) };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function labelNames(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const names: string[] = [];
  for (const entry of input) {
    if (typeof entry === 'string') names.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') names.push((entry as { name: string }).name);
  }
  return names;
}

// ---------------------------------------------------------------- repo-scoped routes

function repoRoutes(repo: RepoRec, rest: string[], req: RestRequest): HttpResult {
  const { method, query } = req;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;

  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = parseBody(req);
      if ('error' in parsed) return parsed.error;
      const body = parsed.body;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) renameRepo(repo, body.name);
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      deleteRepo(repo);
      return { status: 204, contentType: JSON_TYPE, body: Buffer.alloc(0) };
    }
    return notFound();
  }

  const head = rest[0] as string;

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return json(200, branches);
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = branchTip(repo, branch);
      if (sha === null) return notFound();
      return json(200, { name: branch, commit: { sha }, protected: false });
    }
    return notFound();
  }

  if (head === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveRefToCommit(repo, query.get('sha') ?? undefined);
    if (tip === null) return json(200, []);
    const ordered: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      ordered.push(oid);
      const parents = parseCommit(object.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
    }
    return listResult(ordered, query, req.host, `${base}/commits`, (oid) => commitJson(repo, oid));
  }

  if (head === 'contents') {
    return contentsRoutes(repo, rest.slice(1).join('/'), req);
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2) {
      if (method === 'POST') {
        const parsed = parseBody(req);
        if ('error' in parsed) return parsed.error;
        const ref = str(parsed.body.ref);
        const sha = str(parsed.body.sha);
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return unprocessable('Validation Failed');
        if (repo.refs.has(ref)) return unprocessable('Reference already exists');
        repo.refs.set(ref, sha);
        const object = repo.objects.get(sha) as { type: string };
        return json(201, { ref, object: { sha, type: object.type } });
      }
      if (method === 'GET') {
        const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
        return json(200, all);
      }
      return notFound();
    }
    const fullRef = `refs/${rest.slice(2).join('/')}`;
    if (method === 'GET') {
      const sha = repo.refs.get(fullRef);
      if (sha === undefined) return notFound();
      return json(200, { ref: fullRef, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    }
    if (method === 'DELETE') {
      if (!repo.refs.has(fullRef)) return notFound();
      repo.refs.delete(fullRef);
      return { status: 204, contentType: JSON_TYPE, body: Buffer.alloc(0) };
    }
    return notFound();
  }

  if (head === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') return json(200, [...repo.labels.values()].map(labelJson));
      if (method === 'POST') {
        const parsed = parseBody(req);
        if ('error' in parsed) return parsed.error;
        const name = str(parsed.body.name);
        if (name === '') return unprocessable('Validation Failed');
        const color = str(parsed.body.color).replace(/^#/, '') || 'ededed';
        const description = typeof parsed.body.description === 'string' ? parsed.body.description : null;
        const label = createLabel(repo, name, color, description);
        if (label === null) return unprocessable('Validation Failed');
        return json(201, labelJson(label));
      }
      return notFound();
    }
    const label = repo.labels.get(rest.slice(1).join('/'));
    if (label === undefined) return notFound();
    if (method === 'GET') return json(200, labelJson(label));
    if (method === 'DELETE') {
      repo.labels.delete(label.name);
      return { status: 204, contentType: JSON_TYPE, body: Buffer.alloc(0) };
    }
    return notFound();
  }

  if (head === 'issues') return issueRoutes(repo, rest.slice(1), req);
  if (head === 'pulls') return pullRoutes(repo, rest.slice(1), req);

  return notFound();
}

function contentsRoutes(repo: RepoRec, path: string, req: RestRequest): HttpResult {
  const { method, query } = req;
  if (method === 'GET') {
    const commit = resolveRefToCommit(repo, query.get('ref') ?? undefined);
    if (commit === null) return notFound();
    const commitObject = repo.objects.get(commit);
    if (commitObject === undefined) return notFound();
    const rootTree = parseCommit(commitObject.data).tree;
    const flat = flattenTree(repo.objects, rootTree);
    const entry = flat.get(path);
    if (path !== '' && entry !== undefined) {
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) return notFound();
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop(),
        path,
        sha: entry.oid,
        content: blob.data.toString('base64'),
        url: '',
        html_url: '',
        download_url: '',
      });
    }
    const isDir = path === '' || [...flat.keys()].some((key) => key.startsWith(`${path}/`));
    if (!isDir) return notFound();
    // The tree id of the directory itself, for entry shas.
    let dirTree = rootTree;
    if (path !== '') {
      let current = rootTree;
      for (const segment of path.split('/')) {
        const tree = repo.objects.get(current);
        if (tree === undefined || tree.type !== 'tree') return notFound();
        const found = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
        if (found === undefined) return notFound();
        current = found.oid;
      }
      dirTree = current;
      void dirTree;
    }
    const entries = dirEntries(flat, path).map((child) => {
      if (child.isDir) {
        // Resolve the subtree id by walking from the root tree.
        let current = rootTree;
        for (const segment of child.path.split('/')) {
          const tree = repo.objects.get(current);
          if (tree === undefined || tree.type !== 'tree') break;
          const found = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
          if (found === undefined) break;
          current = found.oid;
        }
        return { type: 'dir', name: child.name, path: child.path, sha: current, size: 0, url: '', html_url: '', download_url: '' };
      }
      const blob = child.oid === null ? undefined : repo.objects.get(child.oid);
      return { type: 'file', name: child.name, path: child.path, sha: child.oid, size: blob?.data.length ?? 0, url: '', html_url: '', download_url: '' };
    });
    return json(200, entries);
  }

  if (method === 'PUT') {
    const parsed = parseBody(req);
    if ('error' in parsed) return parsed.error;
    const body = parsed.body;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Update ${path}`;
    const contentBase64 = str(body.content).replace(/[\r\n\t ]+/g, '');
    const content = Buffer.from(contentBase64, 'base64');
    const existing = flatAtBranch(repo, branch).get(path);
    if (existing !== undefined && typeof body.sha === 'string' && body.sha !== existing.oid) {
      return json(409, { message: 'Conflict: the supplied sha does not match the current content' });
    }
    const result = commitFileChange(repo, branch, path, content, message);
    const blob = result.blobOid === null ? undefined : repo.objects.get(result.blobOid);
    return json(existing === undefined ? 201 : 200, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: blob?.data.length ?? content.length,
        name: path.split('/').pop(),
        path,
        sha: result.blobOid,
      },
      commit: { sha: result.commitOid, message, author: { name: VIEWER.name, email: VIEWER.email, date: isoAt(nextSeq()) }, committer: { name: VIEWER.name, email: VIEWER.email, date: isoAt(nextSeq()) } },
    });
  }

  if (method === 'DELETE') {
    const parsed = parseBody(req);
    if ('error' in parsed) return parsed.error;
    const body = parsed.body;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : `Delete ${path}`;
    const existing = flatAtBranch(repo, branch).get(path);
    if (existing === undefined) return notFound();
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      return json(409, { message: 'Conflict: the supplied sha does not match the current content' });
    }
    const result = commitFileChange(repo, branch, path, null, message);
    return json(200, { content: null, commit: { sha: result.commitOid, message } });
  }

  return notFound();
}

function issueRoutes(repo: RepoRec, rest: string[], req: RestRequest): HttpResult {
  const { method, query } = req;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}/issues`;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      const direction = query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      return listResult(issues, query, req.host, base, (issue) => issueJson(repo, issue));
    }
    if (method === 'POST') {
      const parsed = parseBody(req);
      if ('error' in parsed) return parsed.error;
      const labels = labelNames(parsed.body.labels);
      for (const name of labels) {
        if (!repo.labels.has(name)) return unprocessable(`Validation Failed: label '${name}' does not exist`);
      }
      const issue = createIssue(repo, { title: str(parsed.body.title), body: str(parsed.body.body), labels });
      return json(201, issueJson(repo, issue));
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (issue === undefined) return notFound();
    if (method === 'GET') return issueResult(repo, issue);
    if (method === 'PATCH') {
      const parsed = parseBody(req);
      if ('error' in parsed) return parsed.error;
      const body = parsed.body;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (body.labels !== undefined) {
        const labels = labelNames(body.labels);
        for (const name of labels) {
          if (!repo.labels.has(name)) return unprocessable(`Validation Failed: label '${name}' does not exist`);
        }
        issue.labels = labels;
      }
      return json(200, issueJson(repo, issue));
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return notFound();
    if (method === 'GET') return json(200, issue.comments.map(commentJson));
    if (method === 'POST') {
      const parsed = parseBody(req);
      if ('error' in parsed) return parsed.error;
      const comment = addComment(issue, str(parsed.body.body));
      return json(201, commentJson(comment));
    }
    return notFound();
  }
  return notFound();
}

function normalizeBranch(value: string): string {
  let name = value;
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const colon = name.indexOf(':');
  if (colon > 0) name = name.slice(colon + 1);
  return name;
}

function pullRoutes(repo: RepoRec, rest: string[], req: RestRequest): HttpResult {
  const { method, query } = req;
  const base = `/api/v3/repos/${repo.owner}/${repo.name}/pulls`;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.number - b.number);
      return listResult(pulls, query, req.host, base, (pull) => pullJson(repo, pull));
    }
    if (method === 'POST') {
      const parsed = parseBody(req);
      if ('error' in parsed) return parsed.error;
      const head = normalizeBranch(str(parsed.body.head));
      const baseRef = normalizeBranch(str(parsed.body.base));
      if (branchTip(repo, head) === null) return unprocessable('Validation Failed: head ref does not exist');
      if (branchTip(repo, baseRef) === null) return unprocessable('Validation Failed: base ref does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === baseRef) {
          return unprocessable('Validation Failed: a pull request already exists for this branch combination');
        }
      }
      const pull = createPull(repo, { title: str(parsed.body.title), body: str(parsed.body.body), headRef: head, baseRef });
      return json(201, pullJson(repo, pull));
    }
    return notFound();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1 && method === 'GET') {
    if (pull === undefined) return notFound();
    return json(200, pullJson(repo, pull));
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (pull === undefined) return notFound();
    const changes = pullChanges(repo, pull).map((change) => ({
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
      sha: change.sha ?? '',
    }));
    return listResult(changes, query, req.host, `${base}/${number}/files`, (change) => change);
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return notFound();
    const parsed = parseBody(req);
    if ('error' in parsed) return parsed.error;
    const methodName = str(parsed.body.merge_method);
    const mergeMethod = methodName === 'merge' ? 'merge' : methodName === 'rebase' ? 'rebase' : 'squash';
    const result = mergePull(repo, pull, mergeMethod);
    if ('error' in result) {
      return json(405, { message: result.error === 'conflict' ? 'Pull Request is not mergeable: conflicts must be resolved first' : 'Pull Request is not mergeable' });
    }
    return json(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }
  return notFound();
}

// ---------------------------------------------------------------- top level

export function handleRest(req: RestRequest): HttpResult {
  const { method, segments } = req;

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return json(200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '',
      commit_search_url: '',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: '',
      issue_search_url: '',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      user_search_url: '',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    return json(200, { verifiable_password_authentication: false, ssh_key_fingerprints: {}, installed_version: '1.0.0' });
  }

  if (segments[0] === 'rate_limit' && segments.length === 1 && method === 'GET') {
    return json(200, { rate: { limit: 5000, remaining: 4999, reset: 1735693200, used: 1 }, resources: {} });
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    return json(200, userJson());
  }

  if (segments[0] === 'user' && segments.length === 2 && segments[1] === 'repos') {
    if (method === 'GET') {
      return listResult(listRepos(), req.query, req.host, '/api/v3/user/repos', (repo) => repoJson(repo));
    }
    if (method === 'POST') {
      const parsed = parseBody(req);
      if ('error' in parsed) return parsed.error;
      const name = str(parsed.body.name);
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return unprocessable('Validation Failed: name is invalid');
      const repo = createRepo(name, {
        description: typeof parsed.body.description === 'string' ? parsed.body.description : '',
        isPrivate: typeof parsed.body.private === 'boolean' ? parsed.body.private : false,
      });
      if (repo === null) return unprocessable('Repository creation failed: name already exists on this account');
      return json(201, repoJson(repo));
    }
    return notFound();
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = getRepo(segments[1] as string, segments[2] as string);
    if (repo === null) return notFound();
    return repoRoutes(repo, segments.slice(3), req);
  }

  return notFound();
}
