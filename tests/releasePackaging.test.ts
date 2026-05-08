import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("release packaging", () => {
  it("declares local dogfooding package metadata and a constrained tarball surface", async () => {
    const packageJson = await readJson("package.json");

    assert.equal(packageJson.name, "samotest");
    assert.equal(packageJson.version, "0.1.0");
    assert.deepEqual(packageJson.bin, { samotest: "./dist/cli.js" });
    assert.equal(packageJson.private, undefined);
    assert.deepEqual(packageJson.files, ["dist/", "docs/", "samples/", "LICENSE", "README.md", "SPEC.md"]);

    const scripts = packageJson.scripts as Record<string, string>;
    assert.equal(scripts.prepack, "npm run build");
  });

  it("documents the current quickstart and release hold", async () => {
    const readme = await readFile("README.md", "utf8");

    assert.match(readme, /npm link/);
    assert.match(readme, /npm pack --dry-run/);
    assert.match(readme, /samotest init/);
    assert.match(readme, /samotest scenario validate/);
    assert.match(readme, /samotest run my-scenario/);
    assert.match(readme, /samotest evidence inspect/);
    assert.match(readme, /samotest gate check --manifest/);
    assert.match(readme, /issue #20/);
    assert.match(readme, /no release tag should be created until Sprint 2 closeout/);
  });

  it("runs the required PR workflow commands", async () => {
    const workflow = await readFile(".github/workflows/pr.yml", "utf8");

    assert.match(workflow, /pull_request:/);
    assert.match(workflow, /node-version: 20/);
    assert.match(workflow, /run: npm ci/);
    assert.match(workflow, /run: npm test/);
    assert.match(workflow, /run: npm run typecheck/);
    assert.match(workflow, /run: npm run build/);
  });
});
