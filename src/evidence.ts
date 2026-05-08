import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type EvidenceStatus = "passed" | "failed" | "blocked" | "skipped" | "waived";

export interface EvidenceArtifact {
  type: string;
  name: string;
  path: string;
  sha256: string;
  url?: string;
}

export interface EvidenceManifest {
  schema_version: "0.1";
  tool: {
    name: "samotest";
    version: string;
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
  environment?: {
    os?: string;
    profile?: string;
    browser?: string;
    redacted?: boolean;
    [key: string]: unknown;
  };
  artifacts?: EvidenceArtifact[];
  observations?: Array<{
    step_id?: string;
    status?: EvidenceStatus;
    note?: string;
  }>;
  review?: {
    pr?: string;
    mr?: string;
    provider?: "github" | "gitlab" | string;
    uploaded_urls?: string[];
    manifest_url?: string;
    waiver?: {
      reviewer?: string;
      reason?: string;
      timestamp?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

export interface EvidenceManifestInput {
  runDir: string;
  run: EvidenceManifest["run"];
  source: EvidenceManifest["source"];
  environment?: EvidenceManifest["environment"];
  artifacts?: Array<Omit<EvidenceArtifact, "sha256"> & { sha256?: string }>;
  observations?: EvidenceManifest["observations"];
  review?: EvidenceManifest["review"];
}

export interface EvidenceInspection {
  ok: boolean;
  manifest_path: string;
  manifest: EvidenceManifest;
  artifact_checks: ArtifactCheck[];
  errors: EvidenceInspectionError[];
}

export interface ArtifactCheck {
  path: string;
  ok: boolean;
  expected_sha256?: string;
  actual_sha256?: string;
}

export interface EvidenceInspectionError {
  code: string;
  message: string;
  path?: string;
}

const VERSION = "0.1.0";
const VALID_STATUSES = new Set<EvidenceStatus>(["passed", "failed", "blocked", "skipped", "waived"]);

export async function writeEvidenceManifest(input: EvidenceManifestInput): Promise<EvidenceManifest> {
  const runDir = resolve(input.runDir);
  const artifacts = await Promise.all((input.artifacts ?? []).map((artifact) => normalizeArtifact(runDir, artifact)));
  const manifest: EvidenceManifest = {
    schema_version: "0.1",
    tool: {
      name: "samotest",
      version: VERSION,
    },
    run: input.run,
    source: input.source,
    ...(input.environment ? { environment: input.environment } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(input.observations ? { observations: input.observations } : {}),
    ...(input.review ? { review: input.review } : {}),
  };

  const validationErrors = validateEvidenceManifest(manifest);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.map((error) => error.message).join("; "));
  }

  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function inspectEvidence(inputPath: string, cwd = process.cwd()): Promise<EvidenceInspection> {
  const manifestPath = await resolveManifestPath(inputPath, cwd);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EvidenceManifest;
  const manifestErrors = validateEvidenceManifest(manifest);
  const artifactChecks: ArtifactCheck[] = [];
  const artifactErrors: EvidenceInspectionError[] = [];
  const runDir = dirname(manifestPath);

  for (const artifact of manifest.artifacts ?? []) {
    const pathError = validateRelativeArtifactPath(artifact.path);
    if (pathError) {
      artifactChecks.push({ path: artifact.path, ok: false, expected_sha256: artifact.sha256 });
      artifactErrors.push(pathError);
      continue;
    }

    const actualSha = await sha256File(join(runDir, artifact.path)).catch((error: NodeJS.ErrnoException) => {
      artifactErrors.push({
        code: "artifact_missing",
        message: `Artifact ${artifact.path} cannot be read: ${error.message}`,
        path: artifact.path,
      });
      return null;
    });

    if (!actualSha) {
      artifactChecks.push({ path: artifact.path, ok: false, expected_sha256: artifact.sha256 });
      continue;
    }

    const ok = actualSha === artifact.sha256;
    artifactChecks.push({
      path: artifact.path,
      ok,
      expected_sha256: artifact.sha256,
      actual_sha256: actualSha,
    });

    if (!ok) {
      artifactErrors.push({
        code: "artifact_checksum_mismatch",
        message: `Artifact ${artifact.path} sha256 does not match the manifest.`,
        path: artifact.path,
      });
    }
  }

  const errors = [...manifestErrors, ...artifactErrors];
  return {
    ok: errors.length === 0,
    manifest_path: manifestPath,
    manifest,
    artifact_checks: artifactChecks,
    errors,
  };
}

export function formatEvidenceInspectionText(inspection: EvidenceInspection): string {
  const manifest = inspection.manifest;
  const source = manifest.source.repo ? `${manifest.source.repo} @ ${manifest.source.commit}` : manifest.source.commit;
  const lines = [
    `Evidence run ${manifest.run.id}`,
    `Scenario: ${manifest.run.scenario_id}`,
    `Status: ${manifest.run.status}`,
    `Source: ${source}`,
    `Artifacts: ${manifest.artifacts?.length ?? 0}`,
  ];

  for (const artifact of manifest.artifacts ?? []) {
    const check = inspection.artifact_checks.find((candidate) => candidate.path === artifact.path);
    const status = check?.ok === false ? " invalid" : "";
    lines.push(`  - ${artifact.type} ${artifact.name} ${artifact.path} sha256:${artifact.sha256}${status}`);
  }

  lines.push(`Observations: ${manifest.observations?.length ?? 0}`);
  for (const observation of manifest.observations ?? []) {
    const parts = [observation.step_id, observation.status, observation.note].filter(isNonEmptyString);
    lines.push(`  - ${parts.join(" ")}`);
  }

  if (inspection.errors.length > 0) {
    lines.push("Errors:");
    for (const error of inspection.errors) {
      lines.push(`  - ${error.code}: ${error.message}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function validateEvidenceManifest(value: unknown): EvidenceInspectionError[] {
  const errors: EvidenceInspectionError[] = [];

  if (!isRecord(value)) {
    return [{ code: "malformed_manifest", message: "Manifest must be a JSON object." }];
  }

  if (value.schema_version !== "0.1") {
    errors.push({ code: "malformed_manifest", message: "Manifest schema_version must be 0.1." });
  }

  if (!isRecord(value.run)) {
    errors.push({ code: "malformed_manifest", message: "Manifest run must be an object." });
  } else {
    requireString(value.run.id, "run.id", errors);
    requireString(value.run.scenario_id, "run.scenario_id", errors);
    if (!isNonEmptyString(value.run.status) || !VALID_STATUSES.has(value.run.status as EvidenceStatus)) {
      errors.push({
        code: "malformed_manifest",
        message: "Manifest run.status must be passed, failed, blocked, skipped, or waived.",
      });
    }
  }

  if (!isRecord(value.source)) {
    errors.push({ code: "malformed_manifest", message: "Manifest source must be an object." });
  } else {
    requireString(value.source.commit, "source.commit", errors);
  }

  if (value.environment !== undefined && !isRecord(value.environment)) {
    errors.push({ code: "malformed_manifest", message: "Manifest environment must be an object when present." });
  }

  if (value.artifacts !== undefined && !Array.isArray(value.artifacts)) {
    errors.push({ code: "malformed_manifest", message: "Manifest artifacts must be a list when present." });
  } else {
    for (const artifact of value.artifacts ?? []) {
      if (!isRecord(artifact)) {
        errors.push({ code: "malformed_manifest", message: "Manifest artifacts entries must be objects." });
        continue;
      }

      requireString(artifact.type, "artifacts[].type", errors);
      requireString(artifact.name, "artifacts[].name", errors);
      requireString(artifact.path, "artifacts[].path", errors);
      requireString(artifact.sha256, "artifacts[].sha256", errors);

      if (isNonEmptyString(artifact.path)) {
        const pathError = validateRelativeArtifactPath(artifact.path);
        if (pathError) {
          errors.push(pathError);
        }
      }
    }
  }

  if (value.observations !== undefined && !Array.isArray(value.observations)) {
    errors.push({ code: "malformed_manifest", message: "Manifest observations must be a list when present." });
  }

  if (value.review !== undefined && !isRecord(value.review)) {
    errors.push({ code: "malformed_manifest", message: "Manifest review must be an object when present." });
  }

  return errors;
}

async function normalizeArtifact(
  runDir: string,
  artifact: Omit<EvidenceArtifact, "sha256"> & { sha256?: string },
): Promise<EvidenceArtifact> {
  const artifactPath = isAbsolute(artifact.path) ? resolve(artifact.path) : resolve(runDir, artifact.path);
  const relativePath = toManifestPath(relative(runDir, artifactPath));
  const pathError = validateRelativeArtifactPath(relativePath);

  if (pathError) {
    throw new Error(pathError.message);
  }

  return {
    type: artifact.type,
    name: artifact.name,
    path: relativePath,
    sha256: artifact.sha256 ?? (await sha256File(artifactPath)),
    ...(artifact.url ? { url: artifact.url } : {}),
  };
}

async function resolveManifestPath(inputPath: string, cwd: string): Promise<string> {
  const absolutePath = resolve(cwd, inputPath);
  if (basename(absolutePath) === "manifest.json") {
    return absolutePath;
  }

  return join(absolutePath, "manifest.json");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function validateRelativeArtifactPath(path: string): EvidenceInspectionError | null {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path === "." || path.startsWith(`.${sep}`)) {
    return {
      code: "artifact_path_not_relative",
      message: `Artifact path must be relative to the run directory: ${path}`,
      path,
    };
  }

  return null;
}

function toManifestPath(path: string): string {
  return path.split(sep).join("/");
}

function requireString(value: unknown, field: string, errors: EvidenceInspectionError[]): void {
  if (!isNonEmptyString(value)) {
    errors.push({ code: "malformed_manifest", message: `Manifest ${field} is required.` });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
