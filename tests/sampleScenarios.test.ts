import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { inspectEvidence } from "../src/evidence.js";
import { validateScenarioFile } from "../src/scenarioValidation.js";

const repoRoot = join(import.meta.dirname, "..");

describe("Sprint 1 sample scenarios and demo evidence", () => {
  it("commits one CLI sample scenario and one browser/UI sample scenario", async () => {
    const scenarioPaths = [
      "samo/scenarios/sprint1-cli-smoke.yaml",
      "samo/scenarios/sprint1-browser-ui-smoke.yaml",
    ];

    for (const scenarioPath of scenarioPaths) {
      const result = await validateScenarioFile(join(repoRoot, scenarioPath));
      assert.equal(result.valid, true, `${scenarioPath} should match the Sprint 1 scenario schema`);
    }
  });

  it("documents external attachment and native recorder workflows", async () => {
    const docs = await readFile(join(repoRoot, "docs/sprint-1-evidence-attachments.md"), "utf8");

    assert.match(docs, /external tools/i);
    assert.match(docs, /screenshot/i);
    assert.match(docs, /GIF/i);
    assert.match(docs, /video/i);
    assert.match(docs, /cast/i);
    assert.match(docs, /Sprint 3 adds native recorder generation/i);
    assert.match(docs, /samotest doctor/i);
    assert.match(docs, /ffmpeg.*fall back to browser video/i);
  });

  it("includes a small inspectable demo manifest with a fixture attachment", async () => {
    const inspection = await inspectEvidence("samples/evidence/sprint1-cli-smoke", repoRoot);

    assert.equal(inspection.ok, true);
    assert.equal(inspection.manifest.run.scenario_id, "sprint1-cli-smoke");
    assert.equal(inspection.manifest.artifacts?.[0]?.type, "log");
    assert.equal(inspection.artifact_checks[0]?.ok, true);
  });

  it("ships a v0.3 automated-mode sample scenario that validates against the schema", async () => {
    const result = await validateScenarioFile(join(repoRoot, "samples/automated-smoke.yaml"));
    assert.equal(result.valid, true, "samples/automated-smoke.yaml should validate under the schema");
    if (result.valid) {
      const steps = result.scenario.steps;
      const actionTypes = steps
        .map((step) => step.action?.type)
        .filter((value): value is string => typeof value === "string");
      assert.ok(actionTypes.includes("navigate"));
      assert.ok(actionTypes.includes("form_fill"));
      assert.ok(actionTypes.includes("screenshot"));
      assert.ok(actionTypes.includes("api_call"));
      assert.ok(actionTypes.includes("assert_url_matches"));
    }
  });
});
