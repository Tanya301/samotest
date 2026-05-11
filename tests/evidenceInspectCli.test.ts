import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { runCli } from "../src/cli.js";

describe("samotest evidence inspect", () => {
  it("prints human-readable evidence summaries by default", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-inspect-"));
    const runDir = join(cwd, ".samotest/evidence/run-1");

    try {
      await writeEvidenceFixture(runDir);

      const result = await runCli(["evidence", "inspect", runDir], { cwd });

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /Evidence run run-1/);
      assert.match(result.stdout, /Scenario: checkout-discount-demo/);
      assert.match(result.stdout, /Status: passed/);
      assert.match(result.stdout, /Source: Tanya301\/samotest @ abc123/);
      assert.match(result.stdout, /Artifacts: 1/);
      assert.match(result.stdout, /log terminal-output artifacts\/terminal\.log sha256:/);
      assert.match(result.stdout, /Observations: 1/);
      assert.equal(result.stderr, "");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prints machine-readable JSON with --format json", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-inspect-"));
    const runDir = join(cwd, ".samotest/evidence/run-1");

    try {
      await writeEvidenceFixture(runDir);

      const result = await runCli(["evidence", "inspect", runDir, "--format", "json"], { cwd });
      const payload = JSON.parse(result.stdout);

      assert.equal(result.exitCode, 0);
      assert.equal(payload.ok, true);
      assert.equal(payload.manifest.schema_version, "0.1");
      assert.equal(payload.manifest.run.id, "run-1");
      assert.equal(payload.manifest.artifacts[0].path, "artifacts/terminal.log");
      assert.equal(payload.artifact_checks[0].ok, true);
      assert.equal(result.stderr, "");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("resolves bare run ids from the default evidence directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-inspect-"));
    const runDir = join(cwd, ".samotest/evidence/run-1");

    try {
      await writeEvidenceFixture(runDir);

      const result = await runCli(["evidence", "inspect", "run-1"], { cwd });

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /Evidence run run-1/);
      assert.equal(result.stderr, "");
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
          version: "0.1.4",
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
        environment: {
          os: "linux",
          profile: "local",
          redacted: true,
        },
        artifacts: [
          {
            type: "log",
            name: "terminal-output",
            path: "artifacts/terminal.log",
            sha256: "f218352f6ba206ce8fbfdf42b7cca44c67b47584403c5573d703b716d54abcb6",
          },
        ],
        observations: [
          {
            step_id: "checkout",
            status: "passed",
            note: "Checkout flow completed.",
          },
        ],
        review: {
          pr: "7",
          provider: "github",
          uploaded_urls: [],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
