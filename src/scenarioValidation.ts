import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface ScenarioStep {
  id?: string;
  instruction?: string;
  expected?: string;
  evidence?: unknown;
  /**
   * Optional phase label. The automated runner groups steps that share the
   * same `phase` into a single consolidated comment per logical phase.
   * If absent, the step inherits the previous step's phase (or "default").
   */
  phase?: string;
  /**
   * Optional automated action. Backwards-compatible: scenarios without
   * `action` continue to run as guided-manual (existing behaviour).
   */
  action?: ScenarioStepAction;
}

/**
 * Automated step action. The runner switches on `action.type` and executes
 * the action against a single long-lived Playwright page. v0.3 supported
 * types are listed in `AUTOMATED_ACTION_TYPES`.
 */
export interface ScenarioStepAction {
  type: string;
  [key: string]: unknown;
}

export const AUTOMATED_ACTION_TYPES = [
  "navigate",
  "click",
  "fill",
  "form_fill",
  "wait_for_selector",
  "wait_for_inactivity",
  "assert_text",
  "assert_url_matches",
  "screenshot",
  "play_record_video",
  "api_call",
  "gh_assert",
] as const;

export type AutomatedActionType = (typeof AUTOMATED_ACTION_TYPES)[number];

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

  if (Array.isArray(parsed.steps)) {
    parsed.steps.forEach((rawStep, index) => {
      if (!isRecord(rawStep)) {
        return;
      }
      const action = (rawStep as Record<string, unknown>).action;
      if (action === undefined || action === null) {
        return;
      }
      if (!isRecord(action) || !isNonEmptyString(action.type)) {
        errors.push(
          buildError(
            filePath,
            `steps[${index}].action`,
            `Scenario file ${filePath} step ${index} has an action that must be an object with a non-empty string \`type\`.`,
          ),
        );
        return;
      }
      if (!(AUTOMATED_ACTION_TYPES as readonly string[]).includes(action.type)) {
        errors.push(
          buildError(
            filePath,
            `steps[${index}].action.type`,
            `Scenario file ${filePath} step ${index} has unknown action.type \`${action.type}\`. Supported: ${AUTOMATED_ACTION_TYPES.join(", ")}.`,
          ),
        );
      }
    });
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
