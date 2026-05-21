import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  AUTOMATED_ACTION_TYPES,
  validateScenarioFile,
  validateScenarioContent,
} from "../src/scenarioValidation.js";

describe("validateScenarioFile", () => {
  it("accepts a scenario fixture with the required SPEC.md fields", async () => {
    const result = await validateScenarioFile(
      "tests/fixtures/scenarios/valid-checkout.yaml",
    );

    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.scenario?.id, "checkout-discount-demo");
    assert.equal(result.scenario?.result.required_observations.length, 2);
  });

  it("rejects an invalid scenario fixture with file path and field context", async () => {
    const result = await validateScenarioFile(
      "tests/fixtures/scenarios/invalid-missing-fields.yaml",
    );

    assert.equal(result.valid, false);
    assert.deepEqual(
      result.errors.map((error) => ({
        path: error.filePath,
        field: error.field,
      })),
      [
        {
          path: "tests/fixtures/scenarios/invalid-missing-fields.yaml",
          field: "title",
        },
        {
          path: "tests/fixtures/scenarios/invalid-missing-fields.yaml",
          field: "steps",
        },
        {
          path: "tests/fixtures/scenarios/invalid-missing-fields.yaml",
          field: "result.required_observations",
        },
      ],
    );
    assert.match(result.errors[0]?.message ?? "", /title/);
    assert.match(result.errors[0]?.message ?? "", /invalid-missing-fields\.yaml/);
  });

  it("accepts steps with an optional v0.3 action field whose type is supported", () => {
    const yaml = `id: action-ok
title: Action OK
owner: "@me"
priority: required
steps:
  - id: go
    action:
      type: navigate
      url: "https://x.test/"
result:
  required_observations:
    - "ok"
`;
    const result = validateScenarioContent(yaml, "in-memory.yaml");
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  it("rejects steps with an action whose type is not in AUTOMATED_ACTION_TYPES", () => {
    const yaml = `id: action-bad
title: Action Bad
owner: "@me"
priority: required
steps:
  - id: go
    action:
      type: frobnicate
result:
  required_observations:
    - "ok"
`;
    const result = validateScenarioContent(yaml, "in-memory.yaml");
    assert.equal(result.valid, false);
    if (!result.valid) {
      assert.match(result.errors[0]?.message ?? "", /unknown action\.type `frobnicate`/);
      // The error message should list the supported types so contributors see them.
      for (const type of AUTOMATED_ACTION_TYPES) {
        assert.match(result.errors[0]?.message ?? "", new RegExp(type));
      }
    }
  });
});
