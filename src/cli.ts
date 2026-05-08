#!/usr/bin/env node
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";

import { formatEvidenceInspectionText, inspectEvidence } from "./evidence.js";
import { checkGate } from "./gate.js";
import { validateScenarioFile } from "./scenarioValidation.js";
import type { ScenarioDefinition, ScenarioStep } from "./scenarioValidation.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  cwd?: string;
  stdin?: string;
  resolveArtifactUrl?: (url: string) => Promise<boolean>;
}

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
  format: "json" | "text";
}

interface EvidenceInspectArgs {
  path?: string;
  format: "json" | "text";
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

interface Attachment {
  kind: EvidenceKind;
  path: string;
}

type EvidenceKind = "screenshot" | "gif" | "video" | "cast" | "log" | "note";
type StepStatus = "passed" | "failed" | "blocked" | "skipped" | "waived";

const stepStatuses = new Set<StepStatus>(["passed", "failed", "blocked", "skipped", "waived"]);
const evidenceKinds = new Set<EvidenceKind>(["screenshot", "gif", "video", "cast", "log", "note"]);

export async function runCli(args: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const cwd = options.cwd ?? process.cwd();
  const [command, subcommand] = args;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { exitCode: 0, stdout: helpText, stderr: "" };
  }

  if (command === "--version" || command === "-V") {
    return { exitCode: 0, stdout: "0.1.0\n", stderr: "" };
  }

  if (command === "init") {
    await initProject(cwd);
    return { exitCode: 0, stdout: "Initialized .samotest\n", stderr: "" };
  }

  if (command === "gate" && subcommand === "check") {
    return runGateCheck(args.slice(2), options);
  }

  if (command === "evidence" && subcommand === "inspect") {
    return runEvidenceInspect(args.slice(2), options);
  }

  if (command === "run") {
    return runScenario(args.slice(1), options);
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
  return (
    command === "run" ||
    command === "record" ||
    command === "doctor" ||
    (command === "scenario" && (subcommand === "list" || subcommand === "validate")) ||
    (command === "evidence" && ["package", "upload"].includes(subcommand ?? "")) ||
    (command === "gate" && subcommand === "report")
  );
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
