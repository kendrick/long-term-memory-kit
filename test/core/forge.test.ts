import { describe, expect, test } from "bun:test";
import { chooseAdapter, fallbackAdapter, fallbackUrl, forgeRemote, githubAdapter, type ChangeRequest } from "../../src/core/forge.ts";

const head = "ltm/propose/abc";

describe("fallbackUrl", () => {
  test.each([
    [
      "https://gitlab.example.com/acme/bank.git",
      "https://gitlab.example.com/acme/bank/-/merge_requests/new?merge_request[source_branch]=ltm/propose/abc",
    ],
    ["git@gitlab.com:acme/bank.git", "https://gitlab.com/acme/bank/-/merge_requests/new?merge_request[source_branch]=ltm/propose/abc"],
    [
      "https://gitlab.example.com:8443/acme/bank.git",
      "https://gitlab.example.com:8443/acme/bank/-/merge_requests/new?merge_request[source_branch]=ltm/propose/abc",
    ],
    [
      "http://gitlab.example.com:8080/acme/bank.git",
      "http://gitlab.example.com:8080/acme/bank/-/merge_requests/new?merge_request[source_branch]=ltm/propose/abc",
    ],
    // An SSH port belongs to sshd, not to the web UI.
    [
      "ssh://git@gitlab.example.com:2222/acme/bank.git",
      "https://gitlab.example.com/acme/bank/-/merge_requests/new?merge_request[source_branch]=ltm/propose/abc",
    ],
    [
      "https://gitlab.com/acme/platform/bank.git",
      "https://gitlab.com/acme/platform/bank/-/merge_requests/new?merge_request[source_branch]=ltm/propose/abc",
    ],
    ["git@github.com:acme/bank.git", "https://github.com/acme/bank/compare/main...ltm/propose/abc?expand=1"],
    ["https://github.com/acme/bank", "https://github.com/acme/bank/compare/main...ltm/propose/abc?expand=1"],
    [
      "https://dev.azure.com/acme/platform/_git/bank",
      "https://dev.azure.com/acme/platform/_git/bank/pullrequestcreate?sourceRef=ltm/propose/abc&targetRef=main",
    ],
    [
      "https://acme@dev.azure.com/acme/platform/_git/bank",
      "https://dev.azure.com/acme/platform/_git/bank/pullrequestcreate?sourceRef=ltm/propose/abc&targetRef=main",
    ],
    [
      "git@ssh.dev.azure.com:v3/acme/platform/bank",
      "https://dev.azure.com/acme/platform/_git/bank/pullrequestcreate?sourceRef=ltm/propose/abc&targetRef=main",
    ],
  ])("%s", (remote, want) => {
    expect(fallbackUrl(remote, "main", head)).toBe(want);
  });

  // The GitLab rule matches a whole dot-separated label, so a host that merely starts with "git" isn't GitLab.
  test.each([
    "https://git.example.com/acme/bank.git",
    "https://mygitlab.example.com/acme/bank.git",
    "https://bitbucket.org/acme/bank.git",
    "https://dev.azure.com/acme/bank",
    "git@ssh.dev.azure.com:acme/platform/bank",
    "/srv/git/bank.git",
    "not a url",
  ])("%s gives null", (remote) => {
    expect(fallbackUrl(remote, "main", head)).toBeNull();
  });
});

describe("fallbackAdapter", () => {
  test("returns the fallback URL for the request", async () => {
    const req: ChangeRequest = { remoteUrl: "https://gitlab.example.com/acme/bank.git", base: "main", head, title: "t", body: "b" };
    expect(fallbackAdapter.name).toBe("fallback");
    expect(await fallbackAdapter.openChangeRequest(req)).toEqual({
      url: "https://gitlab.example.com/acme/bank/-/merge_requests/new?merge_request[source_branch]=ltm/propose/abc",
    });
  });

  test("returns null for an unknown host", async () => {
    const req: ChangeRequest = { remoteUrl: "https://git.example.com/acme/bank.git", base: "main", head, title: "t", body: "b" };
    expect(await fallbackAdapter.openChangeRequest(req)).toEqual({ url: null });
  });
});

describe("chooseAdapter", () => {
  const gh = "git@github.com:acme/bank.git";

  test("github.com with GH_TOKEN gets the GitHub adapter", () => {
    expect(chooseAdapter(gh, { GH_TOKEN: "t" }).name).toBe("github");
  });

  test("github.com with GITHUB_TOKEN gets the GitHub adapter", () => {
    expect(chooseAdapter("https://github.com/acme/bank.git", { GITHUB_TOKEN: "t" }).name).toBe("github");
  });

  // Each of the next two drops one half of the rule from the passing case above.
  test("github.com with no token falls back", () => {
    expect(chooseAdapter(gh, {}).name).toBe("fallback");
    expect(chooseAdapter(gh, { GH_TOKEN: "", GITHUB_TOKEN: "" }).name).toBe("fallback");
  });

  test("a token on a non-GitHub host falls back", () => {
    expect(chooseAdapter("https://gitlab.example.com/acme/bank.git", { GH_TOKEN: "t", GITHUB_TOKEN: "t" }).name).toBe("fallback");
    expect(chooseAdapter("https://github.example.com/acme/bank.git", { GH_TOKEN: "t" }).name).toBe("fallback");
  });
});

describe("forgeRemote", () => {
  const resolved = "https://github.com/acme/bank.git";

  test("an insteadOf shorthand gives way to the URL git resolved it to", () => {
    expect(forgeRemote("gh:acme/bank.git", resolved)).toBe(resolved);
    expect(chooseAdapter(forgeRemote("gh:acme/bank.git", resolved), { GH_TOKEN: "t" }).name).toBe("github");
  });

  // Each of the next two drops one half of the rule from the passing case above.
  test("a configured forge URL wins even when git rewrites it elsewhere", () => {
    const gitlab = "https://gitlab.example.com/acme/bank.git";
    expect(forgeRemote(gitlab, "/srv/git/bank.git")).toBe(gitlab);
  });

  test("when neither URL names a forge, the configured one stays", () => {
    expect(forgeRemote("gh:acme/bank.git", "/srv/git/bank.git")).toBe("gh:acme/bank.git");
  });
});

type Call = { url: string; method: string | undefined; headers: Record<string, string>; query: string; variables: Record<string, unknown> };

// Replies in order, one per request, and records each, so no test reaches a real forge.
function stubFetch(replies: { status?: number; json: unknown }[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...replies];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const payload = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push({
      url: String(input),
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      query: payload.query,
      variables: payload.variables,
    });
    const reply = queue.shift();
    if (!reply) throw new Error("stub fetch: no reply left");
    return new Response(JSON.stringify(reply.json), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fn as typeof fetch, calls };
}

const prUrl = "https://github.com/acme/bank/pull/7";
const req: ChangeRequest = {
  remoteUrl: "git@github.com:acme/bank.git",
  base: "main",
  head,
  title: "Use Postgres for new services",
  body: "title: Use Postgres for new services\ntype: Decision",
};

describe("githubAdapter", () => {
  test("opens one pull request through GraphQL and passes its URL through", async () => {
    const stub = stubFetch([
      { json: { data: { repository: { id: "R_1" } } } },
      { json: { data: { createPullRequest: { pullRequest: { url: prUrl } } } } },
    ]);
    const adapter = githubAdapter({ token: "tok", fetch: stub.fetch });
    expect(adapter.name).toBe("github");

    expect(await adapter.openChangeRequest(req)).toEqual({ url: prUrl });

    expect(stub.calls).toHaveLength(2);
    for (const call of stub.calls) {
      expect(call.method).toBe("POST");
      expect(call.url).toBe("https://api.github.com/graphql");
      expect(call.headers.authorization).toBe("bearer tok");
    }
    expect(stub.calls[0]!.variables).toEqual({ owner: "acme", name: "bank" });

    const creates = stub.calls.filter((c) => c.url.endsWith("/graphql") && c.query.includes("createPullRequest"));
    expect(creates).toHaveLength(1);
    expect(creates[0]!.variables).toMatchObject({
      repositoryId: "R_1",
      baseRefName: "main",
      headRefName: "ltm/propose/abc",
      title: "Use Postgres for new services",
      body: req.body,
    });
  });

  test("honors a custom endpoint", async () => {
    const stub = stubFetch([
      { json: { data: { repository: { id: "R_1" } } } },
      { json: { data: { createPullRequest: { pullRequest: { url: prUrl } } } } },
    ]);
    await githubAdapter({ token: "tok", fetch: stub.fetch, endpoint: "https://ghe.example.com/api/graphql" }).openChangeRequest(req);
    expect(stub.calls.map((c) => c.url)).toEqual(["https://ghe.example.com/api/graphql", "https://ghe.example.com/api/graphql"]);
  });

  test("an errors reply rejects with the first error's message", async () => {
    const stub = stubFetch([
      { json: { data: { repository: { id: "R_1" } } } },
      { json: { data: null, errors: [{ message: "A pull request already exists for acme:ltm/propose/abc." }, { message: "second" }] } },
    ]);
    await expect(githubAdapter({ token: "tok", fetch: stub.fetch }).openChangeRequest(req)).rejects.toThrow(
      "A pull request already exists for acme:ltm/propose/abc.",
    );
  });

  test("an errors reply to the repository lookup rejects before any createPullRequest", async () => {
    const stub = stubFetch([{ json: { data: { repository: null }, errors: [{ message: "Could not resolve to a Repository" }] } }]);
    await expect(githubAdapter({ token: "tok", fetch: stub.fetch }).openChangeRequest(req)).rejects.toThrow("Could not resolve to a Repository");
    expect(stub.calls.filter((c) => c.query.includes("createPullRequest"))).toHaveLength(0);
  });

  test("a non-2xx status rejects", async () => {
    const stub = stubFetch([{ status: 401, json: { message: "Bad credentials" } }]);
    await expect(githubAdapter({ token: "tok", fetch: stub.fetch }).openChangeRequest(req)).rejects.toThrow("401");
  });

  test("a remote that isn't a parseable GitHub URL rejects without a request", async () => {
    const stub = stubFetch([]);
    await expect(githubAdapter({ token: "tok", fetch: stub.fetch }).openChangeRequest({ ...req, remoteUrl: "not a url" })).rejects.toThrow();
    expect(stub.calls).toHaveLength(0);
  });
});
