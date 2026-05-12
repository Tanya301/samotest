import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { runCli } from "../src/cli.js";

describe("samotest evidence upload", () => {
  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GLAB_TOKEN;
    delete process.env.GITLAB_URL;
  });

  it("posts a GitHub PR evidence summary and records provider-owned manifest metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-upload-github-"));
    const runDir = join(cwd, ".samo/evidence/run-1");
    const requests: Array<{ url: string; method: string; body?: unknown; authorization?: string | null }> = [];
    const originalFetch = globalThis.fetch;

    try {
      await writeEvidenceFixture(runDir, {
        artifactUrl: "https://github.com/Tanya301/samotest/actions/runs/123/artifacts/456",
        review: {
          provider: "github",
          pr: "25",
          manifest_url: "https://github.com/Tanya301/samotest/actions/runs/123/artifacts/manifest",
        },
      });
      process.env.GITHUB_TOKEN = "test-github-token";
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body,
          authorization: init?.headers instanceof Headers
            ? init.headers.get("authorization")
            : (init?.headers as Record<string, string> | undefined)?.authorization
              ?? (init?.headers as Record<string, string> | undefined)?.Authorization,
        });

        if (url.endsWith("/repos/Tanya301/samotest/issues/25/comments")) {
          return jsonResponse(201, {
            id: 456,
            html_url: "https://github.com/Tanya301/samotest/pull/25#issuecomment-456",
          });
        }

        if (url.endsWith("/repos/Tanya301/samotest/issues/comments/456")) {
          return jsonResponse(200, {
            id: 456,
            html_url: "https://github.com/Tanya301/samotest/pull/25#issuecomment-456",
          });
        }

        return jsonResponse(404, { message: "unexpected request" });
      }) as typeof fetch;

      const result = await runCli(
        [
          "evidence",
          "upload",
          "run-1",
          "--provider",
          "github",
          "--repo",
          "Tanya301/samotest",
          "--pr",
          "25",
        ],
        {
          cwd,
          resolveArtifactUrl: async () => true,
          now: () => new Date("2026-05-08T19:09:00Z"),
        },
      );

      assert.equal(result.exitCode, 0, result.stderr);
      const commentRequest = requests.find((request) => request.url.endsWith("/repos/Tanya301/samotest/issues/25/comments"));
      assert.ok(commentRequest);
      assert.equal(commentRequest.method, "POST");
      assert.equal(commentRequest.authorization, "Bearer test-github-token");
      const updateRequest = requests.find((request) => request.url.endsWith("/repos/Tanya301/samotest/issues/comments/456"));
      assert.ok(updateRequest);
      assert.equal(updateRequest.method, "PATCH");
      const posted = JSON.parse(String(updateRequest.body)) as { body: string };
      assert.match(posted.body, /## samotest evidence gate: pass/);
      assert.match(posted.body, /samotest-manifest-url: https:\/\/github\.com\/Tanya301\/samotest\/actions\/runs\/123\/artifacts\/manifest/);
      assert.match(posted.body, /\[terminal-output\]\(https:\/\/github\.com\/Tanya301\/samotest\/actions\/runs\/123\/artifacts\/456\)/);

      const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
      assert.equal(manifest.review.summary.provider, "github");
      assert.equal(manifest.review.summary.target, "pull_request 25");
      assert.equal(manifest.review.summary.url, "https://github.com/Tanya301/samotest/pull/25#issuecomment-456");
      assert.equal(manifest.review.summary.posted_at, "2026-05-08T19:09:00.000Z");
    } finally {
      globalThis.fetch = originalFetch;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prints an exact GitLab MR dry-run upload and comment plan with review-complete URL requirements", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-upload-"));
    const runDir = join(cwd, ".samo/evidence/run-1");
    const outputPath = join(cwd, "gitlab-mr-comment.md");

    try {
      await writeEvidenceFixture(runDir, { review: { provider: "gitlab", mr: "25" } });

      const result = await runCli(
        [
          "evidence",
          "upload",
          "run-1",
          "--provider",
          "gitlab",
          "--repo",
          "NikolayS/samo.team",
          "--mr",
          "25",
          "--dry-run",
          "--output",
          outputPath,
        ],
        { cwd },
      );

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /Provider: gitlab/);
      assert.match(result.stdout, /Target: merge_request 25/);
      assert.match(result.stdout, /Project: NikolayS\/samo\.team/);
      assert.match(result.stdout, /Upload action: POST \/projects\/:id\/uploads artifacts\/terminal\.log/);
      assert.match(result.stdout, /Upload action: POST \/projects\/:id\/uploads manifest\.json/);
      assert.match(result.stdout, /Comment action: POST \/projects\/:id\/merge_requests\/25\/notes/);
      assert.match(result.stdout, /Artifact URL required: artifacts\/terminal\.log -> hosted GitLab upload URL/);
      assert.match(result.stdout, /Manifest URL required: manifest\.json -> hosted GitLab upload URL/);
      assert.match(result.stdout, /Dry run: no uploads or comments were posted\./);
      assert.match(result.stdout, /## samotest evidence gate: fail/);
      assert.match(result.stdout, /Run: run-1/);
      assert.match(result.stdout, /Scenario: checkout-discount-demo/);
      assert.match(result.stdout, /Provider: gitlab/);
      assert.match(result.stdout, /Target: merge_request 25/);
      assert.match(result.stdout, /Command: bun run test:e2e -- --grep checkout/);
      assert.match(result.stdout, /\| checkout-discount-demo \| required \| fail \| fresh \| artifacts\/terminal\.log \| Artifact artifacts\/terminal\.log is missing a URL required for review\. \|/);

      assert.equal(await readFile(outputPath, "utf8"), result.stdout.match(/Markdown:\n([\s\S]*)$/)?.[1]);
      assert.equal(result.stderr, "");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("posts a live GitLab comment payload rebuilt with hosted URLs and run metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-upload-"));
    const runDir = join(cwd, ".samo/evidence/run-1");
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const originalFetch = globalThis.fetch;

    try {
      await writeEvidenceFixture(runDir, { review: { provider: "gitlab", mr: "25" } });
      process.env.GITLAB_TOKEN = "test-token";
      process.env.GITLAB_URL = "https://gitlab.example.test";
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, method: init?.method ?? "GET", body: init?.body });

        if (url.endsWith("/uploads")) {
          const uploadCount = requests.filter((request) => request.url.endsWith("/uploads")).length;
          const payload = uploadCount === 1
            ? {
              markdown: "[terminal-output](/uploads/terminal.log)",
              url: "/uploads/terminal.log",
              full_path: "/uploads/terminal.log",
            }
            : {
              markdown: "[manifest](/uploads/manifest.json)",
              url: "/uploads/manifest.json",
              full_path: "/uploads/manifest.json",
            };
          return jsonResponse(201, payload);
        }

        if (url.endsWith("/merge_requests/25/notes")) {
          return jsonResponse(201, { id: 123 });
        }

        if (url.endsWith("/merge_requests/25/notes/123")) {
          return jsonResponse(200, { id: 123 });
        }

        return jsonResponse(404, { message: "unexpected request" });
      }) as typeof fetch;

      const result = await runCli(
        [
          "evidence",
          "upload",
          "run-1",
          "--provider",
          "gitlab",
          "--repo",
          "NikolayS/samo.team",
          "--mr",
          "25",
        ],
        {
          cwd,
          resolveArtifactUrl: async () => true,
        },
      );

      assert.equal(result.exitCode, 0);
      const noteRequest = requests.find((request) => request.url.endsWith("/merge_requests/25/notes"));
      assert.ok(noteRequest);
      assert.equal(noteRequest.method, "POST");
      const noteUpdateRequest = requests.find((request) => request.url.endsWith("/merge_requests/25/notes/123"));
      assert.ok(noteUpdateRequest);
      assert.equal(noteUpdateRequest.method, "PUT");
      const posted = JSON.parse(String(noteUpdateRequest.body)) as { body: string };
      assert.match(posted.body, /## samotest evidence gate: pass/);
      assert.match(posted.body, /samotest-manifest-url: https:\/\/gitlab\.example\.test\/uploads\/manifest\.json/);
      assert.match(posted.body, /Review completeness: complete/);
      assert.doesNotMatch(posted.body, /artifact_url_missing/);
      assert.match(posted.body, /Run: run-1/);
      assert.match(posted.body, /Scenario: checkout-discount-demo/);
      assert.match(posted.body, /Provider: gitlab/);
      assert.match(posted.body, /Target: merge_request 25/);
      assert.match(posted.body, /Command: bun run test:e2e -- --grep checkout/);
      assert.match(posted.body, /\[terminal-output\]\(https:\/\/gitlab\.example\.test\/uploads\/terminal\.log\)/);
      assert.match(posted.body, /Manifest: \[manifest\]\(https:\/\/gitlab\.example\.test\/uploads\/manifest\.json\)/);
      assert.match(posted.body, /### Hosted GitLab uploads/);

      const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
      assert.equal(manifest.artifacts[0].url, "https://gitlab.example.test/uploads/terminal.log");
      assert.equal(manifest.review.manifest_url, "https://gitlab.example.test/uploads/manifest.json");
      assert.equal(manifest.review.summary.provider, "gitlab");
      assert.equal(manifest.review.summary.target, "merge_request 25");
      assert.equal(manifest.review.summary.url, "https://gitlab.example.test/NikolayS/samo.team/-/merge_requests/25#note_123");
      assert.match(manifest.review.summary.posted_at, /^20/);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails visibly instead of writing a local fallback when provider auth is missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-upload-no-auth-"));
    const runDir = join(cwd, ".samo/evidence/run-1");

    try {
      await writeEvidenceFixture(runDir, {
        artifactUrl: "https://gitlab.example.test/uploads/terminal.log",
        review: {
          provider: "gitlab",
          mr: "25",
          manifest_url: "https://gitlab.example.test/uploads/manifest.json",
        },
      });

      const result = await runCli(
        [
          "evidence",
          "upload",
          "run-1",
          "--provider",
          "gitlab",
          "--repo",
          "NikolayS/samo.team",
          "--mr",
          "25",
        ],
        { cwd, resolveArtifactUrl: async () => true },
      );

      assert.notEqual(result.exitCode, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /GITLAB_TOKEN or GLAB_TOKEN is required for GitLab evidence uploads/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prints a GitLab issue dry-run comment action when --issue is provided", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-upload-"));
    const runDir = join(cwd, ".samo/evidence/run-1");

    try {
      await writeEvidenceFixture(runDir);

      const result = await runCli(
        [
          "evidence",
          "upload",
          "run-1",
          "--provider",
          "gitlab",
          "--repo",
          "NikolayS/samo.team",
          "--issue",
          "255",
          "--dry-run",
        ],
        { cwd },
      );

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /Target: issue 255/);
      assert.match(result.stdout, /Comment action: POST \/projects\/:id\/issues\/255\/notes/);
      assert.equal(result.stderr, "");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unsupported providers before preparing or posting comments", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-upload-"));
    const runDir = join(cwd, ".samo/evidence/run-1");
    const outputPath = join(cwd, "invalid-provider.md");

    try {
      await writeEvidenceFixture(runDir);

      const result = await runCli(
        ["evidence", "upload", "run-1", "--provider", "bitbucket", "--mr", "25", "--output", outputPath],
        { cwd },
      );

      assert.equal(result.exitCode, 3);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Unsupported provider "bitbucket"/);
      assert.match(result.stderr, /Supported providers: github, gitlab/);
      await assert.rejects(access(outputPath));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function writeEvidenceFixture(
  runDir: string,
  overrides: { review?: Record<string, unknown>; artifactUrl?: string } = {},
): Promise<void> {
  await mkdir(join(runDir, "artifacts"), { recursive: true });
  await writeFile(join(runDir, "artifacts/terminal.log"), "checkout flow passed\n", "utf8");
  await writeFile(
    join(runDir, "manifest.json"),
    `${JSON.stringify(
      {
        schema_version: "0.1",
        tool: {
          name: "samotest",
          version: "0.2.0",
        },
        run: {
          id: "run-1",
          scenario_id: "checkout-discount-demo",
          status: "passed",
          started_at: "2026-05-08T19:05:00Z",
          finished_at: "2026-05-08T19:08:41Z",
        },
        source: {
          repo: "Tanya301/samotest",
          base_ref: "main",
          head_ref: "feature/evidence",
          commit: "abc123",
        },
        artifacts: [
          {
            type: "log",
            name: "terminal-output",
            path: "artifacts/terminal.log",
            sha256: "f218352f6ba206ce8fbfdf42b7cca44c67b47584403c5573d703b716d54abcb6",
            ...(overrides.artifactUrl ? { url: overrides.artifactUrl } : {}),
          },
        ],
        review: {
          command: "bun run test:e2e -- --grep checkout",
          ...(overrides.review ?? {}),
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
