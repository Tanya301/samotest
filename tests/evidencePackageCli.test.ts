import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { runCli } from "../src/cli.js";

describe("samotest evidence package", () => {
  it("creates a portable zip bundle for a run directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-package-"));
    const runDir = join(cwd, ".samotest/evidence/run-1");

    try {
      await writeEvidenceFixture(runDir);

      const result = await runCli(["evidence", "package", "run-1", "--format", "zip"], { cwd });

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /\.samotest\/evidence\/run-1\/run-1-evidence\.zip/);
      assert.equal(result.stderr, "");

      const zip = await readFile(join(runDir, "run-1-evidence.zip"));
      assert.equal(zip.subarray(0, 4).toString("hex"), "504b0304");
      assert.deepEqual(listZipEntries(zip), ["artifacts/terminal.log", "manifest.json"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails instead of packaging unmanifested artifacts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-package-unmanifested-"));
    const runDir = join(cwd, ".samotest/evidence/run-1");

    try {
      await writeEvidenceFixture(runDir);
      await writeFile(join(runDir, "artifacts/page@playwright.webm"), "unmanifested video sidecar\n", "utf8");

      const result = await runCli(["evidence", "package", "run-1", "--format", "zip"], { cwd });

      assert.equal(result.exitCode, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /unmanifested artifact/i);
      assert.match(result.stderr, /artifacts\/page@playwright\.webm/);
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
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function listZipEntries(zip: Buffer): string[] {
  const entries: string[] = [];
  let offset = 0;

  while (offset < zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const fileNameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    entries.push(zip.subarray(offset + 30, offset + 30 + fileNameLength).toString("utf8"));
    offset += 30 + fileNameLength + extraLength + compressedSize;
  }

  return entries;
}
