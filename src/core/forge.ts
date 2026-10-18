import { parseRemote, type Env } from "./resolve.ts";

export type ChangeRequest = { remoteUrl: string; base: string; head: string; title: string; body: string };

export type ForgeAdapter = { name: "github" | "fallback"; openChangeRequest(req: ChangeRequest): Promise<{ url: string | null }> };

// Self-hosted GitLab usually lives on a gitlab.<domain> host. Matching a whole label keeps git.example.com and mygitlab.example.com out.
const isGitLabHost = (host: string): boolean => host.split(".").includes("gitlab");

// parseRemote keeps only the hostname. A self-hosted GitLab serves its web UI on the scheme and port of an HTTP(S) remote, so the link takes both from it. An ssh:// port is sshd's, so SSH remotes get plain https.
function webOrigin(remoteUrl: string, host: string): string {
  try {
    const u = new URL(remoteUrl.trim());
    if (u.protocol === "https:" || u.protocol === "http:") return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}`;
  } catch {
    // scp-form remotes aren't URLs.
  }
  return `https://${host}`;
}

// Query params go out unencoded, as the forges' own "new MR/PR" links write them, so the printed URL reads cleanly in a terminal.
export function fallbackUrl(remoteUrl: string, base: string, head: string): string | null {
  const id = parseRemote(remoteUrl);
  if (!id) return null;
  const { host, org, repo } = id;
  if (host === "github.com") return `https://github.com/${org}/${repo}/compare/${base}...${head}?expand=1`;
  if (isGitLabHost(host)) return `${webOrigin(remoteUrl, host)}/${org}/${repo}/-/merge_requests/new?merge_request[source_branch]=${head}`;
  // Azure's two remote shapes put <organization>/<project> on either side of a marker segment: .../_git/<repo> over HTTPS, v3/... over SSH.
  const segs = org.split("/");
  let azure: string[] | null = null;
  if (host === "dev.azure.com" && segs.length === 3 && segs[2] === "_git") azure = segs.slice(0, 2);
  if (host === "ssh.dev.azure.com" && segs.length === 3 && segs[0] === "v3") azure = segs.slice(1);
  if (azure) return `https://dev.azure.com/${azure[0]}/${azure[1]}/_git/${repo}/pullrequestcreate?sourceRef=${head}&targetRef=${base}`;
  return null;
}

// An insteadOf shorthand such as gh:acme/bank.git parses as host "gh", so forge choice falls back to the URL git resolved it to. The configured URL still wins when it names a forge, since a test or mirror setup can rewrite a real forge URL to a local path.
export function forgeRemote(configured: string, resolved: string): string {
  if (fallbackUrl(configured, "", "") !== null) return configured;
  return fallbackUrl(resolved, "", "") !== null ? resolved : configured;
}

export const fallbackAdapter: ForgeAdapter = {
  name: "fallback",
  async openChangeRequest(req) {
    return { url: fallbackUrl(req.remoteUrl, req.base, req.head) };
  },
};

const REPO_QUERY = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }";

const CREATE_PR = `mutation($repositoryId: ID!, $baseRefName: String!, $headRefName: String!, $title: String!, $body: String) {
  createPullRequest(input: { repositoryId: $repositoryId, baseRefName: $baseRefName, headRefName: $headRefName, title: $title, body: $body }) {
    pullRequest { url }
  }
}`;

type GraphQLReply = { data?: Record<string, unknown> | null; errors?: { message?: string }[] };

export function githubAdapter(opts: { token: string; fetch?: typeof fetch; endpoint?: string }): ForgeAdapter {
  const doFetch = opts.fetch ?? fetch;
  const endpoint = opts.endpoint ?? "https://api.github.com/graphql";

  async function post(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await doFetch(endpoint, {
      method: "POST",
      // GitHub rejects API requests that carry no User-Agent, and not every fetch sends one by default.
      headers: { Authorization: `bearer ${opts.token}`, "Content-Type": "application/json", "User-Agent": "ltm" },
      body: JSON.stringify({ query, variables }),
    });
    let reply: GraphQLReply | null = null;
    try {
      reply = (await res.json()) as GraphQLReply;
    } catch {
      // A proxy or outage page can answer with HTML; the status below still says what went wrong.
    }
    const first = reply?.errors?.[0]?.message;
    if (first) throw new Error(first);
    if (!res.ok) throw new Error(`GitHub GraphQL request failed with HTTP ${res.status}`);
    if (!reply?.data) throw new Error("GitHub GraphQL reply had no data");
    return reply.data;
  }

  return {
    name: "github",
    async openChangeRequest(req) {
      const id = parseRemote(req.remoteUrl);
      if (!id) throw new Error(`can't read a GitHub owner and repo from remote '${req.remoteUrl}'`);
      const repoData = await post(REPO_QUERY, { owner: id.org, name: id.repo });
      const repositoryId = (repoData.repository as { id?: string } | null)?.id;
      if (!repositoryId) throw new Error(`GitHub has no repository ${id.org}/${id.repo}`);
      const prData = await post(CREATE_PR, { repositoryId, baseRefName: req.base, headRefName: req.head, title: req.title, body: req.body });
      const url = (prData.createPullRequest as { pullRequest?: { url?: string } } | null)?.pullRequest?.url;
      if (!url) throw new Error("GitHub created no pull request URL");
      return { url };
    },
  };
}

// Without a token the GitHub adapter can only fail, so the fallback's compare link is the better answer there.
export function chooseAdapter(remoteUrl: string, env: Env): ForgeAdapter {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (parseRemote(remoteUrl)?.host === "github.com" && token) return githubAdapter({ token });
  return fallbackAdapter;
}
