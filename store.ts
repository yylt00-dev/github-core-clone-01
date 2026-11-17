// The forge's in-memory store: one viewer (the token's owner), their
// repositories, and each repository's git objects, refs, issues, labels and
// pull requests. Everything lives in Maps; nothing touches the disk, which
// keeps the trial's read-only mount and /tmp-only writes irrelevant.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref name ("refs/heads/main") -> oid
  headRef: string; // symref target of HEAD, e.g. "refs/heads/main"
  issues: Issue[];
  labels: Label[];
  nextIssueNumber: number;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  user: string;
  labels: string[]; // label names
  assignees: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  isPull: boolean;
  // pull-request-only fields (undefined for plain issues)
  headRef?: string;
  headSha?: string;
  baseRef?: string;
  baseSha?: string;
  merged?: boolean;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
  draft?: boolean;
}

export interface Viewer {
  login: string;
  id: number;
  name: string;
  email: string;
}

const nowIso = () => new Date().toISOString();

export class Store {
  // The token owner's identity in the suite's world: the scenario viewer.
  viewer: Viewer = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
  repos = new Map<string, Repo>(); // "owner/name" (lowercased owner) -> repo
  private nextRepoId = 5000;
  private nextLabelId = 9000;
  private nextCommentId = 70000;

  setViewer(login: string, name: string, email: string): void {
    this.viewer = { login, id: 1001, name, email };
  }

  createRepo(owner: string, name: string, description = '', isPrivate = false): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      fullName: `${owner}/${name}`,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      pushedAt: nowIso(),
      objects: new Map(),
      refs: new Map(),
      headRef: 'refs/heads/main',
      issues: [],
      labels: [],
      nextIssueNumber: 1,
    };
    this.repos.set(`${owner.toLowerCase()}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner.toLowerCase()}/${name}`);
  }

  newLabelId(): number {
    return this.nextLabelId++;
  }

  newCommentId(): number {
    return this.nextCommentId++;
  }
}

export { nowIso };
