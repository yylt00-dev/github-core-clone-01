// GitHub REST v3 surface: the API root, meta, the viewer, repositories,
// branches, commits, git refs, the contents API (which authors real git
// commits), labels, issues, comments and pull requests with merges.
// Bodies and status codes follow api.github.com's shapes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Label, Repo, Store } from './store.ts';
import { nowIso } from './store.ts';
import {
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  putObject,
  type TreeEntry,
} from './git.ts';

export interface RestResult {
  status: number;
  body: unknown; // undefined => empty body
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
export const notFound = (message = 'Not Found'): RestResult => ok(404, { message });
export const validationFailed = (message: string): RestResult => ok(422, { message });

export function userJson(store: Store) {
  const v = store.viewer;
  return {
    login: v.login,
    id: v.id,
    node_id: `U_${v.id}`,
    avatar_url: 'https://avatars.githubusercontent.com/u/1001?v=4',
    gravatar_id: '',
    url: `/api/v3/users/${v.login}`,
    html_url: `https://github.com/${v.login}`,
    type: 'User',
    site_admin: false,
    name: v.name,
    email: v.email,
  };
}

export function repoJson(store: Store, repo: Repo) {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(store),
    private: repo.isPrivate,
    html_url: `https://github.com/${repo.fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

export function labelJson(label: Label) {
  return {
    id: label.id,
    node_id: `LA_${label.id}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue) {
  const base: Record<string, unknown> = {
    id: repo.id * 100000 + issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: userJson(store),
    labels: issue.labels
      .map((name) => repo.labels.find((l) => l.name === name))
      .filter((l): l is Label => Boolean(l))
      .map(labelJson),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: issue.assignees.map((login) => ({ login, id: 0, type: 'User' })),
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    body: issue.body,
  };
  if (issue.isPull) {
    base.html_url = `https://github.com/${repo.fullName}/pull/${issue.number}`;
    base.pull_request = {
      url: `/api/v3/repos/${repo.fullName}/pulls/${issue.number}`,
      html_url: base.html_url,
      diff_url: `${base.html_url}.diff`,
      patch_url: `${base.html_url}.patch`,
    };
  }
  return base;
}

export function commentJson(store: Store, repo: Repo, issue: Issue, commentId: number) {
  const comment = issue.comments.find((c) => c.id === commentId)!;
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    body: comment.body,
    user: userJson(store),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function commitJson(store: Store, repo: Repo, oid: string) {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const authorName = commit.author.replace(/ <.*>$/, '');
  return {
    sha: oid,
    node_id: `C_${oid}`,
    url: `/api/v3/repos/${repo.fullName}/commits/${oid}`,
    html_url: `https://github.com/${repo.fullName}/commit/${oid}`,
    commit: {
      author: { name: authorName, email: store.viewer.email, date: repo.createdAt },
      committer: { name: authorName, email: store.viewer.email, date: repo.createdAt },
      message: commit.message,
      tree: { sha: commit.tree, url: `/api/v3/repos/${repo.fullName}/git/trees/${commit.tree}` },
      comment_count: 0,
    },
    author: userJson(store),
    committer: userJson(store),
    parents: commit.parents.map((sha) => ({ sha, url: `/api/v3/repos/${repo.fullName}/commits/${sha}` })),
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

export interface Page {
  perPage: number;
  page: number;
}

export function pageOf(url: URL): Page {
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

export function paginate<T>(items: T[], page: Page, baseUrl: string, path: string, query: URLSearchParams): { slice: T[]; headers: Record<string, string> } {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const links: string[] = [];
  const link = (p: number, rel: string) => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(page.perPage));
    q.set('page', String(p));
    links.push(`<${baseUrl}${path}?${q.toString()}>; rel="${rel}"`);
  };
  if (page.page < totalPages) {
    link(page.page + 1, 'next');
    link(totalPages, 'last');
  }
  if (page.page > 1) {
    link(page.page - 1, 'prev');
    link(1, 'first');
  }
  return { slice, headers: links.length ? { link: links.join(', ') } : {} };
}

// ---------------------------------------------------------------------------
// git plumbing helpers for the contents API and merges
// ---------------------------------------------------------------------------

/** Read a whole tree into a flat path -> {oid, mode} map. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    if (entry.mode === '40000') {
      for (const [k, v] of flattenTree(repo, entry.oid, `${prefix}${entry.name}/`)) out.set(k, v);
    } else {
      out.set(prefix + entry.name, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

/** Write a flat path map back into nested tree objects; returns the root oid. */
export function unflattenTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], { files: new Map(), dirs: new Map() });
      node = node.dirs.get(segments[i])!;
    }
    node.files.set(segments[segments.length - 1], file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

export function makeCommit(
  store: Store,
  repo: Repo,
  treeOid: string,
  parents: string[],
  message: string,
): string {
  const stamp = Math.floor(Date.now() / 1000);
  const ident = `${store.viewer.name} <${store.viewer.email}> ${stamp} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', message);
  return putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** The tree oid at a ref (branch name or sha); '' when the ref is unborn. */
export function treeAt(repo: Repo, refOrSha: string): { tip: string | null; tree: string | null } {
  let tip = repo.refs.get(`refs/heads/${refOrSha}`) ?? repo.refs.get(refOrSha) ?? null;
  if (!tip && /^[0-9a-f]{40}$/.test(refOrSha) && repo.objects.get(refOrSha)?.type === 'commit') tip = refOrSha;
  if (!tip) return { tip: null, tree: null };
  const obj = repo.objects.get(tip);
  if (!obj || obj.type !== 'commit') return { tip, tree: null };
  return { tip, tree: parseCommit(obj.data).tree };
}

// ---------------------------------------------------------------------------
// route handling
// ---------------------------------------------------------------------------

export interface RestContext {
  store: Store;
  method: string;
  url: URL;
  body: Record<string, unknown> | null;
  baseUrl: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export async function handleRest(ctx: RestContext, segments: string[]): Promise<RestResult | null> {
  const { store, method, url, body } = ctx;
  const p = segments; // path segments after /api/v3

  if (p.length === 0) {
    if (method !== 'GET') return null;
    return ok(200, {
      current_user_url: '/api/v3/user',
      user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues?q={query}',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  if (p[0] === 'meta' && method === 'GET') {
    return ok(200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: '3.10.0-makefun',
    });
  }

  if (p[0] === 'user' && p.length === 1 && method === 'GET') return ok(200, userJson(store));

  if (p[0] === 'user' && p[1] === 'repos') {
    if (method === 'POST') {
      const name = str(body?.name);
      if (!name) return validationFailed('Repository creation failed.');
      if (store.getRepo(store.viewer.login, name)) {
        return ok(422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
      }
      const repo = store.createRepo(
        store.viewer.login,
        name,
        str(body?.description),
        body?.private === true,
      );
      if (body?.auto_init === true) {
        const blob = putObject(repo, 'blob', Buffer.from('# ' + name + '\n', 'utf8'));
        const tree = unflattenTree(repo, new Map([['README.md', { oid: blob, mode: '100644' }]]));
        const commit = makeCommit(store, repo, tree, [], 'Initial commit');
        repo.refs.set('refs/heads/' + repo.defaultBranch, commit);
      }
      return ok(201, repoJson(store, repo));
    }
    if (method === 'GET') return listViewerRepos(ctx);
    return null;
  }

  if (p[0] === 'users' && p.length === 3 && p[2] === 'repos' && method === 'GET') {
    if (p[1] !== store.viewer.login) return notFound();
    return listViewerRepos(ctx);
  }

  if (p[0] === 'repos' && p.length >= 3) {
    const repo = store.getRepo(p[1], p[2]);
    if (!repo) return notFound();
    return handleRepo(ctx, repo, p.slice(3));
  }

  return null;
}

function listViewerRepos(ctx: RestContext): RestResult {
  const { store, url } = ctx;
  const repos = [...store.repos.values()]
    .filter((r) => r.owner === store.viewer.login)
    .sort((a, b) => a.id - b.id);
  const page = pageOf(url);
  const { slice, headers } = paginate(repos, page, ctx.baseUrl, '/api/v3/user/repos', url.searchParams);
  return ok(200, slice.map((r) => repoJson(store, r)), headers);
}

async function handleRepo(ctx: RestContext, repo: Repo, rest: string[]): Promise<RestResult | null> {
  const { store, method, url, body } = ctx;

  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(store, repo));
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body?.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) {
        repo.defaultBranch = body.default_branch;
        repo.headRef = `refs/heads/${body.default_branch}`;
      }
      if (typeof body?.name === 'string' && body.name && body.name !== repo.name) {
        store.repos.delete(`${repo.owner.toLowerCase()}/${repo.name}`);
        repo.name = body.name;
        repo.fullName = `${repo.owner}/${repo.name}`;
        store.repos.set(`${repo.owner.toLowerCase()}/${repo.name}`, repo);
      }
      repo.updatedAt = nowIso();
      return ok(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.repos.delete(`${repo.owner.toLowerCase()}/${repo.name}`);
      return ok(204, undefined);
    }
    return null;
  }

  const [head, ...tail] = rest;

  if (head === 'branches') {
    if (tail.length === 0 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, oid]) => ({
          name: name.slice('refs/heads/'.length),
          commit: { sha: oid, url: `/api/v3/repos/${repo.fullName}/commits/${oid}` },
          protected: false,
        }));
      return ok(200, branches);
    }
    if (tail.length >= 1 && method === 'GET') {
      const branch = decodeURIComponent(tail.join('/'));
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) return notFound('Branch not found');
      return ok(200, {
        name: branch,
        commit: commitJson(store, repo, oid),
        protected: false,
      });
    }
    return null;
  }

  if (head === 'commits') {
    if (tail.length === 0 && method === 'GET') {
      const shaParam = url.searchParams.get('sha') ?? repo.defaultBranch;
      const { tip } = treeAt(repo, shaParam);
      if (!tip) return ok(200, []);
      const page = pageOf(url);
      const all = walkCommits(repo, tip);
      const { slice, headers } = paginate(all, page, ctx.baseUrl, url.pathname, url.searchParams);
      return ok(200, slice.map((oid) => commitJson(store, repo, oid)), headers);
    }
    if (tail.length === 1 && method === 'GET') {
      const commit = commitJson(store, repo, tail[0]);
      return commit ? ok(200, commit) : notFound();
    }
    return null;
  }

  if (head === 'git' && tail[0] === 'refs') {
    return handleGitRefs(ctx, repo, tail.slice(1));
  }

  if (head === 'contents') {
    return handleContents(ctx, repo, tail.join('/'));
  }

  if (head === 'labels') return handleLabels(ctx, repo, tail);
  if (head === 'issues') return handleIssues(ctx, repo, tail);
  if (head === 'pulls') return handlePulls(ctx, repo, tail);

  return null;
}

/** All commits reachable from a tip, newest first (topological by time). */
export function walkCommits(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [tip];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    stack.push(...parseCommit(obj.data).parents);
  }
  return out;
}

function handleGitRefs(ctx: RestContext, repo: Repo, parts: string[]): RestResult | null {
  const { method, body } = ctx;
  if (parts.length === 0) {
    if (method === 'POST') {
      const ref = str(body?.ref);
      const sha = str(body?.sha);
      if (!ref.startsWith('refs/') || !repo.objects.get(sha)) return validationFailed('Validation Failed');
      if (repo.refs.has(ref)) return validationFailed('Reference already exists');
      repo.refs.set(ref, sha);
      return ok(201, { ref, node_id: `REF_${ref}`, url: `/api/v3/repos/${repo.fullName}/git/${ref}`, object: { sha, type: repo.objects.get(sha)!.type, url: '' } });
    }
    if (method === 'GET') {
      return ok(200, [...repo.refs.entries()].map(([ref, sha]) => ({
        ref,
        object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' },
      })));
    }
    return null;
  }
  const refName = 'refs/' + parts.map(decodeURIComponent).join('/');
  if (method === 'GET') {
    const sha = repo.refs.get(refName);
    if (!sha) return notFound();
    return ok(200, { ref: refName, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
  }
  if (method === 'DELETE') {
    if (!repo.refs.delete(refName)) return notFound();
    return ok(204, undefined);
  }
  return null;
}

// ---------------------------------------------------------------------------
// contents API
// ---------------------------------------------------------------------------

function contentEntryJson(repo: Repo, path: string, oid: string, mode: string, type: 'file' | 'dir') {
  const name = path.split('/').pop() ?? path;
  const obj = repo.objects.get(oid);
  return {
    name,
    path,
    sha: oid,
    size: type === 'file' && obj ? obj.data.length : 0,
    url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
    html_url: `https://github.com/${repo.fullName}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.fullName}/git/${type === 'file' ? 'blobs' : 'trees'}/${oid}`,
    download_url: type === 'file' ? `https://raw.githubusercontent.com/${repo.fullName}/${repo.defaultBranch}/${path}` : null,
    type,
    _links: { self: `/api/v3/repos/${repo.fullName}/contents/${path}` },
  };
}

function handleContents(ctx: RestContext, repo: Repo, rawPath: string): RestResult | null {
  const { store, method, url, body } = ctx;
  const path = decodeURIComponent(rawPath).replace(/^\/+|\/+$/g, '');
  const branch = str(body?.branch) || url.searchParams.get('ref') || repo.defaultBranch;

  if (method === 'GET') {
    const { tree } = treeAt(repo, branch);
    if (!tree) {
      // an empty repository: the root listing is empty, anything else 404
      return path === '' ? ok(200, []) : notFound();
    }
    if (path === '') {
      const entries = parseTree(repo.objects.get(tree)!.data).map((e) =>
        contentEntryJson(repo, e.name, e.oid, e.mode, e.mode === '40000' ? 'dir' : 'file'));
      return ok(200, entries);
    }
    const files = flattenTree(repo, tree);
    const file = files.get(path);
    if (file) {
      const obj = repo.objects.get(file.oid)!;
      const base64 = obj.data.toString('base64').replace(/.{60}(?=.)/g, '$&\n');
      return ok(200, {
        ...contentEntryJson(repo, path, file.oid, file.mode, 'file'),
        encoding: 'base64',
        content: base64,
      });
    }
    // directory?
    const prefix = path + '/';
    if ([...files.keys()].some((k) => k.startsWith(prefix))) {
      const direct = new Map<string, { oid: string; mode: string; dir: boolean }>();
      for (const [k, v] of files) {
        if (!k.startsWith(prefix)) continue;
        const restName = k.slice(prefix.length);
        const slash = restName.indexOf('/');
        if (slash < 0) direct.set(restName, { ...v, dir: false });
        else {
          const dirName = restName.slice(0, slash);
          if (!direct.has(dirName)) {
            // find the subtree oid by walking
            direct.set(dirName, { oid: subtreeOid(repo, tree, prefix + dirName), mode: '40000', dir: true });
          }
        }
      }
      return ok(200, [...direct.entries()].map(([name, v]) =>
        contentEntryJson(repo, prefix + name, v.oid, v.mode, v.dir ? 'dir' : 'file')));
    }
    return notFound();
  }

  if (method === 'PUT' || method === 'DELETE') {
    if (!path) return validationFailed('Validation Failed');
    const message = str(body?.message) || (method === 'PUT' ? `Create ${path}` : `Delete ${path}`);
    const { tip, tree } = treeAt(repo, branch);
    const files = tree ? flattenTree(repo, tree) : new Map<string, { oid: string; mode: string }>();
    const existing = files.get(path);
    if (method === 'PUT') {
      const contentB64 = str(body?.content).replace(/\s/g, '');
      if (!contentB64) return validationFailed('Validation Failed');
      if (existing) {
        const sha = str(body?.sha);
        if (!sha) return validationFailed('Validation Failed: "sha" wasn\'t supplied');
        if (sha !== existing.oid) return ok(409, { message: `${path} does not match ${sha}` });
      }
      const blobData = Buffer.from(contentB64, 'base64');
      const blob = putObject(repo, 'blob', blobData);
      files.set(path, { oid: blob, mode: '100644' });
      const newTree = unflattenTree(repo, files);
      const commit = makeCommit(store, repo, newTree, tip ? [tip] : [], message);
      repo.refs.set(`refs/heads/${branch}`, commit);
      repo.updatedAt = nowIso();
      repo.pushedAt = repo.updatedAt;
      return ok(existing ? 200 : 201, {
        content: {
          ...contentEntryJson(repo, path, blob, '100644', 'file'),
          encoding: 'base64',
          content: blobData.toString('base64').replace(/.{60}(?=.)/g, '$&\n'),
        },
        commit: { sha: commit, message, author: { name: store.viewer.name, email: store.viewer.email }, committer: { name: store.viewer.name, email: store.viewer.email } },
      });
    }
    // DELETE
    if (!existing) return notFound();
    const sha = str(body?.sha);
    if (!sha) return validationFailed('Validation Failed: "sha" wasn\'t supplied');
    if (sha !== existing.oid) return ok(409, { message: `${path} does not match ${sha}` });
    files.delete(path);
    const newTree = unflattenTree(repo, files);
    const commit = makeCommit(store, repo, newTree, tip ? [tip] : [], message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return ok(200, {
      content: null,
      commit: { sha: commit, message, author: { name: store.viewer.name, email: store.viewer.email }, committer: { name: store.viewer.name, email: store.viewer.email } },
    });
  }
  return null;
}

function subtreeOid(repo: Repo, rootTree: string, dirPath: string): string {
  let current = rootTree;
  for (const segment of dirPath.split('/')) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return current;
    const entry = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
    if (!entry) return current;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

function handleLabels(ctx: RestContext, repo: Repo, parts: string[]): RestResult | null {
  const { store, method, body } = ctx;
  if (parts.length === 0) {
    if (method === 'GET') return ok(200, repo.labels.map(labelJson));
    if (method === 'POST') {
      const name = str(body?.name);
      if (!name) return validationFailed('Validation Failed');
      if (repo.labels.some((l) => l.name === name)) return validationFailed('Validation Failed: label already exists');
      const label: Label = {
        id: store.newLabelId(),
        name,
        color: (str(body?.color) || 'ededed').replace(/^#/, ''),
        description: typeof body?.description === 'string' ? body.description : null,
      };
      repo.labels.push(label);
      return ok(201, labelJson(label));
    }
    return null;
  }
  const name = decodeURIComponent(parts.join('/'));
  const label = repo.labels.find((l) => l.name === name);
  if (!label) return notFound();
  if (method === 'GET') return ok(200, labelJson(label));
  if (method === 'PATCH') {
    if (typeof body?.name === 'string') label.name = body.name;
    if (typeof body?.color === 'string') label.color = body.color.replace(/^#/, '');
    if (typeof body?.description === 'string') label.description = body.description;
    return ok(200, labelJson(label));
  }
  if (method === 'DELETE') {
    repo.labels = repo.labels.filter((l) => l !== label);
    return ok(204, undefined);
  }
  return null;
}

// ---------------------------------------------------------------------------
// issues & comments
// ---------------------------------------------------------------------------

function findIssue(repo: Repo, n: number): Issue | undefined {
  return repo.issues.find((i) => i.number === n);
}

function resolveLabels(repo: Repo, names: unknown): string[] | null {
  if (!Array.isArray(names)) return [];
  const out: string[] = [];
  for (const item of names) {
    const name = typeof item === 'string' ? item : str((item as Record<string, unknown>)?.name);
    if (!repo.labels.some((l) => l.name === name)) return null;
    out.push(name);
  }
  return out;
}

export function createIssue(store: Store, repo: Repo, input: { title: string; body?: string | null; labels?: string[] }): Issue {
  const issue: Issue = {
    number: repo.nextIssueNumber++,
    title: input.title,
    body: input.body ?? null,
    state: 'open',
    user: store.viewer.login,
    labels: input.labels ?? [],
    assignees: [],
    comments: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    closedAt: null,
    isPull: false,
  };
  repo.issues.push(issue);
  return issue;
}

function handleIssues(ctx: RestContext, repo: Repo, parts: string[]): RestResult | null {
  const { store, method, url, body } = ctx;
  if (parts.length === 0) {
    if (method === 'POST') {
      const title = str(body?.title);
      if (!title) return validationFailed('Validation Failed');
      const labels = resolveLabels(repo, body?.labels);
      if (labels === null) return validationFailed('Validation Failed: label not found');
      const issue = createIssue(store, repo, {
        title,
        body: typeof body?.body === 'string' ? body.body : null,
        labels,
      });
      if (Array.isArray(body?.assignees)) {
        issue.assignees = body.assignees.filter((a): a is string => typeof a === 'string');
      }
      return ok(201, issueJson(store, repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = repo.issues.filter((i) => state === 'all' || i.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = pageOf(url);
      const { slice, headers } = paginate(list, page, ctx.baseUrl, url.pathname, url.searchParams);
      return ok(200, slice.map((i) => issueJson(store, repo, i)), headers);
    }
    return null;
  }
  const n = parseInt(parts[0], 10);
  const issue = Number.isFinite(n) ? findIssue(repo, n) : undefined;
  if (parts.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return ok(200, issueJson(store, repo, issue));
    if (method === 'PATCH') {
      if (typeof body?.title === 'string') issue.title = body.title;
      if (typeof body?.body === 'string' || body?.body === null) issue.body = body.body as string | null;
      if (body?.state === 'closed' || body?.state === 'open') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? nowIso() : null;
      }
      if (body?.labels !== undefined) {
        const labels = resolveLabels(repo, body.labels);
        if (labels === null) return validationFailed('Validation Failed: label not found');
        issue.labels = labels;
      }
      issue.updatedAt = nowIso();
      return ok(200, issueJson(store, repo, issue));
    }
    return null;
  }
  if (parts.length === 2 && parts[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'GET') {
      return ok(200, issue.comments.map((c) => commentJson(store, repo, issue, c.id)));
    }
    if (method === 'POST') {
      const text = str(body?.body);
      if (!text) return validationFailed('Validation Failed');
      const comment = {
        id: store.newCommentId(),
        body: text,
        user: store.viewer.login,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      issue.comments.push(comment);
      issue.updatedAt = nowIso();
      return ok(201, commentJson(store, repo, issue, comment.id));
    }
    return null;
  }
  if (parts.length === 2 && parts[1] === 'labels') {
    if (!issue) return notFound();
    if (method === 'POST') {
      const labels = resolveLabels(repo, body?.labels ?? body);
      if (labels === null) return validationFailed('Validation Failed: label not found');
      for (const l of labels) if (!issue.labels.includes(l)) issue.labels.push(l);
      return ok(200, issue.labels.map((name) => labelJson(repo.labels.find((l) => l.name === name)!)));
    }
    if (method === 'GET') {
      return ok(200, issue.labels.map((name) => labelJson(repo.labels.find((l) => l.name === name)!)));
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

export interface PullSides {
  headTip: string;
  baseTip: string;
  headTree: string;
  baseTree: string;
  mergeBase: string | null;
}

/** The merge base of two commits: a common ancestor, deepest first found. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): string[] => walkCommits(repo, tip);
  const bSet = new Set(ancestorsOf(b));
  for (const candidate of ancestorsOf(a)) {
    if (bSet.has(candidate)) return candidate;
  }
  return null;
}

export function pullSides(repo: Repo, issue: Issue): PullSides | null {
  const headTip = repo.refs.get(`refs/heads/${issue.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${issue.baseRef}`);
  if (!headTip || !baseTip) return null;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  return { headTip, baseTip, headTree, baseTree, mergeBase: mergeBase(repo, headTip, baseTip) };
}

/** Three-way tree merge; returns the merged tree oid or null on conflict. */
export function mergeTrees(repo: Repo, baseTree: string, headTree: string, ancestorTree: string | null): string | null {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const ancestor = ancestorTree ? flattenTree(repo, ancestorTree) : new Map<string, { oid: string; mode: string }>();
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...head.keys(), ...ancestor.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    const a = ancestor.get(path);
    if (h?.oid === b?.oid) {
      if (b) merged.set(path, b);
    } else if (a?.oid === b?.oid) {
      if (h) merged.set(path, h);
    } else if (a?.oid === h?.oid) {
      if (b) merged.set(path, b);
    } else if (!a && b && h) {
      return null; // added differently on both sides
    } else if (!a) {
      if (h) merged.set(path, h);
      else if (b) merged.set(path, b);
    } else {
      return null; // changed differently on both sides, or delete vs modify
    }
  }
  return unflattenTree(repo, merged);
}

export function pullJson(store: Store, repo: Repo, issue: Issue) {
  const base = issueJson(store, repo, issue) as Record<string, unknown>;
  const sides = pullSides(repo, issue);
  const headTip = repo.refs.get(`refs/heads/${issue.headRef}`) ?? issue.headSha ?? '';
  const baseTip = repo.refs.get(`refs/heads/${issue.baseRef}`) ?? issue.baseSha ?? '';
  let mergeable: boolean | null = null;
  if (sides && !issue.merged) {
    const ancestorTree = sides.mergeBase
      ? parseCommit(repo.objects.get(sides.mergeBase)!.data).tree
      : null;
    mergeable = mergeTrees(repo, sides.baseTree, sides.headTree, ancestorTree) !== null;
  }
  return {
    ...base,
    state: issue.state,
    draft: issue.draft ?? false,
    merged: issue.merged ?? false,
    merged_at: issue.mergedAt ?? null,
    merge_commit_sha: issue.mergeCommitSha ?? null,
    mergeable,
    mergeable_state: issue.merged ? 'clean' : mergeable === null ? 'unknown' : mergeable ? 'clean' : 'dirty',
    head: {
      label: `${repo.owner}:${issue.headRef}`,
      ref: issue.headRef,
      sha: headTip,
      user: userJson(store),
      repo: repoJson(store, repo),
    },
    base: {
      label: `${repo.owner}:${issue.baseRef}`,
      ref: issue.baseRef,
      sha: baseTip,
      user: userJson(store),
      repo: repoJson(store, repo),
    },
    merged_by: issue.merged ? userJson(store) : null,
    comments: issue.comments.length,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

/** The file-level diff between two trees, GitHub's pull-files shape. */
export function diffTrees(repo: Repo, baseTree: string, headTree: string) {
  const base = flattenTree(repo, baseTree);
  const head = flattenTree(repo, headTree);
  const files: Array<Record<string, unknown>> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b?.oid === h?.oid) continue;
    const status = !b ? 'added' : !h ? 'removed' : 'modified';
    const headData = h ? repo.objects.get(h.oid)?.data : undefined;
    const baseData = b ? repo.objects.get(b.oid)?.data : undefined;
    const { additions, deletions } = lineDiff(baseData, headData);
    files.push({
      sha: h?.oid ?? b?.oid ?? '',
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
      raw_url: '',
      contents_url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
    });
  }
  return files;
}

function toLines(data: Buffer | undefined): string[] {
  if (!data) return [];
  const text = data.toString('utf8');
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff counts via LCS (exact for the sizes the suite uses). */
function lineDiff(baseData: Buffer | undefined, headData: Buffer | undefined): { additions: number; deletions: number } {
  const a = toLines(baseData);
  const b = toLines(headData);
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

function handlePulls(ctx: RestContext, repo: Repo, parts: string[]): RestResult | null {
  const { store, method, url, body } = ctx;
  if (parts.length === 0) {
    if (method === 'POST') {
      const title = str(body?.title);
      const headRaw = str(body?.head);
      const baseRef = str(body?.base) || repo.defaultBranch;
      const headRef = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
      if (!title || !headRef) return validationFailed('Validation Failed');
      const headTip = repo.refs.get(`refs/heads/${headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headTip) return validationFailed(`Validation Failed: head branch ${headRef} does not exist`);
      if (!baseTip) return validationFailed(`Validation Failed: base branch ${baseRef} does not exist`);
      const issue = createIssue(store, repo, {
        title,
        body: typeof body?.body === 'string' ? body.body : null,
      });
      issue.isPull = true;
      issue.headRef = headRef;
      issue.headSha = headTip;
      issue.baseRef = baseRef;
      issue.baseSha = baseTip;
      issue.merged = false;
      issue.mergedAt = null;
      issue.mergeCommitSha = null;
      issue.draft = body?.draft === true;
      return ok(201, pullJson(store, repo, issue));
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = repo.issues.filter((i) => i.isPull);
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      const direction = url.searchParams.get('direction') ?? 'desc';
      list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const page = pageOf(url);
      const { slice, headers } = paginate(list, page, ctx.baseUrl, url.pathname, url.searchParams);
      return ok(200, slice.map((i) => pullJson(store, repo, i)), headers);
    }
    return null;
  }
  const n = parseInt(parts[0], 10);
  const issue = Number.isFinite(n) ? findIssue(repo, n) : undefined;
  if (!issue || !issue.isPull) {
    if (parts[1] === 'merge' && method === 'PUT') return notFound();
    if (method === 'GET' || method === 'PUT') return notFound();
    return null;
  }
  if (parts.length === 1) {
    if (method === 'GET') return ok(200, pullJson(store, repo, issue));
    if (method === 'PATCH') {
      if (typeof body?.title === 'string') issue.title = body.title;
      if (typeof body?.body === 'string' || body?.body === null) issue.body = body.body as string | null;
      if (body?.state === 'closed' || body?.state === 'open') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? nowIso() : null;
      }
      if (typeof body?.base === 'string') issue.baseRef = body.base;
      issue.updatedAt = nowIso();
      return ok(200, pullJson(store, repo, issue));
    }
    return null;
  }
  if (parts.length === 2 && parts[1] === 'files' && method === 'GET') {
    const sides = pullSides(repo, issue);
    if (!sides) return ok(200, []);
    const ancestorTree = sides.mergeBase
      ? parseCommit(repo.objects.get(sides.mergeBase)!.data).tree
      : sides.baseTree;
    const files = diffTrees(repo, ancestorTree, sides.headTree);
    const page = pageOf(url);
    const { slice, headers } = paginate(files, page, ctx.baseUrl, url.pathname, url.searchParams);
    return ok(200, slice, headers);
  }
  if (parts.length === 2 && parts[1] === 'merge' && method === 'PUT') {
    return mergePull(store, repo, issue, body);
  }
  return null;
}

/** Merge a pull request (squash or merge); shared by REST and MCP. */
export function mergePull(
  store: Store,
  repo: Repo,
  issue: Issue,
  input: { merge_method?: unknown; commit_title?: unknown; commit_message?: unknown } | null,
): RestResult {
  if (issue.merged) return ok(405, { message: 'Pull Request is already merged', documentation_url: '' });
  if (issue.state !== 'open') return ok(405, { message: 'Pull Request is not mergeable', documentation_url: '' });
  const sides = pullSides(repo, issue);
  if (!sides) return ok(405, { message: 'Pull Request is not mergeable', documentation_url: '' });
  const ancestorTree = sides.mergeBase
    ? parseCommit(repo.objects.get(sides.mergeBase)!.data).tree
    : null;
  const mergedTree = mergeTrees(repo, sides.baseTree, sides.headTree, ancestorTree);
  if (mergedTree === null) {
    return ok(405, { message: 'Pull Request is not mergeable', documentation_url: '' });
  }
  const method = str(input?.merge_method) || 'merge';
  const title = str(input?.commit_title) || (method === 'squash' ? `${issue.title} (#${issue.number})` : `Merge pull request #${issue.number} from ${repo.owner}:${issue.headRef}`);
  const message = str(input?.commit_message) ? `${title}\n\n${str(input?.commit_message)}` : title;
  const parents = method === 'squash' || method === 'rebase'
    ? [sides.baseTip]
    : [sides.baseTip, sides.headTip];
  const commit = makeCommit(store, repo, mergedTree, parents, message);
  repo.refs.set(`refs/heads/${issue.baseRef}`, commit);
  issue.merged = true;
  issue.state = 'closed';
  issue.closedAt = nowIso();
  issue.mergedAt = issue.closedAt;
  issue.mergeCommitSha = commit;
  issue.updatedAt = issue.closedAt;
  repo.updatedAt = issue.closedAt;
  return ok(200, { sha: commit, merged: true, message: 'Pull Request successfully merged' });
}

export { hashObject };
