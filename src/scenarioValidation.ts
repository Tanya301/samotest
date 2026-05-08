import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface ScenarioStep {
  id?: string;
  instruction?: string;
  expected?: string;
  evidence?: unknown;
}

export interface ScenarioDefinition {
  id: string;
  title: string;
  owner: string;
  priority: string;
  steps: ScenarioStep[];
  result: {
    required_observations: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ScenarioValidationError {
  filePath: string;
  field: string;
  message: string;
}

export type ScenarioValidationResult =
  | {
      valid: true;
      scenario: ScenarioDefinition;
      errors: [];
    }
  | {
      valid: false;
      scenario?: undefined;
      errors: ScenarioValidationError[];
    };

const REQUIRED_STRING_FIELDS = ["id", "title", "owner", "priority"] as const;

export async function validateScenarioFile(
  filePath: string,
): Promise<ScenarioValidationResult> {
  const source = await readFile(filePath, "utf8");
  return validateScenarioContent(source, filePath);
}

export function validateScenarioContent(
  source: string,
  filePath: string,
): ScenarioValidationResult {
  let parsed: unknown;

  try {
    parsed = parse(source);
  } catch (error) {
    return invalid([
      buildError(filePath, "$", `Invalid YAML in ${filePath}: ${formatError(error)}`),
    ]);
  }

  if (!isRecord(parsed)) {
    return invalid([
      buildError(filePath, "$", `Scenario file ${filePath} must contain a YAML object.`),
    ]);
  }

  const errors: ScenarioValidationError[] = [];

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(parsed[field])) {
      errors.push(
        buildError(
          filePath,
          field,
          `Scenario file ${filePath} is missing required field ${field}.`,
        ),
      );
    }
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    errors.push(
      buildError(
        filePath,
        "steps",
        `Scenario file ${filePath} must define required field steps as a non-empty list.`,
      ),
    );
  }

  const result = parsed.result;
  const requiredObservations = isRecord(result)
    ? result.required_observations
    : undefined;

  if (
    !Array.isArray(requiredObservations) ||
    requiredObservations.length === 0 ||
    !requiredObservations.every(isNonEmptyString)
  ) {
    errors.push(
      buildError(
        filePath,
        "result.required_observations",
        `Scenario file ${filePath} must define required field result.required_observations as a non-empty string list.`,
      ),
    );
  }

  if (errors.length > 0) {
    return invalid(errors);
  }

  return {
    valid: true,
    scenario: parsed as unknown as ScenarioDefinition,
    errors: [],
  };
}

function invalid(errors: ScenarioValidationError[]): ScenarioValidationResult {
  return {
    valid: false,
    errors,
  };
}

function buildError(
  filePath: string,
  field: string,
  message: string,
): ScenarioValidationError {
  return {
    filePath,
    field,
    message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
