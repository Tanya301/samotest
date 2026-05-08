import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type EvidenceStatus = "passed" | "failed" | "blocked" | "skipped" | "waived";
export type GateStatus = "pass" | "fail" | "warn" | "waived";
export type ScenarioGateStatus = GateStatus;

export interface EvidenceArtifact {
  type: string;
  name: string;
  path: string;
  sha256: string;
  url?: string;
}

export interface EvidenceManifest {
  schema_version: "0.1";
  tool?: {
    name?: string;
    version?: string;
  };
  run: {
    id: string;
    scenario_id: string;
    status: EvidenceStatus;
    started_at?: string;
    finished_at?: string;
    required?: boolean;
  };
  source: {
    repo?: string;
    base_ref?: string;
    head_ref?: string;
    commit: string;
  };
  artifacts?: EvidenceArtifact[];
  observations?: Array<{
    step_id?: string;
    status?: EvidenceStatus;
    note?: string;
  }>;
  review?: {
    manifest_url?: string;
    waiver?: GateWaiver;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GateWaiver {
  reviewer?: string;
  reason?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export interface GateError {
  code: string;
  message: string;
  scenario_id?: string;
}

export interface GateReport {
  schema_version: "0.1";
  tool: {
    name: "samotest";
    version: string;
  };
  gate: {
    status: GateStatus;
    checked_at: string;
    base_ref?: string;
    head_ref?: string;
    head_sha?: string;
    manifest_path: string;
    manifest_url?: string;
    summary: {
      required: number;
      passed: number;
      failed: number;
      warned: number;
      waived: number;
    };
  };
  scenarios: Array<{
    id: string;
    required: boolean;
    status: ScenarioGateStatus;
    fresh: boolean;
    reason: string;
    artifacts: EvidenceArtifact[];
    waiver: GateWaiver | null;
  }>;
  errors: GateError[];
}

export interface GateCheckOptions {
  manifestPath: string;
  cwd?: string;
  baseRef?: string;
  headRef?: string;
  headSha?: string;
  now?: Date;
  resolveArtifactUrl?: (url: string) => Promise<boolean>;
}

export interface GateCheckResult {
  exitCode: 0 | 1 | 2 | 3 | 4;
  report: GateReport;
}

const VERSION = "0.1.0";
const VALID_STATUSES = new Set<EvidenceStatus>([
  "passed",
  "failed",
  "blocked",
  "skipped",
  "waived",
]);

export async function checkGate(options: GateCheckOptions): Promise<GateCheckResult> {
  const manifestPath = resolve(options.cwd ?? process.cwd(), options.manifestPath);
  const checkedAt = (options.now ?? new Date()).toISOString();
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 2,
      report: emptyFailureReport({
        manifestPath,
        checkedAt,
        baseRef: options.baseRef,
        headRef: options.headRef,
        headSha: options.headSha,
        error: {
          code: "malformed_manifest",
          message: `Manifest cannot be read or parsed: ${message}`,
        },
      }),
    };
  }

  const validationError = validateManifest(parsed);
  if (validationError) {
    return {
      exitCode: 2,
      report: emptyFailureReport({
        manifestPath,
        checkedAt,
        baseRef: options.baseRef,
        headRef: options.headRef,
        headSha: options.headSha,
        error: validationError,
      }),
    };
  }

  const manifest = parsed as EvidenceManifest;
  const required = manifest.run.required !== false;
  const artifacts = manifest.artifacts ?? [];
  const waiver = manifest.review?.waiver ?? null;
  const errors: GateError[] = [];
  const staleReasons = staleEvidenceReasons(manifest, options);
  const artifactErrors = await artifactUrlErrors(manifest, required, options.resolveArtifactUrl ?? resolveArtifactUrl);
  const fresh = staleReasons.length === 0;
  let scenarioStatus: ScenarioGateStatus;
  let reason = "Evidence passed and matches the requested refs.";

  for (const staleReason of staleReasons) {
    errors.push({
      code: "stale_evidence",
      message: staleReason,
      scenario_id: manifest.run.scenario_id,
    });
  }

  errors.push(...artifactErrors);

  if (!fresh) {
    scenarioStatus = "fail";
    reason = staleReasons[0] ?? "Evidence was captured for a different commit.";
  } else if (artifactErrors.length > 0) {
    scenarioStatus = required ? "fail" : "warn";
    reason = artifactErrors[0]?.message ?? "An artifact URL required for review cannot be resolved.";
  } else if (required && !isNonEmptyString(manifest.run.finished_at)) {
    scenarioStatus = "fail";
    reason = "Required evidence must include run.finished_at.";
    errors.push({
      code: "unfinished_evidence",
      message: reason,
      scenario_id: manifest.run.scenario_id,
    });
  } else if (manifest.run.status === "passed") {
    scenarioStatus = "pass";
  } else if (manifest.run.status === "waived") {
    if (isAuthorizedWaiver(waiver)) {
      scenarioStatus = "waived";
      reason = "Required evidence was waived according to policy.";
    } else {
      scenarioStatus = required ? "fail" : "warn";
      reason = "Waived evidence is missing an authorized waiver record.";
      errors.push({
        code: "unauthorized_waiver",
        message: reason,
        scenario_id: manifest.run.scenario_id,
      });
    }
  } else if (required) {
    scenarioStatus = "fail";
    reason = `Required evidence status is ${manifest.run.status}.`;
    errors.push({
      code: `evidence_status_${manifest.run.status}`,
      message: reason,
      scenario_id: manifest.run.scenario_id,
    });
  } else {
    scenarioStatus = "warn";
    reason = `Non-blocking evidence status is ${manifest.run.status}.`;
  }

  const summary = {
    required: required ? 1 : 0,
    passed: scenarioStatus === "pass" ? 1 : 0,
    failed: scenarioStatus === "fail" ? 1 : 0,
    warned: scenarioStatus === "warn" ? 1 : 0,
    waived: scenarioStatus === "waived" ? 1 : 0,
  };
  const status = summarizeGateStatus(summary);
  const report: GateReport = {
    schema_version: "0.1",
    tool: {
      name: "samotest",
      version: VERSION,
    },
    gate: {
      status,
      checked_at: checkedAt,
      base_ref: options.baseRef ?? manifest.source.base_ref,
      head_ref: options.headRef ?? manifest.source.head_ref,
      head_sha: options.headSha ?? manifest.source.commit,
      manifest_path: manifestPath,
      manifest_url: manifest.review?.manifest_url,
      summary,
    },
    scenarios: [
      {
        id: manifest.run.scenario_id,
        required,
        status: scenarioStatus,
        fresh,
        reason,
        artifacts,
        waiver,
      },
    ],
    errors,
  };

  return {
    exitCode: artifactErrors.length > 0 ? 4 : status === "fail" ? 1 : 0,
    report,
  };
}

export function formatGateReportMarkdown(report: GateReport): string {
  const lines = [
    `## samotest evidence gate: ${report.gate.status}`,
    "",
    `Checked: ${report.gate.checked_at}`,
    `Head: ${report.gate.head_sha ?? "unknown"}`,
    `Summary: ${report.gate.summary.passed} passed, ${report.gate.summary.failed} failed, ${report.gate.summary.warned} warned, ${report.gate.summary.waived} waived`,
    `Review completeness: ${reportHasLocalOnlyArtifacts(report) ? "incomplete - hosted artifact URLs are required before review." : "complete"}`,
  ];

  if (isNonEmptyString(report.gate.manifest_url)) {
    lines.push(`Manifest: [manifest](${report.gate.manifest_url})`);
  } else {
    lines.push(`Manifest: ${report.gate.manifest_path}`);
  }

  lines.push(
    "",
    "| Scenario | Requirement | Status | Fresh | Evidence | Reason |",
    "| --- | --- | --- | --- | --- | --- |",
  );

  for (const scenario of report.scenarios) {
    const artifacts = scenario.artifacts.length > 0
      ? scenario.artifacts.map(formatArtifactLink).join("<br>")
      : "none";
    lines.push(
      `| ${escapeTableCell(scenario.id)} | ${scenario.required ? "required" : "optional"} | ${scenario.status} | ${scenario.fresh ? "fresh" : "stale"} | ${artifacts} | ${escapeTableCell(scenario.reason)} |`,
    );
  }

  if (report.errors.length > 0) {
    lines.push("", "### Gate errors");
    for (const error of report.errors) {
      lines.push(`- ${error.code}: ${error.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatSamorevReviewNote(report: GateReport): string {
  const lines = [
    "## samorev review note: samotest",
    "",
    `Status: \`${report.gate.status}\``,
    `Checked: ${report.gate.checked_at}`,
    `Head: \`${report.gate.head_sha ?? "unknown"}\``,
    `Summary: ${report.gate.summary.passed} passed, ${report.gate.summary.failed} failed, ${report.gate.summary.warned} warned, ${report.gate.summary.waived} waived`,
    `Manifest: ${formatManifestReference(report)}`,
    "",
    "### Scenario evidence",
  ];

  if (report.scenarios.length === 0) {
    lines.push("- No scenario evidence was available.");
  }

  for (const scenario of report.scenarios) {
    lines.push(
      `- \`${scenario.id}\`: \`${scenario.status}\` (${scenario.required ? "required" : "optional"}, ${scenario.fresh ? "fresh" : "stale"})`,
      `  - Reason: ${scenario.reason}`,
      `  - Evidence: ${formatSamorevEvidence(scenario.artifacts)}`,
    );
  }

  if (report.errors.length > 0) {
    lines.push("", "### Gate errors");
    for (const error of report.errors) {
      const scenario = error.scenario_id ? ` for \`${error.scenario_id}\`` : "";
      lines.push(`- \`${error.code}\`${scenario}: ${error.message}`);
    }
  }

  lines.push(
    "",
    "<details>",
    "<summary>samotest gate check JSON</summary>",
    "",
    "```json",
    JSON.stringify(report, null, 2),
    "```",
    "",
    "</details>",
  );

  return `${lines.join("\n")}\n`;
}

async function artifactUrlErrors(
  manifest: EvidenceManifest,
  required: boolean,
  resolveUrl: (url: string) => Promise<boolean>,
): Promise<GateError[]> {
  if (!required) {
    return [];
  }

  const errors: GateError[] = [];

  for (const artifact of manifest.artifacts ?? []) {
    if (!isNonEmptyString(artifact.url)) {
      errors.push({
        code: "artifact_url_missing",
        message: `Artifact ${artifact.path} is missing a URL required for review.`,
        scenario_id: manifest.run.scenario_id,
      });
      continue;
    }

    if (!(await resolveUrl(artifact.url))) {
      errors.push({
        code: "artifact_url_unresolved",
        message: `Artifact URL cannot be resolved: ${artifact.url}`,
        scenario_id: manifest.run.scenario_id,
      });
    }
  }

  return errors;
}

async function resolveArtifactUrl(url: string): Promise<boolean> {
  const timeout = AbortSignal.timeout(5000);

  try {
    const head = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: timeout,
    });

    if (head.ok) {
      return true;
    }

    if (head.status !== 405 && head.status !== 403) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const get = await fetch(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-0",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });

    return get.ok || get.status === 206;
  } catch {
    return false;
  }
}

function validateManifest(value: unknown): GateError | null {
  if (!isRecord(value)) {
    return malformed("Manifest must be a JSON object.");
  }

  if (value.schema_version !== "0.1") {
    return malformed("Manifest schema_version must be 0.1.");
  }

  if (!isRecord(value.run)) {
    return malformed("Manifest run must be an object.");
  }

  if (!isNonEmptyString(value.run.scenario_id)) {
    return malformed("Manifest run.scenario_id is required.");
  }

  if (!isNonEmptyString(value.run.status) || !VALID_STATUSES.has(value.run.status as EvidenceStatus)) {
    return malformed("Manifest run.status must be passed, failed, blocked, skipped, or waived.");
  }

  if (!isRecord(value.source)) {
    return malformed("Manifest source must be an object.");
  }

  if (!isNonEmptyString(value.source.commit)) {
    return malformed("Manifest source.commit is required.");
  }

  if (value.artifacts !== undefined && !Array.isArray(value.artifacts)) {
    return malformed("Manifest artifacts must be a list when present.");
  }

  return null;
}

function staleEvidenceReasons(manifest: EvidenceManifest, options: GateCheckOptions): string[] {
  const reasons: string[] = [];

  if (options.headSha && manifest.source.commit !== options.headSha) {
    reasons.push("Evidence was captured for a different commit.");
  }

  if (options.baseRef && manifest.source.base_ref && manifest.source.base_ref !== options.baseRef) {
    reasons.push("Manifest source base_ref does not match the requested base ref.");
  }

  if (options.headRef && manifest.source.head_ref && manifest.source.head_ref !== options.headRef) {
    reasons.push("Manifest source head_ref does not match the requested head ref.");
  }

  return reasons;
}

function summarizeGateStatus(summary: GateReport["gate"]["summary"]): GateStatus {
  if (summary.failed > 0) {
    return "fail";
  }

  if (summary.warned > 0) {
    return "warn";
  }

  if (summary.waived > 0) {
    return "waived";
  }

  return "pass";
}

function emptyFailureReport(options: {
  manifestPath: string;
  checkedAt: string;
  baseRef?: string;
  headRef?: string;
  headSha?: string;
  error: GateError;
}): GateReport {
  return {
    schema_version: "0.1",
    tool: {
      name: "samotest",
      version: VERSION,
    },
    gate: {
      status: "fail",
      checked_at: options.checkedAt,
      base_ref: options.baseRef,
      head_ref: options.headRef,
      head_sha: options.headSha,
      manifest_path: options.manifestPath,
      summary: {
        required: 0,
        passed: 0,
        failed: 1,
        warned: 0,
        waived: 0,
      },
    },
    scenarios: [],
    errors: [options.error],
  };
}

function malformed(message: string): GateError {
  return {
    code: "malformed_manifest",
    message,
  };
}

function formatArtifactLink(artifact: EvidenceArtifact): string {
  const label = escapeTableCell(artifact.name || artifact.path);
  if (isNonEmptyString(artifact.url)) {
    return `[${label}](${artifact.url})`;
  }

  return escapeTableCell(artifact.path);
}

function reportHasLocalOnlyArtifacts(report: GateReport): boolean {
  return report.errors.some((error) => error.code === "artifact_url_missing");
}

function formatManifestReference(report: GateReport): string {
  if (isNonEmptyString(report.gate.manifest_url)) {
    return `[manifest](${report.gate.manifest_url})`;
  }

  return `\`${report.gate.manifest_path}\``;
}

function formatSamorevEvidence(artifacts: EvidenceArtifact[]): string {
  if (artifacts.length === 0) {
    return "none";
  }

  return artifacts.map((artifact) => {
    const label = artifact.name || artifact.path;
    if (isNonEmptyString(artifact.url)) {
      return `[${label}](${artifact.url})`;
    }

    return `missing URL for \`${artifact.path}\``;
  }).join("; ");
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function isAuthorizedWaiver(value: GateWaiver | null): value is Required<Pick<GateWaiver, "reviewer" | "reason" | "timestamp">> {
  return (
    isRecord(value) &&
    isNonEmptyString(value.reviewer) &&
    isNonEmptyString(value.reason) &&
    isNonEmptyString(value.timestamp)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
