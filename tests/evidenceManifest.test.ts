import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { inspectEvidence, writeEvidenceManifest } from "../src/evidence.js";

describe("evidence manifest schema and artifacts", () => {
  it("writes schema 0.1 manifests with relative artifact paths and sha256 checksums", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-evidence-"));
    const runDir = join(cwd, ".samo/evidence/run-1");
    const artifactPath = join(runDir, "artifacts/terminal.log");

    try {
      await mkdir(join(runDir, "artifacts"), { recursive: true });
      await writeFile(artifactPath, "checkout flow passed\n", "utf8");

      const manifest = await writeEvidenceManifest({
        runDir,
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
            path: artifactPath,
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
      });

      const expectedSha = createHash("sha256").update("checkout flow passed\n").digest("hex");
      assert.equal(manifest.schema_version, "0.1");
      assert.equal(manifest.run.id, "run-1");
      assert.equal(manifest.source.commit, "abc123");
      assert.deepEqual(manifest.environment, {
        os: "linux",
        profile: "local",
        redacted: true,
      });
      assert.equal(manifest.artifacts?.[0]?.path, "artifacts/terminal.log");
      assert.equal(manifest.artifacts?.[0]?.sha256, expectedSha);

      const persisted = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
      assert.equal(persisted.artifacts[0].path, "artifacts/terminal.log");
      assert.equal(persisted.artifacts[0].sha256, expectedSha);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reports checksum failures when inspecting a manifest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-evidence-"));
    const runDir = join(cwd, ".samo/evidence/run-1");
    const artifactPath = join(runDir, "artifacts/terminal.log");

    try {
      await mkdir(join(runDir, "artifacts"), { recursive: true });
      await writeFile(artifactPath, "original evidence\n", "utf8");
      await writeEvidenceManifest({
        runDir,
        run: {
          id: "run-1",
          scenario_id: "checkout-discount-demo",
          status: "passed",
        },
        source: {
          commit: "abc123",
        },
        artifacts: [
          {
            type: "log",
            name: "terminal-output",
            path: artifactPath,
          },
        ],
      });
      await writeFile(artifactPath, "modified evidence\n", "utf8");

      const inspection = await inspectEvidence(runDir);

      assert.equal(inspection.ok, false);
      assert.equal(inspection.artifact_checks[0]?.path, "artifacts/terminal.log");
      assert.equal(inspection.artifact_checks[0]?.ok, false);
      assert.equal(inspection.errors[0]?.code, "artifact_checksum_mismatch");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
