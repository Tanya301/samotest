import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";

describe("samotest evidence upload", () => {
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

async function writeEvidenceFixture(runDir: string): Promise<void> {
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
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
