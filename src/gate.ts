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

  if (!fresh) {
    scenarioStatus = "fail";
    reason = staleReasons[0] ?? "Evidence was captured for a different commit.";
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
    exitCode: status === "fail" ? 1 : 0,
    report,
  };
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
