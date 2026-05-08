#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { checkGate } from "./gate.js";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  cwd?: string;
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

  if (isReviewedPlaceholder(command, subcommand)) {
    return { exitCode: 1, stdout: "", stderr: `${formatCommand(command, subcommand)} is not implemented yet\n` };
  }

  return { exitCode: 1, stdout: "", stderr: `Unknown command: ${args.join(" ")}\n\n${helpText}` };
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
    (command === "evidence" && ["inspect", "package", "upload"].includes(subcommand ?? "")) ||
    (command === "gate" && subcommand === "report")
  );
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
