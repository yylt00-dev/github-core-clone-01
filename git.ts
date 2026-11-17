// Git object model, packfiles and the smart-HTTP protocol (v0 and v2),
// implemented from the protocol itself on node:crypto and node:zlib.
// Objects live in the repo's in-memory Map (see store.ts); a pack is just a
// transport encoding of the same objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------
// object parsing
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  const out = { object: '', type: '', tag: '' };
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return out;
}

/** Follow tag objects to the commit they ultimately name (or null). */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops++) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    current = parseTag(obj.data).object;
  }
  return null;
}

/** The commit a ref ultimately points at, through tags; null when unborn/odd. */
export function refCommit(repo: Repo, oid: string): string | null {
  return peelToCommit(repo, oid);
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

/** Every object reachable from `tips` (commits walk parents, trees recurse). */
export function collectReachable(repo: Repo, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/**
 * Objects to send for a fetch: reachable from wants, minus everything
 * reachable from haves. When `depth` is set, the walk stops `depth`
 * generations of commits from the tips and the boundary commits are
 * reported as shallow. `clientShallow` lists boundary commits the client
 * already holds shallow (they count as generation 0 for deepen).
 */
export function fetchSet(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  clientShallow: string[],
): { objects: string[]; shallow: string[]; unshallow: string[] } {
  // A have the client holds shallow counts with its tree and blobs but
  // WITHOUT its parents: the client does not have that history, which is
  // the whole point of the deepen exchange.
  const shallowHaves = new Set(clientShallow);
  const haveClosure = new Set<string>();
  {
    const stack = haves.filter((h) => repo.objects.has(h));
    while (stack.length) {
      const oid = stack.pop()!;
      if (haveClosure.has(oid) || oid === ZERO_OID) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      haveClosure.add(oid);
      if (obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        stack.push(commit.tree);
        if (!shallowHaves.has(oid)) stack.push(...commit.parents);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  }
  const shallowSet = new Set<string>();
  const unshallow: string[] = [];
  const send = new Set<string>();

  // Commit generations from the tips, honouring the depth budget.
  const generation = new Map<string, number>();
  let frontier = wants
    .map((w) => peelToCommit(repo, w))
    .filter((c): c is string => c !== null);
  for (const boundary of clientShallow) {
    if (repo.objects.has(boundary)) generation.set(boundary, 0);
  }
  let gen = 0;
  const commitsInRange = new Set<string>();
  while (frontier.length) {
    const next: string[] = [];
    for (const oid of frontier) {
      if (commitsInRange.has(oid)) continue;
      commitsInRange.add(oid);
      generation.set(oid, gen);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const atBoundary = depth !== null && gen + 1 >= depth;
      for (const parent of parents) {
        if (atBoundary) {
          if (repo.objects.has(parent)) shallowSet.add(oid);
        } else if (!commitsInRange.has(parent)) {
          next.push(parent);
        }
      }
      if (depth !== null && parents.length === 0) {
        // a root commit inside the depth budget is a natural boundary only
        // when the client asked for a depth that cuts history; a full
        // history root is not shallow.
      }
    }
    frontier = next;
    gen += 1;
    if (depth !== null && gen >= depth) break;
  }

  // When deepening, commits the client already holds as shallow that now
  // fall inside the new depth stop being shallow.
  for (const boundary of clientShallow) {
    if (commitsInRange.has(boundary) && !shallowSet.has(boundary)) {
      const obj = repo.objects.get(boundary);
      if (obj && obj.type === 'commit') {
        const parents = parseCommit(obj.data).parents;
        const g = generation.get(boundary) ?? 0;
        const cut = depth !== null && g + 1 >= depth && parents.length > 0;
        if (!cut) unshallow.push(boundary);
      }
    }
  }

  // Gather: wanted tips themselves (incl. tags/blobs), the commits in
  // range, and their trees/blobs — minus the have closure.
  const seeds: string[] = [];
  for (const want of wants) if (repo.objects.has(want)) seeds.push(want);
  for (const oid of commitsInRange) seeds.push(oid);
  const walked = collectFromSeeds(repo, seeds, haveClosure, commitsInRange, depth !== null);
  for (const oid of walked) send.add(oid);

  return { objects: [...send], shallow: [...shallowSet], unshallow };
}

/**
 * Reachability restricted to a commit set: trees/blobs of the listed
 * commits, tags followed, parents only followed while in the set.
 */
function collectFromSeeds(
  repo: Repo,
  seeds: string[],
  exclude: Set<string>,
  commitSet: Set<string>,
  shallowMode: boolean,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...seeds];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid) || exclude.has(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit' && shallowMode && !commitSet.has(oid)) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) {
        if (!shallowMode || commitSet.has(parent)) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let cpOffset = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) cpOffset |= delta[offset++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) cpSize |= delta[offset++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOffset, cpOffset + cpSize));
      produced += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || produced !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

interface PackEntry {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

/** Read a whole pack, resolving deltas; `external` supplies thin-pack bases. */
export function readPack(
  pack: Buffer,
  external: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const raw: Array<{ type: GitObjectType | 'ofs' | 'ref'; data: Buffer; baseOffset?: number; baseOid?: string; entryOffset: number }> = [];
  const byOffset = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const typeId = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeId === 6) {
      byte = pack[offset++];
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++];
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (typeId === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const data = inflated.buffer;
    if (data.length !== size) throw new Error('pack entry size mismatch');
    offset += inflated.engine.bytesWritten;
    byOffset.set(entryOffset, raw.length);
    if (typeId === 6) raw.push({ type: 'ofs', data, baseOffset, entryOffset });
    else if (typeId === 7) raw.push({ type: 'ref', data, baseOid, entryOffset });
    else raw.push({ type: ID_TYPES[typeId], data, entryOffset });
  }
  const resolved = new Map<string, GitObject>();
  const resolveIndex = (index: number): PackEntry => {
    const entry = raw[index];
    if (entry.type === 'ofs' || entry.type === 'ref') {
      let base: GitObject;
      if (entry.type === 'ofs') {
        const baseIndex = byOffset.get(entry.baseOffset!);
        if (baseIndex === undefined) throw new Error('ofs-delta base outside pack');
        const resolvedBase = resolveIndex(baseIndex);
        base = { type: resolvedBase.type, data: resolvedBase.data };
      } else {
        const found = resolved.get(entry.baseOid!) ?? external(entry.baseOid!);
        if (!found) throw new Error(`ref-delta base ${entry.baseOid} not available`);
        base = found;
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data, oid: hashObject(base.type, data) };
    }
    return { type: entry.type, data: entry.data, oid: hashObject(entry.type, entry.data) };
  };
  for (let i = 0; i < raw.length; i++) {
    const entry = resolveIndex(i);
    resolved.set(entry.oid, { type: entry.type, data: entry.data });
  }
  return resolved;
}

/** Write a pack of full objects (no deltas): small, valid, checksummed. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    let size = obj.data.length;
    const typeId = TYPE_IDS[obj.type];
    const bytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    bytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode every complete packet in a request body; trailing bytes are returned too. */
export function decodePackets(body: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length >= 4 && offset + length <= body.length) {
      packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
      offset += length;
    } else {
      break;
    }
  }
  return { packets, rest: body.subarray(offset) };
}

/** Sideband-wrap a byte stream into pkt-lines (band 1 = data). */
export function sideband(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65516 - 1;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    parts.push(pkt(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (data.length === 0) parts.push(pkt(Buffer.from([band])));
  return Buffer.concat(parts);
}
