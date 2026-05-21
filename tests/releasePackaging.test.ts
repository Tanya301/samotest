import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { describe, it } from "bun:test";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("release packaging", () => {
  it("declares local dogfooding package metadata and a constrained tarball surface", async () => {
    const packageJson = await readJson("package.json");

    assert.equal(packageJson.name, "samotest");
    assert.equal(packageJson.version, "0.2.2");
    assert.equal(packageJson.license, "Apache-2.0");
    assert.equal(packageJson.packageManager, "bun@1.3.13");
    assert.deepEqual(packageJson.bin, { samotest: "./dist/cli.js" });
    assert.deepEqual(packageJson.engines, { bun: ">=1.3.13", node: ">=20" });
    assert.equal(packageJson.private, undefined);
    assert.deepEqual(packageJson.files, ["dist/", "docs/", "samples/", "LICENSE", "README.md", "SPEC.md"]);

    const scripts = packageJson.scripts as Record<string, string>;
    assert.equal(scripts.build, "tsc -p tsconfig.build.json && chmod +x dist/cli.js");
    assert.equal(scripts.prepack, "bun run build");
    assert.equal(scripts.start, "bun src/cli.ts");
    assert.equal(scripts.test, "bun test");
  });

  it("documents the current quickstart and local recorder workflow", async () => {
    const readme = await readFile("README.md", "utf8");

    assert.match(readme, /bun link/);
    assert.match(readme, /bun pm pack --dry-run/);
    assert.match(readme, /samotest init/);
    assert.match(readme, /samotest scenario validate/);
    assert.match(readme, /samotest run my-scenario/);
    assert.match(readme, /samotest evidence inspect/);
    assert.match(readme, /samotest gate check --manifest/);
    assert.match(readme, /v0\.2\.2 is ready for early real use/);
    assert.doesNotMatch(readme, /0\.1\.0/);
    assert.doesNotMatch(readme, /scenario validate is not implemented yet/);
    assert.match(readme, /samotest doctor/);
    assert.match(readme, /samotest record my-browser-scenario --format video/);
    assert.match(readme, /record --format gif.*video fallback evidence/);
  });

  it("runs the required PR workflow commands", async () => {
    const workflow = await readFile(".github/workflows/pr.yml", "utf8");

    assert.match(workflow, /pull_request:/);
    assert.match(workflow, /oven-sh\/setup-bun/);
    assert.match(workflow, /run: bun install --frozen-lockfile/);
    assert.match(workflow, /run: bun test/);
    assert.match(workflow, /run: bun run typecheck/);
    assert.match(workflow, /run: bun run build/);
  });

  it("packs and installs a working samotest --version bin", async () => {
    const cwd = process.cwd();
    const tempDir = await mkdtemp(join(tmpdir(), "samotest-package-smoke-"));
    const installDir = join(tempDir, "install");

    try {
      await run("bun", ["run", "build"], { cwd });
      const pack = await run("bun", ["pm", "pack", "--destination", tempDir, "--quiet"], { cwd });
      const filename = pack.stdout.trim().split(/\r?\n/).at(-1);
      assert.ok(filename, "bun pm pack should print a tarball filename");

      await run("bun", ["init", "-y"], { cwd: installDir, createCwd: true });
      const tarballPath = isAbsolute(filename) ? filename : join(tempDir, filename);
      await run("bun", ["add", tarballPath], { cwd: installDir });

      const bin = await run(join(installDir, "node_modules/.bin/samotest"), ["--version"], { cwd: installDir });
      const bunOnlyBin = await run(join(installDir, "node_modules/.bin/samotest"), ["--version"], {
        cwd: installDir,
        env: {
          ...process.env,
          PATH: dirname(process.execPath),
        },
      });

      assert.equal(bin.stdout, "0.2.2\n");
      assert.equal(bin.stderr, "");
      assert.equal(bunOnlyBin.stdout, "0.2.2\n");
      assert.equal(bunOnlyBin.stderr, "");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 15000);
});

async function run(
  command: string,
  args: string[],
  options: { cwd: string; createCwd?: boolean; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  if (options.createCwd) {
    await mkdir(options.cwd, { recursive: true });
  }

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
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
