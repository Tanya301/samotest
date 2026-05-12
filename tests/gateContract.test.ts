import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { checkGate, type EvidenceManifest } from "../src/gate.js";
import { runCli } from "../src/cli.js";

const baseManifest: EvidenceManifest = {
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
    head_ref: "feature/gate",
    commit: "abc123",
  },
  artifacts: [
    {
      type: "log",
      name: "gate-contract",
      path: "artifacts/gate-contract.log",
      sha256: "0123456789abcdef",
      url: "https://github.com/Tanya301/samotest/actions/runs/123/artifacts/456",
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
    provider: "github",
    pr: "25",
    command: "bun test --filter gate",
    manifest_url: "https://github.com/Tanya301/samotest/actions/runs/123/artifacts/manifest",
    summary: {
      provider: "github",
      target: "pull_request 25",
      url: "https://github.com/Tanya301/samotest/pull/25#issuecomment-123",
      posted_at: "2026-05-08T19:09:00Z",
    },
  },
};

describe("gate check samorev contract", () => {
  it("emits a stable pass report and exits 0 for fresh passing evidence", async () => {
    await withManifest(baseManifest, async ({ cwd, manifestPath }) => {
      const result = await checkGate({
        manifestPath,
        baseRef: "main",
        headRef: "feature/gate",
        headSha: "abc123",
        cwd,
        resolveArtifactUrl: async () => true,
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.report.schema_version, "0.1");
      assert.equal(result.report.tool.name, "samotest");
      assert.equal(result.report.gate.status, "pass");
      assert.equal(result.report.gate.base_ref, "main");
      assert.equal(result.report.gate.head_ref, "feature/gate");
      assert.equal(result.report.gate.head_sha, "abc123");
      assert.equal(result.report.gate.manifest_path, manifestPath);
      assert.deepEqual(result.report.gate.summary, {
        required: 1,
        passed: 1,
        failed: 0,
        warned: 0,
        waived: 0,
      });
      assert.equal(result.report.scenarios[0]?.id, "checkout-discount-demo");
      assert.equal(result.report.scenarios[0]?.required, true);
      assert.equal(result.report.scenarios[0]?.status, "pass");
      assert.equal(result.report.scenarios[0]?.fresh, true);
      assert.deepEqual(result.report.errors, []);
    });
  });

  it("exits 1 and reports fail when required evidence failed", async () => {
    await withManifest(
      {
        ...baseManifest,
        run: {
          ...baseManifest.run,
          status: "failed",
        },
        observations: [
          {
            step_id: "gate-check",
            status: "failed",
            note: "The manual gate contract check failed.",
          },
        ],
      },
      async ({ cwd, manifestPath }) => {
        const cli = await runCli(
          ["gate", "check", "--manifest", manifestPath, "--head", "abc123", "--format", "json"],
          { cwd, resolveArtifactUrl: async () => true },
        );
        const report = JSON.parse(cli.stdout);

        assert.equal(cli.exitCode, 1);
        assert.equal(report.gate.status, "fail");
        assert.equal(report.gate.summary.failed, 1);
        assert.equal(report.errors[0]?.code, "evidence_status_failed");
        assert.equal(report.scenarios[0]?.status, "fail");
      },
    );
  });

  it("exits 0 and reports warn for configured non-blocking skipped evidence", async () => {
    await withManifest(
      {
        ...baseManifest,
        run: {
          ...baseManifest.run,
          status: "skipped",
          required: false,
        },
        artifacts: [],
        observations: [],
      },
      async ({ cwd, manifestPath }) => {
        const cli = await runCli(
          ["gate", "check", "--manifest", manifestPath, "--head", "abc123", "--format", "json"],
          { cwd, resolveArtifactUrl: async () => true },
        );
        const report = JSON.parse(cli.stdout);

        assert.equal(cli.exitCode, 0);
        assert.equal(report.gate.status, "warn");
        assert.equal(report.gate.summary.required, 0);
        assert.equal(report.gate.summary.warned, 1);
        assert.equal(report.scenarios[0]?.required, false);
        assert.equal(report.scenarios[0]?.status, "warn");
      },
    );
  });

  it("exits 1 and reports stale evidence when the manifest commit differs from --head", async () => {
    await withManifest(baseManifest, async ({ cwd, manifestPath }) => {
      const cli = await runCli(
        ["gate", "check", "--manifest", manifestPath, "--head", "def456", "--format", "json"],
        { cwd, resolveArtifactUrl: async () => true },
      );
      const report = JSON.parse(cli.stdout);

      assert.equal(cli.exitCode, 1);
      assert.equal(report.gate.status, "fail");
      assert.equal(report.gate.head_sha, "def456");
      assert.equal(report.scenarios[0]?.fresh, false);
      assert.equal(report.errors[0]?.code, "stale_evidence");
    });
  });

  it("exits 2 and emits JSON for malformed manifests", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-gate-"));
    const manifestPath = join(cwd, "manifest.json");

    try {
      await writeFile(manifestPath, "{ not json", "utf8");
      const cli = await runCli(
        ["gate", "check", "--manifest", manifestPath, "--format", "json"],
        { cwd },
      );
      const report = JSON.parse(cli.stdout);

      assert.equal(cli.exitCode, 2);
      assert.equal(report.gate.status, "fail");
      assert.equal(report.gate.manifest_path, manifestPath);
      assert.equal(report.gate.summary.failed, 1);
      assert.equal(report.errors[0]?.code, "malformed_manifest");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("exits 1 and reports incomplete evidence when required passed evidence has no finished_at", async () => {
    const { finished_at: _finishedAt, ...unfinishedRun } = baseManifest.run;

    await withManifest(
      {
        ...baseManifest,
        run: unfinishedRun,
      },
      async ({ cwd, manifestPath }) => {
        const cli = await runCli(
          ["gate", "check", "--manifest", manifestPath, "--head", "abc123", "--format", "json"],
          { cwd, resolveArtifactUrl: async () => true },
        );
        const report = JSON.parse(cli.stdout);

        assert.equal(cli.exitCode, 1);
        assert.equal(report.gate.status, "fail");
        assert.equal(report.gate.summary.failed, 1);
        assert.equal(report.scenarios[0]?.status, "fail");
        assert.equal(report.errors[0]?.code, "unfinished_evidence");
      },
    );
  });

  it("exits 4 and reports fail when a required artifact URL cannot be resolved", async () => {
    await withManifest(baseManifest, async ({ cwd, manifestPath }) => {
      const cli = await runCli(
        ["gate", "check", "--manifest", manifestPath, "--head", "abc123", "--format", "json"],
        { cwd, resolveArtifactUrl: async () => false },
      );
      const report = JSON.parse(cli.stdout);

      assert.equal(cli.exitCode, 4);
      assert.equal(report.gate.status, "fail");
      assert.equal(report.gate.summary.failed, 1);
      assert.equal(report.scenarios[0]?.status, "fail");
      assert.equal(report.errors[0]?.code, "artifact_url_unresolved");
    });
  });

  it("exits non-zero and reports local-only evidence when required artifacts have no hosted URL", async () => {
    await withManifest(
      {
        ...baseManifest,
        artifacts: baseManifest.artifacts?.map(({ url: _url, ...artifact }) => artifact),
        review: {
          ...baseManifest.review,
          manifest_url: undefined,
          summary: undefined,
        },
      },
      async ({ cwd, manifestPath }) => {
        const cli = await runCli(
          ["gate", "check", "--manifest", manifestPath, "--head", "abc123", "--format", "json"],
          { cwd, resolveArtifactUrl: async () => true },
        );
        const report = JSON.parse(cli.stdout);

        assert.notEqual(cli.exitCode, 0);
        assert.equal(report.gate.status, "fail");
        assert.equal(report.scenarios[0]?.status, "fail");
        assert.ok(report.errors.some((error: { code: string }) => error.code === "local_only_evidence"));
      },
    );
  });

  it("exits non-zero for link-only evidence that was not posted by samotest", async () => {
    await withManifest(
      {
        ...baseManifest,
        review: {
          provider: "github",
          pr: "25",
          command: "bun test --filter gate",
          manifest_url: "https://github.com/Tanya301/samotest/actions/runs/123/artifacts/manifest",
        },
      },
      async ({ cwd, manifestPath }) => {
        const cli = await runCli(
          ["gate", "check", "--manifest", manifestPath, "--head", "abc123", "--format", "json"],
          { cwd, resolveArtifactUrl: async () => true },
        );
        const report = JSON.parse(cli.stdout);

        assert.notEqual(cli.exitCode, 0);
        assert.equal(report.gate.status, "fail");
        assert.equal(report.scenarios[0]?.status, "fail");
        assert.ok(report.errors.some((error: { code: string }) => error.code === "evidence_summary_missing"));
      },
    );
  });

  it("exits non-zero for hosted links plus locally forged URL-less provider summary", async () => {
    await withManifest(
      {
        ...baseManifest,
        review: {
          provider: "github",
          pr: "25",
          command: "bun test --filter gate",
          manifest_url: "https://github.com/Tanya301/samotest/actions/runs/123/artifacts/manifest",
          summary: {
            provider: "github",
            target: "pull_request 25",
            posted_at: "2026-05-08T19:09:00Z",
          },
        },
      },
      async ({ cwd, manifestPath }) => {
        const cli = await runCli(
          ["gate", "check", "--manifest", manifestPath, "--head", "abc123", "--format", "json"],
          { cwd, resolveArtifactUrl: async () => true },
        );
        const report = JSON.parse(cli.stdout);

        assert.notEqual(cli.exitCode, 0);
        assert.equal(report.gate.status, "fail");
        assert.equal(report.scenarios[0]?.status, "fail");
        assert.ok(report.errors.some((error: { code: string }) => error.code === "evidence_summary_url_missing"));
      },
    );
  });

  it("passes CLI transcript evidence after provider-owned posting metadata is present", async () => {
    await withManifest(baseManifest, async ({ cwd, manifestPath }) => {
      const cli = await runCli(
        ["gate", "check", "--manifest", manifestPath, "--head", "abc123", "--format", "json"],
        { cwd, resolveArtifactUrl: async () => true },
      );
      const report = JSON.parse(cli.stdout);

      assert.equal(cli.exitCode, 0);
      assert.equal(report.gate.status, "pass");
      assert.equal(report.scenarios[0]?.artifacts[0]?.type, "log");
      assert.equal(report.evidence.provider, "github");
      assert.equal(report.evidence.target, "pull_request 25");
    });
  });

  it("passes UI artifact evidence after provider-owned posting metadata is present", async () => {
    await withManifest(
      {
        ...baseManifest,
        run: {
          ...baseManifest.run,
          scenario_id: "browser-checkout-demo",
        },
        artifacts: [
          {
            type: "video",
            name: "checkout-flow",
            path: "artifacts/checkout-flow.webm",
            sha256: "abcdef0123456789",
            url: "https://gitlab.example.test/uploads/checkout-flow.webm",
          },
        ],
        review: {
          provider: "gitlab",
          mr: "25",
          command: "samotest record browser-checkout-demo --format video",
          manifest_url: "https://gitlab.example.test/uploads/manifest.json",
          summary: {
            provider: "gitlab",
            target: "merge_request 25",
            url: "https://gitlab.example.test/NikolayS/samo.team/-/merge_requests/25#note_123",
            posted_at: "2026-05-08T19:09:00Z",
          },
        },
      },
      async ({ cwd, manifestPath }) => {
        const cli = await runCli(
          ["gate", "check", "--manifest", manifestPath, "--head", "abc123", "--format", "json"],
          { cwd, resolveArtifactUrl: async () => true },
        );
        const report = JSON.parse(cli.stdout);

        assert.equal(cli.exitCode, 0);
        assert.equal(report.gate.status, "pass");
        assert.equal(report.scenarios[0]?.artifacts[0]?.type, "video");
        assert.equal(report.evidence.provider, "gitlab");
        assert.equal(report.evidence.target, "merge_request 25");
      },
    );
  });
});

async function withManifest(
  manifest: EvidenceManifest,
  callback: (context: { cwd: string; manifestPath: string }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "samotest-gate-"));
  const manifestPath = join(cwd, "manifest.json");

  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await callback({ cwd, manifestPath });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
