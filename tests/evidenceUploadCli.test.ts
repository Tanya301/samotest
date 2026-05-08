import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";

describe("samotest evidence upload", () => {
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
      assert.match(result.stdout, /\| checkout-discount-demo \| required \| fail \| fresh \| artifacts\/terminal\.log \| Artifact artifacts\/terminal\.log is missing a URL required for review\. \|/);

      assert.equal(await readFile(outputPath, "utf8"), result.stdout.match(/Markdown:\n([\s\S]*)$/)?.[1]);
      assert.equal(result.stderr, "");
    } finally {
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
        ...(overrides.review ? { review: overrides.review } : {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
