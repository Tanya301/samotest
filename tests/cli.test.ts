import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  it("runs a scenario non-interactively and records step statuses, notes, and attachments", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-run-"));

    try {
      await mkdir(join(cwd, ".samotest/scenarios"), { recursive: true });
      await mkdir(join(cwd, "artifacts"), { recursive: true });
      await writeFile(join(cwd, "artifacts/open-cart.png"), "fake screenshot");
      await writeFile(join(cwd, "artifacts/apply-code.log"), "fake log");
      await writeFile(
        join(cwd, ".samotest/scenarios/checkout-discount-demo.yaml"),
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
          ".samotest/evidence",
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
        await readFile(join(cwd, ".samotest/evidence/run-001/run.json"), "utf8"),
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

  it("rejects waived step status unless the scenario step allows it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-run-"));

    try {
      await mkdir(join(cwd, ".samotest/scenarios"), { recursive: true });
      await writeFile(
        join(cwd, ".samotest/scenarios/no-waive.yaml"),
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
