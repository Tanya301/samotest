/**
 * Automated step-execution runner for `samotest run --automated`.
 *
 * Owns:
 *   - Playwright browser / context / page lifecycle (one per run)
 *   - recordVideo + recordHar + console listener attachment
 *   - Per-step action execution + evidence collection
 *   - Phase grouping (one consolidated comment per logical phase, per
 *     `consolidated-status-not-spam` memory)
 *   - Evidence manifest writing (existing schema_version 0.1 shape)
 *   - Fail-loudly behaviour on any action failure (no half-measures)
 *
 * The runner exports a single entrypoint `runAutomated()`. The Playwright
 * driver is injected via `options.driver`, so the unit tests can mock it
 * without launching Chromium.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { join } from "node:path";

import {
  type ActionContext,
  type ActionEvidenceArtifact,
  type ActionResult,
  type PlaywrightLike,
  executeAction,
} from "./automatedActions.js";
import { writeEvidenceManifest } from "./evidence.js";
import { MissingEnvVarError, interpolateEnvTokens } from "./envInterpolation.js";
import {
  type ScenarioDefinition,
  type ScenarioStep,
} from "./scenarioValidation.js";

export interface PhaseSummary {
  phase: string;
  status: "passed" | "failed";
  steps: Array<{
    step_id: string;
    status: "passed" | "failed";
    note?: string;
    error?: string;
    artifacts: ActionEvidenceArtifact[];
    duration_ms: number;
  }>;
  total_duration_ms: number;
}

export interface AutomatedRunArtifacts {
  artifacts: ActionEvidenceArtifact[];
  videoPath?: string;
  harPath?: string;
  consolePath?: string;
}

export interface AutomatedRunResult {
  status: "passed" | "failed";
  runId: string;
  scenarioId: string;
  runDir: string;
  manifestPath: string;
  phaseSummaries: PhaseSummary[];
  artifacts: ActionEvidenceArtifact[];
  startedAt: string;
  finishedAt: string;
  failedStepId?: string;
}

export interface AutomatedRunnerDriver {
  /**
   * Launch Playwright and return a `BrowserContext` + page wrapped to
   * the `PlaywrightLike` shape the action executors expect. Also exposes
   * recordVideo/recordHar/console destinations so the runner can stitch
   * them into the manifest.
   */
  launch: (input: AutomatedDriverLaunchInput) => Promise<AutomatedDriverHandle>;
}

export interface AutomatedDriverLaunchInput {
  videoPath: string;
  harPath: string;
  consoleLogPath: string;
  artifactsDir: string;
}

export interface AutomatedDriverHandle {
  page: PlaywrightLike;
  close: () => Promise<{ videoPath?: string; harPath?: string; consoleLogPath?: string }>;
}

export interface RunAutomatedOptions {
  scenario: ScenarioDefinition;
  /** Path the scenario was loaded from (for the manifest). */
  scenarioPath?: string;
  /** Run identifier. */
  runId: string;
  /** Root output directory (e.g. `.samo/evidence`). */
  outputRoot: string;
  /** cwd for git/source-commit detection. */
  cwd: string;
  /** Driver — production default launches real Playwright. */
  driver: AutomatedRunnerDriver;
  /** Environment lookup for `${env.*}` interpolation. */
  env?: Record<string, string | undefined>;
  /** Callback for phase comments (consolidated-not-spammy). */
  onPhaseComplete?: (summary: PhaseSummary) => void | Promise<void>;
  /** Heartbeat sink. */
  onHeartbeat?: (line: string) => void;
  /** Optional now() for tests. */
  now?: () => Date;
  /** Optional fetch impl (passed through to api_call). */
  fetchImpl?: typeof fetch;
  /** Optional execFile override for gh_assert (testability). */
  execFileImpl?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** Optional commit fetcher (testability). */
  currentCommit?: (cwd: string) => Promise<string>;
  /** Optional abort signal for user cancel. */
  signal?: AbortSignal;
}

export async function runAutomated(options: RunAutomatedOptions): Promise<AutomatedRunResult> {
  const now = options.now ?? (() => new Date());
  const startedAtDate = now();
  const startedAt = startedAtDate.toISOString();

  const runDir = join(options.outputRoot, options.runId);
  const artifactsDir = join(runDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  // 1. Interpolate ${env.*} tokens. Missing required vars => fail loudly.
  let interpolated: ScenarioDefinition;
  try {
    interpolated = interpolateEnvTokens(options.scenario, { env: options.env });
  } catch (error) {
    if (error instanceof MissingEnvVarError) {
      await writeFailureRun({
        runDir,
        scenarioId: options.scenario.id,
        runId: options.runId,
        startedAt,
        finishedAt: now().toISOString(),
        reason: error.message,
        cwd: options.cwd,
        currentCommit: options.currentCommit,
      });
      throw error;
    }
    throw error;
  }

  // 2. Launch driver (Playwright with recordVideo + recordHar + console).
  const videoPath = join(artifactsDir, "run.webm");
  const harPath = join(artifactsDir, "run.har");
  const consoleLogPath = join(artifactsDir, "console.log");
  const handle = await options.driver.launch({
    videoPath,
    harPath,
    consoleLogPath,
    artifactsDir,
  });

  // 3. Wire shared action context.
  let screenshotCounter = 0;
  const actionContext: ActionContext = {
    page: handle.page,
    runDir,
    nextScreenshotIndex: () => {
      screenshotCounter += 1;
      return screenshotCounter;
    },
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    onHeartbeat: options.onHeartbeat,
    execFileImpl: options.execFileImpl,
    now: () => now().getTime(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  // 4. Execute steps phase by phase. Phase = consecutive steps sharing the
  //    same `phase` label (the runner consolidates the phase into a single
  //    summary callback at phase boundary).
  const phaseSummaries: PhaseSummary[] = [];
  const allArtifacts: ActionEvidenceArtifact[] = [];
  const stepObservations: Array<{
    step_id: string;
    status: "passed" | "failed";
    note?: string;
  }> = [];

  let overallStatus: "passed" | "failed" = "passed";
  let failedStepId: string | undefined;

  let currentPhase = readStepPhase(interpolated.steps[0]) ?? "default";
  let currentPhaseSteps: PhaseSummary["steps"] = [];
  let currentPhaseStartedAtMs = now().getTime();

  for (const [index, step] of interpolated.steps.entries()) {
    const stepPhase = readStepPhase(step) ?? currentPhase;
    if (stepPhase !== currentPhase) {
      // Flush previous phase.
      const summary = buildPhaseSummary(currentPhase, currentPhaseSteps, now().getTime() - currentPhaseStartedAtMs);
      phaseSummaries.push(summary);
      if (options.onPhaseComplete) {
        await options.onPhaseComplete(summary);
      }
      currentPhase = stepPhase;
      currentPhaseSteps = [];
      currentPhaseStartedAtMs = now().getTime();
    }

    const stepId = step.id ?? `step-${index + 1}`;

    if (!step.action) {
      // v0.3 contract: under --automated, every step MUST declare an action.
      // Half-measures (manual prompts) are not allowed in the automated path.
      const reason = `Step "${stepId}" has no \`action\` block. --automated requires every step to declare a typed action.`;
      const stepResult = recordStepFailure(stepId, reason, 0);
      currentPhaseSteps.push(stepResult);
      stepObservations.push({ step_id: stepId, status: "failed", note: reason });
      overallStatus = "failed";
      failedStepId = stepId;
      break;
    }

    const stepStartMs = now().getTime();
    let result: ActionResult;
    try {
      result = await executeAction(step.action, stepId, actionContext);
    } catch (error) {
      // executeAction already catches, but defence in depth.
      result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    const stepDurationMs = now().getTime() - stepStartMs;

    if (result.ok) {
      const artifacts = result.artifacts ?? [];
      allArtifacts.push(...artifacts);
      currentPhaseSteps.push({
        step_id: stepId,
        status: "passed",
        note: result.note,
        artifacts,
        duration_ms: result.durationMs ?? stepDurationMs,
      });
      stepObservations.push({ step_id: stepId, status: "passed", note: result.note });
    } else {
      // Fail-loudly: capture a crash screenshot, then halt the run.
      const crashArtifacts: ActionEvidenceArtifact[] = [];
      try {
        const crashScreenshotName = `${stepId}-crash.png`.replace(/[^a-zA-Z0-9_.-]+/g, "-");
        const crashPath = join(artifactsDir, crashScreenshotName);
        await handle.page.screenshot({ path: crashPath, fullPage: true });
        crashArtifacts.push({
          type: "screenshot",
          name: crashScreenshotName.replace(/\.png$/, ""),
          path: join("artifacts", crashScreenshotName),
        });
      } catch {
        // If we can't even screenshot, soldier on with the failure record.
      }
      const combinedArtifacts = [...(result.artifacts ?? []), ...crashArtifacts];
      allArtifacts.push(...combinedArtifacts);
      currentPhaseSteps.push({
        step_id: stepId,
        status: "failed",
        error: result.reason,
        artifacts: combinedArtifacts,
        duration_ms: stepDurationMs,
      });
      stepObservations.push({ step_id: stepId, status: "failed", note: result.reason });
      overallStatus = "failed";
      failedStepId = stepId;
      break;
    }
  }

  // Flush trailing phase.
  if (currentPhaseSteps.length > 0) {
    const summary = buildPhaseSummary(currentPhase, currentPhaseSteps, now().getTime() - currentPhaseStartedAtMs);
    phaseSummaries.push(summary);
    if (options.onPhaseComplete) {
      await options.onPhaseComplete(summary);
    }
  }

  // 5. Close driver — Playwright finalizes video + HAR here.
  const closeResult = await handle.close().catch((error: unknown) => {
    // If close fails AFTER the run already succeeded, demote to failed.
    overallStatus = "failed";
    failedStepId = failedStepId ?? "__driver_close__";
    return {
      videoPath: undefined,
      harPath: undefined,
      consoleLogPath: undefined,
      error: error instanceof Error ? error.message : String(error),
    } as { videoPath?: string; harPath?: string; consoleLogPath?: string; error?: string };
  });

  if (closeResult.videoPath) {
    allArtifacts.push({ type: "video", name: "run", path: relativeFromRunDir(runDir, closeResult.videoPath) });
  }
  if (closeResult.harPath) {
    allArtifacts.push({ type: "log", name: "run-har", path: relativeFromRunDir(runDir, closeResult.harPath) });
  }
  if (closeResult.consoleLogPath) {
    allArtifacts.push({ type: "log", name: "run-console", path: relativeFromRunDir(runDir, closeResult.consoleLogPath) });
  }

  const finishedAt = now().toISOString();
  const commit = options.currentCommit ? await options.currentCommit(options.cwd) : "unknown";

  const manifestPath = join(runDir, "manifest.json");
  await writeEvidenceManifest({
    runDir,
    run: {
      id: options.runId,
      scenario_id: interpolated.id,
      status: overallStatus,
      started_at: startedAt,
      finished_at: finishedAt,
      required: interpolated.priority === "required",
    },
    source: { commit },
    environment: {
      os: platform(),
      browser: "chromium",
      redacted: true,
      automated: true,
    },
    artifacts: allArtifacts.map((artifact) => ({
      type: artifact.type,
      name: artifact.name,
      path: join(runDir, artifact.path),
    })),
    observations: stepObservations,
  });

  // Also write a v0.3 phase-summary sidecar for downstream tooling.
  await writeFile(
    join(runDir, "phase-summaries.json"),
    `${JSON.stringify(
      {
        schema_version: "0.1",
        run_id: options.runId,
        scenario_id: interpolated.id,
        status: overallStatus,
        phases: phaseSummaries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    status: overallStatus,
    runId: options.runId,
    scenarioId: interpolated.id,
    runDir,
    manifestPath,
    phaseSummaries,
    artifacts: allArtifacts,
    startedAt,
    finishedAt,
    ...(failedStepId ? { failedStepId } : {}),
  };
}

function readStepPhase(step: ScenarioStep | undefined): string | undefined {
  if (!step) return undefined;
  const value = (step as Record<string, unknown>).phase;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildPhaseSummary(
  phase: string,
  steps: PhaseSummary["steps"],
  durationMs: number,
): PhaseSummary {
  const failed = steps.some((step) => step.status === "failed");
  return {
    phase,
    status: failed ? "failed" : "passed",
    steps,
    total_duration_ms: durationMs,
  };
}

function recordStepFailure(stepId: string, reason: string, durationMs: number): PhaseSummary["steps"][number] {
  return {
    step_id: stepId,
    status: "failed",
    error: reason,
    artifacts: [],
    duration_ms: durationMs,
  };
}

function relativeFromRunDir(runDir: string, absolutePath: string): string {
  const prefix = runDir.endsWith("/") ? runDir : `${runDir}/`;
  if (absolutePath.startsWith(prefix)) {
    return absolutePath.slice(prefix.length);
  }
  return absolutePath;
}

async function writeFailureRun(input: {
  runDir: string;
  scenarioId: string;
  runId: string;
  startedAt: string;
  finishedAt: string;
  reason: string;
  cwd: string;
  currentCommit?: (cwd: string) => Promise<string>;
}): Promise<void> {
  await mkdir(input.runDir, { recursive: true });
  const commit = input.currentCommit ? await input.currentCommit(input.cwd) : "unknown";
  await writeEvidenceManifest({
    runDir: input.runDir,
    run: {
      id: input.runId,
      scenario_id: input.scenarioId,
      status: "failed",
      started_at: input.startedAt,
      finished_at: input.finishedAt,
    },
    source: { commit },
    environment: { os: platform(), redacted: true, automated: true },
    observations: [
      {
        step_id: "__env_interpolation__",
        status: "failed",
        note: input.reason,
      },
    ],
  });
}
