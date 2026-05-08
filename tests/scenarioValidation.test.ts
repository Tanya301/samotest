import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateScenarioFile } from "../src/scenarioValidation.js";

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
});
