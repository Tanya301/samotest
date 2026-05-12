import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
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
      assert.match(result.stdout, /Initialized samo\/ and \.samo\//);
      assert.equal((await stat(join(cwd, ".samo/config.yaml"))).isFile(), true);
      assert.equal((await stat(join(cwd, "samo/scenarios"))).isDirectory(), true);
      assert.equal((await stat(join(cwd, ".samo/evidence"))).isDirectory(), true);
      assert.match(await readFile(join(cwd, ".gitignore"), "utf8"), /\.samo\/evidence\//);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("validates a scenario file from the CLI", async () => {
    const result = await runCli([
      "scenario",
      "validate",
      "tests/fixtures/scenarios/valid-checkout.yaml",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /Valid scenario: checkout-discount-demo/);
    assert.match(result.stdout, /tests\/fixtures\/scenarios\/valid-checkout\.yaml/);
    assert.equal(result.stderr, "");
  });

  it("returns actionable CLI output for an invalid scenario file", async () => {
    const result = await runCli([
      "scenario",
      "validate",
      "tests/fixtures/scenarios/invalid-missing-fields.yaml",
    ]);

    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Invalid scenario: tests\/fixtures\/scenarios\/invalid-missing-fields\.yaml/);
    assert.match(result.stderr, /title/);
    assert.match(result.stderr, /steps/);
    assert.match(result.stderr, /result\.required_observations/);
  });

  it("runs a scenario non-interactively and records step statuses, notes, and attachments", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-run-"));

    try {
      await mkdir(join(cwd, "samo/scenarios"), { recursive: true });
      await mkdir(join(cwd, "artifacts"), { recursive: true });
      await writeFile(join(cwd, "artifacts/open-cart.png"), "fake screenshot");
      await writeFile(join(cwd, "artifacts/apply-code.log"), "fake log");
      await writeFile(
        join(cwd, "samo/scenarios/checkout-discount-demo.yaml"),
        `id: checkout-discount-demo
title: Checkout discount manual demo
owner: "@team-web"
priority: required
prerequisites:
  - "Seed the demo account."
steps:
  - id: open-cart
    instruction: "Open the cart page for the seeded demo account."
  - id: apply-code
    instruction: "Apply discount code SAVE10."
    expected: "Order summary shows a 10% discount and updated total."
    allow_waive: true
result:
  required_observations:
    - "Discount appears once."
`,
      );

      const result = await runCli(
        [
          "run",
          "checkout-discount-demo",
          "--run-id",
          "run-001",
          "--non-interactive",
          "--output",
          ".samo/evidence",
        ],
        {
          cwd,
          stdin: [
            "run note: observed in Chrome",
            "passed",
            "step note: cart rendered",
            "screenshot artifacts/open-cart.png",
            "",
            "waived",
            "step note: discount service waived by QA lead",
            "log artifacts/apply-code.log",
            "",
          ].join("\n"),
        },
      );

      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /Recorded run run-001/);

      const run = JSON.parse(
        await readFile(join(cwd, ".samo/evidence/run-001/run.json"), "utf8"),
      );
      assert.equal(run.scenario.id, "checkout-discount-demo");
      assert.equal(run.notes[0], "observed in Chrome");
      assert.equal(run.steps[0].status, "passed");
      assert.equal(run.steps[0].notes[0], "cart rendered");
      assert.equal(run.steps[0].attachments[0].kind, "screenshot");
      assert.equal(run.steps[0].attachments[0].path, "artifacts/open-cart.png");
      assert.equal(run.steps[1].status, "waived");
      assert.equal(run.steps[1].attachments[0].kind, "log");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reads piped stdin in the default guided run mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-run-"));

    try {
      await mkdir(join(cwd, "samo/scenarios"), { recursive: true });
      await mkdir(join(cwd, "artifacts"), { recursive: true });
      await writeFile(join(cwd, "artifacts/open-cart.png"), "fake screenshot");
      await writeFile(
        join(cwd, "samo/scenarios/checkout-discount-demo.yaml"),
        `id: checkout-discount-demo
title: Checkout discount manual demo
owner: "@team-web"
priority: required
steps:
  - id: open-cart
    instruction: "Open the cart page for the seeded demo account."
result:
  required_observations:
    - "Cart page opens."
`,
      );

      const result = await runCliProcess(
        [
          "run",
          "checkout-discount-demo",
          "--run-id",
          "run-default",
          "--output",
          ".samo/evidence",
        ],
        {
          cwd,
          stdin: ["run note: smoke", "passed", "step note: cart rendered", "screenshot artifacts/open-cart.png", ""].join(
            "\n",
          ),
        },
      );

      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Status \[passed\|failed\|blocked\|skipped\|waived\]:/);
      assert.match(result.stdout, /Recorded run run-default/);

      const run = JSON.parse(
        await readFile(join(cwd, ".samo/evidence/run-default/run.json"), "utf8"),
      );
      assert.equal(run.metadata.non_interactive, false);
      assert.equal(run.notes[0], "smoke");
      assert.equal(run.steps[0].status, "passed");
      assert.equal(run.steps[0].attachments[0].path, "artifacts/open-cart.png");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects waived step status unless the scenario step allows it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-run-"));

    try {
      await mkdir(join(cwd, "samo/scenarios"), { recursive: true });
      await writeFile(
        join(cwd, "samo/scenarios/no-waive.yaml"),
        `id: no-waive
title: No waive scenario
owner: "@team-web"
priority: required
steps:
  - id: only-step
    instruction: "Run the check."
result:
  required_observations:
    - "Check was run."
`,
      );

      const result = await runCli(["run", "no-waive", "--non-interactive"], {
        cwd,
        stdin: ["", "waived", "", ""].join("\n"),
      });

      assert.equal(result.exitCode, 3);
      assert.match(result.stderr, /Step only-step does not allow waived status/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function runCliProcess(
  args: string[],
  options: { cwd: string; stdin: string },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const repoRoot = join(import.meta.dirname, "..");
  const child = spawn("bun", [
    join(repoRoot, "src/cli.ts"),
    ...args,
  ], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
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
  child.stdin.end(options.stdin);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  return { exitCode, stdout, stderr };
}
