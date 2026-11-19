// Git smart HTTP: ref advertisement (v0 and v2), v2 ls-refs, v2/v0 fetch with shallow support,
// and v0 receive-pack with per-ref fast-forward enforcement and report-status.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLine,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktFlush,
  pktLines,
  reachableObjects,
  readPack,
  sidebandWrap,
  writePack,
  type GitObj,
} from './gitcore.ts';
import { getRepo, type RepoRec } from './store.ts';

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS = `side-band-64k ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/main`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;

function json(status: number, value: unknown): HttpResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8') };
}

function notFound(): HttpResult {
  return json(404, { message: 'Not Found' });
}

/** Refs in advertisement order: HEAD's target first is handled by the caller; refs sort by name. */
function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function advertisementV0(repo: RepoRec, service: string): HttpResult {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : UPLOAD_CAPS;
  const refs = sortedRefs(repo);
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}\n`);
      const target = repo.objects.get(oid);
      if (name.startsWith('refs/tags/') && target !== undefined && target.type === 'tag') {
        const peeled = peelToCommit(repo.objects, oid);
        if (peeled !== null) lines.push(`${peeled} ${name}^{}\n`);
      }
    }
  }
  const body = Buffer.concat([encodePktLine(`# service=${service}\n`), pktFlush(), pktLines(lines), pktFlush()]);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body };
}

// The v2 advertisement names no ref and never changes: build its body once, serve it forever.
const ADVERTISEMENT_V2_BODY: Buffer = (() => {
  const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
  const parts = lines.map((line) => encodePktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
})();

function advertisementV2(): HttpResult {
  return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: ADVERTISEMENT_V2_BODY };
}

function infoRefs(repo: RepoRec, service: string, gitProtocol: string | undefined): HttpResult {
  if (service === 'git-upload-pack') {
    if (gitProtocol !== undefined && /(^|[\s,])version=2/.test(gitProtocol)) return advertisementV2();
    return advertisementV0(repo, service);
  }
  if (service === 'git-receive-pack') return advertisementV0(repo, service);
  return notFound();
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(repo: RepoRec, args: LsRefsArgs): HttpResult {
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${headTarget}` : ''}`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const target = repo.objects.get(oid);
      if (target !== undefined && target.type === 'tag') {
        const peeled = peelToCommit(repo.objects, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  const framed = lines.map((line) => `${line}\n`);
  const body = Buffer.concat([pktLines(framed), pktFlush()]);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}
// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

interface FetchSelection {
  objects: { oid: string; type: GitObj['type']; data: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

function selectFetchObjects(repo: RepoRec, request: FetchRequest): FetchSelection {
  const objects = repo.objects;
  // Commit distances from the wants (tags peel to their commit at distance 1). The walk is a
  // queue with a read index (no O(n) shift per step) and, for a shallow fetch, it never expands
  // a commit already at the depth limit: its parents can only land beyond the limit, so the
  // included set — and therefore the pack — is exactly the one the unbounded walk produced.
  const distances = new Map<string, number>();
  const queue: { oid: string; distance: number }[] = [];
  for (const want of request.wants) {
    const commit = peelToCommit(objects, want);
    if (commit !== null && !distances.has(commit)) {
      distances.set(commit, 1);
      queue.push({ oid: commit, distance: 1 });
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const { oid, distance } = queue[head] as { oid: string; distance: number };
    if (request.depth !== null && distance >= request.depth) continue;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distances.has(parent)) {
        distances.set(parent, distance + 1);
        queue.push({ oid: parent, distance: distance + 1 });
      }
    }
  }
  const includedCommits = new Set<string>();
  for (const [oid, distance] of distances) {
    if (request.depth === null || distance <= request.depth) includedCommits.add(oid);
  }
  // Candidate objects: a walk from the wants that never descends past the depth boundary.
  const candidate = new Set<string>();
  const walk: string[] = [...request.wants];
  while (walk.length > 0) {
    const oid = walk.pop() as string;
    if (candidate.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      if (!includedCommits.has(oid)) continue;
      candidate.add(oid);
      const commit = parseCommit(object.data);
      walk.push(commit.tree);
      for (const parent of commit.parents) walk.push(parent);
    } else if (object.type === 'tag') {
      candidate.add(oid);
      walk.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      candidate.add(oid);
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') walk.push(entry.oid);
    } else {
      candidate.add(oid);
    }
  }
  // Boundary: included commits with a parent that is not included.
  const boundary = new Set<string>();
  if (request.depth !== null) {
    for (const oid of includedCommits) {
      if (!candidate.has(oid)) continue;
      const object = objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.some((parent) => !includedCommits.has(parent))) boundary.add(oid);
    }
  }
  const clientShallow = new Set(request.shallow.filter((oid) => isOid(oid)));
  const presentHaves = request.haves.filter((oid) => objects.has(oid));
  const haveClosure = presentHaves.length === 0 ? new Set<string>() : reachableObjects(objects, presentHaves, clientShallow);
  const rank = (type: GitObj['type']): number => (type === 'tag' ? 0 : type === 'commit' ? 1 : type === 'tree' ? 2 : 3);
  const list: FetchSelection['objects'] = [];
  for (const oid of candidate) {
    if (haveClosure.has(oid)) continue;
    const object = objects.get(oid) as GitObj;
    list.push({ oid, type: object.type, data: object.data });
  }
  list.sort((a, b) => rank(a.type) - rank(b.type));
  const unshallow = [...clientShallow].filter((oid) => includedCommits.has(oid) && !boundary.has(oid));
  return { objects: list, shallow: [...boundary], unshallow };
}

// Generated packs are a pure function of the request and the object graph it names: objects
// are content-addressed and immutable, and a fetch selection is fully determined by its wants,
// haves, shallow boundary and depth — adding unrelated objects to the store (a push to another
// branch, say) cannot change what an existing want set selects. Repeated fetches of the same
// tip — fifty concurrent shallow clones of one repository above all — therefore reuse the
// first pack byte for byte instead of re-walking and re-deflating the same objects each time,
// and the fully framed response bodies are memoised on the same entry: the shallow-info and
// packfile sections of a v2 answer (and the ACK line of a v0 one) are functions of the same
// selection, so a cache hit returns the finished bytes without re-framing anything.
interface PackCacheEntry {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  bodyV2: Buffer | null;
  bodyV0: Buffer | null;
}

const packCache = new Map<string, PackCacheEntry>();
const PACK_CACHE_LIMIT = 256;

function packCacheKey(repo: RepoRec, request: FetchRequest): string {
  const sorted = (values: string[]): string => [...values].sort().join(',');
  // The repository's id, not its name: ids are never reused, so a repository deleted and
  // recreated under the same name can never inherit the old one's cached packs.
  return [
    repo.id,
    request.depth ?? '',
    sorted(request.wants),
    sorted(request.haves),
    sorted(request.shallow),
  ].join('|');
}

function buildPack(repo: RepoRec, request: FetchRequest): PackCacheEntry {
  const key = packCacheKey(repo, request);
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const selection = selectFetchObjects(repo, request);
  const pack = writePack(selection.objects);
  const entry: PackCacheEntry = { pack, shallow: selection.shallow, unshallow: selection.unshallow, bodyV2: null, bodyV0: null };
  // Cache only a selection whose inputs the store already fully holds: when every want, have
  // and shallow oid is present, the walk's closure is fixed by content addressing and no later
  // push can change it. A request naming an oid the store lacks is answered fresh each time,
  // so a push that lands that oid is picked up by the next identical fetch.
  const closed =
    request.wants.every((oid) => repo.objects.has(oid)) &&
    request.haves.every((oid) => repo.objects.has(oid)) &&
    request.shallow.every((oid) => repo.objects.has(oid));
  if (!closed) return entry;
  if (packCache.size >= PACK_CACHE_LIMIT) packCache.clear();
  packCache.set(key, entry);
  return entry;
}

function fetchV2(repo: RepoRec, request: FetchRequest): HttpResult {
  if (!request.done) {
    const parts: Buffer[] = [];
    parts.push(encodePktLine('acknowledgments\n'));
    const common = request.haves.filter((have) => repo.objects.has(have));
    if (common.length === 0) {
      parts.push(encodePktLine('NAK\n'));
    } else {
      for (const have of common) parts.push(encodePktLine(`ACK ${have}\n`));
    }
    parts.push(pktFlush());
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  const entry = buildPack(repo, request);
  if (entry.bodyV2 !== null) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: entry.bodyV2 };
  }
  const parts: Buffer[] = [];
  if (request.depth !== null || request.shallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of entry.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of entry.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandWrap(entry.pack));
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  entry.bodyV2 = body;
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function fetchV0(repo: RepoRec, request: FetchRequest): HttpResult {
  const entry = buildPack(repo, request);
  // The memoised body is served only when the request names no haves: the ACK/NAK line is
  // then always NAK and every other byte is a function of the cached selection. With haves,
  // the ACK names the first one the store currently holds, which a later push can change,
  // so those answers are framed fresh each time.
  if (request.haves.length === 0 && entry.bodyV0 !== null) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: entry.bodyV0 };
  }
  const parts: Buffer[] = [];
  if (request.depth !== null || request.shallow.length > 0) {
    for (const oid of entry.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of entry.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  }
  const common = request.haves.filter((have) => repo.objects.has(have));
  if (common.length > 0) parts.push(encodePktLine(`ACK ${common[0]}\n`));
  else parts.push(encodePktLine('NAK\n'));
  parts.push(sidebandWrap(entry.pack));
  parts.push(pktFlush());
  const body = Buffer.concat(parts);
  if (request.haves.length === 0) entry.bodyV0 = body;
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
}

function parseFetchArgs(lines: string[], request: FetchRequest): void {
  for (const line of lines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim().split(' ')[0] as string);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number.parseInt(line.slice(7).trim(), 10) || null;
    else if (line === 'done') request.done = true;
  }
}

function uploadPackPost(repo: RepoRec, body: Buffer, gitProtocol: string | undefined): HttpResult {
  const { items, consumed } = decodePktLines(body);
  void consumed;
  const isV2 = gitProtocol !== undefined && /(^|[\s,])version=2/.test(gitProtocol);
  if (!isV2) {
    // v0: wants in the first flush-terminated section, haves after it.
    const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
    let section = 0;
    for (const item of items) {
      if (item.kind === 'flush') {
        section += 1;
        continue;
      }
      if (item.kind !== 'data') continue;
      const line = item.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) parseFetchArgs([line], request);
      else parseFetchArgs([line], request);
    }
    if (request.wants.length === 0) return json(400, { message: 'Bad Request' });
    request.done = true;
    return fetchV0(repo, request);
  }
  // v2: capability section up to the delim, argument section up to the flush.
  let command = '';
  const argLines: string[] = [];
  let phase = 0;
  for (const item of items) {
    if (item.kind === 'delim') {
      phase = 1;
      continue;
    }
    if (item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    const line = item.payload.toString('utf8').replace(/\n$/, '');
    if (phase === 0) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      argLines.push(line);
    }
  }
  if (command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of argLines) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return lsRefs(repo, args);
  }
  if (command === 'fetch') {
    const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
    parseFetchArgs(argLines, request);
    return fetchV2(repo, request);
  }
  return json(400, { message: 'Bad Request' });
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: RepoRec, body: Buffer): HttpResult {
  const { items, consumed } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  let sawFlush = false;
  for (const item of items) {
    if (item.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (item.kind !== 'data') continue;
    let line = item.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  if (!sawFlush && commands.length === 0) return json(400, { message: 'Bad Request' });
  const packBytes = body.subarray(consumed);
  const caps = new Set(capabilities.split(' ').filter((cap) => cap !== ''));
  const useSideband = caps.has('side-band-64k');
  const useReport = caps.has('report-status') || caps.has('report-status-v2');

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const incoming = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of incoming) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [];
  reportLines.push(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`);
  for (const command of commands) {
    const failure = unpackError === null ? applyCommand(repo, command) : 'unpacker error';
    reportLines.push(failure === null ? `ok ${command.ref}\n` : `ng ${command.ref} ${failure}\n`);
  }
  if (!useReport) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const inner = Buffer.concat([pktLines(reportLines), pktFlush()]);
  const bodyOut = useSideband ? Buffer.concat([sidebandWrap(inner), pktFlush()]) : inner;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: bodyOut };
}

/** Apply one ref update; returns the refusal reason or null when applied. */
function applyCommand(repo: RepoRec, command: PushCommand): string | null {
  if (!command.ref.startsWith('refs/')) return 'invalid ref';
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.oldOid !== current) return 'stale info';
  if (command.newOid === ZERO_OID) {
    repo.refs.delete(command.ref);
    return null;
  }
  const target = repo.objects.get(command.newOid);
  if (target === undefined) return 'invalid object';
  if (target.type !== 'commit' && target.type !== 'tag') return 'invalid object';
  if (command.oldOid !== ZERO_OID) {
    const oldCommit = peelToCommit(repo.objects, command.oldOid);
    const newCommit = peelToCommit(repo.objects, command.newOid);
    if (oldCommit === null || newCommit === null) return 'invalid object';
    if (oldCommit !== newCommit) {
      // Fast-forward only: the old commit must be an ancestor of the new one.
      const seen = new Set<string>();
      const queue = [newCommit];
      let found = false;
      while (queue.length > 0 && !found) {
        const oid = queue.pop() as string;
        if (oid === oldCommit) {
          found = true;
          break;
        }
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (object === undefined || object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
      if (!found) return 'non-fast-forward';
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}

// ---------------------------------------------------------------- entry point

export function handleGit(owner: string, repoName: string, subPath: string, method: string, query: URLSearchParams, body: Buffer, gitProtocol: string | undefined): HttpResult {
  const repo = getRepo(owner, repoName);
  if (repo === null) return notFound();
  if (method === 'GET' && subPath === '/info/refs') {
    return infoRefs(repo, query.get('service') ?? '', gitProtocol);
  }
  if (method === 'POST' && subPath === '/git-upload-pack') {
    try {
      return uploadPackPost(repo, body, gitProtocol);
    } catch {
      return json(400, { message: 'Bad Request' });
    }
  }
  if (method === 'POST' && subPath === '/git-receive-pack') {
    try {
      return receivePack(repo, body);
    } catch {
      return json(400, { message: 'Bad Request' });
    }
  }
  return notFound();
}
