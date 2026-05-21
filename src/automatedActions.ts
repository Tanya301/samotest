/**
 * Automated action executors for the `samotest run --automated` runner.
 *
 * Each action type maps to a small executor. The runner passes a shared
 * `ActionContext` (Playwright page, evidence directory, fetch impl,
 * abort signal, logger) plus the parsed action body, and the executor
 * carries out the action and returns either `ok: true` with optional
 * captured-evidence paths, or `ok: false` with a reason.
 *
 * Action types are deliberately small and composable; sequencing /
 * grouping / phase semantics live in the runner (`automatedRunner.ts`).
 *
 * All long waits in this file flow through `waitWithHeartbeat` per
 * HARD RULE 10 — no wall-clock LLM timeouts.
 */

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { waitWithHeartbeat } from "./heartbeat.js";
import type { ScenarioStepAction } from "./scenarioValidation.js";

const execFileAsync = promisify(execFile);

export interface PlaywrightLike {
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  click: (selector: string, options?: Record<string, unknown>) => Promise<unknown>;
  fill: (selector: string, value: string, options?: Record<string, unknown>) => Promise<unknown>;
  waitForSelector: (selector: string, options?: Record<string, unknown>) => Promise<unknown>;
  waitForURL: (urlOrPredicate: string | RegExp, options?: Record<string, unknown>) => Promise<unknown>;
  url: () => string;
  screenshot: (options: { path: string; fullPage?: boolean }) => Promise<unknown>;
  textContent: (selector: string, options?: Record<string, unknown>) => Promise<string | null>;
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}

export interface ActionContext {
  page: PlaywrightLike;
  /** Run directory; artifacts go under `${runDir}/artifacts/`. */
  runDir: string;
  /** Per-run, monotonically increasing screenshot index for auto-naming. */
  nextScreenshotIndex: () => number;
  /** Fetch impl (overridable for tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Process abort signal for user cancel. */
  signal?: AbortSignal;
  /** Optional override for heartbeat lines (defaults to stderr). */
  onHeartbeat?: (line: string) => void;
  /** Optional clock (testability). */
  now?: () => number;
  /** Optional sleep (testability). */
  sleep?: (ms: number) => Promise<void>;
  /** Optional execFile override (testability for gh_assert). */
  execFileImpl?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Optional logger for action-level events (default: noop). */
  logger?: (line: string) => void;
}

export interface ActionEvidenceArtifact {
  type: string;
  name: string;
  path: string;
}

export interface ActionResultOk {
  ok: true;
  /** Newly captured evidence artifacts produced as a side effect. */
  artifacts?: ActionEvidenceArtifact[];
  /** Optional human-readable note appended to the step observation. */
  note?: string;
  /** Optional duration in ms (the runner adds wall-clock if missing). */
  durationMs?: number;
}

export interface ActionResultFail {
  ok: false;
  reason: string;
  /** Newly captured evidence at the failure point (e.g. crash screenshot). */
  artifacts?: ActionEvidenceArtifact[];
}

export type ActionResult = ActionResultOk | ActionResultFail;

export type ActionExecutor = (
  action: ScenarioStepAction,
  stepId: string,
  ctx: ActionContext,
) => Promise<ActionResult>;

const ARTIFACTS_DIRNAME = "artifacts";

async function ensureArtifactsDir(ctx: ActionContext): Promise<string> {
  const dir = join(ctx.runDir, ARTIFACTS_DIRNAME);
  await mkdir(dir, { recursive: true });
  return dir;
}

function requireString(action: ScenarioStepAction, key: string): string {
  const value = (action as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`action.${action.type} requires string field \`${key}\``);
  }
  return value;
}

function optionalString(action: ScenarioStepAction, key: string): string | undefined {
  const value = (action as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(action: ScenarioStepAction, key: string): number | undefined {
  const value = (action as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(action: ScenarioStepAction, key: string): boolean | undefined {
  const value = (action as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function buildSlug(stepId: string): string {
  return stepId.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

// ---------------------------------------------------------------------------
// Individual action executors
// ---------------------------------------------------------------------------

export const navigateAction: ActionExecutor = async (action, _stepId, ctx) => {
  const url = requireString(action, "url");
  const waitFor = optionalString(action, "wait_for_selector");
  await ctx.page.goto(url, { waitUntil: optionalString(action, "wait_until") ?? "load" });
  if (waitFor) {
    await ctx.page.waitForSelector(waitFor);
  }
  return { ok: true, note: `navigated to ${url}` };
};

export const clickAction: ActionExecutor = async (action, _stepId, ctx) => {
  const selector = requireString(action, "selector");
  await ctx.page.click(selector);
  return { ok: true, note: `clicked ${selector}` };
};

export const fillAction: ActionExecutor = async (action, _stepId, ctx) => {
  const selector = requireString(action, "selector");
  const value = requireString(action, "value");
  await ctx.page.fill(selector, value);
  return { ok: true, note: `filled ${selector}` };
};

interface FormFillField {
  selector: string;
  value: string;
}

function readFormFillFields(action: ScenarioStepAction): FormFillField[] {
  const raw = (action as Record<string, unknown>).fields;
  if (!Array.isArray(raw)) {
    throw new Error("action.form_fill requires array field `fields`");
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`action.form_fill fields[${index}] must be an object with selector + value`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.selector !== "string" || record.selector.length === 0) {
      throw new Error(`action.form_fill fields[${index}] requires non-empty selector and value`);
    }
    if (typeof record.value !== "string") {
      throw new Error(`action.form_fill fields[${index}] requires non-empty selector and value`);
    }
    return { selector: record.selector, value: record.value };
  });
}

export const formFillAction: ActionExecutor = async (action, _stepId, ctx) => {
  const url = optionalString(action, "url");
  const fields = readFormFillFields(action);
  const submit = optionalString(action, "submit");
  const await_ = optionalString(action, "await");

  if (url) {
    await ctx.page.goto(url, { waitUntil: "load" });
  }
  for (const field of fields) {
    await ctx.page.fill(field.selector, field.value);
  }
  if (submit) {
    await ctx.page.click(submit);
  }
  if (await_) {
    if (await_.startsWith("http://") || await_.startsWith("https://")) {
      await ctx.page.waitForURL(await_, { waitUntil: "load" });
    } else {
      await ctx.page.waitForSelector(await_);
    }
  }
  return {
    ok: true,
    note: `form_fill submitted ${fields.length} field(s)${submit ? ` via ${submit}` : ""}`,
  };
};

export const waitForSelectorAction: ActionExecutor = async (action, _stepId, ctx) => {
  const selector = requireString(action, "selector");
  const timeoutMs = optionalNumber(action, "timeout_ms") ?? optionalNumber(action, "timeout");
  await ctx.page.waitForSelector(selector, timeoutMs ? { timeout: timeoutMs } : undefined);
  return { ok: true, note: `selector ${selector} appeared` };
};

export const waitForInactivityAction: ActionExecutor = async (action, stepId, ctx) => {
  const probeSelector = requireString(action, "selector");
  const pollMs = optionalNumber(action, "poll_ms") ?? 1_000;
  const heartbeatMs = optionalNumber(action, "heartbeat_ms") ?? 15_000;
  // Heartbeat-based stale detection: when DOM fingerprint stops changing
  // for `stale_after_ms`, declare the wait complete. Defaults to 30s of
  // no DOM change, which is enough for spec-rounds / codegen / deploy.
  const staleAfterMs = optionalNumber(action, "stale_after_ms") ?? 30_000;
  const expectSelectorPresent = optionalBoolean(action, "expect_selector_present");

  const probe = async (): Promise<{
    done: boolean;
    progress?: string;
    detail?: string;
  }> => {
    // Default: probe page.evaluate to read a fingerprint string. The
    // fingerprint should mutate while progress is happening; once it
    // stops changing, the wait is "done" (DOM-stable).
    let present = false;
    try {
      await ctx.page.waitForSelector(probeSelector, { timeout: 250, state: "attached" as never });
      present = true;
    } catch {
      present = false;
    }
    const fingerprint = await ctx.page.evaluate(() => {
      // Use a cheap whole-document fingerprint: text length + node count.
      const root = (globalThis as { document?: { body?: { innerText?: string; getElementsByTagName?: (s: string) => { length: number } } } }).document?.body;
      if (!root) return "no-body";
      const text = root.innerText ?? "";
      const allCount = root.getElementsByTagName?.("*")?.length ?? 0;
      return `${text.length}:${allCount}`;
    });
    return {
      done: false,
      progress: fingerprint,
      detail: `selector ${present ? "present" : "absent"}, dom fp=${fingerprint}`,
    };
  };

  // wait_for_inactivity reports stale when the fingerprint has been
  // identical for `stale_after_ms` — that is the success criterion.
  // We coerce stale into "done".
  try {
    await waitWithHeartbeat({
      label: `step ${stepId}`,
      probe,
      pollMs,
      heartbeatMs,
      staleAfterMs,
      signal: ctx.signal,
      onHeartbeat: ctx.onHeartbeat,
      now: ctx.now,
      sleep: ctx.sleep,
    });
    // Probe never reports done:true — should never reach here.
    return { ok: true, note: "DOM inactive (probe reported done)" };
  } catch (error) {
    if (error instanceof Error && error.name === "HeartbeatStaleError") {
      // Stale is success — DOM stopped changing.
      if (expectSelectorPresent) {
        // Final check: the expected selector must be visible.
        try {
          await ctx.page.waitForSelector(probeSelector);
        } catch {
          return { ok: false, reason: `wait_for_inactivity: selector ${probeSelector} never appeared even after DOM became stable` };
        }
      }
      return { ok: true, note: `DOM became stable after activity stopped` };
    }
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
};

export const assertTextAction: ActionExecutor = async (action, _stepId, ctx) => {
  const selector = requireString(action, "selector");
  const expected = (action as Record<string, unknown>).expected;
  const text = (await ctx.page.textContent(selector)) ?? "";
  if (typeof expected === "string") {
    if (!text.includes(expected)) {
      return { ok: false, reason: `assert_text: selector ${selector} text "${text}" does not include "${expected}"` };
    }
    return { ok: true, note: `assert_text matched substring "${expected}"` };
  }
  if (expected && typeof expected === "object" && "regex" in (expected as Record<string, unknown>)) {
    const rawRegex = (expected as Record<string, unknown>).regex;
    if (typeof rawRegex !== "string") {
      return { ok: false, reason: `assert_text: expected.regex must be a string` };
    }
    const re = new RegExp(rawRegex);
    if (!re.test(text)) {
      return { ok: false, reason: `assert_text: selector ${selector} text "${text}" did not match /${rawRegex}/` };
    }
    return { ok: true, note: `assert_text matched regex /${rawRegex}/` };
  }
  return { ok: false, reason: `assert_text: expected must be a string substring or { regex: "..." }` };
};

export const assertUrlMatchesAction: ActionExecutor = async (action, _stepId, ctx) => {
  const rawRegex = requireString(action, "regex");
  const re = new RegExp(rawRegex);
  const url = ctx.page.url();
  if (!re.test(url)) {
    return { ok: false, reason: `assert_url_matches: current URL "${url}" did not match /${rawRegex}/` };
  }
  return { ok: true, note: `URL ${url} matched /${rawRegex}/` };
};

export const screenshotAction: ActionExecutor = async (action, stepId, ctx) => {
  const dir = await ensureArtifactsDir(ctx);
  const index = ctx.nextScreenshotIndex();
  const name = optionalString(action, "name") ?? `${buildSlug(stepId)}-${String(index).padStart(2, "0")}`;
  const fileName = `${name}.png`;
  const fullPath = join(dir, fileName);
  await ctx.page.screenshot({ path: fullPath, fullPage: true });
  return {
    ok: true,
    note: `screenshot saved ${fileName}`,
    artifacts: [
      {
        type: "screenshot",
        name,
        path: join(ARTIFACTS_DIRNAME, fileName),
      },
    ],
  };
};

/**
 * play_record_video — a marker action. Video recording is owned by the
 * runner via Playwright `recordVideo` (one video per run); this action
 * lets a scenario mark the start/stop boundaries for a "segment" by
 * writing a small marker file the runner stitches into the manifest.
 */
export const playRecordVideoAction: ActionExecutor = async (action, stepId, ctx) => {
  const dir = await ensureArtifactsDir(ctx);
  const phase = optionalString(action, "phase") ?? "default";
  const markerName = `${buildSlug(stepId)}-segment.json`;
  const marker = {
    step_id: stepId,
    phase,
    boundary: optionalString(action, "boundary") ?? "mark",
    at: new Date().toISOString(),
  };
  await writeFile(join(dir, markerName), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return {
    ok: true,
    note: `video segment marker ${marker.boundary} recorded`,
    artifacts: [
      {
        type: "video-segment",
        name: `${buildSlug(stepId)}-segment`,
        path: join(ARTIFACTS_DIRNAME, markerName),
      },
    ],
  };
};

export const apiCallAction: ActionExecutor = async (action, stepId, ctx) => {
  const url = requireString(action, "url");
  const method = (optionalString(action, "method") ?? "GET").toUpperCase();
  const headers = (action as Record<string, unknown>).headers;
  const body = (action as Record<string, unknown>).body;
  const expectStatus = optionalNumber(action, "expect_status") ?? optionalNumber(action, "expected_status");
  const expectJsonContains = (action as Record<string, unknown>).expect_json_contains;
  const fetchImpl = ctx.fetchImpl ?? fetch;

  const init: Record<string, unknown> = { method };
  if (headers && typeof headers === "object") {
    init.headers = headers as Record<string, string>;
  }
  if (body !== undefined && body !== null) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetchImpl(url, init as RequestInit);
  } catch (error) {
    return { ok: false, reason: `api_call ${method} ${url} failed: ${formatError(error)}` };
  }

  if (typeof expectStatus === "number" && response.status !== expectStatus) {
    return { ok: false, reason: `api_call ${method} ${url}: expected status ${expectStatus}, got ${response.status}` };
  }

  if (expectJsonContains && typeof expectJsonContains === "object") {
    let parsed: unknown;
    try {
      parsed = await response.clone().json();
    } catch (error) {
      return { ok: false, reason: `api_call ${method} ${url}: expected JSON body but parse failed: ${formatError(error)}` };
    }
    const mismatch = findJsonMismatch(parsed, expectJsonContains);
    if (mismatch) {
      return { ok: false, reason: `api_call ${method} ${url}: JSON did not contain expected fields (${mismatch})` };
    }
  }

  // Persist a sanitized response transcript as a per-step artifact.
  const dir = await ensureArtifactsDir(ctx);
  const fileName = `${buildSlug(stepId)}-api.json`;
  const transcript = {
    request: { method, url },
    response: {
      status: response.status,
      ok: response.ok,
      headers: Object.fromEntries(response.headers.entries()),
    },
  };
  await writeFile(join(dir, fileName), `${JSON.stringify(transcript, null, 2)}\n`, "utf8");

  return {
    ok: true,
    note: `${method} ${url} -> ${response.status}`,
    artifacts: [
      {
        type: "log",
        name: `${buildSlug(stepId)}-api`,
        path: join(ARTIFACTS_DIRNAME, fileName),
      },
    ],
  };
};

function findJsonMismatch(actual: unknown, expected: unknown, path = "$"): string | null {
  if (expected === null || typeof expected !== "object") {
    if (actual !== expected) {
      return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    }
    return null;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      return `${path}: expected array, got ${typeof actual}`;
    }
    for (let i = 0; i < expected.length; i += 1) {
      const mismatch = findJsonMismatch(actual[i], expected[i], `${path}[${i}]`);
      if (mismatch) return mismatch;
    }
    return null;
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return `${path}: expected object, got ${Array.isArray(actual) ? "array" : typeof actual}`;
  }
  const expectedObj = expected as Record<string, unknown>;
  const actualObj = actual as Record<string, unknown>;
  for (const key of Object.keys(expectedObj)) {
    const mismatch = findJsonMismatch(actualObj[key], expectedObj[key], `${path}.${key}`);
    if (mismatch) return mismatch;
  }
  return null;
}

export const ghAssertAction: ActionExecutor = async (action, _stepId, ctx) => {
  const args = (action as Record<string, unknown>).args;
  if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) {
    return { ok: false, reason: `gh_assert requires \`args\` as a string[] (e.g. ["api","/repos/owner/repo/branches/main"])` };
  }
  const argList = args as string[];
  const expectContains = optionalString(action, "expect_contains");
  const exec = ctx.execFileImpl ?? ((file: string, fileArgs: string[]) => execFileAsync(file, fileArgs));

  try {
    const { stdout } = await exec("gh", argList);
    if (expectContains && !stdout.includes(expectContains)) {
      return { ok: false, reason: `gh_assert: \`gh ${argList.join(" ")}\` stdout did not contain "${expectContains}"` };
    }
    return { ok: true, note: `gh ${argList.join(" ")} ok` };
  } catch (error) {
    return { ok: false, reason: `gh_assert: \`gh ${argList.join(" ")}\` failed: ${formatError(error)}` };
  }
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ACTION_EXECUTORS: Record<string, ActionExecutor> = {
  navigate: navigateAction,
  click: clickAction,
  fill: fillAction,
  form_fill: formFillAction,
  wait_for_selector: waitForSelectorAction,
  wait_for_inactivity: waitForInactivityAction,
  assert_text: assertTextAction,
  assert_url_matches: assertUrlMatchesAction,
  screenshot: screenshotAction,
  play_record_video: playRecordVideoAction,
  api_call: apiCallAction,
  gh_assert: ghAssertAction,
};

export function executeAction(
  action: ScenarioStepAction,
  stepId: string,
  ctx: ActionContext,
): Promise<ActionResult> {
  const executor = ACTION_EXECUTORS[action.type];
  if (!executor) {
    return Promise.resolve({
      ok: false,
      reason: `Unknown action.type "${action.type}". Supported: ${Object.keys(ACTION_EXECUTORS).join(", ")}.`,
    });
  }
  return executor(action, stepId, ctx).catch((error: unknown) => ({
    ok: false,
    reason: `${action.type}: ${formatError(error)}`,
  }));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
