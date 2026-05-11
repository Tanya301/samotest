import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { inspectEvidence } from "../src/evidence.js";
import { runCli } from "../src/cli.js";

describe("samotest recorder capture", () => {
  it("reports recorder availability in doctor output without crashing on missing tools", async () => {
    const result = await runCli(["doctor"], {
      recorderDoctor: async () => ({
        screenshot: {
          available: false,
          tool: "Playwright",
          detail: "Install playwright and a browser with `bunx playwright install chromium`.",
        },
        video: {
          available: false,
          tool: "Playwright",
          detail: "Install playwright and a browser with `bunx playwright install chromium`.",
        },
        gif: {
          available: false,
          tool: "ffmpeg",
          detail: "Install ffmpeg to convert browser videos to GIF.",
        },
        cast: {
          available: false,
          tool: "asciinema",
          detail: "Install asciinema to record terminal casts.",
        },
      }),
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Recorder availability/);
    assert.match(result.stdout, /screenshot\s+missing\s+Playwright/);
    assert.match(result.stdout, /video\s+missing\s+Playwright/);
    assert.match(result.stdout, /gif\s+missing\s+ffmpeg/);
    assert.match(result.stdout, /bunx playwright install chromium/);
    assert.match(result.stdout, /cast\s+missing\s+asciinema/);
    assert.equal(result.stderr, "");
  });

  it("records a browser screenshot through a stubbed recorder and writes an inspectable manifest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-record-"));

    try {
      await mkdir(join(cwd, ".samotest/scenarios"), { recursive: true });
      await writeFile(
        join(cwd, ".samotest/scenarios/browser-checkout.yaml"),
        `id: browser-checkout
title: Browser checkout smoke
owner: "@team-web"
priority: required
target:
  type: browser
  url: "https://example.test/checkout"
steps:
  - id: open-checkout
    instruction: "Open checkout."
result:
  required_observations:
    - "Checkout renders."
`,
      );

      const result = await runCli(
        [
          "record",
          "browser-checkout",
          "--format",
          "screenshot",
          "--run-id",
          "record-001",
          "--output",
          ".samotest/evidence",
        ],
        {
          cwd,
          screenshotRecorder: async ({ outputPath, url }) => {
            assert.equal(url, "https://example.test/checkout");
            await writeFile(outputPath, "fake png bytes");
            return {
              browser: "stub-browser",
            };
          },
        },
      );

      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Recorded screenshot evidence record-001/);
      assert.match(result.stdout, /manifest\.json/);

      const runDir = join(cwd, ".samotest/evidence/record-001");
      const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
      assert.equal(manifest.run.id, "record-001");
      assert.equal(manifest.run.scenario_id, "browser-checkout");
      assert.equal(manifest.run.status, "passed");
      assert.equal(manifest.environment.browser, "stub-browser");
      assert.equal(manifest.artifacts[0].type, "screenshot");
      assert.equal(manifest.artifacts[0].path, "artifacts/screenshot.png");
      assert.match(manifest.artifacts[0].sha256, /^[a-f0-9]{64}$/);

      const inspection = await inspectEvidence(runDir, cwd);
      assert.equal(inspection.ok, true);
      assert.equal(inspection.artifact_checks[0]?.ok, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns an actionable error when screenshot recording dependencies are unavailable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-record-missing-"));

    try {
      await mkdir(join(cwd, ".samotest/scenarios"), { recursive: true });
      await writeFile(
        join(cwd, ".samotest/scenarios/browser-checkout.yaml"),
        `id: browser-checkout
title: Browser checkout smoke
owner: "@team-web"
priority: required
target:
  type: browser
  url: "https://example.test/checkout"
steps:
  - id: open-checkout
    instruction: "Open checkout."
result:
  required_observations:
    - "Checkout renders."
`,
      );

      const result = await runCli(["record", "browser-checkout", "--format", "screenshot"], {
        cwd,
        recorderDoctor: async () => ({
          screenshot: {
            available: false,
            tool: "Playwright",
            detail: "Install playwright and a browser with `bunx playwright install chromium`.",
          },
          video: {
            available: false,
            tool: "Playwright",
            detail: "Install playwright and a browser with `bunx playwright install chromium`.",
          },
          gif: {
            available: false,
            tool: "ffmpeg",
            detail: "Install ffmpeg to convert browser videos to GIF.",
          },
          cast: {
            available: false,
            tool: "asciinema",
            detail: "Install asciinema to record terminal casts.",
          },
        }),
      });

      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /Screenshot recorder unavailable/);
      assert.match(result.stderr, /bunx playwright install chromium/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("records browser video through a stubbed recorder and writes an inspectable manifest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-record-video-"));

    try {
      await writeBrowserScenario(cwd);

      const result = await runCli(
        [
          "record",
          "browser-checkout",
          "--format",
          "video",
          "--run-id",
          "record-video-001",
          "--output",
          ".samotest/evidence",
        ],
        {
          cwd,
          videoRecorder: async ({ outputPath, url }) => {
            assert.equal(url, "https://example.test/checkout");
            await writeFile(outputPath, "fake webm bytes");
            return {
              browser: "stub-chromium",
            };
          },
        },
      );

      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /Recorded video evidence record-video-001/);

      const runDir = join(cwd, ".samotest/evidence/record-video-001");
      const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
      assert.equal(manifest.environment.browser, "stub-chromium");
      assert.equal(manifest.artifacts[0].type, "video");
      assert.equal(manifest.artifacts[0].path, "artifacts/video.webm");
      assert.match(manifest.artifacts[0].sha256, /^[a-f0-9]{64}$/);

      const inspection = await inspectEvidence(runDir, cwd);
      assert.equal(inspection.ok, true);
      assert.equal(inspection.artifact_checks[0]?.ok, true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to video evidence when GIF conversion is unavailable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-record-gif-fallback-"));

    try {
      await writeBrowserScenario(cwd);

      const result = await runCli(
        [
          "record",
          "browser-checkout",
          "--format",
          "gif",
          "--run-id",
          "record-gif-001",
          "--output",
          ".samotest/evidence",
        ],
        {
          cwd,
          recorderDoctor: async () => ({
            screenshot: { available: true, tool: "Playwright", detail: "ok" },
            video: { available: true, tool: "Playwright", detail: "ok" },
            gif: { available: false, tool: "ffmpeg", detail: "Install ffmpeg to convert browser videos to GIF." },
            cast: { available: true, tool: "asciinema", detail: "ok" },
          }),
          videoRecorder: async ({ outputPath }) => {
            await writeFile(outputPath, "fallback webm bytes");
            return {
              browser: "stub-chromium",
            };
          },
        },
      );

      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /GIF conversion unavailable/);
      assert.match(result.stdout, /Recorded video fallback evidence record-gif-001/);

      const manifest = JSON.parse(await readFile(join(cwd, ".samotest/evidence/record-gif-001/manifest.json"), "utf8"));
      assert.equal(manifest.artifacts[0].type, "video");
      assert.equal(manifest.artifacts[0].path, "artifacts/video.webm");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns an actionable error when cast recording dependencies are unavailable", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "samotest-record-cast-missing-"));

    try {
      await writeTerminalScenario(cwd);

      const result = await runCli(["record", "terminal-smoke", "--format", "cast"], {
        cwd,
        recorderDoctor: async () => ({
          screenshot: { available: true, tool: "Playwright", detail: "ok" },
          video: { available: true, tool: "Playwright", detail: "ok" },
          gif: { available: true, tool: "ffmpeg", detail: "ok" },
          cast: {
            available: false,
            tool: "asciinema",
            detail: "Install asciinema to record terminal casts.",
          },
        }),
      });

      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /Cast recorder unavailable/);
      assert.match(result.stderr, /Install asciinema/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function writeBrowserScenario(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".samotest/scenarios"), { recursive: true });
  await writeFile(
    join(cwd, ".samotest/scenarios/browser-checkout.yaml"),
    `id: browser-checkout
title: Browser checkout smoke
owner: "@team-web"
priority: required
target:
  type: browser
  url: "https://example.test/checkout"
steps:
  - id: open-checkout
    instruction: "Open checkout."
result:
  required_observations:
    - "Checkout renders."
`,
  );
}

async function writeTerminalScenario(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".samotest/scenarios"), { recursive: true });
  await writeFile(
    join(cwd, ".samotest/scenarios/terminal-smoke.yaml"),
    `id: terminal-smoke
title: Terminal smoke
owner: "@team-cli"
priority: required
recording:
  mode: terminal
  command: "printf hello"
steps:
  - id: run-command
    instruction: "Run the smoke command."
result:
  required_observations:
    - "Command prints hello."
`,
  );
}
