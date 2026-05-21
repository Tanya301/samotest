import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { runAutomated, type AutomatedRunnerDriver } from "../src/automatedRunner.js";
import type { PlaywrightLike } from "../src/automatedActions.js";
import type { ScenarioDefinition } from "../src/scenarioValidation.js";

function makeMockDriver(): {
  driver: AutomatedRunnerDriver;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const page: PlaywrightLike = {
    goto: async (url, options) => {
      calls.push({ method: "goto", args: [url, options] });
    },
    click: async (selector) => {
      calls.push({ method: "click", args: [selector] });
    },
    fill: async (selector, value) => {
      calls.push({ method: "fill", args: [selector, value] });
    },
    waitForSelector: async (selector) => {
      calls.push({ method: "waitForSelector", args: [selector] });
    },
    waitForURL: async (url) => {
      calls.push({ method: "waitForURL", args: [url] });
    },
    url: () => "https://example.test/dashboard",
    screenshot: async (options) => {
      await Bun.write(options.path, "fake-png");
    },
    textContent: async () => "ok",
    evaluate: async () => "stable" as never,
  };
  const driver: AutomatedRunnerDriver = {
    launch: async (_input) => ({
      page,
      close: async () => ({ videoPath: undefined, harPath: undefined, consoleLogPath: undefined }),
    }),
  };
  return { driver, calls };
}

describe("runAutomated", () => {
  it("executes every step and writes a passing manifest + phase summary file", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "samotest-runner-pass-"));
    try {
      const { driver } = makeMockDriver();
      const scenario: ScenarioDefinition = {
        id: "smoke",
        title: "Smoke",
        owner: "@me",
        priority: "required",
        steps: [
          { id: "load", phase: "load", action: { type: "navigate", url: "https://example.test/" } },
          { id: "shot", phase: "load", action: { type: "screenshot" } },
          { id: "ver", phase: "verify", action: { type: "assert_url_matches", regex: ".*example\\.test.*" } },
        ],
        result: { required_observations: ["x"] },
      };
      const phaseSummaries: string[] = [];
      const result = await runAutomated({
        scenario,
        runId: "run-001",
        outputRoot,
        cwd: outputRoot,
        driver,
        env: {},
        onPhaseComplete: (summary) => {
          phaseSummaries.push(`${summary.phase}:${summary.status}:${summary.steps.length}`);
        },
        now: () => new Date("2026-05-21T00:00:00Z"),
        currentCommit: async () => "deadbeef",
      });

      assert.equal(result.status, "passed");
      assert.equal(result.phaseSummaries.length, 2);
      assert.deepEqual(phaseSummaries, ["load:passed:2", "verify:passed:1"]);

      const manifest = JSON.parse(await readFile(join(outputRoot, "run-001/manifest.json"), "utf8"));
      assert.equal(manifest.run.status, "passed");
      assert.equal(manifest.run.scenario_id, "smoke");

      const phaseDoc = JSON.parse(await readFile(join(outputRoot, "run-001/phase-summaries.json"), "utf8"));
      assert.equal(phaseDoc.phases.length, 2);
      assert.equal(phaseDoc.status, "passed");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("halts on the first failing step, captures a crash screenshot, and writes a failed manifest", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "samotest-runner-fail-"));
    try {
      const { driver } = makeMockDriver();
      const scenario: ScenarioDefinition = {
        id: "fails",
        title: "Fails",
        owner: "@me",
        priority: "required",
        steps: [
          { id: "load", phase: "load", action: { type: "navigate", url: "https://x.test/" } },
          { id: "asserts-fail", phase: "verify", action: { type: "assert_url_matches", regex: "^https://nope" } },
          { id: "never-runs", phase: "verify", action: { type: "screenshot" } },
        ],
        result: { required_observations: ["x"] },
      };
      const result = await runAutomated({
        scenario,
        runId: "run-002",
        outputRoot,
        cwd: outputRoot,
        driver,
        env: {},
        now: () => new Date("2026-05-21T00:00:00Z"),
        currentCommit: async () => "deadbeef",
      });

      assert.equal(result.status, "failed");
      assert.equal(result.failedStepId, "asserts-fail");
      const manifest = JSON.parse(await readFile(join(outputRoot, "run-002/manifest.json"), "utf8"));
      assert.equal(manifest.run.status, "failed");
      // Crash screenshot is captured under artifacts/.
      const screenshots = (manifest.artifacts ?? []).filter((artifact: { type: string }) => artifact.type === "screenshot");
      assert.ok(screenshots.some((artifact: { name: string }) => artifact.name.includes("crash")));
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("throws MissingEnvVarError when a required ${env.VAR} is unset (fail-loudly contract)", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "samotest-runner-env-"));
    try {
      const { driver } = makeMockDriver();
      const scenario: ScenarioDefinition = {
        id: "envless",
        title: "Envless",
        owner: "@me",
        priority: "required",
        steps: [{ id: "go", action: { type: "navigate", url: "${env.SAMO_BASE_URL}/" } }],
        result: { required_observations: ["x"] },
      };
      let thrown: unknown;
      try {
        await runAutomated({
          scenario,
          runId: "run-003",
          outputRoot,
          cwd: outputRoot,
          driver,
          env: {},
          now: () => new Date("2026-05-21T00:00:00Z"),
          currentCommit: async () => "deadbeef",
        });
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof Error);
      assert.match((thrown as Error).message, /SAMO_BASE_URL/);
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });

  it("fails loudly when --automated is used with a step that lacks an action block", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "samotest-runner-noaction-"));
    try {
      const { driver } = makeMockDriver();
      const scenario: ScenarioDefinition = {
        id: "manual-leftover",
        title: "Mixed",
        owner: "@me",
        priority: "required",
        steps: [
          { id: "load", phase: "p", action: { type: "navigate", url: "https://x.test/" } },
          { id: "manual-step", phase: "p", instruction: "Click around" },
        ],
        result: { required_observations: ["x"] },
      };
      const result = await runAutomated({
        scenario,
        runId: "run-004",
        outputRoot,
        cwd: outputRoot,
        driver,
        env: {},
        now: () => new Date("2026-05-21T00:00:00Z"),
        currentCommit: async () => "deadbeef",
      });
      assert.equal(result.status, "failed");
      assert.equal(result.failedStepId, "manual-step");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
