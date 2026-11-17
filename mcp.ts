// Model Context Protocol over streamable HTTP (POST /mcp): JSON-RPC 2.0,
// no session state. Supports the modern server/discover probe and the
// legacy initialize handshake, tools/list and tools/call for the forge's
// six core tools, which act on the same store the REST surface serves —
// an object made over MCP is the same object over REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { createIssue, issueJson, mergePull, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'makefun-forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body (Markdown).' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
      body: { type: 'string', description: 'The pull request body (Markdown).' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolsList() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
    },
  }));
}

type SendJson = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });

function toolText(value: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    isError,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { __rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolText(`Missing required argument: ${required}`, true);
    }
  }
  const owner = String(args.owner ?? store.viewer.login);
  const repoName = String(args.repo ?? '');
  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(args.name);
      if (store.getRepo(store.viewer.login, repoNameArg)) {
        return toolText(`Repository ${repoNameArg} already exists`, true);
      }
      const repo = store.createRepo(
        store.viewer.login,
        repoNameArg,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolText(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolText(`Repository ${owner}/${repoName} not found`, true);
      return toolText(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolText(`Repository ${owner}/${repoName} not found`, true);
      const issue = createIssue(store, repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
      });
      return toolText(issueJson(store, repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolText(`Repository ${owner}/${repoName} not found`, true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter(
        (i) => !i.isPull && (state === 'all' || i.state === state),
      );
      return toolText(list.map((i) => issueJson(store, repo, i)));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolText(`Repository ${owner}/${repoName} not found`, true);
      const headRef = String(args.head).includes(':') ? String(args.head).split(':').pop()! : String(args.head);
      const baseRef = String(args.base);
      const headTip = repo.refs.get(`refs/heads/${headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headTip) return toolText(`Head branch ${headRef} does not exist`, true);
      if (!baseTip) return toolText(`Base branch ${baseRef} does not exist`, true);
      const issue = createIssue(store, repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : null,
      });
      issue.isPull = true;
      issue.headRef = headRef;
      issue.headSha = headTip;
      issue.baseRef = baseRef;
      issue.baseSha = baseTip;
      issue.merged = false;
      issue.mergedAt = null;
      issue.mergeCommitSha = null;
      return toolText(pullJson(store, repo, issue));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolText(`Repository ${owner}/${repoName} not found`, true);
      const issue = repo.issues.find((i) => i.number === Number(args.pull_number) && i.isPull);
      if (!issue) return toolText(`Pull request ${args.pull_number} not found`, true);
      const result = mergePull(store, repo, issue, { merge_method: 'merge' });
      if (result.status !== 200) {
        return toolText((result.body as { message?: string })?.message ?? 'Merge failed', true);
      }
      return toolText(pullJson(store, repo, issue));
    }
  }
  return toolText('unreachable', true);
}

async function dispatch(store: Store, message: Record<string, unknown>): Promise<unknown | null> {
  const method = String(message.method ?? '');
  const id = message.id;
  const params = (message.params ?? {}) as Record<string, unknown>;
  if (method.startsWith('notifications/')) return null; // no reply
  switch (method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'server/discover':
      return rpcResult(id, {
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        supportedVersions: SUPPORTED_VERSIONS,
      });
    case 'tools/list':
      return rpcResult(id, { tools: toolsList() });
    case 'tools/call': {
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const out = callTool(store, name, args) as Record<string, unknown>;
      if (out && '__rpcError' in out) {
        const err = out.__rpcError as { code: number; message: string };
        return rpcError(id, err.code, err.message);
      }
      return rpcResult(id, out);
    }
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  isAuthorized: boolean,
  sendJson: SendJson,
): Promise<void> {
  if (req.method === 'GET' || req.method === 'DELETE') {
    // No server-initiated stream is offered; the spec's answer is 405.
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Method Not Allowed' }, id: null }));
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(rpcError(null, -32700, 'Parse error')));
    return;
  }
  if (!isAuthorized) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  if (Array.isArray(parsed)) {
    const out = [];
    for (const item of parsed) {
      const reply = await dispatch(store, item as Record<string, unknown>);
      if (reply !== null) out.push(reply);
    }
    sendJson(res, 200, out);
    return;
  }
  const reply = await dispatch(store, parsed as Record<string, unknown>);
  if (reply === null) {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    res.end('');
    return;
  }
  const headers: Record<string, string> = {};
  if ((parsed as Record<string, unknown>).method === 'initialize') {
    headers['mcp-session-id'] = 'makefun-forge-session';
  }
  sendJson(res, 200, reply, headers);
}
