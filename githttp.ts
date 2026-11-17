// Smart-HTTP handlers: info/refs advertisements (v0 and v2), upload-pack
// (v0 fetch and v2 ls-refs/fetch) and receive-pack pushes. The wire shapes
// follow the git protocol as the conformance client speaks it: pkt-line
// framing everywhere, side-band-64k around pack data and push reports.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import {
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  decodePackets,
  fetchSet,
  hashObject,
  parseCommit,
  parseTag,
  pkt,
  readPack,
  refCommit,
  sideband,
  writePack,
} from './git.ts';

const AGENT = 'agent=makefun-forge/1.0';
export const UPLOAD_CAPS =
  `side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not ${AGENT}`;
export const RECEIVE_CAPS =
  `report-status report-status-v2 delete-refs side-band-64k ofs-delta ${AGENT}`;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  send(res, 404, 'application/json; charset=utf-8', Buffer.from('{"message":"Not Found"}\n'));
}

/** Refs in advertisement order: branches and tags sorted by name. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The oid HEAD advertises: its target's tip, or ZERO when unborn. */
function headOid(repo: Repo): string {
  return repo.refs.get(repo.headRef) ?? ZERO_OID;
}

/** Peel an oid through tag objects to a commit; returns the peeled oid. */
function peeled(repo: Repo, oid: string): string | null {
  const commit = refCommit(repo, oid);
  return commit !== null && commit !== oid ? commit : null;
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const firstCaps = `${caps} symref=HEAD:${repo.headRef}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${firstCaps}\n`));
  } else {
    parts.push(pkt(`${headOid(repo)} HEAD\0${firstCaps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pkt(`${oid} ${name}\n`));
      const peel = peeled(repo, oid);
      if (peel) parts.push(pkt(`${peel} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(service: string): Buffer {
  const lines = [
    'version 2\n',
    `${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'server-option\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([pkt(`# service=${service}\n`), PKT_FLUSH, ...lines.map((l) => pkt(l)), PKT_FLUSH]);
}

export async function infoRefs(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  service: string,
): Promise<void> {
  const repo = store.getRepo(owner, name);
  if (!repo || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    notFound(res);
    return;
  }
  const protocol = req.headers['git-protocol'] ?? '';
  const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
  const body =
    wantsV2 && service === 'git-upload-pack' ? v2Advertisement(service) : v0Advertisement(repo, service);
  send(res, 200, `application/x-${service}-advertisement`, body);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function computeFetch(repo: Repo, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[]; common: string[] } {
  const common = args.haves.filter((h) => repo.objects.has(h));
  const result = fetchSet(repo, args.wants, args.haves, args.depth, args.shallow);
  const objects = result.objects
    .map((oid) => repo.objects.get(oid)!)
    .filter(Boolean)
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return { pack: writePack(objects), shallow: result.shallow, unshallow: result.unshallow, common };
}

function handleLsRefs(repo: Repo, argLines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of argLines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  if (matches('HEAD') && (head !== ZERO_OID || unborn)) {
    let line = `${head} HEAD`;
    if (symrefs) line += ` symref-target:${repo.headRef}`;
    parts.push(pkt(`${line}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const peelOid = peeled(repo, oid);
      if (peelOid) line += ` peeled:${peelOid}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, argLines: string[]): Buffer {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of argLines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7), 10);
  }
  const { pack, shallow, unshallow, common } = computeFetch(repo, args);
  const parts: Buffer[] = [pkt('acknowledgments\n')];
  if (common.length) {
    for (const oid of common) parts.push(pkt(`ACK ${oid}\n`));
    parts.push(pkt('ready\n'));
  } else {
    parts.push(pkt('NAK\n'));
  }
  parts.push(Buffer.from('0001', 'ascii'));
  if (args.depth !== null || args.shallow.length || shallow.length || unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(pkt('packfile\n'));
  parts.push(sideband(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, packets: Array<{ kind: string; payload?: Buffer }>): Buffer {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload!.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7), 10);
  }
  const { pack, shallow, unshallow, common } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  if (common.length) parts.push(pkt(`ACK ${common[common.length - 1]}\n`));
  else parts.push(pkt('NAK\n'));
  parts.push(sideband(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export async function uploadPack(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
): Promise<void> {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    notFound(res);
    return;
  }
  const body = await readBody(req);
  const { packets } = decodePackets(body);
  const lines = packets
    .filter((p) => p.kind === 'data')
    .map((p) => (p as { payload: Buffer }).payload.toString('utf8').replace(/\n$/, ''));
  const protocol = req.headers['git-protocol'] ?? '';
  const isV2 = typeof protocol === 'string' && protocol.includes('version=2');
  if (isV2) {
    const commandLine = lines.find((l) => l.startsWith('command='));
    const command = commandLine?.slice('command='.length);
    const delimIndex = packets.findIndex((p) => p.kind === 'delim');
    const argLines = delimIndex >= 0
      ? packets
          .slice(delimIndex + 1)
          .filter((p) => p.kind === 'data')
          .map((p) => (p as { payload: Buffer }).payload.toString('utf8').replace(/\n$/, ''))
      : [];
    if (command === 'ls-refs') {
      send(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, argLines));
      return;
    }
    if (command === 'fetch') {
      send(res, 200, 'application/x-git-upload-pack-result', handleFetchV2(repo, argLines));
      return;
    }
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown command\n'));
    return;
  }
  if (!lines.some((l) => l.startsWith('want '))) {
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('expected want lines\n'));
    return;
  }
  send(res, 200, 'application/x-git-upload-pack-result', handleFetchV0(repo, packets as Array<{ kind: string; payload?: Buffer }>));
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

export async function receivePack(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
): Promise<void> {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    notFound(res);
    return;
  }
  const body = await readBody(req);
  const { packets, rest } = decodePackets(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  if (!commands.length) {
    send(res, 400, 'text/plain; charset=utf-8', Buffer.from('no ref commands\n'));
    return;
  }

  let unpackOk = true;
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
    }
  }

  const report: string[] = [`unpack ${unpackOk ? 'ok' : 'error'}\n`];
  for (const command of commands) {
    const fail = (reason: string) => report.push(`ng ${command.ref} ${reason}\n`);
    const ok = () => report.push(`ok ${command.ref}\n`);
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === undefined) fail('reference does not exist');
      else if (current !== command.oldOid) fail('stale info');
      else if (command.ref === repo.headRef) fail('deletion of the current branch prohibited');
      else {
        repo.refs.delete(command.ref);
        ok();
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        fail('reference already exists');
        continue;
      }
    } else {
      if (current === undefined) {
        fail('reference does not exist');
        continue;
      }
      if (current !== command.oldOid) {
        fail('stale info');
        continue;
      }
    }
    const newObj = repo.objects.get(command.newOid);
    if (!newObj) {
      fail('missing object');
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && newObj.type !== 'commit') {
      fail('not a commit');
      continue;
    }
    if (
      command.oldOid !== ZERO_OID &&
      command.ref.startsWith('refs/heads/') &&
      !isAncestor(repo, command.oldOid, command.newOid)
    ) {
      fail('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    if (command.ref === repo.headRef || command.ref === 'refs/heads/' + repo.defaultBranch) {
      repo.pushedAt = new Date().toISOString();
      repo.updatedAt = repo.pushedAt;
    }
    ok();
  }

  const reportStream = Buffer.concat([...report.map((l) => pkt(l)), PKT_FLUSH]);
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const out = useSideband
    ? Buffer.concat([sideband(reportStream.subarray(0, reportStream.length - 4)), PKT_FLUSH])
    : reportStream;
  send(res, 200, 'application/x-git-receive-pack-result', out);
}
