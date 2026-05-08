import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCli } from "../src/cli.js";

describe("samotest CLI", () => {
  it("prints Sprint 1 commands in help output", async () => {
    const result = await runCli(["--help"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /samotest init/);
    assert.match(result.stdout, /samotest scenario list/);
    assert.match(result.stdout, /samotest scenario validate \[path\]/);
    assert.match(result.stdout, /samotest run <scenario-id>/);
    assert.match(result.stdout, /samotest evidence inspect <run-id-or-path>/);
    assert.match(result.stdout, /samotest gate check --manifest <path>/);
    assert.match(result.stdout, /samotest doctor/);
  });

  it("initializes config, scenario, evidence, and ignore guidance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-init-"));

    try {
      const result = await runCli(["init"], { cwd });

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /Initialized \.samotest/);
      assert.equal((await stat(join(cwd, ".samotest/config.yaml"))).isFile(), true);
      assert.equal((await stat(join(cwd, ".samotest/scenarios"))).isDirectory(), true);
      assert.equal((await stat(join(cwd, ".samotest/evidence"))).isDirectory(), true);
      assert.match(await readFile(join(cwd, ".gitignore"), "utf8"), /\.samotest\/evidence\//);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
