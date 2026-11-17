// GraphQL v4 surface: a small hand-written parser and executor for the
// documents gh and github-mcp-server send — viewer, repository reads,
// issue/pull-request connections with cursor pagination, the five
// mutations, Relay node(id:) and __type introspection. Anything outside
// that surface answers with a GraphQL errors array, as the API does.

import type { Issue, Repo, Store } from './store.ts';
import { createIssue, diffTrees, mergePull, pullSides } from './rest.ts';
import { parseCommit } from './git.ts';

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> }
  | { kind: 'variable'; name: string };

interface FieldNode {
  name: string;
  alias?: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name?: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$!@='.includes(ch)) {
      tokens.push(ch);
      i++;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          out += source[j + 1] === 'n' ? '\n' : source[j + 1] === 't' ? '\t' : source[j + 1];
          j += 2;
        } else {
          out += source[j];
          j++;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(source.slice(i));
    if (!match) throw new Error(`unexpected character ${ch}`);
    tokens.push(match[0]);
    i += match[0].length;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    const t = this.tokens[this.pos++];
    if (t === undefined) throw new Error('unexpected end of document');
    return t;
  }
  expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new Error(`expected ${t}, got ${got}`);
  }
  skipType(): void {
    // a type reference: Name, [Type], trailing !
    if (this.peek() === '[') {
      this.next();
      this.skipType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', selections: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        const type = this.next() as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek() && /^[A-Za-z_][A-Za-z0-9_]*$/.test(this.peek()!) && this.peek() !== '(' && this.peek() !== '{') {
          name = this.next();
        }
        if (this.peek() === '(') this.parseVariableDefinitions();
        // directives on operations are not used by the clients; skip simple ones
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.parseArguments();
        }
        operations.push({ type, name, selections: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        this.next(); // type condition
        fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.skipType();
      if (this.peek() === '=') {
        this.next();
        this.parseValue();
      }
      if (this.peek() === '@') {
        this.next();
        this.next();
        if (this.peek() === '(') this.parseArguments();
      }
    }
    this.expect(')');
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
      } else {
        selections.push({ kind: 'field', field: this.parseField() });
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek() === '(') args = this.parseArguments();
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.parseArguments();
    }
    let selections: SelectionNode[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { name, alias, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expect('(');
    const args: Record<string, ValueNode> = {};
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  parseValue(): ValueNode {
    const t = this.next();
    if (t === '$') return { kind: 'variable', name: this.next() };
    if (t === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.startsWith('"')) return { kind: 'string', value: t.slice(1, -1) };
    if (t === 'true' || t === 'false') return { kind: 'boolean', value: t === 'true' };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: parseInt(t, 10) };
    if (/^-?\d*\.\d+/.test(t)) return { kind: 'float', value: parseFloat(t) };
    return { kind: 'enum', value: t };
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
    case 'variable':
      return variables[node.name];
  }
}

// ---------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------

export function globalId(type: string, key: string | number): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// schema & execution
// ---------------------------------------------------------------------------

type Ctx = { store: Store };
type Resolver = (source: any, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE';
  fields?: Record<string, { type: string; resolve: Resolver }>;
  values?: string[];
}

const field = (type: string, resolve: Resolver) => ({ type, resolve });
const prop = (type: string, key: string) => field(type, (s) => s?.[key] ?? null);

function userSource(store: Store) {
  return { __typename: 'User', login: store.viewer.login };
}

function repoSource(repo: Repo) {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: Repo, issue: Issue) {
  return { __typename: issue.isPull ? 'PullRequest' : 'Issue', repo, issue };
}

function issueState(issue: Issue): string {
  if (issue.isPull && issue.merged) return 'MERGED';
  return issue.state.toUpperCase();
}

function connection<T>(
  items: T[],
  args: Record<string, unknown>,
): { nodes: T[]; totalCount: number; pageInfo: Record<string, unknown> } {
  const first = typeof args.first === 'number' ? args.first : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after) {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const n = parseInt(decoded.replace('cursor:', ''), 10);
      if (Number.isFinite(n)) start = n;
    } catch {
      start = 0;
    }
  }
  const slice = items.slice(start, start + first);
  const endIndex = start + slice.length;
  return {
    nodes: slice,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: endIndex < items.length,
      hasPreviousPage: start > 0,
      startCursor: slice.length ? Buffer.from(`cursor:${start}`).toString('base64') : null,
      endCursor: slice.length ? Buffer.from(`cursor:${endIndex}`).toString('base64') : null,
    },
  };
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: field('User', (_s, _a, ctx) => userSource(ctx.store)),
      repository: field('Repository', (_s, args, ctx) => {
        const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoSource(repo) : null;
      }),
      node: field('Node', (_s, args, ctx) => resolveNode(ctx.store, String(args.id ?? ''))),
      rateLimit: field('RateLimit', () => ({
        __typename: 'RateLimit',
        limit: 5000,
        cost: 1,
        remaining: 4999,
        used: 1,
        nodeCount: 0,
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      })),
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: field('CreateIssuePayload', (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found');
        const issue = createIssue(ctx.store, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : null,
        });
        return {
          __typename: 'CreateIssuePayload',
          clientMutationId: input.clientMutationId ?? null,
          issue: issueSource(repo, issue),
        };
      }),
      closeIssue: field('CloseIssuePayload', (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(ctx.store, String(input.issueId ?? ''));
        if (!found) throw new Error('issue not found');
        found.issue.state = 'closed';
        found.issue.closedAt = new Date().toISOString();
        return {
          __typename: 'CloseIssuePayload',
          clientMutationId: input.clientMutationId ?? null,
          issue: issueSource(found.repo, found.issue),
        };
      }),
      createPullRequest: field('CreatePullRequestPayload', (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
        if (!repo) throw new Error('repository not found');
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? repo.defaultBranch);
        const headTip = repo.refs.get(`refs/heads/${headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
        if (!headTip || !baseTip) throw new Error('head or base branch does not exist');
        const issue = createIssue(ctx.store, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : null,
        });
        issue.isPull = true;
        issue.headRef = headRef;
        issue.headSha = headTip;
        issue.baseRef = baseRef;
        issue.baseSha = baseTip;
        issue.merged = false;
        issue.mergedAt = null;
        issue.mergeCommitSha = null;
        issue.draft = input.draft === true;
        return {
          __typename: 'CreatePullRequestPayload',
          clientMutationId: input.clientMutationId ?? null,
          pullRequest: issueSource(repo, issue),
        };
      }),
      mergePullRequest: field('MergePullRequestPayload', (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(ctx.store, String(input.pullRequestId ?? ''));
        if (!found) throw new Error('pull request not found');
        const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
        const result = mergePull(ctx.store, found.repo, found.issue, { merge_method: method });
        if (result.status !== 200) {
          throw new Error((result.body as { message?: string })?.message ?? 'merge failed');
        }
        return {
          __typename: 'MergePullRequestPayload',
          clientMutationId: input.clientMutationId ?? null,
          pullRequest: issueSource(found.repo, found.issue),
        };
      }),
      addComment: field('AddCommentPayload', (_s, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(ctx.store, String(input.subjectId ?? ''));
        if (!found) throw new Error('subject not found');
        const comment = {
          id: ctx.store.newCommentId(),
          body: String(input.body ?? ''),
          user: ctx.store.viewer.login,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        found.issue.comments.push(comment);
        const node = {
          __typename: 'IssueComment',
          repo: found.repo,
          issue: found.issue,
          comment,
        };
        return {
          __typename: 'AddCommentPayload',
          clientMutationId: input.clientMutationId ?? null,
          commentEdge: { __typename: 'IssueCommentEdge', node, cursor: '' },
          subject: issueSource(found.repo, found.issue),
        };
      }),
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (_s, _a, ctx) => globalId('User', ctx.store.viewer.id)),
      databaseId: field('Int', (_s, _a, ctx) => ctx.store.viewer.id),
      login: field('String', (_s, _a, ctx) => ctx.store.viewer.login),
      name: field('String', (_s, _a, ctx) => ctx.store.viewer.name),
      email: field('String', (_s, _a, ctx) => ctx.store.viewer.email),
      url: field('URI', (_s, _a, ctx) => `https://github.com/${ctx.store.viewer.login}`),
      avatarUrl: field('URI', () => 'https://avatars.githubusercontent.com/u/1001?v=4'),
      isViewer: field('Boolean', () => true),
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (s) => globalId('Repository', (s.repo as Repo).id)),
      databaseId: field('Int', (s) => (s.repo as Repo).id),
      name: field('String', (s) => (s.repo as Repo).name),
      nameWithOwner: field('String', (s) => (s.repo as Repo).fullName),
      owner: field('User', (_s, _a, ctx) => userSource(ctx.store)),
      description: field('String', (s) => (s.repo as Repo).description || null),
      isPrivate: field('Boolean', (s) => (s.repo as Repo).isPrivate),
      visibility: field('RepositoryVisibility', (s) => ((s.repo as Repo).isPrivate ? 'PRIVATE' : 'PUBLIC')),
      viewerPermission: field('RepositoryPermission', () => 'ADMIN'),
      hasIssuesEnabled: field('Boolean', () => true),
      hasProjectsEnabled: field('Boolean', () => true),
      hasWikiEnabled: field('Boolean', () => true),
      isFork: field('Boolean', () => false),
      forkCount: field('Int', () => 0),
      stargazerCount: field('Int', () => 0),
      createdAt: field('DateTime', (s) => (s.repo as Repo).createdAt),
      updatedAt: field('DateTime', (s) => (s.repo as Repo).updatedAt),
      pushedAt: field('DateTime', (s) => (s.repo as Repo).pushedAt),
      url: field('URI', (s) => `https://github.com/${(s.repo as Repo).fullName}`),
      resourcePath: field('URI', (s) => `/${(s.repo as Repo).fullName}`),
      defaultBranchRef: field('Ref', (s) => {
        const repo = s.repo as Repo;
        const oid = repo.refs.get(repo.headRef);
        if (!oid) return null;
        return { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: { __typename: 'Commit', oid } };
      }),
      issue: field('Issue', (s, args) => {
        const repo = s.repo as Repo;
        const issue = repo.issues.find((i) => i.number === Number(args.number) && !i.isPull);
        return issue ? issueSource(repo, issue) : null;
      }),
      issues: field('IssueConnection', (s, args) => {
        const repo = s.repo as Repo;
        let list = repo.issues.filter((i) => !i.isPull);
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length) {
          list = list.filter((i) => states.includes(i.state.toUpperCase()));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
        list = [...list].sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
        const conn = connection(list.map((i) => issueSource(repo, i)), args);
        return { __typename: 'IssueConnection', ...conn };
      }),
      pullRequest: field('PullRequest', (s, args) => {
        const repo = s.repo as Repo;
        const issue = repo.issues.find((i) => i.number === Number(args.number) && i.isPull);
        return issue ? issueSource(repo, issue) : null;
      }),
      pullRequests: field('PullRequestConnection', (s, args) => {
        const repo = s.repo as Repo;
        let list = repo.issues.filter((i) => i.isPull);
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length) {
          list = list.filter((i) => states.includes(issueState(i)));
        }
        list = [...list].sort((a, b) => b.number - a.number);
        const conn = connection(list.map((i) => issueSource(repo, i)), args);
        return { __typename: 'PullRequestConnection', ...conn };
      }),
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: prop('String', 'name'),
      prefix: prop('String', 'prefix'),
      target: prop('Commit', 'target'),
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (s) => globalId('Commit', s.oid)),
      oid: prop('GitObjectID', 'oid'),
      abbreviatedOid: field('String', (s) => String(s.oid).slice(0, 7)),
      message: field('String', (s, _a, ctx) => {
        const repo = findRepoWithObject(ctx.store, s.oid);
        return repo ? parseCommit(repo.objects.get(s.oid)!.data).message : '';
      }),
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (s) => globalId('Issue', (s.repo as Repo).id * 100000 + (s.issue as Issue).number)),
      databaseId: field('Int', (s) => (s.repo as Repo).id * 100000 + (s.issue as Issue).number),
      number: field('Int', (s) => (s.issue as Issue).number),
      title: field('String', (s) => (s.issue as Issue).title),
      body: field('String', (s) => (s.issue as Issue).body ?? ''),
      bodyText: field('String', (s) => (s.issue as Issue).body ?? ''),
      state: field('IssueState', (s) => issueState(s.issue as Issue)),
      author: field('User', (_s, _a, ctx) => userSource(ctx.store)),
      createdAt: field('DateTime', (s) => (s.issue as Issue).createdAt),
      updatedAt: field('DateTime', (s) => (s.issue as Issue).updatedAt),
      closedAt: field('DateTime', (s) => (s.issue as Issue).closedAt),
      url: field('URI', (s) => `https://github.com/${(s.repo as Repo).fullName}/issues/${(s.issue as Issue).number}`),
      resourcePath: field('URI', (s) => `/${(s.repo as Repo).fullName}/issues/${(s.issue as Issue).number}`),
      repository: field('Repository', (s) => repoSource(s.repo as Repo)),
      comments: field('IssueCommentConnection', (s, args) => {
        const repo = s.repo as Repo;
        const issue = s.issue as Issue;
        const conn = connection(
          issue.comments.map((c) => ({ __typename: 'IssueComment', repo, issue, comment: c })),
          args,
        );
        return { __typename: 'IssueCommentConnection', ...conn, totalCount: issue.comments.length };
      }),
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (s) => globalId('IssueComment', s.comment.id)),
      databaseId: field('Int', (s) => s.comment.id),
      body: field('String', (s) => s.comment.body),
      author: field('User', (_s, _a, ctx) => userSource(ctx.store)),
      createdAt: field('DateTime', (s) => s.comment.createdAt),
      updatedAt: field('DateTime', (s) => s.comment.updatedAt),
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: field('ID', (s) => globalId('PullRequest', (s.repo as Repo).id * 100000 + (s.issue as Issue).number)),
      databaseId: field('Int', (s) => (s.repo as Repo).id * 100000 + (s.issue as Issue).number),
      number: field('Int', (s) => (s.issue as Issue).number),
      title: field('String', (s) => (s.issue as Issue).title),
      body: field('String', (s) => (s.issue as Issue).body ?? ''),
      state: field('PullRequestState', (s) => issueState(s.issue as Issue)),
      merged: field('Boolean', (s) => (s.issue as Issue).merged ?? false),
      mergedAt: field('DateTime', (s) => (s.issue as Issue).mergedAt ?? null),
      closedAt: field('DateTime', (s) => (s.issue as Issue).closedAt),
      createdAt: field('DateTime', (s) => (s.issue as Issue).createdAt),
      updatedAt: field('DateTime', (s) => (s.issue as Issue).updatedAt),
      author: field('User', (_s, _a, ctx) => userSource(ctx.store)),
      isDraft: field('Boolean', (s) => (s.issue as Issue).draft ?? false),
      headRefName: field('String', (s) => (s.issue as Issue).headRef ?? ''),
      baseRefName: field('String', (s) => (s.issue as Issue).baseRef ?? ''),
      headRefOid: field('GitObjectID', (s) => (s.repo as Repo).refs.get(`refs/heads/${(s.issue as Issue).headRef}`) ?? (s.issue as Issue).headSha ?? ''),
      baseRefOid: field('GitObjectID', (s) => (s.repo as Repo).refs.get(`refs/heads/${(s.issue as Issue).baseRef}`) ?? (s.issue as Issue).baseSha ?? ''),
      mergeable: field('MergeableState', (s) => {
        const repo = s.repo as Repo;
        const issue = s.issue as Issue;
        if (issue.merged) return 'UNKNOWN';
        const json = pullMergeable(repo, issue);
        return json === null ? 'UNKNOWN' : json ? 'MERGEABLE' : 'CONFLICTING';
      }),
      url: field('URI', (s) => `https://github.com/${(s.repo as Repo).fullName}/pull/${(s.issue as Issue).number}`),
      resourcePath: field('URI', (s) => `/${(s.repo as Repo).fullName}/pull/${(s.issue as Issue).number}`),
      repository: field('Repository', (s) => repoSource(s.repo as Repo)),
      mergeCommit: field('Commit', (s) => {
        const sha = (s.issue as Issue).mergeCommitSha;
        return sha ? { __typename: 'Commit', oid: sha } : null;
      }),
      files: field('PullRequestChangedFileConnection', (s, args) => {
        const repo = s.repo as Repo;
        const issue = s.issue as Issue;
        const sides = pullSides(repo, issue);
        let nodes: Array<{ __typename: string; path: string }> = [];
        if (sides) {
          const ancestorTree = sides.mergeBase
            ? parseCommit(repo.objects.get(sides.mergeBase)!.data).tree
            : sides.baseTree;
          nodes = diffTrees(repo, ancestorTree, sides.headTree).map((f) => ({
            __typename: 'PullRequestChangedFile',
            path: String(f.filename),
          }));
        }
        const conn = connection(nodes, args);
        return { __typename: 'PullRequestChangedFileConnection', ...conn };
      }),
      changedFiles: field('Int', (s) => {
        const repo = s.repo as Repo;
        const sides = pullSides(repo, s.issue as Issue);
        if (!sides) return 0;
        const ancestorTree = sides.mergeBase
          ? parseCommit(repo.objects.get(sides.mergeBase)!.data).tree
          : sides.baseTree;
        return diffTrees(repo, ancestorTree, sides.headTree).length;
      }),
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: prop('String', 'path'),
      additions: field('Int', () => 0),
      deletions: field('Int', () => 0),
    },
  },
  IssueConnection: { kind: 'OBJECT', fields: connectionFields('Issue') },
  PullRequestConnection: { kind: 'OBJECT', fields: connectionFields('PullRequest') },
  IssueCommentConnection: { kind: 'OBJECT', fields: connectionFields('IssueComment') },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: connectionFields('PullRequestChangedFile') },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: prop('Boolean', 'hasNextPage'),
      hasPreviousPage: prop('Boolean', 'hasPreviousPage'),
      startCursor: prop('String', 'startCursor'),
      endCursor: prop('String', 'endCursor'),
    },
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: prop('String', 'clientMutationId'), issue: prop('Issue', 'issue') } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { clientMutationId: prop('String', 'clientMutationId'), issue: prop('Issue', 'issue') } },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: prop('String', 'clientMutationId'), pullRequest: prop('PullRequest', 'pullRequest') } },
  MergePullRequestPayload: { kind: 'OBJECT', fields: { clientMutationId: prop('String', 'clientMutationId'), pullRequest: prop('PullRequest', 'pullRequest') } },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      clientMutationId: prop('String', 'clientMutationId'),
      commentEdge: prop('IssueCommentEdge', 'commentEdge'),
      subject: prop('Node', 'subject'),
    },
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: { node: prop('IssueComment', 'node'), cursor: prop('String', 'cursor') },
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: {
      limit: prop('Int', 'limit'),
      cost: prop('Int', 'cost'),
      remaining: prop('Int', 'remaining'),
      used: prop('Int', 'used'),
      nodeCount: prop('Int', 'nodeCount'),
      resetAt: prop('DateTime', 'resetAt'),
    },
  },
  Node: { kind: 'INTERFACE', fields: { id: field('ID', () => null) } },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: prop('String', 'name'),
      kind: prop('String', 'kind'),
      description: prop('String', 'description'),
      fields: prop('[__Field]', 'fields'),
      enumValues: prop('[__EnumValue]', 'enumValues'),
      inputFields: prop('[__InputValue]', 'inputFields'),
      interfaces: prop('[__Type]', 'interfaces'),
      possibleTypes: prop('[__Type]', 'possibleTypes'),
      specifiedByURL: prop('String', 'specifiedByURL'),
      ofType: prop('__Type', 'ofType'),
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: prop('String', 'name'),
      description: prop('String', 'description'),
      args: prop('[__InputValue]', 'args'),
      type: prop('__Type', 'type'),
      isDeprecated: prop('Boolean', 'isDeprecated'),
      deprecationReason: prop('String', 'deprecationReason'),
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: prop('String', 'name'),
      description: prop('String', 'description'),
      isDeprecated: prop('Boolean', 'isDeprecated'),
      deprecationReason: prop('String', 'deprecationReason'),
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: prop('String', 'name'),
      description: prop('String', 'description'),
      type: prop('__Type', 'type'),
      defaultValue: prop('String', 'defaultValue'),
    },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      description: prop('String', 'description'),
      types: prop('[__Type]', 'types'),
      queryType: prop('__Type', 'queryType'),
      mutationType: prop('__Type', 'mutationType'),
      subscriptionType: prop('__Type', 'subscriptionType'),
      directives: prop('[__Directive]', 'directives'),
    },
  },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  RepositoryVisibility: { kind: 'ENUM', values: ['PUBLIC', 'PRIVATE', 'INTERNAL'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
};

function connectionFields(nodeType: string) {
  return {
    nodes: field(`[${nodeType}]`, (s) => s.nodes),
    totalCount: field('Int', (s) => s.totalCount),
    pageInfo: field('PageInfo', (s) => ({ __typename: 'PageInfo', ...s.pageInfo })),
  };
}

function pullMergeable(repo: Repo, issue: Issue): boolean | null {
  // reuse the REST mergeability computation through pullJson-free path
  const sides = pullSides(repo, issue);
  if (!sides) return null;
  // a dry three-way merge is computed in rest.ts via pullJson; here we
  // approximate with the same helper the REST layer exposes through
  // mergeTrees — imported lazily to avoid a cycle at module load.
  return mergeableCache(repo, issue, sides);
}

import { mergeTrees } from './rest.ts';
function mergeableCache(repo: Repo, issue: Issue, sides: NonNullable<ReturnType<typeof pullSides>>): boolean {
  const ancestorTree = sides.mergeBase
    ? parseCommit(repo.objects.get(sides.mergeBase)!.data).tree
    : null;
  return mergeTrees(repo, sides.baseTree, sides.headTree, ancestorTree) !== null;
}

function findRepoWithObject(store: Store, oid: string): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.objects.has(oid)) return repo;
  return undefined;
}

function repoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return null;
  const wanted = Number(decoded.key);
  for (const repo of store.repos.values()) if (repo.id === wanted) return repo;
  return null;
}

function issueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const key = Number(decoded.key);
  if (!Number.isFinite(key)) return null;
  const repoId = Math.floor(key / 100000);
  const number = key % 100000;
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.find((i) => i.number === number);
    if (issue) return { repo, issue };
  }
  return null;
}

function resolveNode(store: Store, id: string): unknown {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  if (decoded.type === 'Repository') {
    const repo = repoByGlobalId(store, id);
    return repo ? repoSource(repo) : null;
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const found = issueByGlobalId(store, id);
    return found ? issueSource(found.repo, found.issue) : null;
  }
  if (decoded.type === 'User') return userSource(store);
  return null;
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface ExecError {
  message: string;
}

function typeOfValue(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).__typename);
  }
  return fallback;
}

function executeSelectionSet(
  selections: SelectionNode[],
  typeName: string,
  source: any,
  ctx: Ctx,
  variables: Record<string, unknown>,
  fragments: Map<string, SelectionNode[]>,
  errors: ExecError[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(selection.selections, typeName, source, ctx, variables, fragments, errors));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const frag = fragments.get(selection.name);
      if (frag) Object.assign(out, executeSelectionSet(frag, typeName, source, ctx, variables, fragments, errors));
      continue;
    }
    const node = selection.field;
    const key = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (node.name === '__type' && typeName === 'Query') {
      const args = resolveArgs(node.args, variables);
      out[key] = typeDescription(String(args.name ?? ''));
      continue;
    }
    if (node.name === '__schema' && typeName === 'Query') {
      out[key] = schemaDescription();
      continue;
    }
    const fieldDef = typeDef?.fields?.[node.name];
    if (!fieldDef) {
      errors.push({ message: `Field '${node.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      const args = resolveArgs(node.args, variables);
      value = fieldDef.resolve(source, args, ctx);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, fieldDef.type, node, ctx, variables, fragments, errors);
  }
  return out;
}

function resolveArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, variables);
  return out;
}

function completeValue(
  value: unknown,
  type: string,
  node: FieldNode,
  ctx: Ctx,
  variables: Record<string, unknown>,
  fragments: Map<string, SelectionNode[]>,
  errors: ExecError[],
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, type, node, ctx, variables, fragments, errors));
  }
  if (typeof value === 'object') {
    const typeName = typeOfValue(value, type.replace(/[\[\]!]/g, ''));
    if (node.selections.length === 0) return value;
    return executeSelectionSet(node.selections, typeName, value, ctx, variables, fragments, errors);
  }
  return value;
}

function typeDescription(name: string): Record<string, unknown> | null {
  const def = SCHEMA[name];
  if (!def) return null;
  return {
    __typename: '__Type',
    name,
    kind: def.kind,
    description: null,
    fields: def.fields
      ? Object.entries(def.fields).map(([fieldName, f]) => ({
          __typename: '__Field',
          name: fieldName,
          description: null,
          args: [],
          type: { __typename: '__Type', name: f.type.replace(/[\[\]!]/g, ''), kind: 'OBJECT', ofType: null },
          isDeprecated: false,
          deprecationReason: null,
        }))
      : null,
    enumValues: def.values
      ? def.values.map((v) => ({ __typename: '__EnumValue', name: v, description: null, isDeprecated: false, deprecationReason: null }))
      : null,
    inputFields: null,
    interfaces: [],
    possibleTypes: null,
    specifiedByURL: null,
  };
}

function schemaDescription(): Record<string, unknown> {
  return {
    __typename: '__Schema',
    description: null,
    types: Object.keys(SCHEMA).map((name) => typeDescription(name)),
    queryType: { __typename: '__Type', name: 'Query' },
    mutationType: { __typename: '__Type', name: 'Mutation' },
    subscriptionType: null,
    directives: [],
  };
}

export async function handleGraphql(store: Store, payload: unknown): Promise<unknown> {
  if (Array.isArray(payload)) {
    const out = [];
    for (const item of payload) out.push(await handleGraphql(store, item));
    return out;
  }
  const body = (payload ?? {}) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
  if (typeof body.query !== 'string') {
    return { errors: [{ message: 'No query provided' }] };
  }
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(body.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation =
    document.operations.find((op) => op.name === body.operationName) ?? document.operations[0];
  if (!operation) return { errors: [{ message: 'No operation found' }] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const errors: ExecError[] = [];
  const data = executeSelectionSet(
    operation.selections,
    rootType,
    { __typename: rootType },
    { store },
    body.variables ?? {},
    document.fragments,
    errors,
  );
  const response: Record<string, unknown> = { data };
  if (errors.length) response.errors = errors;
  return response;
}
