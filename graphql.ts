// A compact GraphQL v4 executor for POST /api/graphql: a tokenizer/parser for the documents gh
// and github-mcp-server send (operations, variables, aliases, inline fragments, input objects,
// enum lists, batching) and a resolver layer over the shared store. Unknown fields answer
// HTTP 200 with an `errors` entry naming the field, as GitHub does.

import {
  VIEWER,
  addComment,
  branchTip,
  createIssue,
  createPull,
  getRepo,
  isoAt,
  mergePull,
  pullChanges,
  pullConflicts,
  repoById,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import type { HttpResult } from './githttp.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:=!$@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else value += esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) {
        if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  varDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    if (!this.isPunct(value)) throw new Error(`expected '${value}'`);
    this.pos += 1;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, varDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation or fragment definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const varDefaults = new Map<string, ValueNode>();
        if (this.isPunct('(')) this.parseVariableDefinitions(varDefaults);
        this.skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, varDefaults, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected `on` in a fragment definition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, ValueNode>): void {
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.isPunct('=')) {
        this.next();
        defaults.set(name, this.parseValue());
      }
      this.skipDirectives();
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.expectPunct(')');
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      const token = this.peek();
      if (token.kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value !== 'on') {
          selections.push({ kind: 'spread', name: this.expectName() });
        } else {
          let typeCondition: string | null = null;
          if (this.peek().kind === 'name') {
            this.next(); // 'on'
            typeCondition = this.expectName();
          }
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, ValueNode>();
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selectionSet: SelectionNode[] | null = null;
    if (this.isPunct('{')) selectionSet = this.parseSelectionSet();
    return { alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }
}

function evalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return vars[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => evalValue(value, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------- global ids

function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0] as string, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- schema surface

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', '__type', '__schema', 'rateLimit', 'search', 'user', 'organization', 'repositoryOwner'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'updateIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'databaseId', 'name', 'email', 'url', 'avatarUrl', 'isViewer', 'createdAt', 'updatedAt'],
  RepositoryOwner: ['login', 'id', 'url', 'avatarUrl'],
  Organization: ['login', 'id', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'isPrivate', 'isFork', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'url', 'homepageUrl', 'createdAt', 'updatedAt', 'pushedAt', 'stargazerCount', 'forkCount',
  ],
  Ref: ['name', 'prefix', 'target'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'url', 'createdAt', 'updatedAt', 'closed',
    'closedAt', 'author', 'editor', 'labels', 'comments', 'repository', 'participants', 'locked', 'activeLockReason',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'url', 'createdAt', 'updatedAt', 'closed', 'closedAt', 'author',
    'files', 'commits', 'comments', 'mergedBy', 'mergeCommit', 'isDraft', 'additions', 'deletions', 'changedFiles',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestCommitConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestCommitEdge: ['node', 'cursor'],
  PullRequestCommit: ['id', 'oid', 'message', 'committedDate', 'author'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  Comment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  Label: ['id', 'name', 'color', 'description', 'isDefault'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  ReopenIssuePayload: ['issue', 'clientMutationId'],
  UpdateIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', 'subject'],
  CommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL', 'isOneOf'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives', 'description'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
  Node: ['id'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  CommentAuthorAssociation: ['OWNER', 'MEMBER', 'COLLABORATOR', 'NONE'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

const OBJECT_KINDS: Record<string, string> = { Query: 'OBJECT', Mutation: 'OBJECT' };

// ---------------------------------------------------------------- object builders

type GqlObj = Record<string, unknown> & { __typename: string };

function viewerObj(): GqlObj {
  return {
    __typename: 'User',
    login: VIEWER.login,
    id: gid('user', VIEWER.login),
    databaseId: VIEWER.id,
    name: VIEWER.name,
    email: VIEWER.email,
    url: '',
    avatarUrl: '',
    isViewer: true,
    createdAt: isoAt(1),
    updatedAt: isoAt(1),
  };
}

function repoObj(repo: RepoRec): GqlObj {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: gid('repo', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    isFork: false,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasPullRequestsEnabled: true,
    url: '',
    homepageUrl: null,
    createdAt: isoAt(repo.seq),
    updatedAt: isoAt(repo.seq),
    pushedAt: isoAt(repo.seq),
    stargazerCount: 0,
    forkCount: 0,
  };
}

function issueObj(repo: RepoRec, issue: IssueRec): GqlObj {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: gid('issue', repo.id, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    bodyText: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: '',
    createdAt: isoAt(issue.seq),
    updatedAt: isoAt(issue.seq),
    closed: issue.state === 'closed',
    closedAt: issue.state === 'closed' ? isoAt(issue.seq) : null,
    locked: false,
    activeLockReason: null,
  };
}

function pullObj(repo: RepoRec, pull: PullRec): GqlObj {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: gid('pr', repo.id, pull.number),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergedAt: pull.mergedSeq === null ? null : isoAt(pull.mergedSeq),
    mergeable: pull.state !== 'open' ? 'UNKNOWN' : pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    url: '',
    createdAt: isoAt(pull.seq),
    updatedAt: isoAt(pull.mergedSeq ?? pull.seq),
    closed: pull.state === 'closed',
    closedAt: pull.state === 'closed' ? isoAt(pull.mergedSeq ?? pull.seq) : null,
    isDraft: false,
  };
}

function pageInfo(hasNext: boolean, hasPrev: boolean, startCursor: string | null, endCursor: string | null): GqlObj {
  return { __typename: 'PageInfo', hasNextPage: hasNext, hasPreviousPage: hasPrev, startCursor, endCursor };
}

function typeObj(name: string): GqlObj | null {
  const fields = TYPE_FIELDS[name];
  const enumValues = ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  const kind = enumValues !== undefined && fields === undefined ? 'ENUM' : (OBJECT_KINDS[name] ?? 'OBJECT');
  return {
    __typename: '__Type',
    _typeName: name,
    name,
    kind,
    description: null,
    possibleTypes: null,
    inputFields: null,
    ofType: null,
    specifiedByURL: null,
    isOneOf: false,
  };
}

// ---------------------------------------------------------------- executor

interface ExecContext {
  vars: Record<string, unknown>;
  errors: { message: string; path?: (string | number)[] }[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: SelectionNode[] }>;
}

function evalArgs(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, value] of field.args) args[name] = evalValue(value, ctx.vars);
  // Variable defaults fill anything the caller left unset.
  return args;
}

function executeSelectionSet(typeName: string, source: GqlObj, selections: SelectionNode[], ctx: ExecContext, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === source.__typename || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(source.__typename, source, selection.selectionSet, ctx, path));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === source.__typename)) {
        Object.assign(out, executeSelectionSet(source.__typename, source, fragment.selectionSet, ctx, path));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    const fieldPath = [...path, key];
    if (field.name === '__typename') {
      out[key] = source.__typename;
      continue;
    }
    const validFields = TYPE_FIELDS[typeName] ?? TYPE_FIELDS[source.__typename] ?? [];
    if (!validFields.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'`, path: fieldPath });
      out[key] = null;
      continue;
    }
    const args = evalArgs(field, ctx);
    const value = resolveField(typeName, source, field.name, args, ctx, fieldPath);
    out[key] = completeValue(value, field, ctx, fieldPath);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecContext, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry, index) => completeValue(entry, field, ctx, [...path, index]));
  }
  if (typeof value === 'object') {
    const obj = value as GqlObj;
    if (typeof obj.__typename === 'string' && field.selectionSet !== null) {
      return executeSelectionSet(obj.__typename, obj, field.selectionSet, ctx, path);
    }
    if (field.selectionSet !== null && typeof obj.__typename === 'string') {
      return executeSelectionSet(obj.__typename, obj, field.selectionSet, ctx, path);
    }
    return value;
  }
  return value;
}

function asRepo(source: GqlObj): RepoRec {
  return source._repo as RepoRec;
}

function issueConnection(repo: RepoRec, args: Record<string, unknown>): GqlObj {
  let items = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state)) : null;
  if (states !== null) items = items.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const direction = orderBy?.direction === 'ASC' ? 'ASC' : orderBy?.direction === 'DESC' ? 'DESC' : 'ASC';
  items.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  return pagedConnection('IssueConnection', 'IssueEdge', items.map((issue) => issueObj(repo, issue)), args);
}

function pullConnection(repo: RepoRec, args: Record<string, unknown>): GqlObj {
  let items = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map((state) => String(state)) : ['OPEN'];
  items = items.filter((pull) => {
    const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    return states.includes(state);
  });
  items.sort((a, b) => a.number - b.number);
  return pagedConnection('PullRequestConnection', 'PullRequestEdge', items.map((pull) => pullObj(repo, pull)), args);
}

function pagedConnection(typeName: string, edgeType: string, nodes: GqlObj[], args: Record<string, unknown>): GqlObj {
  let start = 0;
  if (typeof args.after === 'string') {
    const afterNumber = numberFromCursor(args.after);
    if (afterNumber !== null) {
      const index = nodes.findIndex((node) => node.number === afterNumber);
      if (index >= 0) start = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : nodes.length;
  const page = nodes.slice(start, start + first);
  const hasNext = start + page.length < nodes.length;
  const connection: GqlObj = {
    __typename: typeName,
    _nodes: page,
    _edges: page.map((node) => ({ __typename: edgeType, node, cursor: cursorFor(node.number as number) })),
    _pageInfo: pageInfo(
      hasNext,
      start > 0,
      page.length > 0 ? cursorFor(page[0]?.number as number) : null,
      page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null,
    ),
    totalCount: nodes.length,
  };
  return connection;
}

function findIssueByGid(id: string): { repo: RepoRec; issue: IssueRec } | null {
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'issue') return null;
  const repo = repoById(Number.parseInt(parsed.parts[0] as string, 10));
  if (repo === null) return null;
  const issue = repo.issues.get(Number.parseInt(parsed.parts[1] as string, 10));
  return issue === undefined ? null : { repo, issue };
}

function findPullByGid(id: string): { repo: RepoRec; pull: PullRec } | null {
  const parsed = parseGid(id);
  if (parsed === null || parsed.kind !== 'pr') return null;
  const repo = repoById(Number.parseInt(parsed.parts[0] as string, 10));
  if (repo === null) return null;
  const pull = repo.pulls.get(Number.parseInt(parsed.parts[1] as string, 10));
  return pull === undefined ? null : { repo, pull };
}

function nodeById(id: string): GqlObj | null {
  const parsed = parseGid(id);
  if (parsed === null) return null;
  if (parsed.kind === 'repo') {
    const repo = repoById(Number.parseInt(parsed.parts[0] as string, 10));
    return repo === null ? null : repoObj(repo);
  }
  if (parsed.kind === 'issue') {
    const found = findIssueByGid(id);
    return found === null ? null : issueObj(found.repo, found.issue);
  }
  if (parsed.kind === 'pr') {
    const found = findPullByGid(id);
    return found === null ? null : pullObj(found.repo, found.pull);
  }
  if (parsed.kind === 'user') return viewerObj();
  return null;
}

function resolveField(typeName: string, source: GqlObj, field: string, args: Record<string, unknown>, ctx: ExecContext, path: (string | number)[]): unknown {
  if (typeName === 'Query') {
    switch (field) {
      case 'viewer':
        return viewerObj();
      case 'repository': {
        const repo = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : repoObj(repo);
      }
      case 'node':
        return typeof args.id === 'string' ? nodeById(args.id) : null;
      case 'nodes': {
        if (!Array.isArray(args.ids)) return [];
        return (args.ids as unknown[]).map((id) => (typeof id === 'string' ? nodeById(id) : null));
      }
      case '__type':
        return typeof args.name === 'string' ? typeObj(args.name) : null;
      case '__schema':
        return {
          __typename: '__Schema',
          description: null,
          types: Object.keys(TYPE_FIELDS).map((name) => typeObj(name)),
          queryType: typeObj('Query'),
          mutationType: typeObj('Mutation'),
          subscriptionType: null,
          directives: [],
        };
      default:
        return null;
    }
  }

  if (typeName === 'Mutation') return resolveMutation(field, args, ctx, path);

  if (typeName === '__Type') {
    const name = source._typeName as string;
    if (field === 'fields') {
      const fields = TYPE_FIELDS[name];
      if (fields === undefined || ENUM_VALUES[name] !== undefined) return null;
      return fields.map((fieldName) => ({
        __typename: '__Field',
        name: fieldName,
        description: null,
        args: [],
        type: null,
        isDeprecated: false,
        deprecationReason: null,
      }));
    }
    if (field === 'enumValues') {
      const values = ENUM_VALUES[name];
      if (values === undefined) return null;
      return values.map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null }));
    }
    return source[field] ?? null;
  }

  if (source.__typename === 'Repository') {
    const repo = asRepo(source);
    switch (field) {
      case 'owner':
        return viewerObj();
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.defaultBranch);
        return tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: null };
      }
      case 'issue': {
        const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
        return issue === undefined ? null : issueObj(repo, issue);
      }
      case 'issues':
        return issueConnection(repo, args);
      case 'pullRequest': {
        const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
        return pull === undefined ? null : pullObj(repo, pull);
      }
      case 'pullRequests':
        return pullConnection(repo, args);
      default:
        return source[field] ?? null;
    }
  }

  if (source.__typename === 'Issue') {
    const repo = asRepo(source);
    const issue = source._issue as IssueRec;
    switch (field) {
      case 'author':
      case 'editor':
        return viewerObj();
      case 'repository':
        return repoObj(repo);
      case 'labels': {
        const nodes = issue.labels.map((name) => {
          const label = repo.labels.get(name);
          return { __typename: 'Label', id: gid('label', repo.id, name), name, color: label?.color ?? 'ededed', description: label?.description ?? null, isDefault: false };
        });
        return { __typename: 'LabelConnection', _nodes: nodes, _edges: [], _pageInfo: pageInfo(false, false, null, null), totalCount: nodes.length };
      }
      case 'comments': {
        const nodes = issue.comments.map((comment) => ({
          __typename: 'IssueComment',
          id: gid('comment', repo.id, issue.number, comment.id),
          databaseId: comment.id,
          body: comment.body,
          createdAt: isoAt(comment.seq),
          updatedAt: isoAt(comment.seq),
          author: viewerObj(),
          url: '',
        }));
        return { __typename: 'IssueCommentConnection', _nodes: nodes, _edges: [], _pageInfo: pageInfo(false, false, null, null), totalCount: nodes.length };
      }
      default:
        return source[field] ?? null;
    }
  }

  if (source.__typename === 'PullRequest') {
    const repo = asRepo(source);
    const pull = source._pull as PullRec;
    switch (field) {
      case 'author':
        return viewerObj();
      case 'mergedBy':
        return pull.merged ? viewerObj() : null;
      case 'headRef': {
        const tip = branchTip(repo, pull.headRef);
        return tip === null ? null : { __typename: 'Ref', name: pull.headRef, prefix: 'refs/heads/', target: null };
      }
      case 'baseRef': {
        const tip = branchTip(repo, pull.baseRef);
        return tip === null ? null : { __typename: 'Ref', name: pull.baseRef, prefix: 'refs/heads/', target: null };
      }
      case 'files': {
        const changes = pullChanges(repo, pull);
        const nodes = changes.map((change) => ({
          __typename: 'PullRequestChangedFile',
          path: change.filename,
          additions: change.additions,
          deletions: change.deletions,
          changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }));
        const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : nodes.length;
        return {
          __typename: 'PullRequestChangedFileConnection',
          _nodes: nodes.slice(0, first),
          _edges: [],
          _pageInfo: pageInfo(nodes.length > first, false, null, null),
          totalCount: nodes.length,
        };
      }
      case 'commits': {
        return { __typename: 'PullRequestCommitConnection', _nodes: [], _edges: [], _pageInfo: pageInfo(false, false, null, null), totalCount: 0 };
      }
      case 'comments': {
        return { __typename: 'IssueCommentConnection', _nodes: [], _edges: [], _pageInfo: pageInfo(false, false, null, null), totalCount: 0 };
      }
      case 'additions':
        return pullChanges(repo, pull).reduce((sum, change) => sum + change.additions, 0);
      case 'deletions':
        return pullChanges(repo, pull).reduce((sum, change) => sum + change.deletions, 0);
      case 'changedFiles':
        return pullChanges(repo, pull).length;
      case 'mergeCommit':
        return null;
      default:
        return source[field] ?? null;
    }
  }

  if (source.__typename.endsWith('Connection')) {
    if (field === 'nodes') return source._nodes ?? [];
    if (field === 'edges') return source._edges ?? [];
    if (field === 'pageInfo') return source._pageInfo ?? pageInfo(false, false, null, null);
    if (field === 'totalCount') return source.totalCount ?? 0;
    return source[field] ?? null;
  }

  return source[field] ?? null;
}

function inputOf(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
}

function resolveMutation(field: string, args: Record<string, unknown>, ctx: ExecContext, path: (string | number)[]): unknown {
  const input = inputOf(args);
  switch (field) {
    case 'createIssue': {
      const parsed = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'repo' ? repoById(Number.parseInt(parsed.parts[0] as string, 10)) : null;
      if (repo === null) {
        ctx.errors.push({ message: 'Repository not found', path });
        return null;
      }
      const issue = createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: input.clientMutationId ?? null };
    }
    case 'closeIssue':
    case 'reopenIssue':
    case 'updateIssue': {
      const found = typeof input.issueId === 'string' ? findIssueByGid(input.issueId) : typeof input.id === 'string' ? findIssueByGid(input.id) : null;
      if (found === null) {
        ctx.errors.push({ message: 'Issue not found', path });
        return null;
      }
      if (field === 'closeIssue') found.issue.state = 'closed';
      if (field === 'reopenIssue') found.issue.state = 'open';
      if (field === 'updateIssue') {
        if (typeof input.title === 'string') found.issue.title = input.title;
        if (typeof input.body === 'string') found.issue.body = input.body;
        if (input.state === 'OPEN') found.issue.state = 'open';
        if (input.state === 'CLOSED') found.issue.state = 'closed';
      }
      const payloadType = field === 'closeIssue' ? 'CloseIssuePayload' : field === 'reopenIssue' ? 'ReopenIssuePayload' : 'UpdateIssuePayload';
      return { __typename: payloadType, issue: issueObj(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    }
    case 'createPullRequest': {
      const parsed = typeof input.repositoryId === 'string' ? parseGid(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'repo' ? repoById(Number.parseInt(parsed.parts[0] as string, 10)) : null;
      if (repo === null) {
        ctx.errors.push({ message: 'Repository not found', path });
        return null;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      if (branchTip(repo, headRef) === null || branchTip(repo, baseRef) === null) {
        ctx.errors.push({ message: 'Head or base ref does not exist', path });
        return null;
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, existing), clientMutationId: input.clientMutationId ?? null };
        }
      }
      const pull = createPull(repo, { title: String(input.title ?? ''), body: String(input.body ?? ''), headRef, baseRef });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: input.clientMutationId ?? null };
    }
    case 'mergePullRequest': {
      const found = typeof input.pullRequestId === 'string' ? findPullByGid(input.pullRequestId) : null;
      if (found === null) {
        ctx.errors.push({ message: 'Pull request not found', path });
        return null;
      }
      const methodName = String(input.mergeMethod ?? 'SQUASH').toUpperCase();
      const method = methodName === 'MERGE' ? 'merge' : methodName === 'REBASE' ? 'rebase' : 'squash';
      const result = mergePull(found.repo, found.pull, method);
      if ('error' in result) {
        ctx.errors.push({ message: 'Pull Request is not mergeable', path });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
    }
    case 'addComment': {
      const found = typeof input.subjectId === 'string' ? findIssueByGid(input.subjectId) : null;
      if (found === null) {
        ctx.errors.push({ message: 'Subject not found', path });
        return null;
      }
      const comment = addComment(found.issue, String(input.body ?? ''));
      const node: GqlObj = {
        __typename: 'IssueComment',
        id: gid('comment', found.repo.id, found.issue.number, comment.id),
        databaseId: comment.id,
        body: comment.body,
        createdAt: isoAt(comment.seq),
        updatedAt: isoAt(comment.seq),
        author: viewerObj(),
        url: '',
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node, cursor: cursorFor(found.issue.number) },
        subject: issueObj(found.repo, found.issue),
        clientMutationId: input.clientMutationId ?? null,
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- HTTP entry

interface OperationRequest {
  query: string;
  variables: Record<string, unknown>;
  operationName?: string;
}

function executeOperation(request: OperationRequest): Record<string, unknown> {
  let document: DocumentNode;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  let operation = document.operations[0];
  if (request.operationName !== undefined) {
    operation = document.operations.find((candidate) => candidate.name === request.operationName) ?? operation;
  }
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation in the document' }] };
  const vars: Record<string, unknown> = { ...request.variables };
  for (const [name, defaultValue] of operation.varDefaults) {
    if (vars[name] === undefined) vars[name] = evalValue(defaultValue, vars);
  }
  const ctx: ExecContext = { vars, errors: [], fragments: document.fragments };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObj = { __typename: rootType };
  const data = executeSelectionSet(rootType, root, operation.selectionSet, ctx, []);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

export function handleGraphQL(rawBody: Buffer): HttpResult {
  const text = rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] })}\n`, 'utf8') };
  }
  const toRequest = (entry: unknown): OperationRequest | null => {
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.query !== 'string') return null;
    const variables = typeof record.variables === 'object' && record.variables !== null ? (record.variables as Record<string, unknown>) : {};
    return { query: record.query, variables, operationName: typeof record.operationName === 'string' ? record.operationName : undefined };
  };
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const request = toRequest(entry);
      return request === null ? { data: null, errors: [{ message: 'Invalid operation' }] } : executeOperation(request);
    });
    return { status: 200, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(results)}\n`, 'utf8') };
  }
  const request = toRequest(parsed);
  if (request === null) {
    return { status: 200, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ data: null, errors: [{ message: 'A query is required' }] })}\n`, 'utf8') };
  }
  const result = executeOperation(request);
  return { status: 200, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(result)}\n`, 'utf8') };
}
