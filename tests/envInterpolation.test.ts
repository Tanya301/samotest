import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { MissingEnvVarError, interpolateEnvTokens } from "../src/envInterpolation.js";

describe("envInterpolation", () => {
  it("substitutes ${env.VAR} tokens with values from the supplied env", () => {
    const result = interpolateEnvTokens(
      {
        url: "${env.BASE}/login",
        nested: { email: "${env.EMAIL}" },
        items: ["${env.A}", "literal", "${env.B}"],
      },
      { env: { BASE: "https://x.test", EMAIL: "u@e.com", A: "alpha", B: "beta" } },
    );

    assert.deepEqual(result, {
      url: "https://x.test/login",
      nested: { email: "u@e.com" },
      items: ["alpha", "literal", "beta"],
    });
  });

  it("supports ${env.VAR:-fallback} default-value syntax", () => {
    const result = interpolateEnvTokens(
      { url: "${env.MISSING:-https://default.test}", port: "${env.PORT:-8080}" },
      { env: {} },
    );
    assert.deepEqual(result, { url: "https://default.test", port: "8080" });
  });

  it("throws MissingEnvVarError when a required ${env.VAR} is unset", () => {
    let thrown: unknown;
    try {
      interpolateEnvTokens({ url: "${env.REQUIRED_VAR}/x" }, { env: {} });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof MissingEnvVarError);
    assert.match((thrown as MissingEnvVarError).message, /REQUIRED_VAR/);
    assert.equal((thrown as MissingEnvVarError).references.length, 1);
    assert.equal((thrown as MissingEnvVarError).references[0]?.variable, "REQUIRED_VAR");
  });

  it("aggregates missing-var references across the whole tree", () => {
    let thrown: unknown;
    try {
      interpolateEnvTokens(
        {
          a: "${env.A}",
          b: { c: "${env.B}" },
          d: ["${env.C}", "${env.A}"],
        },
        { env: {} },
      );
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof MissingEnvVarError);
    const variables = (thrown as MissingEnvVarError).references.map((reference) => reference.variable);
    assert.deepEqual(new Set(variables), new Set(["A", "B", "C"]));
  });

  it("leaves primitives and tokens-without-env untouched", () => {
    const result = interpolateEnvTokens({ x: 42, y: true, z: null, arr: [1, 2] }, { env: {} });
    assert.deepEqual(result, { x: 42, y: true, z: null, arr: [1, 2] });
  });
});
