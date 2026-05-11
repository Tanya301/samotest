#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { formatEvidenceInspectionText, inspectEvidence, packageEvidenceZip, writeEvidenceManifest } from "./evidence.js";
import { checkGate, formatGateReportMarkdown } from "./gate.js";
import { validateScenarioFile } from "./scenarioValidation.js";
import type { ScenarioDefinition, ScenarioStep, ScenarioValidationError } from "./scenarioValidation.js";

const execFileAsync = promisify(execFile);

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  cwd?: string;
  stdin?: string;
  resolveArtifactUrl?: (url: string) => Promise<boolean>;
  recorderDoctor?: () => Promise<RecorderDoctorResult>;
  screenshotRecorder?: ScreenshotRecorder;
  videoRecorder?: VideoRecorder;
  gifConverter?: GifConverter;
  castRecorder?: CastRecorder;
  now?: () => Date;
}

export interface RecorderAvailability {
  available: boolean;
  tool: string;
  detail: string;
}

export interface RecorderDoctorResult {
  screenshot: RecorderAvailability;
  video: RecorderAvailability;
  gif: RecorderAvailability;
  cast: RecorderAvailability;
}

export interface ScreenshotRecorderInput {
  url: string;
  outputPath: string;
}

export interface ScreenshotRecorderResult {
  browser?: string;
}

export type ScreenshotRecorder = (input: ScreenshotRecorderInput) => Promise<ScreenshotRecorderResult>;

export interface VideoRecorderInput {
  url: string;
  outputPath: string;
}

export interface VideoRecorderResult {
  browser?: string;
}

export type VideoRecorder = (input: VideoRecorderInput) => Promise<VideoRecorderResult>;

export interface GifConverterInput {
  videoPath: string;
  outputPath: string;
}

export type GifConverter = (input: GifConverterInput) => Promise<void>;

export interface CastRecorderInput {
  command: string;
  outputPath: string;
  cwd: string;
}

export interface CastRecorderResult {
  tool?: string;
}

export type CastRecorder = (input: CastRecorderInput) => Promise<CastRecorderResult>;

const sprintCommands = [
  "samotest init",
  "samotest scenario list",
  "samotest scenario validate [path]",
  "samotest run <scenario-id> [--profile <name>] [--output <dir>] [--pr <id>] [--mr <id>]",
  "samotest record <scenario-id> [--format screenshot|gif|video|cast] [--output <dir>]",
  "samotest evidence inspect <run-id-or-path>",
  "samotest evidence package <run-id-or-path> [--format dir|zip]",
  "samotest evidence upload <run-id-or-path> [--provider github|gitlab]",
  "samotest gate check --manifest <path> [--base <ref>] [--head <ref>] [--format text|json]",
  "samotest gate report --manifest <path> [--format text|json|markdown]",
  "samotest doctor"
];

const starterConfig = `schema_version: "0.1"
evidence:
  directory: ".samotest/evidence"
scenarios:
  directory: ".samotest/scenarios"
`;

const helpText = `Usage: samotest <command> [options]

Manual testing and evidence capture CLI.

Reviewed Sprint 1 commands:
${sprintCommands.map((command) => `  ${command}`).join("\n")}
`;

interface GateCheckArgs {
  manifest?: string;
  base?: string;
  head?: string;
  format: "json" | "text" | "markdown";
}

interface EvidenceInspectArgs {
  path?: string;
  format: "json" | "text";
}

interface EvidencePackageArgs {
  path?: string;
  format: "zip" | "dir";
}

interface EvidenceUploadArgs {
  path?: string;
  provider?: string;
  issue?: string;
  pr?: string;
  mr?: string;
  repo?: string;
  dryRun: boolean;
  output?: string;
}

interface UploadTarget {
  provider: UploadProvider;
  kind: "issue" | "merge_request" | "pull_request";
  id: string;
}

interface GitLabUploadResult {
  localPath: string;
  markdown: string;
  url: string;
}

interface ProviderEvidenceSummary {
  provider: UploadProvider;
  target: string;
  url?: string;
  posted_at: string;
}

interface RunCommandArgs {
  scenarioId?: string;
  output: string;
  runId?: string;
  profile?: string;
  pr?: string;
  mr?: string;
  nonInteractive: boolean;
}

interface RecordCommandArgs {
  scenarioId?: string;
  output: string;
  runId?: string;
  format: "screenshot" | "gif" | "video" | "cast";
}

interface Attachment {
  kind: EvidenceKind;
  path: string;
}

type EvidenceKind = "screenshot" | "gif" | "video" | "cast" | "log" | "note";
type UploadProvider = "github" | "gitlab";
type StepStatus = "passed" | "failed" | "blocked" | "skipped" | "waived";

const stepStatuses = new Set<StepStatus>(["passed", "failed", "blocked", "skipped", "waived"]);
const evidenceKinds = new Set<EvidenceKind>(["screenshot", "gif", "video", "cast", "log", "note"]);
const uploadProviders = new Set<UploadProvider>(["github", "gitlab"]);

export async function runCli(args: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const cwd = options.cwd ?? process.cwd();
  const [command, subcommand] = args;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { exitCode: 0, stdout: helpText, stderr: "" };
  }

  if (command === "--version" || command === "-V") {
    return { exitCode: 0, stdout: "0.2.0\n", stderr: "" };
  }

  if (command === "init") {
    await initProject(cwd);
    return { exitCode: 0, stdout: "Initialized .samotest\n", stderr: "" };
  }

  if (command === "scenario" && subcommand === "validate") {
    return runScenarioValidate(args.slice(2), options);
  }

  if (command === "gate" && subcommand === "check") {
    return runGateCheck(args.slice(2), options);
  }

  if (command === "gate" && subcommand === "report") {
    return runGateReport(args.slice(2), options);
  }

  if (command === "evidence" && subcommand === "inspect") {
    return runEvidenceInspect(args.slice(2), options);
  }

  if (command === "evidence" && subcommand === "package") {
    return runEvidencePackage(args.slice(2), options);
  }

  if (command === "evidence" && subcommand === "upload") {
    return runEvidenceUpload(args.slice(2), options);
  }

  if (command === "run") {
    return runScenario(args.slice(1), options);
  }

  if (command === "doctor") {
    return runDoctor(options);
  }

  if (command === "record") {
    return runRecord(args.slice(1), options);
  }

  if (isReviewedPlaceholder(command, subcommand)) {
    return { exitCode: 1, stdout: "", stderr: `${formatCommand(command, subcommand)} is not implemented yet\n` };
  }

  return { exitCode: 1, stdout: "", stderr: `Unknown command: ${args.join(" ")}\n\n${helpText}` };
}

async function runScenario(args: string[], options: RunCliOptions): Promise<CliResult> {
  const cwd = options.cwd ?? process.cwd();
  const parsed = parseRunArgs(args);

  if (!parsed.scenarioId) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Missing required argument <scenario-id>\n",
    };
  }

  const loaded = await loadScenario(cwd, parsed.scenarioId);
  if (!loaded.ok) {
    return {
      exitCode: loaded.exitCode,
      stdout: "",
      stderr: loaded.error,
    };
  }

  const input = options.stdin ?? await readAvailableStdin();
  const lines = new ScriptedInput(input);
  const stdout: string[] = [];
  const now = new Date().toISOString();
  const runId = parsed.runId ?? `run-${now.replace(/[:.]/g, "-")}`;

  stdout.push(`samotest run ${loaded.scenario.id}`);
  stdout.push(`Scenario: ${loaded.scenario.title}`);

  const prerequisites = toStringList(loaded.scenario.prerequisites);
  if (prerequisites.length > 0) {
    stdout.push("Prerequisites:");
    prerequisites.forEach((prerequisite, index) => stdout.push(`  ${index + 1}. ${prerequisite}`));
  }

  stdout.push("Run note (optional):");
  const runNotes = parseNotes(lines.next(), "run note:");
  const stepResults = [];

  for (const [index, step] of loaded.scenario.steps.entries()) {
    const stepId = step.id ?? `step-${index + 1}`;
    stdout.push(`Step ${index + 1}: ${stepId}`);
    if (step.instruction) {
      stdout.push(`Instruction: ${step.instruction}`);
    }
    if (step.expected) {
      stdout.push(`Expected: ${step.expected}`);
    }
    stdout.push("Status [passed|failed|blocked|skipped|waived]:");

    const rawStatus = lines.next().trim().toLowerCase();
    if (!stepStatuses.has(rawStatus as StepStatus)) {
      return {
        exitCode: 3,
        stdout: stdout.join("\n") + "\n",
        stderr: `Invalid status for step ${stepId}: ${rawStatus || "<empty>"}\n`,
      };
    }

    const status = rawStatus as StepStatus;
    if (status === "waived" && !allowsWaive(step)) {
      return {
        exitCode: 3,
        stdout: stdout.join("\n") + "\n",
        stderr: `Step ${stepId} does not allow waived status\n`,
      };
    }

    stdout.push("Step note (optional):");
    const notes = parseNotes(lines.next(), "step note:");
    stdout.push("Attachments, one per line; blank line to continue:");
    const attachmentsResult = await readAttachments(lines, cwd);
    if (!attachmentsResult.ok) {
      return {
        exitCode: 3,
        stdout: stdout.join("\n") + "\n",
        stderr: attachmentsResult.error,
      };
    }

    stepResults.push({
      id: stepId,
      instruction: step.instruction,
      expected: step.expected,
      status,
      notes,
      attachments: attachmentsResult.attachments,
    });
  }

  const run = {
    schema_version: "0.1",
    run_id: runId,
    scenario: {
      id: loaded.scenario.id,
      title: loaded.scenario.title,
      owner: loaded.scenario.owner,
      priority: loaded.scenario.priority,
      path: loaded.path,
    },
    status: summarizeRunStatus(stepResults.map((step) => step.status)),
    started_at: now,
    finished_at: new Date().toISOString(),
    metadata: {
      profile: parsed.profile,
      pr: parsed.pr,
      mr: parsed.mr,
      non_interactive: parsed.nonInteractive,
    },
    prerequisites,
    notes: runNotes,
    steps: stepResults,
  };

  const outputRoot = isAbsolute(parsed.output) ? parsed.output : join(cwd, parsed.output);
  const outputDir = join(outputRoot, runId);
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);

  stdout.push(`Recorded run ${runId} at ${join(parsed.output, runId, "run.json")}`);
  return {
    exitCode: run.status === "failed" ? 1 : 0,
    stdout: stdout.join("\n") + "\n",
    stderr: "",
  };
}

async function initProject(cwd: string): Promise<void> {
  const baseDir = join(cwd, ".samotest");

  await mkdir(join(baseDir, "scenarios"), { recursive: true });
  await mkdir(join(baseDir, "evidence"), { recursive: true });
  await writeFile(join(baseDir, "config.yaml"), starterConfig, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") {
      throw error;
    }
  });
  await ensureGitignoreEntry(join(cwd, ".gitignore"), ".samotest/evidence/");
}

async function ensureGitignoreEntry(path: string, entry: string): Promise<void> {
  const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }

    throw error;
  });

  const lines = existing.split(/\r?\n/).filter(Boolean);
  if (lines.includes(entry)) {
    return;
  }

  const next = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${entry}\n`;
  await writeFile(path, next);
}

function isReviewedPlaceholder(command: string, subcommand?: string): boolean {
  return command === "scenario" && subcommand === "list";
}

async function runScenarioValidate(args: string[], options: RunCliOptions): Promise<CliResult> {
  const cwd = options.cwd ?? process.cwd();
  const providedPath = args.find((arg) => !arg.startsWith("-"));

  if (args.some((arg) => arg.startsWith("-"))) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Usage: samotest scenario validate [path]\n",
    };
  }

  const files = providedPath
    ? [{
        displayPath: providedPath,
        absolutePath: isAbsolute(providedPath) ? providedPath : join(cwd, providedPath),
      }]
    : await findDefaultScenarioFiles(cwd);

  if (files.length === 0) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "No scenario path provided and no YAML scenarios found under .samotest/scenarios.\nUsage: samotest scenario validate [path]\n",
    };
  }

  const validLines: string[] = [];
  const invalidSections: string[] = [];
  let readFailure: string | undefined;

  for (const file of files) {
    try {
      const validation = await validateScenarioFile(file.absolutePath);
      if (validation.valid) {
        validLines.push(`Valid scenario: ${validation.scenario.id} (${file.displayPath})`);
      } else {
        invalidSections.push(formatScenarioValidationErrors(file.displayPath, validation.errors));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      readFailure = `Unable to validate scenario ${file.displayPath}: ${message}`;
      break;
    }
  }

  if (readFailure) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `${readFailure}\n`,
    };
  }

  if (invalidSections.length > 0) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: `${invalidSections.join("\n")}\n`,
    };
  }

  return {
    exitCode: 0,
    stdout: `${validLines.join("\n")}\n`,
    stderr: "",
  };
}

async function findDefaultScenarioFiles(cwd: string): Promise<Array<{ displayPath: string; absolutePath: string }>> {
  const scenarioDir = join(cwd, ".samotest/scenarios");
  const entries = await readdir(scenarioDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  });

  return entries
    .filter((entry) => [".yaml", ".yml"].includes(extname(entry)))
    .sort()
    .map((entry) => ({
      displayPath: join(".samotest/scenarios", entry),
      absolutePath: join(scenarioDir, entry),
    }));
}

function formatScenarioValidationErrors(displayPath: string, errors: ScenarioValidationError[]): string {
  return [
    `Invalid scenario: ${displayPath}`,
    ...errors.map((error) => `- ${error.field}: ${error.message}`),
  ].join("\n");
}

async function runEvidencePackage(args: string[], options: RunCliOptions): Promise<CliResult> {
  const parsed = parseEvidencePackageArgs(args);

  if (!parsed.path) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Missing required argument <run-id-or-path>\n",
    };
  }

  if (parsed.format !== "zip") {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Invalid --format. Expected zip.\n",
    };
  }

  try {
    const result = await packageEvidenceZip(parsed.path, options.cwd);
    return {
      exitCode: 0,
      stdout: `Created evidence package ${result.output_path}\nEntries: ${result.entries.length}\n`,
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Evidence cannot be packaged: ${message}\n`,
    };
  }
}

async function runDoctor(options: RunCliOptions): Promise<CliResult> {
  const doctor = options.recorderDoctor ? await options.recorderDoctor() : await detectRecorderAvailability();
  return {
    exitCode: 0,
    stdout: formatDoctorOutput(doctor),
    stderr: "",
  };
}

async function runRecord(args: string[], options: RunCliOptions): Promise<CliResult> {
  const cwd = options.cwd ?? process.cwd();
  const parsed = parseRecordArgs(args);

  if (!parsed.scenarioId) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Missing required argument <scenario-id>\n",
    };
  }

  if (!["screenshot", "gif", "video", "cast"].includes(parsed.format)) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Invalid --format. Expected screenshot, gif, video, or cast.\n",
    };
  }

  const loaded = await loadScenario(cwd, parsed.scenarioId);
  if (!loaded.ok) {
    return {
      exitCode: loaded.exitCode,
      stdout: "",
      stderr: loaded.error,
    };
  }

  if (parsed.format === "cast") {
    return recordCastEvidence({ cwd, parsed, scenario: loaded.scenario, options });
  }

  const url = findBrowserScenarioUrl(loaded.scenario);
  if (!url) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: `Scenario ${loaded.scenario.id} does not define a browser URL for ${parsed.format} recording.\n`,
    };
  }

  const needsDoctor =
    (parsed.format === "screenshot" && !options.screenshotRecorder) ||
    ((parsed.format === "video" || parsed.format === "gif") && !options.videoRecorder) ||
    (parsed.format === "gif" && !options.gifConverter);
  const doctor = needsDoctor
    ? options.recorderDoctor
      ? await options.recorderDoctor()
      : await detectRecorderAvailability()
    : null;

  if (parsed.format === "screenshot" && !options.screenshotRecorder && !doctor?.screenshot.available) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Screenshot recorder unavailable: ${doctor?.screenshot.detail ?? "Playwright is unavailable."}\n`,
    };
  }

  if ((parsed.format === "video" || parsed.format === "gif") && !options.videoRecorder && !doctor?.video.available) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Video recorder unavailable: ${doctor?.video.detail ?? "Playwright video recording is unavailable."}\n`,
    };
  }

  const now = options.now ? options.now() : new Date();
  const runId = parsed.runId ?? `record-${now.toISOString().replace(/[:.]/g, "-")}`;
  const outputRoot = isAbsolute(parsed.output) ? parsed.output : join(cwd, parsed.output);
  const runDir = join(outputRoot, runId);
  const artifactsDir = join(runDir, "artifacts");

  await mkdir(artifactsDir, { recursive: true });

  const artifacts: Array<{ type: string; name: string; path: string }> = [];
  let browser = "playwright";
  let stdoutPrefix = `Recorded ${parsed.format} evidence ${runId}`;
  let note = `Captured browser ${parsed.format} for ${url}.`;

  if (parsed.format === "screenshot") {
    const screenshotPath = join(artifactsDir, "screenshot.png");
    const recorder = options.screenshotRecorder ?? recordScreenshotWithPlaywright;
    let recorderResult: ScreenshotRecorderResult;
    try {
      recorderResult = await recorder({ url, outputPath: screenshotPath });
    } catch (error) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `Screenshot recorder failed: ${formatError(error)}\n`,
      };
    }
    browser = recorderResult.browser ?? "playwright";
    artifacts.push({
      type: "screenshot",
      name: `${loaded.scenario.id}-screenshot`,
      path: screenshotPath,
    });
  }

  if (parsed.format === "video" || parsed.format === "gif") {
    const videoPath = join(artifactsDir, "video.webm");
    const recorder = options.videoRecorder ?? recordVideoWithPlaywright;
    let recorderResult: VideoRecorderResult;
    try {
      recorderResult = await recorder({ url, outputPath: videoPath });
    } catch (error) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `Video recorder failed: ${formatError(error)}\n`,
      };
    }
    browser = recorderResult.browser ?? "chromium";
    artifacts.push({
      type: "video",
      name: `${loaded.scenario.id}-video`,
      path: videoPath,
    });

    if (parsed.format === "gif") {
      if (!options.gifConverter && !doctor?.gif.available) {
        stdoutPrefix = `GIF conversion unavailable: ${doctor?.gif.detail ?? "ffmpeg is unavailable."}\nRecorded video fallback evidence ${runId}`;
        note = `Captured browser video fallback for ${url}; GIF conversion was unavailable.`;
      } else {
        const gifPath = join(artifactsDir, "animation.gif");
        const converter = options.gifConverter ?? convertVideoToGifWithFfmpeg;
        try {
          await converter({ videoPath, outputPath: gifPath });
        } catch (error) {
          return {
            exitCode: 2,
            stdout: "",
            stderr: `GIF conversion failed: ${formatError(error)}\n`,
          };
        }
        artifacts.push({
          type: "gif",
          name: `${loaded.scenario.id}-gif`,
          path: gifPath,
        });
        stdoutPrefix = `Recorded gif evidence ${runId}`;
      }
    }
  }

  const finishedAt = (options.now ? options.now() : new Date()).toISOString();
  const commit = await currentCommit(cwd);
  await writeEvidenceManifest({
    runDir,
    run: {
      id: runId,
      scenario_id: loaded.scenario.id,
      status: "passed",
      started_at: now.toISOString(),
      finished_at: finishedAt,
      required: loaded.scenario.priority === "required",
    },
    source: {
      commit,
    },
    environment: {
      os: platform(),
      browser,
      redacted: true,
    },
    artifacts,
    observations: [
      {
        step_id: firstStepId(loaded.scenario),
        status: "passed",
        note,
      },
    ],
  });

  return {
    exitCode: 0,
    stdout: `${stdoutPrefix} at ${join(parsed.output, runId, "manifest.json")}\n`,
    stderr: "",
  };
}

async function recordCastEvidence(input: {
  cwd: string;
  parsed: RecordCommandArgs;
  scenario: ScenarioDefinition;
  options: RunCliOptions;
}): Promise<CliResult> {
  const command = findTerminalScenarioCommand(input.scenario);
  if (!command) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: `Scenario ${input.scenario.id} does not define a terminal command for cast recording.\n`,
    };
  }

  if (!input.options.castRecorder) {
    const doctor = input.options.recorderDoctor ? await input.options.recorderDoctor() : await detectRecorderAvailability();
    if (!doctor.cast.available) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `Cast recorder unavailable: ${doctor.cast.detail}\n`,
      };
    }
  }

  const now = input.options.now ? input.options.now() : new Date();
  const runId = input.parsed.runId ?? `record-${now.toISOString().replace(/[:.]/g, "-")}`;
  const outputRoot = isAbsolute(input.parsed.output) ? input.parsed.output : join(input.cwd, input.parsed.output);
  const runDir = join(outputRoot, runId);
  const artifactsDir = join(runDir, "artifacts");
  const castPath = join(artifactsDir, "terminal.cast");

  await mkdir(artifactsDir, { recursive: true });
  const recorder = input.options.castRecorder ?? recordCastWithAsciinema;
  let recorderResult: CastRecorderResult;
  try {
    recorderResult = await recorder({ command, outputPath: castPath, cwd: input.cwd });
  } catch (error) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Cast recorder failed: ${formatError(error)}\n`,
    };
  }

  const finishedAt = (input.options.now ? input.options.now() : new Date()).toISOString();
  const commit = await currentCommit(input.cwd);
  await writeEvidenceManifest({
    runDir,
    run: {
      id: runId,
      scenario_id: input.scenario.id,
      status: "passed",
      started_at: now.toISOString(),
      finished_at: finishedAt,
      required: input.scenario.priority === "required",
    },
    source: {
      commit,
    },
    environment: {
      os: platform(),
      terminal_recorder: recorderResult.tool ?? "asciinema",
      redacted: true,
    },
    artifacts: [
      {
        type: "cast",
        name: `${input.scenario.id}-cast`,
        path: castPath,
      },
    ],
    observations: [
      {
        step_id: firstStepId(input.scenario),
        status: "passed",
        note: `Captured terminal cast for configured command.`,
      },
    ],
  });

  return {
    exitCode: 0,
    stdout: `Recorded cast evidence ${runId} at ${join(input.parsed.output, runId, "manifest.json")}\n`,
    stderr: "",
  };
}

async function runEvidenceInspect(args: string[], options: RunCliOptions): Promise<CliResult> {
  const parsed = parseEvidenceInspectArgs(args);

  if (!parsed.path) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Missing required argument <manifest-or-run-dir>\n",
    };
  }

  if (parsed.format !== "json" && parsed.format !== "text") {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Invalid --format. Expected json or text.\n",
    };
  }

  try {
    const inspection = await inspectEvidence(parsed.path, options.cwd);
    const exitCode = inspection.ok ? 0 : 1;

    if (parsed.format === "json") {
      return {
        exitCode,
        stdout: `${JSON.stringify(inspection, null, 2)}\n`,
        stderr: "",
      };
    }

    return {
      exitCode,
      stdout: formatEvidenceInspectionText(inspection),
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Evidence cannot be inspected: ${message}\n`,
    };
  }
}

function formatCommand(command: string, subcommand?: string): string {
  return subcommand ? `${command} ${subcommand}` : command;
}

async function runGateCheck(args: string[], options: RunCliOptions): Promise<CliResult> {
  const parsed = parseGateCheckArgs(args);

  if (!parsed.manifest) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Missing required option --manifest <path>\n",
    };
  }

  if (parsed.format !== "json" && parsed.format !== "text") {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Invalid --format. Expected json or text.\n",
    };
  }

  const result = await checkGate({
    manifestPath: parsed.manifest,
    cwd: options.cwd,
    baseRef: parsed.base,
    headSha: parsed.head,
    resolveArtifactUrl: options.resolveArtifactUrl,
  });

  if (parsed.format === "json") {
    return {
      exitCode: result.exitCode,
      stdout: `${JSON.stringify(result.report, null, 2)}\n`,
      stderr: "",
    };
  }

  return {
    exitCode: result.exitCode,
    stdout: `samotest gate ${result.report.gate.status}\n`,
    stderr: "",
  };
}

async function runGateReport(args: string[], options: RunCliOptions): Promise<CliResult> {
  const parsed = parseGateCheckArgs(args);

  if (!parsed.manifest) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Missing required option --manifest <path>\n",
    };
  }

  if (parsed.format !== "markdown" && parsed.format !== "json" && parsed.format !== "text") {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Invalid --format. Expected markdown, json, or text.\n",
    };
  }

  const result = await checkGate({
    manifestPath: parsed.manifest,
    cwd: options.cwd,
    baseRef: parsed.base,
    headSha: parsed.head,
    resolveArtifactUrl: options.resolveArtifactUrl,
  });

  if (parsed.format === "json") {
    return {
      exitCode: result.exitCode,
      stdout: `${JSON.stringify(result.report, null, 2)}\n`,
      stderr: "",
    };
  }

  if (parsed.format === "text") {
    return {
      exitCode: result.exitCode,
      stdout: `samotest gate ${result.report.gate.status}\n`,
      stderr: "",
    };
  }

  return {
    exitCode: result.exitCode,
    stdout: formatGateReportMarkdown(result.report),
    stderr: "",
  };
}

async function runEvidenceUpload(args: string[], options: RunCliOptions): Promise<CliResult> {
  const cwd = options.cwd ?? process.cwd();
  const parsed = parseEvidenceUploadArgs(args);

  if (!parsed.path) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: "Missing required argument <run-id-or-path>\n",
    };
  }

  const inspection = await inspectEvidence(parsed.path, cwd).catch((error: Error) => ({ error }));
  if ("error" in inspection) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `Evidence cannot be prepared for upload: ${inspection.error.message}\n`,
    };
  }

  const rawProvider = parsed.provider ?? inspection.manifest.review?.provider;
  const provider = parseUploadProvider(rawProvider);
  if (!provider.ok) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: `${provider.error}\n`,
    };
  }

  const gate = await checkGate({
    manifestPath: inspection.manifest_path,
    cwd,
    resolveArtifactUrl: options.resolveArtifactUrl,
  });
  const body = formatGateReportMarkdown(gate.report);
  const fallbackPath =
    parsed.output ?? join(cwd, ".samotest", "evidence", `${inspection.manifest.run.id}-${provider.value}-comment.md`);
  await mkdir(dirname(fallbackPath), { recursive: true });
  await writeFile(fallbackPath, body, "utf8");
  const project = parsed.repo ?? inspection.manifest.source.repo;
  const target = resolveUploadTarget(provider.value, parsed, inspection.manifest.review);

  if (parsed.dryRun) {
    return {
      exitCode: 0,
      stdout: formatUploadDryRun({
        provider: provider.value,
        target,
        project,
        manifestPath: inspection.manifest_path,
        artifacts: inspection.manifest.artifacts ?? [],
        markdownPath: fallbackPath,
        markdown: body,
      }),
      stderr: "",
    };
  }

  if (!target) {
    return {
      exitCode: 0,
      stdout: `Prepared ${provider.value} comment markdown at ${fallbackPath}\nNo ${
        provider.value === "github" ? "--pr" : "--issue or --mr"
      } target was provided, so no comment was posted.\n`,
      stderr: "",
    };
  }

  const posted = provider.value === "gitlab"
    ? await postGitLabEvidence({
      target,
      project,
      manifestPath: inspection.manifest_path,
      artifacts: inspection.manifest.artifacts ?? [],
      bodyPath: fallbackPath,
      resolveArtifactUrl: options.resolveArtifactUrl,
      now: options.now,
    })
    : await postGitHubEvidence({
      target,
      project,
      manifestPath: inspection.manifest_path,
      bodyPath: fallbackPath,
      resolveArtifactUrl: options.resolveArtifactUrl,
      now: options.now,
    });

  if (!posted.ok) {
    return {
      exitCode: 4,
      stdout: "",
      stderr: `${posted.reason}\n`,
    };
  }

  return {
    exitCode: 0,
    stdout: `Posted ${provider.value} comment to ${target.kind} ${target.id}\nSaved comment markdown at ${fallbackPath}\n`,
    stderr: "",
  };
}

function parseGateCheckArgs(args: string[]): GateCheckArgs {
  const parsed: GateCheckArgs = {
    format: "text",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--manifest") {
      parsed.manifest = next;
      index += 1;
    } else if (arg === "--base") {
      parsed.base = next;
      index += 1;
    } else if (arg === "--head") {
      parsed.head = next;
      index += 1;
    } else if (arg === "--format") {
      parsed.format = next as GateCheckArgs["format"];
      index += 1;
    }
  }

  return parsed;
}

function parseEvidencePackageArgs(args: string[]): EvidencePackageArgs {
  const parsed: EvidencePackageArgs = {
    format: "zip",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--format") {
      parsed.format = next as EvidencePackageArgs["format"];
      index += 1;
    } else if (!arg.startsWith("-") && !parsed.path) {
      parsed.path = arg;
    }
  }

  return parsed;
}

function parseEvidenceUploadArgs(args: string[]): EvidenceUploadArgs {
  const parsed: EvidenceUploadArgs = {
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--provider") {
      parsed.provider = next;
      index += 1;
    } else if (arg === "--issue") {
      parsed.issue = next;
      index += 1;
    } else if (arg === "--pr") {
      parsed.pr = next;
      index += 1;
    } else if (arg === "--mr") {
      parsed.mr = next;
      index += 1;
    } else if (arg === "--repo") {
      parsed.repo = next;
      index += 1;
    } else if (arg === "--output") {
      parsed.output = next;
      index += 1;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (!arg.startsWith("-") && !parsed.path) {
      parsed.path = arg;
    }
  }

  return parsed;
}

function parseUploadProvider(provider: string | undefined): { ok: true; value: UploadProvider } | { ok: false; error: string } {
  if (!provider) {
    return { ok: false, error: "Missing required option --provider github|gitlab" };
  }

  if (uploadProviders.has(provider as UploadProvider)) {
    return { ok: true, value: provider as UploadProvider };
  }

  return { ok: false, error: `Unsupported provider "${provider}". Supported providers: github, gitlab` };
}

function resolveUploadTarget(
  provider: UploadProvider,
  parsed: EvidenceUploadArgs,
  review: Record<string, unknown> | undefined,
): UploadTarget | null {
  if (provider === "github") {
    const id = parsed.pr ?? stringRecordValue(review, "pr");
    return id ? { provider, kind: "pull_request", id } : null;
  }

  const issue = parsed.issue ?? stringRecordValue(review, "issue");
  if (issue) {
    return { provider, kind: "issue", id: issue };
  }

  const mr = parsed.mr ?? stringRecordValue(review, "mr");
  return mr ? { provider, kind: "merge_request", id: mr } : null;
}

function formatUploadDryRun(options: {
  provider: UploadProvider;
  target: UploadTarget | null;
  project?: string;
  manifestPath: string;
  artifacts: Array<{ path: string }>;
  markdownPath: string;
  markdown: string;
}): string {
  const lines = [
    `Provider: ${options.provider}`,
    `Target: ${options.target ? `${options.target.kind} ${options.target.id}` : "missing"}`,
    `Project: ${options.project ?? "missing"}`,
  ];

  if (options.provider === "gitlab") {
    for (const artifact of options.artifacts) {
      lines.push(`Upload action: POST /projects/:id/uploads ${artifact.path}`);
    }
    lines.push("Upload action: POST /projects/:id/uploads manifest.json");
    lines.push(`Comment action: ${formatGitLabCommentAction(options.target)}`);
    for (const artifact of options.artifacts) {
      lines.push(`Artifact URL required: ${artifact.path} -> hosted GitLab upload URL`);
    }
    lines.push("Manifest URL required: manifest.json -> hosted GitLab upload URL");
  } else {
    lines.push(`Comment action: gh pr comment ${options.target?.id ?? "<missing>"} --body-file ${options.markdownPath}`);
    for (const artifact of options.artifacts) {
      lines.push(`Artifact URL required: ${artifact.path} -> hosted URL`);
    }
    lines.push("Manifest URL required: manifest.json -> hosted URL");
  }

  lines.push(
    `Markdown output: ${options.markdownPath}`,
    "Dry run: no uploads or comments were posted.",
    "",
    "Markdown:",
    options.markdown,
  );

  return lines.join("\n");
}

function formatGitLabCommentAction(target: UploadTarget | null): string {
  if (!target) {
    return "POST /projects/:id/<issue-or-merge-request>/<iid>/notes";
  }

  if (target.kind === "issue") {
    return `POST /projects/:id/issues/${target.id}/notes`;
  }

  return `POST /projects/:id/merge_requests/${target.id}/notes`;
}

async function postGitHubEvidence(options: {
  target: UploadTarget;
  project?: string;
  manifestPath: string;
  bodyPath: string;
  resolveArtifactUrl?: (url: string) => Promise<boolean>;
  now?: () => Date;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!options.project) {
    return { ok: false, reason: "GitHub repository is required for evidence posting." };
  }

  const originalManifest = JSON.parse(await readFile(options.manifestPath, "utf8")) as Record<string, unknown>;
  const missingHostedArtifacts = missingArtifactUrls(originalManifest.artifacts);
  if (missingHostedArtifacts.length > 0) {
    return {
      ok: false,
      reason: `GitHub evidence posting requires hosted artifact URLs before commenting: ${missingHostedArtifacts.join(", ")}`,
    };
  }

  const review = isRecord(originalManifest.review) ? originalManifest.review : undefined;
  const manifestUrl = stringRecordValue(review, "manifest_url");
  if (!manifestUrl) {
    return { ok: false, reason: "GitHub evidence posting requires review.manifest_url before commenting." };
  }

  const postedAt = (options.now ? options.now() : new Date()).toISOString();
  const pendingSummary: ProviderEvidenceSummary = {
    provider: "github",
    target: `${options.target.kind} ${options.target.id}`,
    posted_at: postedAt,
  };
  const reportManifest = await writeTemporaryManifest(withProviderSummary(originalManifest, pendingSummary));
  const hostedGate = await checkGate({
    manifestPath: reportManifest,
    resolveArtifactUrl: options.resolveArtifactUrl ?? (async () => true),
  });
  await writeFile(options.bodyPath, formatGateReportMarkdown(hostedGate.report), "utf8");

  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const posted = await postGitHubIssueComment({
      token,
      repo: options.project,
      issue: options.target.id,
      body: await readFile(options.bodyPath, "utf8"),
    });
    if (!posted.ok) {
      return { ok: false, reason: posted.reason };
    }
    if (!posted.url || posted.id === undefined) {
      return { ok: false, reason: "GitHub evidence comment response did not include a provider comment URL." };
    }

    const summary = {
      ...pendingSummary,
      url: posted.url,
    };
    const finalBody = await renderProviderOwnedGateBody({
      manifest: withProviderSummary(originalManifest, summary),
      bodyPath: options.bodyPath,
      resolveArtifactUrl: options.resolveArtifactUrl,
    });
    const updated = await updateGitHubIssueComment({
      token,
      repo: options.project,
      commentId: posted.id,
      body: finalBody,
    });
    if (!updated.ok) {
      return { ok: false, reason: updated.reason };
    }
    await updateManifestForProviderPost(options.manifestPath, {
      summary,
    });
    return { ok: true };
  }

  const auth = await commandSucceeds("gh", ["auth", "status"]);
  if (!auth) {
    return { ok: false, reason: "GitHub evidence posting requires GITHUB_TOKEN or authenticated gh CLI." };
  }

  const ghToken = await githubTokenFromGh();
  if (!ghToken.ok) {
    return { ok: false, reason: ghToken.reason };
  }

  const posted = await postGitHubIssueComment({
    token: ghToken.token,
    repo: options.project,
    issue: options.target.id,
    body: await readFile(options.bodyPath, "utf8"),
  });
  if (!posted.ok) {
    return posted;
  }
  if (!posted.url || posted.id === undefined) {
    return { ok: false, reason: "GitHub evidence comment response did not include a provider comment URL." };
  }

  const summary = {
    ...pendingSummary,
    url: posted.url,
  };
  const finalBody = await renderProviderOwnedGateBody({
    manifest: withProviderSummary(originalManifest, summary),
    bodyPath: options.bodyPath,
    resolveArtifactUrl: options.resolveArtifactUrl,
  });
  const updated = await updateGitHubIssueComment({
    token: ghToken.token,
    repo: options.project,
    commentId: posted.id,
    body: finalBody,
  });
  if (!updated.ok) {
    return { ok: false, reason: updated.reason };
  }
  await updateManifestForProviderPost(options.manifestPath, {
    summary,
  });
  return { ok: true };
}

async function postGitLabEvidence(options: {
  target: UploadTarget;
  project?: string;
  manifestPath: string;
  artifacts: Array<{ path: string }>;
  bodyPath: string;
  resolveArtifactUrl?: (url: string) => Promise<boolean>;
  now?: () => Date;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!options.project) {
    return { ok: false, reason: "GitLab project is required for evidence uploads." };
  }

  const token = process.env.GITLAB_TOKEN ?? process.env.GLAB_TOKEN;
  if (!token) {
    return { ok: false, reason: "GITLAB_TOKEN or GLAB_TOKEN is required for GitLab evidence uploads." };
  }

  const baseUrl = (process.env.GITLAB_URL ?? "https://gitlab.com").replace(/\/$/, "");
  const runDir = dirname(options.manifestPath);
  const uploadedArtifacts: GitLabUploadResult[] = [];

  for (const artifact of options.artifacts) {
    const upload = await uploadGitLabFile({
      baseUrl,
      token,
      project: options.project,
      filePath: join(runDir, artifact.path),
      localPath: artifact.path,
    });
    if (!upload.ok) {
      return { ok: false, reason: upload.reason };
    }
    uploadedArtifacts.push(upload.value);
  }

  const originalManifest = JSON.parse(await readFile(options.manifestPath, "utf8")) as Record<string, unknown>;
  const artifacts = withHostedArtifactUrls(originalManifest.artifacts, uploadedArtifacts, baseUrl);
  const tempDir = await mkdtemp(join(tmpdir(), "samotest-gitlab-upload-"));
  const manifestUploadPath = join(tempDir, "manifest.json");
  const uploadedManifest = { ...originalManifest, artifacts };
  await writeFile(manifestUploadPath, `${JSON.stringify(uploadedManifest, null, 2)}\n`, "utf8");

  const manifestUpload = await uploadGitLabFile({
    baseUrl,
    token,
    project: options.project,
    filePath: manifestUploadPath,
    localPath: "manifest.json",
  });
  if (!manifestUpload.ok) {
    return { ok: false, reason: manifestUpload.reason };
  }

  const hostedManifestUrl = absoluteGitLabUrl(baseUrl, manifestUpload.value.url);
  const postedAt = (options.now ? options.now() : new Date()).toISOString();
  const pendingSummary: ProviderEvidenceSummary = {
    provider: "gitlab",
    target: `${options.target.kind} ${options.target.id}`,
    posted_at: postedAt,
  };
  const reportManifestPath = join(tempDir, "manifest-for-report.json");
  await writeFile(
    reportManifestPath,
    `${JSON.stringify(withProviderSummary(withHostedManifestUrl(uploadedManifest, hostedManifestUrl), pendingSummary), null, 2)}\n`,
    "utf8",
  );
  const hostedGate = await checkGate({
    manifestPath: reportManifestPath,
    resolveArtifactUrl: options.resolveArtifactUrl ?? (async () => true),
  });
  const body = bodyWithGitLabUploads(
    formatGateReportMarkdown(hostedGate.report),
    uploadedArtifacts,
    manifestUpload.value,
    baseUrl,
  );
  await writeFile(options.bodyPath, body, "utf8");
  const posted = await postGitLabNote({
    baseUrl,
    token,
    project: options.project,
    target: options.target,
    body,
  });

  if (!posted.ok) {
    return { ok: false, reason: posted.reason };
  }
  if (!posted.url || posted.id === undefined) {
    return { ok: false, reason: "GitLab evidence note response did not include a provider note URL." };
  }

  const summary = {
    ...pendingSummary,
    url: posted.url,
  };
  const finalManifest = withProviderSummary(withHostedManifestUrl(uploadedManifest, hostedManifestUrl), summary);
  const finalReportManifestPath = join(tempDir, "manifest-final-report.json");
  await writeFile(finalReportManifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`, "utf8");
  const finalGate = await checkGate({
    manifestPath: finalReportManifestPath,
    resolveArtifactUrl: options.resolveArtifactUrl ?? (async () => true),
  });
  const finalBody = bodyWithGitLabUploads(
    formatGateReportMarkdown(finalGate.report),
    uploadedArtifacts,
    manifestUpload.value,
    baseUrl,
  );
  await writeFile(options.bodyPath, finalBody, "utf8");
  const updated = await updateGitLabNote({
    baseUrl,
    token,
    project: options.project,
    target: options.target,
    noteId: posted.id,
    body: finalBody,
  });
  if (!updated.ok) {
    return { ok: false, reason: updated.reason };
  }
  await writeFile(
    options.manifestPath,
    `${JSON.stringify(finalManifest, null, 2)}\n`,
    "utf8",
  );

  return { ok: true };
}

function withHostedArtifactUrls(
  artifacts: unknown,
  uploadedArtifacts: GitLabUploadResult[],
  baseUrl: string,
): unknown {
  if (!Array.isArray(artifacts)) {
    return artifacts;
  }

  return artifacts.map((artifact) => {
    if (!isRecord(artifact) || !isNonEmptyString(artifact.path)) {
      return artifact;
    }
    const uploaded = uploadedArtifacts.find((candidate) => candidate.localPath === artifact.path);
    return uploaded ? { ...artifact, url: absoluteGitLabUrl(baseUrl, uploaded.url) } : artifact;
  });
}

function withHostedManifestUrl(manifest: Record<string, unknown>, manifestUrl: string): Record<string, unknown> {
  const review = isRecord(manifest.review) ? manifest.review : {};
  return {
    ...manifest,
    review: {
      ...review,
      manifest_url: manifestUrl,
    },
  };
}

function withProviderSummary(manifest: Record<string, unknown>, summary: ProviderEvidenceSummary): Record<string, unknown> {
  const review = isRecord(manifest.review) ? manifest.review : {};
  return {
    ...manifest,
    review: {
      ...review,
      provider: summary.provider,
      summary,
    },
  };
}

async function writeTemporaryManifest(manifest: Record<string, unknown>): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), "samotest-provider-manifest-"));
  const path = join(tempDir, "manifest.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

async function renderProviderOwnedGateBody(options: {
  manifest: Record<string, unknown>;
  bodyPath: string;
  resolveArtifactUrl?: (url: string) => Promise<boolean>;
}): Promise<string> {
  const reportManifest = await writeTemporaryManifest(options.manifest);
  const gate = await checkGate({
    manifestPath: reportManifest,
    resolveArtifactUrl: options.resolveArtifactUrl ?? (async () => true),
  });
  const body = formatGateReportMarkdown(gate.report);
  await writeFile(options.bodyPath, body, "utf8");
  return body;
}

async function updateManifestForProviderPost(
  manifestPath: string,
  options: { summary: ProviderEvidenceSummary },
): Promise<void> {
  const originalManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  await writeFile(manifestPath, `${JSON.stringify(withProviderSummary(originalManifest, options.summary), null, 2)}\n`, "utf8");
}

function missingArtifactUrls(artifacts: unknown): string[] {
  if (!Array.isArray(artifacts)) {
    return [];
  }

  return artifacts
    .filter((artifact) => isRecord(artifact) && isNonEmptyString(artifact.path) && !isNonEmptyString(artifact.url))
    .map((artifact) => (artifact as { path: string }).path);
}

async function postGitHubIssueComment(options: {
  token: string;
  repo: string;
  issue: string;
  body: string;
}): Promise<{ ok: true; id?: number; url?: string } | { ok: false; reason: string }> {
  const response = await fetch(`https://api.github.com/repos/${options.repo}/issues/${encodeURIComponent(options.issue)}/comments`, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${options.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ body: options.body }),
  }).catch((error: Error) => error);

  if (response instanceof Error) {
    return { ok: false, reason: `GitHub evidence comment failed: ${response.message}` };
  }

  if (!response.ok) {
    return { ok: false, reason: `GitHub evidence comment failed: HTTP ${response.status} ${await response.text()}` };
  }

  const parsed = await response.json() as { id?: unknown; html_url?: unknown };
  return {
    ok: true,
    id: typeof parsed.id === "number" ? parsed.id : undefined,
    url: stringValue(parsed.html_url) ?? undefined,
  };
}

async function updateGitHubIssueComment(options: {
  token: string;
  repo: string;
  commentId: number;
  body: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const response = await fetch(`https://api.github.com/repos/${options.repo}/issues/comments/${options.commentId}`, {
    method: "PATCH",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${options.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ body: options.body }),
  }).catch((error: Error) => error);

  if (response instanceof Error) {
    return { ok: false, reason: `GitHub evidence comment update failed: ${response.message}` };
  }

  if (!response.ok) {
    return { ok: false, reason: `GitHub evidence comment update failed: HTTP ${response.status} ${await response.text()}` };
  }

  return { ok: true };
}

async function githubTokenFromGh(): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    const token = stdout.trim();
    if (!token) {
      return { ok: false, reason: "GitHub evidence posting could not read a token from authenticated gh CLI." };
    }

    return { ok: true, token };
  } catch (error) {
    return { ok: false, reason: `GitHub evidence posting could not read a token from gh CLI: ${formatError(error)}` };
  }
}

async function uploadGitLabFile(options: {
  baseUrl: string;
  token: string;
  project: string;
  filePath: string;
  localPath: string;
}): Promise<{ ok: true; value: GitLabUploadResult } | { ok: false; reason: string }> {
  const form = new FormData();
  const data = await readFile(options.filePath);
  form.set("file", new Blob([data]), basename(options.filePath));

  const response = await fetch(`${options.baseUrl}/api/v4/projects/${encodeURIComponent(options.project)}/uploads`, {
    method: "POST",
    headers: gitLabAuthHeaders(options.token),
    body: form,
  }).catch((error: Error) => error);

  if (response instanceof Error) {
    return { ok: false, reason: `GitLab upload failed for ${options.localPath}: ${response.message}` };
  }

  if (!response.ok) {
    return { ok: false, reason: `GitLab upload failed for ${options.localPath}: HTTP ${response.status} ${await response.text()}` };
  }

  const parsed = await response.json() as { markdown?: unknown; url?: unknown; full_path?: unknown };
  const url = stringValue(parsed.full_path) ?? stringValue(parsed.url);
  if (!isNonEmptyString(parsed.markdown) || !url) {
    return { ok: false, reason: `GitLab upload response for ${options.localPath} did not include markdown and url fields.` };
  }

  return {
    ok: true,
    value: {
      localPath: options.localPath,
      markdown: parsed.markdown,
      url,
    },
  };
}

async function postGitLabNote(options: {
  baseUrl: string;
  token: string;
  project: string;
  target: UploadTarget;
  body: string;
}): Promise<{ ok: true; id?: string; url?: string } | { ok: false; reason: string }> {
  const endpoint = options.target.kind === "issue"
    ? `issues/${encodeURIComponent(options.target.id)}/notes`
    : `merge_requests/${encodeURIComponent(options.target.id)}/notes`;
  const response = await fetch(`${options.baseUrl}/api/v4/projects/${encodeURIComponent(options.project)}/${endpoint}`, {
    method: "POST",
    headers: {
      ...gitLabAuthHeaders(options.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: options.body }),
  }).catch((error: Error) => error);

  if (response instanceof Error) {
    return { ok: false, reason: `GitLab comment command failed; local markdown fallback was written. ${response.message}` };
  }

  if (!response.ok) {
    return { ok: false, reason: `GitLab comment command failed; local markdown fallback was written. HTTP ${response.status} ${await response.text()}` };
  }

  const parsed = await response.json().catch(() => ({})) as { id?: unknown; web_url?: unknown };
  const id = typeof parsed.id === "number" || isNonEmptyString(parsed.id) ? String(parsed.id) : undefined;
  return {
    ok: true,
    id,
    url: stringValue(parsed.web_url) ?? gitLabNoteUrl(options.baseUrl, options.project, options.target, id),
  };
}

async function updateGitLabNote(options: {
  baseUrl: string;
  token: string;
  project: string;
  target: UploadTarget;
  noteId: string;
  body: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const endpoint = options.target.kind === "issue"
    ? `issues/${encodeURIComponent(options.target.id)}/notes/${encodeURIComponent(options.noteId)}`
    : `merge_requests/${encodeURIComponent(options.target.id)}/notes/${encodeURIComponent(options.noteId)}`;
  const response = await fetch(`${options.baseUrl}/api/v4/projects/${encodeURIComponent(options.project)}/${endpoint}`, {
    method: "PUT",
    headers: {
      ...gitLabAuthHeaders(options.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body: options.body }),
  }).catch((error: Error) => error);

  if (response instanceof Error) {
    return { ok: false, reason: `GitLab comment update failed: ${response.message}` };
  }

  if (!response.ok) {
    return { ok: false, reason: `GitLab comment update failed: HTTP ${response.status} ${await response.text()}` };
  }

  return { ok: true };
}

function gitLabNoteUrl(baseUrl: string, project: string, target: UploadTarget, noteId: unknown): string | undefined {
  if (!isNonEmptyString(noteId) && typeof noteId !== "number") {
    return undefined;
  }

  const id = String(noteId);
  const targetPath = target.kind === "issue"
    ? `issues/${target.id}`
    : `merge_requests/${target.id}`;
  return `${baseUrl}/${project}/-/${targetPath}#note_${id}`;
}

function bodyWithGitLabUploads(
  body: string,
  artifacts: GitLabUploadResult[],
  manifest: GitLabUploadResult,
  baseUrl: string,
): string {
  const lines = [body.trimEnd(), "", "### Hosted GitLab uploads"];
  for (const artifact of artifacts) {
    lines.push(`- ${artifact.localPath}: ${absoluteGitLabUrl(baseUrl, artifact.url)}`);
  }
  lines.push(`- manifest.json: ${absoluteGitLabUrl(baseUrl, manifest.url)}`);
  return `${lines.join("\n")}\n`;
}

function absoluteGitLabUrl(baseUrl: string, url: string): string {
  if (/^https?:\/\//.test(url)) {
    return url;
  }
  return `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
}

function gitLabAuthHeaders(token: string): Record<string, string> {
  return {
    "PRIVATE-TOKEN": token,
  };
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(command, args);
    return true;
  } catch {
    return false;
  }
}

async function postCommand(command: string, args: string[]): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await execFileAsync(command, args);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `${command} comment command failed; local markdown fallback was written. ${message}` };
  }
}

function parseEvidenceInspectArgs(args: string[]): EvidenceInspectArgs {
  const parsed: EvidenceInspectArgs = {
    format: "text",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--format") {
      parsed.format = next as EvidenceInspectArgs["format"];
      index += 1;
    } else if (!arg.startsWith("-") && !parsed.path) {
      parsed.path = arg;
    }
  }

  return parsed;
}

function parseRunArgs(args: string[]): RunCommandArgs {
  const parsed: RunCommandArgs = {
    output: ".samotest/evidence",
    nonInteractive: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--output") {
      parsed.output = next;
      index += 1;
    } else if (arg === "--run-id") {
      parsed.runId = next;
      index += 1;
    } else if (arg === "--profile") {
      parsed.profile = next;
      index += 1;
    } else if (arg === "--pr") {
      parsed.pr = next;
      index += 1;
    } else if (arg === "--mr") {
      parsed.mr = next;
      index += 1;
    } else if (arg === "--non-interactive") {
      parsed.nonInteractive = true;
    } else if (!arg.startsWith("-") && !parsed.scenarioId) {
      parsed.scenarioId = arg;
    }
  }

  return parsed;
}

function parseRecordArgs(args: string[]): RecordCommandArgs {
  const parsed: RecordCommandArgs = {
    output: ".samotest/evidence",
    format: "screenshot",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];

    if (arg === "--output") {
      parsed.output = next;
      index += 1;
    } else if (arg === "--run-id") {
      parsed.runId = next;
      index += 1;
    } else if (arg === "--format") {
      parsed.format = next as RecordCommandArgs["format"];
      index += 1;
    } else if (!arg.startsWith("-") && !parsed.scenarioId) {
      parsed.scenarioId = arg;
    }
  }

  return parsed;
}

async function loadScenario(
  cwd: string,
  scenarioId: string,
): Promise<
  | { ok: true; scenario: ScenarioDefinition; path: string }
  | { ok: false; exitCode: number; error: string }
> {
  const scenarioDir = join(cwd, ".samotest/scenarios");
  const entries = await readdir(scenarioDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  });

  if (!entries) {
    return {
      ok: false,
      exitCode: 2,
      error: "Scenario directory .samotest/scenarios does not exist\n",
    };
  }

  const scenarioFiles = entries
    .filter((entry) => [".yaml", ".yml"].includes(extname(entry)))
    .map((entry) => ({
      absolutePath: join(scenarioDir, entry),
      relativePath: join(".samotest/scenarios", entry),
    }));

  for (const file of scenarioFiles) {
    const validation = await validateScenarioFile(file.absolutePath);
    if (!validation.valid) {
      return {
        ok: false,
        exitCode: 2,
        error: validation.errors.map((error) => error.message).join("\n") + "\n",
      };
    }

    const fileId = basename(file.absolutePath, extname(file.absolutePath));
    if (validation.scenario.id === scenarioId || fileId === scenarioId) {
      return {
        ok: true,
        scenario: validation.scenario,
        path: file.relativePath,
      };
    }
  }

  return {
    ok: false,
    exitCode: 2,
    error: `Scenario not found: ${scenarioId}\n`,
  };
}

class ScriptedInput {
  private readonly lines: string[];
  private index = 0;

  constructor(source = "") {
    this.lines = source.split(/\r?\n/);
  }

  next(): string {
    const line = this.lines[this.index];
    this.index += 1;
    return line ?? "";
  }
}

function parseNotes(line: string, prefix: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  return [trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed];
}

async function readAttachments(
  lines: ScriptedInput,
  cwd: string,
): Promise<{ ok: true; attachments: Attachment[] } | { ok: false; error: string }> {
  const attachments: Attachment[] = [];

  for (;;) {
    const line = lines.next().trim();
    if (!line) {
      return { ok: true, attachments };
    }

    const [kind, ...pathParts] = line.split(/\s+/);
    const path = pathParts.join(" ");
    if (!evidenceKinds.has(kind as EvidenceKind) || !path) {
      return {
        ok: false,
        error: `Invalid attachment. Expected "<screenshot|gif|video|cast|log|note> <path>", got: ${line}\n`,
      };
    }

    const attachmentPath = isAbsolute(path) ? path : join(cwd, path);
    const exists = await access(attachmentPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return {
        ok: false,
        error: `Attachment file does not exist: ${path}\n`,
      };
    }

    attachments.push({
      kind: kind as EvidenceKind,
      path,
    });
  }
}

function allowsWaive(step: ScenarioStep): boolean {
  const record = step as Record<string, unknown>;
  return record.allow_waive === true || record.waive_allowed === true;
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function formatDoctorOutput(result: RecorderDoctorResult): string {
  const lines = ["Recorder availability"];
  for (const [name, availability] of Object.entries(result)) {
    lines.push(
      `${name.padEnd(10)} ${availability.available ? "available" : "missing"} ${availability.tool} - ${availability.detail}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

async function detectRecorderAvailability(): Promise<RecorderDoctorResult> {
  const [screenshot, video, gif, cast] = await Promise.all([
    detectPlaywrightBrowserSupport("screenshots"),
    detectPlaywrightBrowserSupport("video"),
    detectFfmpegSupport(),
    detectAsciinemaSupport(),
  ]);

  return {
    screenshot,
    video,
    gif,
    cast,
  };
}

async function detectPlaywrightBrowserSupport(capability: "screenshots" | "video"): Promise<RecorderAvailability> {
  try {
    const playwright = await importOptionalPackage("playwright");
    const browser = await playwright.chromium.launch({ headless: true });
    await browser.close();
    return {
      available: true,
      tool: "Playwright",
      detail: `Chromium browser can launch for ${capability}.`,
    };
  } catch (error) {
    return {
      available: false,
      tool: "Playwright",
      detail: `Install playwright and a browser with \`bun add -d playwright && bunx playwright install chromium\`. Detected error: ${formatError(error)}`,
    };
  }
}

async function detectFfmpegSupport(): Promise<RecorderAvailability> {
  try {
    const { stdout, stderr } = await execFileAsync("ffmpeg", ["-version"]);
    const firstLine = (stdout || stderr).split(/\r?\n/, 1)[0]?.trim();
    return {
      available: true,
      tool: "ffmpeg",
      detail: firstLine || "ffmpeg is on PATH.",
    };
  } catch {
    return {
      available: false,
      tool: "ffmpeg",
      detail: "Install ffmpeg to convert Playwright browser videos to GIF; `record --format gif` will fall back to video when browser recording is available.",
    };
  }
}

async function detectAsciinemaSupport(): Promise<RecorderAvailability> {
  try {
    const { stdout } = await execFileAsync("asciinema", ["--version"]);
    return {
      available: true,
      tool: "asciinema",
      detail: stdout.trim() || "asciinema is on PATH.",
    };
  } catch {
    return {
      available: false,
      tool: "asciinema",
      detail: "Install asciinema to record terminal casts.",
    };
  }
}

async function recordScreenshotWithPlaywright(input: ScreenshotRecorderInput): Promise<ScreenshotRecorderResult> {
  const playwright = await importOptionalPackage("playwright");
  const browser = await playwright.chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(input.url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.screenshot({ path: input.outputPath, fullPage: true });
  } finally {
    await browser.close();
  }

  return {
    browser: "chromium",
  };
}

async function recordVideoWithPlaywright(input: VideoRecorderInput): Promise<VideoRecorderResult> {
  const playwright = await importOptionalPackage("playwright");
  const browser = await playwright.chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      recordVideo: {
        dir: dirname(input.outputPath),
      },
    });
    const page = await context.newPage();
    await page.goto(input.url, { waitUntil: "networkidle", timeout: 30_000 });
    const video = page.video();
    await context.close();
    const recordedPath = await video?.path();
    if (!recordedPath) {
      throw new Error("Playwright did not produce a video artifact.");
    }
    if (recordedPath !== input.outputPath) {
      try {
        await rename(recordedPath, input.outputPath);
      } catch (error) {
        if (!isErrnoException(error) || error.code !== "EXDEV") {
          throw error;
        }
        await copyFile(recordedPath, input.outputPath);
        await rm(recordedPath, { force: true });
      }
    }
  } finally {
    await browser.close();
  }

  return {
    browser: "chromium",
  };
}

async function convertVideoToGifWithFfmpeg(input: GifConverterInput): Promise<void> {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    input.videoPath,
    "-vf",
    "fps=12,scale=960:-1:flags=lanczos",
    input.outputPath,
  ]);
}

async function recordCastWithAsciinema(input: CastRecorderInput): Promise<CastRecorderResult> {
  await execFileAsync("asciinema", ["rec", "--quiet", "--overwrite", "--command", input.command, input.outputPath], {
    cwd: input.cwd,
  });
  return {
    tool: "asciinema",
  };
}

async function importOptionalPackage(specifier: string): Promise<any> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (moduleSpecifier: string) => Promise<any>;
  return dynamicImport(specifier);
}

async function currentCommit(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    const commit = stdout.trim();
    return commit || "unknown";
  } catch {
    return "unknown";
  }
}

function findBrowserScenarioUrl(scenario: ScenarioDefinition): string | null {
  const candidates = [
    scenario.url,
    scenario.browser,
    isRecord(scenario.browser) ? scenario.browser.url : undefined,
    scenario.target,
    isRecord(scenario.target) ? scenario.target.url : undefined,
    isRecord(scenario.app) ? scenario.app.url : undefined,
  ];

  for (const candidate of candidates) {
    if (isHttpUrl(candidate)) {
      return candidate;
    }
  }

  for (const step of scenario.steps) {
    const record = step as Record<string, unknown>;
    if (isHttpUrl(record.url)) {
      return record.url;
    }
  }

  return null;
}

function findTerminalScenarioCommand(scenario: ScenarioDefinition): string | null {
  const recording = isRecord(scenario.recording) ? scenario.recording : undefined;
  const target = isRecord(scenario.target) ? scenario.target : undefined;
  const candidates = [
    recording?.command,
    recording?.shell,
    scenario.command,
    target?.command,
  ];

  for (const candidate of candidates) {
    if (isNonEmptyString(candidate)) {
      return candidate;
    }
  }

  for (const step of scenario.steps) {
    const record = step as Record<string, unknown>;
    if (isNonEmptyString(record.command)) {
      return record.command;
    }
  }

  return null;
}

function firstStepId(scenario: ScenarioDefinition): string | undefined {
  return scenario.steps[0]?.id ?? "screenshot";
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringValue(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function stringRecordValue(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return isNonEmptyString(value) ? value : undefined;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeRunStatus(statuses: StepStatus[]): StepStatus {
  if (statuses.includes("failed")) {
    return "failed";
  }
  if (statuses.includes("blocked")) {
    return "blocked";
  }
  if (statuses.every((status) => status === "skipped")) {
    return "skipped";
  }
  if (statuses.every((status) => status === "waived")) {
    return "waived";
  }

  return "passed";
}

async function readAvailableStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function isMainModule(): Promise<boolean> {
  if (!process.argv[1]) {
    return false;
  }

  const [modulePath, invokedPath] = await Promise.all([
    realpath(fileURLToPath(import.meta.url)),
    realpath(process.argv[1]),
  ]);

  return modulePath === invokedPath;
}

if (await isMainModule()) {
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
