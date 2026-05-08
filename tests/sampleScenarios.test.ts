import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { inspectEvidence } from "../src/evidence.js";
import { validateScenarioFile } from "../src/scenarioValidation.js";

const repoRoot = join(import.meta.dirname, "..");

describe("Sprint 1 sample scenarios and demo evidence", () => {
  it("commits one CLI sample scenario and one browser/UI sample scenario", async () => {
    const scenarioPaths = [
      ".samotest/scenarios/sprint1-cli-smoke.yaml",
      ".samotest/scenarios/sprint1-browser-ui-smoke.yaml",
    ];

    for (const scenarioPath of scenarioPaths) {
      const result = await validateScenarioFile(join(repoRoot, scenarioPath));
      assert.equal(result.valid, true, `${scenarioPath} should match the Sprint 1 scenario schema`);
    }
  });

  it("documents external screenshot, GIF, video, and cast attachment workflow", async () => {
    const docs = await readFile(join(repoRoot, "docs/sprint-1-evidence-attachments.md"), "utf8");

    assert.match(docs, /external tools/i);
    assert.match(docs, /screenshot/i);
    assert.match(docs, /GIF/i);
    assert.match(docs, /video/i);
    assert.match(docs, /cast/i);
    assert.match(docs, /native GIF\/video generation is deferred/i);
  });

  it("includes a small inspectable demo manifest with a fixture attachment", async () => {
    const inspection = await inspectEvidence("samples/evidence/sprint1-cli-smoke", repoRoot);

    assert.equal(inspection.ok, true);
    assert.equal(inspection.manifest.run.scenario_id, "sprint1-cli-smoke");
    assert.equal(inspection.manifest.artifacts?.[0]?.type, "log");
    assert.equal(inspection.artifact_checks[0]?.ok, true);
  });
});
