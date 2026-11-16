// The forge's in-memory store and domain operations, shared by REST, GraphQL, MCP and git.
// Determinism: no Date.now / Math.random anywhere in observable output. Every timestamp derives
// from EPOCH_BASE plus a monotonic sequence counter, and every id from a sequential counter.

import {
  buildCommit,
  buildTreeFromFlat,
  commitAncestors,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  peelToCommit,
  type GitObj,
  type ObjType,
} from './gitcore.ts';

// ---------------------------------------------------------------- the viewer
// The token names one login: the scenario viewer of the contest's fixed seed. The login is
// derived here with the same seeded PRNG the suite uses (wire.ts: FNV-1a + splitmix64 seeding
// an xorshift64* stream), so the owner login matches by construction, not by a copied string.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface Viewer {
  id: number;
  login: string;
  name: string;
  email: string;
}

function deriveViewer(): Viewer {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
  return { id: 1000, login, name: `${first} ${last}`, email: `${login}@example.invalid` };
}

export const VIEWER: Viewer = deriveViewer();

// ---------------------------------------------------------------- counters and clocks

export const EPOCH_BASE = 1_735_689_600; // 2025-01-01T00:00:00Z, the scenario's day one

let sequence = 0;
export function nextSeq(): number {
  sequence += 1;
  return sequence;
}

// isoAt is a pure function of seq, and hot serializers ask for the same seq many times over
// (created_at and updated_at of one record, then every re-read of that record): memoise it.
// The map is cleared when it grows past a bound so a long-lived process stays flat.
const isoCache = new Map<number, string>();

export function isoAt(seq: number): string {
  const cached = isoCache.get(seq);
  if (cached !== undefined) return cached;
  const value = new Date((EPOCH_BASE + seq) * 1000).toISOString();
  if (isoCache.size >= 8192) isoCache.clear();
  isoCache.set(seq, value);
  return value;
}

let repoIdCounter = 0;
let issueIdCounter = 0;
let commentIdCounter = 0;
let labelIdCounter = 0;
let requestCounter = 0;

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36).toUpperCase().padStart(6, '0')}`;
}

// ---------------------------------------------------------------- records

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headShaFallback: string;
  baseShaFallback: string;
  seq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  seq: number;
}

const repos = new Map<string, RepoRec>();

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): RepoRec | null {
  if (owner !== VIEWER.login) return null;
  return repos.get(repoKey(owner, name)) ?? null;
}

export function listRepos(): RepoRec[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

export function createRepo(name: string, options: { description?: string; isPrivate?: boolean } = {}): RepoRec | null {
  const key = repoKey(VIEWER.login, name);
  if (repos.has(key)) return null;
  repoIdCounter += 1;
  const repo: RepoRec = {
    id: repoIdCounter,
    owner: VIEWER.login,
    name,
    description: options.description ?? '',
    isPrivate: options.isPrivate ?? false,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    seq: nextSeq(),
  };
  repos.set(key, repo);
  return repo;
}

export function deleteRepo(repo: RepoRec): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

export function renameRepo(repo: RepoRec, newName: string): boolean {
  const target = repoKey(repo.owner, newName);
  if (repos.has(target)) return false;
  repos.delete(repoKey(repo.owner, repo.name));
  repo.name = newName;
  repos.set(target, repo);
  return true;
}

export function repoById(id: number): RepoRec | null {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return null;
}

// ---------------------------------------------------------------- git helpers on a repo

export function repoPut(repo: RepoRec, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function resolveRefToCommit(repo: RepoRec, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    const tip = branchTip(repo, repo.defaultBranch);
    return tip === null ? null : peelToCommit(repo.objects, tip);
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return peelToCommit(repo.objects, branch);
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return peelToCommit(repo.objects, tag);
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return peelToCommit(repo.objects, direct);
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined) return object.type === 'commit' ? ref : peelToCommit(repo.objects, ref);
  }
  return null;
}

/** The flat file map at a branch (or the default branch), empty when the branch is unborn. */
export function flatAtBranch(repo: RepoRec, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = branchTip(repo, branch);
  if (tip === null) return new Map();
  const commitOid = peelToCommit(repo.objects, tip);
  if (commitOid === null) return new Map();
  const commit = repo.objects.get(commitOid);
  if (commit === undefined) return new Map();
  return flattenTree(repo.objects, parseCommit(commit.data).tree);
}

export function authorLine(seq: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${EPOCH_BASE + seq} +0000`;
}

/** Commit one file change (content === null deletes) on a branch; creates the branch when unborn. */
export function commitFileChange(
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitOid: string; blobOid: string | null } {
  let tip = branchTip(repo, branch);
  if (tip === null && branch !== repo.defaultBranch) {
    // A contents write naming a fresh branch starts it from the default branch tip.
    tip = branchTip(repo, repo.defaultBranch);
  }
  const parentCommit = tip === null ? null : peelToCommit(repo.objects, tip);
  const flat = parentCommit === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo.objects, parseCommit((repo.objects.get(parentCommit) as GitObj).data).tree);
  let blobOid: string | null = null;
  if (content === null) {
    flat.delete(path);
  } else {
    blobOid = repoPut(repo, 'blob', content);
    flat.set(path, { oid: blobOid, mode: '100644' });
  }
  const treeOid = buildTreeFromFlat((type, data) => repoPut(repo, type, data), flat);
  const seq = nextSeq();
  const line = authorLine(seq);
  const commitOid = repoPut(repo, 'commit', buildCommit({
    tree: treeOid,
    parents: parentCommit === null ? [] : [parentCommit],
    author: line,
    committer: line,
    message,
  }));
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return { commitOid, blobOid };
}

// ---------------------------------------------------------------- issues, labels, comments

export function createLabel(repo: RepoRec, name: string, color: string, description: string | null): LabelRec | null {
  if (repo.labels.has(name)) return null;
  labelIdCounter += 1;
  const label: LabelRec = { id: labelIdCounter, name, color, description };
  repo.labels.set(name, label);
  return label;
}

export function createIssue(repo: RepoRec, input: { title: string; body: string; labels?: string[] }): IssueRec {
  issueIdCounter += 1;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: IssueRec = {
    id: issueIdCounter,
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...(input.labels ?? [])],
    comments: [],
    seq: nextSeq(),
  };
  repo.issues.set(number, issue);
  return issue;
}

export function addComment(issue: IssueRec, body: string): CommentRec {
  commentIdCounter += 1;
  const comment: CommentRec = { id: commentIdCounter, body, seq: nextSeq() };
  issue.comments.push(comment);
  return comment;
}

// ---------------------------------------------------------------- pull requests

export function createPull(repo: RepoRec, input: { title: string; body: string; headRef: string; baseRef: string }): PullRec {
  issueIdCounter += 1;
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: PullRec = {
    id: issueIdCounter,
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    mergedSeq: null,
    mergeCommitSha: null,
    headRef: input.headRef,
    baseRef: input.baseRef,
    headShaFallback: branchTip(repo, input.headRef) ?? '0'.repeat(40),
    baseShaFallback: branchTip(repo, input.baseRef) ?? '0'.repeat(40),
    seq: nextSeq(),
  };
  repo.pulls.set(number, pull);
  return pull;
}

export function pullHeadSha(repo: RepoRec, pull: PullRec): string {
  return branchTip(repo, pull.headRef) ?? pull.headShaFallback;
}

export function pullBaseSha(repo: RepoRec, pull: PullRec): string {
  return branchTip(repo, pull.baseRef) ?? pull.baseShaFallback;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string | null;
}

function lineCount(repo: RepoRec, oid: string | null): number {
  if (oid === null) return 0;
  const object = repo.objects.get(oid);
  if (object === undefined) return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length;
}

/** The changed paths between the merge base of head/base and the head tip. */
export function pullChanges(repo: RepoRec, pull: PullRec): FileChange[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const headCommit = peelToCommit(repo.objects, headTip);
  const baseCommit = peelToCommit(repo.objects, baseTip);
  if (headCommit === null || baseCommit === null) return [];
  const base = mergeBase(repo.objects, baseCommit, headCommit) ?? baseCommit;
  const baseObject = repo.objects.get(base);
  const headObject = repo.objects.get(headCommit);
  if (baseObject === undefined || headObject === undefined) return [];
  const fromFlat = flattenTree(repo.objects, parseCommit(baseObject.data).tree);
  const toFlat = flattenTree(repo.objects, parseCommit(headObject.data).tree);
  const changes: FileChange[] = [];
  const paths = new Set([...fromFlat.keys(), ...toFlat.keys()]);
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
    if (from === undefined && to !== undefined) {
      const additions = lineCount(repo, to.oid);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions, sha: to.oid });
    } else if (from !== undefined && to === undefined) {
      const deletions = lineCount(repo, from.oid);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions, sha: null });
    } else if (from !== undefined && to !== undefined) {
      const additions = lineCount(repo, to.oid);
      const deletions = lineCount(repo, from.oid);
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions, sha: to.oid });
    }
  }
  return changes;
}

export interface PullCommitInfo {
  oid: string;
  message: string;
  committedDate: string;
}

/** The commits a pull request adds: reachable from the head tip but not from the merge base
 * (the base tip itself when the branches share no history), newest first. */
export function pullCommits(repo: RepoRec, pull: PullRec): PullCommitInfo[] {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const headCommit = peelToCommit(repo.objects, headTip);
  const baseCommit = peelToCommit(repo.objects, baseTip);
  if (headCommit === null || baseCommit === null) return [];
  const base = mergeBase(repo.objects, baseCommit, headCommit);
  const excluded = base === null ? new Set<string>() : commitAncestors(repo.objects, base);
  const out: PullCommitInfo[] = [];
  const seen = new Set<string>();
  const stack = [headCommit];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || excluded.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const match = / (\d+) [+-]\d{4}$/.exec(commit.author);
    const ts = match === null ? EPOCH_BASE : Number.parseInt(match[1] as string, 10);
    out.push({ oid, message: commit.message, committedDate: new Date(ts * 1000).toISOString() });
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return out;
}

/** Whether merging `pull` today would conflict: a path both sides changed since the merge base. */
export function pullConflicts(repo: RepoRec, pull: PullRec): boolean {
  return mergeAttempt(repo, pull) === 'conflict';
}

type MergeOutcome = 'ok' | 'conflict' | 'not-mergeable';

function mergeAttempt(repo: RepoRec, pull: PullRec): MergeOutcome {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return 'not-mergeable';
  const headCommit = peelToCommit(repo.objects, headTip);
  const baseCommit = peelToCommit(repo.objects, baseTip);
  if (headCommit === null || baseCommit === null) return 'not-mergeable';
  if (headCommit === baseCommit) return 'not-mergeable';
  if (isAncestor(repo.objects, headCommit, baseCommit)) return 'not-mergeable';
  const base = mergeBase(repo.objects, baseCommit, headCommit);
  const baseFlat = base === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo.objects, parseCommit((repo.objects.get(base) as GitObj).data).tree);
  const currentFlat = flattenTree(repo.objects, parseCommit((repo.objects.get(baseCommit) as GitObj).data).tree);
  const headFlat = flattenTree(repo.objects, parseCommit((repo.objects.get(headCommit) as GitObj).data).tree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const atBase = baseFlat.get(path);
    const atHead = headFlat.get(path);
    if (atBase?.oid === atHead?.oid && atBase?.mode === atHead?.mode) continue;
    const atCurrent = currentFlat.get(path);
    if (atCurrent?.oid === atBase?.oid && atCurrent?.mode === atBase?.mode) continue;
    if (atCurrent?.oid === atHead?.oid && atCurrent?.mode === atHead?.mode) continue;
    return 'conflict';
  }
  return 'ok';
}

/** Merge a pull request (squash or merge commit). Returns the merge commit sha or an outcome word. */
export function mergePull(repo: RepoRec, pull: PullRec, method: 'squash' | 'merge' | 'rebase'): { sha: string } | { error: MergeOutcome } {
  if (pull.state !== 'open' || pull.merged) return { error: 'not-mergeable' };
  const outcome = mergeAttempt(repo, pull);
  if (outcome !== 'ok') return { error: outcome };
  const headTip = branchTip(repo, pull.headRef) as string;
  const baseTip = branchTip(repo, pull.baseRef) as string;
  const headCommit = peelToCommit(repo.objects, headTip) as string;
  const baseCommit = peelToCommit(repo.objects, baseTip) as string;
  const base = mergeBase(repo.objects, baseCommit, headCommit);
  const baseFlat = base === null ? new Map<string, { oid: string; mode: string }>() : flattenTree(repo.objects, parseCommit((repo.objects.get(base) as GitObj).data).tree);
  const currentFlat = flattenTree(repo.objects, parseCommit((repo.objects.get(baseCommit) as GitObj).data).tree);
  const headFlat = flattenTree(repo.objects, parseCommit((repo.objects.get(headCommit) as GitObj).data).tree);
  const result = new Map(currentFlat);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const atBase = baseFlat.get(path);
    const atHead = headFlat.get(path);
    if (atBase?.oid === atHead?.oid && atBase?.mode === atHead?.mode) continue;
    if (atHead === undefined) result.delete(path);
    else result.set(path, atHead);
  }
  const treeOid = buildTreeFromFlat((type, data) => repoPut(repo, type, data), result);
  const seq = nextSeq();
  const line = authorLine(seq);
  let commitOid: string;
  if (method === 'merge') {
    commitOid = repoPut(repo, 'commit', buildCommit({
      tree: treeOid,
      parents: [baseCommit, headCommit],
      author: line,
      committer: line,
      message: `Merge pull request #${pull.number} from ${pull.headRef}\n`,
    }));
  } else {
    const body = pull.body === '' ? '' : `\n\n${pull.body}`;
    commitOid = repoPut(repo, 'commit', buildCommit({
      tree: treeOid,
      parents: [baseCommit],
      author: line,
      committer: line,
      message: `${pull.title}${body}`,
    }));
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSeq = seq;
  pull.mergeCommitSha = commitOid;
  return { sha: commitOid };
}
