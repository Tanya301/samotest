/**
 * Production Playwright driver for the automated runner.
 *
 * Launches a headless Chromium with `recordVideo` + `recordHar`
 * configured to write into the run's `artifacts/` directory, and
 * forwards `console.*` events into a console log file. The handle
 * exposes a thin `PlaywrightLike` wrapper so the action executors
 * (and their unit tests) can ignore Playwright internals.
 */

import { appendFile, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  AutomatedDriverHandle,
  AutomatedDriverLaunchInput,
  AutomatedRunnerDriver,
} from "./automatedRunner.js";
import type { PlaywrightLike } from "./automatedActions.js";

interface PlaywrightModule {
  chromium: {
    launch: (options?: Record<string, unknown>) => Promise<unknown>;
  };
}

async function importPlaywright(): Promise<PlaywrightModule> {
  // Hide from bundler so this module never tries to eagerly resolve
  // playwright when samotest is consumed as a dist build.
  const dynamicImport = new Function("specifier", "return import(specifier)") as (s: string) => Promise<PlaywrightModule>;
  return dynamicImport("playwright");
}

export const realPlaywrightDriver: AutomatedRunnerDriver = {
  async launch(input: AutomatedDriverLaunchInput): Promise<AutomatedDriverHandle> {
    await mkdir(input.artifactsDir, { recursive: true });

    const playwright = await importPlaywright();
    const browser = (await playwright.chromium.launch({ headless: true })) as {
      newContext: (options?: Record<string, unknown>) => Promise<unknown>;
      close: () => Promise<void>;
    };

    const context = (await browser.newContext({
      recordVideo: { dir: input.artifactsDir },
      recordHar: { path: input.harPath, content: "embed" },
    })) as {
      newPage: () => Promise<unknown>;
      close: () => Promise<void>;
    };

    const page = (await context.newPage()) as PageInternal;

    // Attach console listener -> append to console.log.
    page.on?.("console", async (message: ConsoleMessage) => {
      try {
        const line = `[${new Date().toISOString()}] ${message.type()} ${message.text()}\n`;
        await mkdir(dirname(input.consoleLogPath), { recursive: true });
        await appendFile(input.consoleLogPath, line, "utf8");
      } catch {
        // Console capture is best-effort; do not crash the run.
      }
    });
    page.on?.("pageerror", async (error: Error) => {
      try {
        await appendFile(input.consoleLogPath, `[${new Date().toISOString()}] pageerror ${error.message}\n`, "utf8");
      } catch {
        // best-effort
      }
    });

    const wrapped: PlaywrightLike = {
      goto: (url, options) => page.goto(url, asGotoOptions(options)),
      click: (selector, options) => page.click(selector, options),
      fill: (selector, value, options) => page.fill(selector, value, options),
      waitForSelector: (selector, options) => page.waitForSelector(selector, options),
      waitForURL: (urlOrPredicate, options) => page.waitForURL(urlOrPredicate as never, options),
      url: () => page.url(),
      screenshot: (options) => page.screenshot(options),
      textContent: (selector, options) => page.textContent(selector, options),
      evaluate: (fn) => page.evaluate(fn as never),
    };

    return {
      page: wrapped,
      close: async () => {
        const result: { videoPath?: string; harPath?: string; consoleLogPath?: string } = {};
        let videoFinal: string | undefined;
        try {
          const video = (page as { video?: () => { path?: () => Promise<string> } | undefined }).video?.();
          await context.close();
          // After context.close() Playwright writes the video to a path under
          // recordVideo.dir; we move it to the canonical run.webm.
          const recordedPath = await video?.path?.();
          if (recordedPath) {
            try {
              await rename(recordedPath, input.videoPath);
              videoFinal = input.videoPath;
            } catch {
              videoFinal = recordedPath;
            }
          }
          result.videoPath = videoFinal;
          result.harPath = input.harPath;
          result.consoleLogPath = input.consoleLogPath;
        } finally {
          try {
            await browser.close();
          } catch {
            // best-effort
          }
        }
        // Suppress unused-import warning.
        void rm;
        return result;
      },
    };
  },
};

interface PageInternal {
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  click: (selector: string, options?: Record<string, unknown>) => Promise<unknown>;
  fill: (selector: string, value: string, options?: Record<string, unknown>) => Promise<unknown>;
  waitForSelector: (selector: string, options?: Record<string, unknown>) => Promise<unknown>;
  waitForURL: (url: string | RegExp, options?: Record<string, unknown>) => Promise<unknown>;
  url: () => string;
  screenshot: (options: { path: string; fullPage?: boolean }) => Promise<unknown>;
  textContent: (selector: string, options?: Record<string, unknown>) => Promise<string | null>;
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
  on?: (event: string, listener: (...args: never[]) => unknown) => unknown;
  video?: () => { path?: () => Promise<string> } | undefined;
}

interface ConsoleMessage {
  type: () => string;
  text: () => string;
}

function asGotoOptions(options?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!options) return undefined;
  // Playwright accepts a small set of wait states; pass through what we get.
  return options;
}
