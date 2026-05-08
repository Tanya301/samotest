import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("documents the current quickstart and local recorder workflow", async () => {
    const readme = await readFile("README.md", "utf8");

    assert.match(readme, /npm link/);
    assert.match(readme, /npm pack --dry-run/);
    assert.match(readme, /samotest init/);
    assert.match(readme, /samotest scenario validate/);
    assert.match(readme, /samotest run my-scenario/);
    assert.match(readme, /samotest evidence inspect/);
    assert.match(readme, /samotest gate check --manifest/);
    assert.match(readme, /v0\.1\.0 is released/);
    assert.match(readme, /samotest doctor/);
    assert.match(readme, /samotest record my-browser-scenario --format video/);
    assert.match(readme, /record --format gif.*video fallback evidence/);
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

  it("packs and installs a working samotest --version bin", async () => {
    const cwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), "samotest-package-smoke-"));
    const installDir = join(tempDir, "install");

    try {
      await run("npm", ["run", "build"], { cwd });
      const pack = await run("npm", ["pack", "--pack-destination", tempDir, "--json"], { cwd });
      const [{ filename }] = JSON.parse(pack.stdout) as Array<{ filename: string }>;

      await run("npm", ["init", "-y"], { cwd: installDir, createCwd: true });
      await run("npm", ["install", join(tempDir, filename)], { cwd: installDir });

      const bin = await run(join(installDir, "node_modules/.bin/samotest"), ["--version"], { cwd: installDir });

      assert.equal(bin.stdout, "0.1.0\n");
      assert.equal(bin.stderr, "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

async function run(
  command: string,
  args: string[],
  options: { cwd: string; createCwd?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  if (options.createCwd) {
    await mkdir(options.cwd, { recursive: true });
  }

  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  assert.equal(exitCode, 0, `${command} ${args.join(" ")} failed\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
  return { stdout, stderr };
}
