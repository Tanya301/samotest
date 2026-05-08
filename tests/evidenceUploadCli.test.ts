import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runCli } from "../src/cli.js";

describe("samotest evidence upload", () => {
  afterEach(() => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GLAB_TOKEN;
    delete process.env.GITLAB_URL;
  });

  it("prints an exact GitLab MR dry-run upload and comment plan with review-complete URL requirements", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-upload-"));
    const runDir = join(cwd, ".samotest/evidence/run-1");
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
      assert.match(result.stdout, /Command: npm run test:e2e -- --grep checkout/);
      assert.match(result.stdout, /\| checkout-discount-demo \| required \| fail \| fresh \| artifacts\/terminal\.log \| Artifact artifacts\/terminal\.log is missing a URL required for review\. \|/);

      assert.equal(await readFile(outputPath, "utf8"), result.stdout.match(/Markdown:\n([\s\S]*)$/)?.[1]);
      assert.equal(result.stderr, "");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("posts a live GitLab comment payload rebuilt with hosted URLs and run metadata", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-upload-"));
    const runDir = join(cwd, ".samotest/evidence/run-1");
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
      const posted = JSON.parse(String(noteRequest.body)) as { body: string };
      assert.match(posted.body, /## samotest evidence gate: pass/);
      assert.match(posted.body, /Review completeness: complete/);
      assert.doesNotMatch(posted.body, /artifact_url_missing/);
      assert.match(posted.body, /Run: run-1/);
      assert.match(posted.body, /Scenario: checkout-discount-demo/);
      assert.match(posted.body, /Provider: gitlab/);
      assert.match(posted.body, /Target: merge_request 25/);
      assert.match(posted.body, /Command: npm run test:e2e -- --grep checkout/);
      assert.match(posted.body, /\[terminal-output\]\(https:\/\/gitlab\.example\.test\/uploads\/terminal\.log\)/);
      assert.match(posted.body, /Manifest: \[manifest\]\(https:\/\/gitlab\.example\.test\/uploads\/manifest\.json\)/);
      assert.match(posted.body, /### Hosted GitLab uploads/);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prints a GitLab issue dry-run comment action when --issue is provided", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-upload-"));
    const runDir = join(cwd, ".samotest/evidence/run-1");

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
    const runDir = join(cwd, ".samotest/evidence/run-1");
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
  overrides: { review?: Record<string, unknown> } = {},
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
          version: "0.1.0",
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
          },
        ],
        review: {
          command: "npm run test:e2e -- --grep checkout",
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
