import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { runCli } from "../src/cli.js";
import type { AutomatedRunnerDriver } from "../src/automatedRunner.js";
import type { PlaywrightLike } from "../src/automatedActions.js";

/**
 * Integration smoke: run --automated against a local HTTP fixture using
 * a stubbed Playwright driver. Verifies that the CLI wires the scenario
 * to the runner, the env-interpolation contract, evidence-manifest
 * writes, and consolidated phase comments.
 *
 * Per the v0.3 sample manifest in `samples/automated-smoke.yaml`, the
 * scenario walks: navigate -> form_fill -> screenshot -> api_call ->
 * assert_url_matches.
 */
describe("samotest run --automated CLI integration", () => {
  it("walks an automated scenario end-to-end against a local fixture HTTP server", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-auto-cli-"));
    const server = Bun.serve({
      port: 0,
      fetch(req: Request): Response {
        const url = new URL(req.url);
        if (url.pathname === "/" && req.method === "GET") {
          return new Response(
            `<html><body><a id=login href="/login">login</a></body></html>`,
            { headers: { "content-type": "text/html" } },
          );
        }
        if (url.pathname === "/login") {
          return new Response(`<html><body><form><input id=email/><input id=password type=password/><button data-testid=submit></button></form></body></html>`, {
            headers: { "content-type": "text/html" },
          });
        }
        if (url.pathname === "/dashboard") {
          return new Response("<html><body><h1>Hello</h1></body></html>", {
            headers: { "content-type": "text/html" },
          });
        }
        if (url.pathname === "/api/version") {
          return Response.json({ version: "v0.3.0-test" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const baseUrl = `http://localhost:${server.port}`;

    try {
      await mkdir(join(cwd, "samo/scenarios"), { recursive: true });
      await writeFile(
        join(cwd, "samo/scenarios/auto-smoke.yaml"),
        `id: auto-smoke
title: Automated smoke walk
owner: "@me"
priority: required
steps:
  - id: landing
    phase: bootstrap
    action:
      type: navigate
      url: "\${env.SMOKE_BASE_URL}/"
  - id: login
    phase: auth
    action:
      type: form_fill
      url: "\${env.SMOKE_BASE_URL}/login"
      fields:
        - selector: "#email"
          value: "u@e.com"
        - selector: "#password"
          value: "pw"
      submit: "[data-testid=submit]"
  - id: ver
    phase: assert
    action:
      type: api_call
      method: GET
      url: "\${env.SMOKE_BASE_URL}/api/version"
      expect_status: 200
      expect_json_contains:
        version: "v0.3.0-test"
result:
  required_observations:
    - "Smoke walk completed"
`,
      );

      // Stub driver records call sequence + maintains url state.
      let currentUrl = `${baseUrl}/`;
      const page: PlaywrightLike = {
        goto: async (url) => {
          currentUrl = url;
        },
        click: async () => {},
        fill: async () => {},
        waitForSelector: async () => {},
        waitForURL: async (url) => {
          if (typeof url === "string") currentUrl = url;
        },
        url: () => currentUrl,
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

      const phaseLines: string[] = [];
      const result = await runCli(
        [
          "run",
          "auto-smoke",
          "--automated",
          "--run-id",
          "auto-001",
          "--output",
          ".samo/evidence",
        ],
        {
          cwd,
          automatedDriver: driver,
          env: { SMOKE_BASE_URL: baseUrl },
          now: () => new Date("2026-05-21T00:00:00Z"),
          onPhaseComplete: (summary) => {
            phaseLines.push(`${summary.phase}:${summary.status}`);
          },
        },
      );

      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /samotest run --automated auto-smoke/);
      assert.match(result.stdout, /Run status: passed/);
      assert.deepEqual(phaseLines, ["bootstrap:passed", "auth:passed", "assert:passed"]);

      const manifestPath = join(cwd, ".samo/evidence/auto-001/manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(manifest.run.scenario_id, "auto-smoke");
      assert.equal(manifest.run.status, "passed");
    } finally {
      server.stop(true);
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails the CLI with exit code 3 when required ${env.*} variables are missing", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-auto-cli-env-"));
    try {
      await mkdir(join(cwd, "samo/scenarios"), { recursive: true });
      await writeFile(
        join(cwd, "samo/scenarios/envless.yaml"),
        `id: envless
title: Envless
owner: "@me"
priority: required
steps:
  - id: go
    action:
      type: navigate
      url: "\${env.REQUIRED_BASE}/"
result:
  required_observations: ["x"]
`,
      );
      const driver: AutomatedRunnerDriver = {
        launch: async () => ({
          page: {
            goto: async () => {},
            click: async () => {},
            fill: async () => {},
            waitForSelector: async () => {},
            waitForURL: async () => {},
            url: () => "",
            screenshot: async (options) => {
              await Bun.write(options.path, "x");
            },
            textContent: async () => "",
            evaluate: async () => "" as never,
          },
          close: async () => ({}),
        }),
      };

      const result = await runCli(
        ["run", "envless", "--automated", "--run-id", "envless-001"],
        { cwd, automatedDriver: driver, env: {} },
      );
      assert.equal(result.exitCode, 3);
      assert.match(result.stderr, /REQUIRED_BASE/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
