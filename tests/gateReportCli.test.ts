import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";
import type { EvidenceManifest } from "../src/gate.js";

const manifest: EvidenceManifest = {
  schema_version: "0.1",
  tool: {
    name: "samotest",
    version: "0.1.3",
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
    head_ref: "feature/gate",
    commit: "abc123",
  },
  artifacts: [
    {
      type: "log",
      name: "gate-contract",
      path: "artifacts/gate-contract.log",
      sha256: "0123456789abcdef",
      url: "https://example.test/artifacts/gate-contract.log",
    },
  ],
  observations: [
    {
      step_id: "gate-check",
      status: "passed",
      note: "Gate check emitted the samorev JSON contract.",
    },
  ],
  review: {
    manifest_url: "https://example.test/manifest.json",
  },
};

describe("samotest gate report", () => {
  it("renders a PR-ready markdown summary with artifact links and status", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-report-"));
    const manifestPath = join(cwd, "manifest.json");

    try {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const result = await runCli(
        ["gate", "report", "--manifest", manifestPath, "--head", "abc123", "--format", "markdown"],
        { cwd, resolveArtifactUrl: async () => true },
      );

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /## samotest evidence gate: pass/);
      assert.match(result.stdout, /\| checkout-discount-demo \| required \| pass \| fresh \|/);
      assert.match(result.stdout, /\[gate-contract\]\(https:\/\/example\.test\/artifacts\/gate-contract\.log\)/);
      assert.match(result.stdout, /\[manifest\]\(https:\/\/example\.test\/manifest\.json\)/);
      assert.equal(result.stderr, "");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("marks local-only artifact evidence as review-incomplete", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-report-"));
    const manifestPath = join(cwd, "manifest.json");
    const localOnlyManifest: EvidenceManifest = {
      ...manifest,
      artifacts: [
        {
          type: "log",
          name: "gate-contract",
          path: "artifacts/gate-contract.log",
          sha256: "0123456789abcdef",
        },
      ],
      review: {},
    };

    try {
      await writeFile(manifestPath, `${JSON.stringify(localOnlyManifest, null, 2)}\n`, "utf8");

      const result = await runCli(
        ["gate", "report", "--manifest", manifestPath, "--head", "abc123", "--format", "markdown"],
        { cwd, resolveArtifactUrl: async () => false },
      );

      assert.equal(result.exitCode, 4);
      assert.match(result.stdout, /## samotest evidence gate: fail/);
      assert.match(result.stdout, /Review completeness: incomplete - hosted artifact URLs are required before review\./);
      assert.match(result.stdout, /artifact_url_missing: Artifact artifacts\/gate-contract\.log is missing a URL required for review\./);
      assert.equal(result.stderr, "");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
