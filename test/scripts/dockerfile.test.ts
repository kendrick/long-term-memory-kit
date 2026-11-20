import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../..", import.meta.url).pathname;
// System dirs only, so a real ltm on the developer's PATH can't stand in for the fetched one.
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const dockerfile = readFileSync(join(repo, "Dockerfile"), "utf8");
const asset = Bun.spawnSync(["sh", "-c", `. "${join(repo, "bin/ltm-fetch.sh")}" && ltm_asset`]).stdout.toString().trim();
const fakeBinary = `#!/bin/sh\necho "fetched $*"\n`;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let scratch: string;
let requests: string[];
let sums: string | undefined;
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "ltm-dockerfile-")));
  requests = [];
  sums = undefined;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      if (path === `/v9.9.9/${asset}`) return new Response(fakeBinary);
      if (path === "/v9.9.9/SHA256SUMS") return new Response(sums ?? `${sha256(fakeBinary)}  ${asset}\n`);
      return new Response("not found", { status: 404 });
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

// The fetch line ends by deleting /tmp/ltm-fetch.sh, so that path maps to a scratch copy of bin/ltm-fetch.sh rather than the repo's file.
function fetchRun(): string {
  const line = dockerfile.split("\n").find((l) => l.includes('ltm_fetch "$LTM_VERSION"'));
  if (!line?.startsWith("RUN ")) throw new Error("no RUN line calls ltm_fetch in the Dockerfile");
  copyFileSync(join(repo, "bin/ltm-fetch.sh"), join(scratch, "ltm-fetch.sh"));
  return line
    .slice("RUN ".length)
    .replaceAll("/tmp/ltm-fetch.sh", join(scratch, "ltm-fetch.sh"))
    .replaceAll("/usr/local/bin/ltm", join(scratch, "ltm"));
}

// Async spawn: a sync one would block the event loop the fake release server answers on.
async function runFetch(version = "v9.9.9") {
  const proc = Bun.spawn(["sh", "-c", fetchRun()], {
    env: { PATH: SYSTEM_PATH, LTM_VERSION: version, LTM_RELEASE_BASE_URL: `http://127.0.0.1:${server.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { stderr, code };
}

describe("Dockerfile", () => {
  test("the Dockerfile's fetch installs a verified binary", async () => {
    const r = await runFetch();
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    const ltm = join(scratch, "ltm");
    expect(statSync(ltm).mode & 0o111).not.toBe(0);
    expect(Bun.spawnSync([ltm, "x"]).stdout.toString()).toBe("fetched x\n");
    expect(existsSync(join(scratch, "ltm-fetch.sh"))).toBe(false);
  });

  test("the Dockerfile's fetch refuses a mismatched checksum", async () => {
    sums = `${sha256("something else")}  ${asset}\n`;
    const r = await runFetch();
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("checksum mismatch");
    expect(existsSync(join(scratch, "ltm"))).toBe(false);
  });

  test("the Dockerfile needs LTM_VERSION", async () => {
    const r = await runFetch("");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("LTM_VERSION");
    expect(requests).toEqual([]);
  });

  test("the Dockerfile pins its shape", () => {
    const lines = dockerfile.split("\n");
    const froms = lines.filter((l) => /^FROM\s/.test(l));
    expect(froms.length).toBeGreaterThan(0);
    for (const f of froms) expect(f).toContain("--platform=linux/amd64");
    expect(lines).toContain("ARG LTM_VERSION");
    const users = lines.filter((l) => /^USER\s/.test(l));
    expect(users.length).toBeGreaterThan(0);
    for (const u of users) expect(u).not.toMatch(/^USER\s+(root|0)(:|\s|$)/);
    expect(lines).toContain("ENV LTM_DATA_DIR=/var/lib/ltm");
    expect(lines).toContain('ENTRYPOINT ["ltm", "mcp", "--http", "0.0.0.0:8080"]');
    expect(dockerfile).not.toContain("--trust-proxy-auth");
    const ignore = readFileSync(join(repo, ".dockerignore"), "utf8").split("\n").filter((l) => l !== "");
    expect(ignore).toEqual(["*", "!bin/ltm-fetch.sh"]);
  });

  const docker = Bun.which("docker");
  const expectDocker = process.env.LTM_EXPECT_DOCKER_TESTS === "1";
  // Skipping silently in the docker CI job would report a green job that built nothing, so the test fails there instead.
  test.skipIf(docker === null && !expectDocker)(
    "docker builds the image from a tagged release",
    async () => {
      expect(docker).not.toBeNull();
      const sh = async (argv: string[]) => {
        const proc = Bun.spawn(argv, { cwd: repo, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { stdout, stderr, code };
      };
      const built = await sh([docker!, "build", "--build-arg", "LTM_VERSION=v0.3.0", "-t", "ltm-mcp-test", "."]);
      if (built.code !== 0) throw new Error(`docker build failed:\n${built.stderr.slice(-2000)}`);
      const version = await sh([docker!, "run", "--rm", "--entrypoint", "ltm", "ltm-mcp-test", "--version"]);
      expect(version.stdout.trim()).toBe("0.3.0");
      const bad = await sh([docker!, "build", "--build-arg", "LTM_VERSION=v0.0.0-nope", "-t", "ltm-mcp-test-nope", "."]);
      expect(bad.code).not.toBe(0);
    },
    10 * 60_000,
  );
});
