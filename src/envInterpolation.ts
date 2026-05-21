/**
 * Env-variable interpolation for scenario YAML.
 *
 * Replaces `${env.VAR_NAME}` and `${env.VAR_NAME:-fallback}` tokens in any
 * string value across the parsed YAML tree. Missing required vars (no
 * fallback supplied AND the var is referenced) raise `MissingEnvVarError`
 * with the full path of every missing reference so the caller can fail
 * loudly per HARD RULE 4 / the canonical walker's fail-loudly contract.
 *
 * Backwards-compatible: scenarios that do not use `${env.*}` tokens pass
 * through unchanged.
 */

const TOKEN_REGEX = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export class MissingEnvVarError extends Error {
  readonly references: ReadonlyArray<{ variable: string; path: string }>;

  constructor(references: ReadonlyArray<{ variable: string; path: string }>) {
    const variables = Array.from(new Set(references.map((reference) => reference.variable)));
    const detail = references
      .map((reference) => `${reference.path} -> \${env.${reference.variable}}`)
      .join("; ");
    super(
      `Missing required environment variable(s) for scenario interpolation: ${variables.join(", ")}. References: ${detail}`,
    );
    this.name = "MissingEnvVarError";
    this.references = references;
  }
}

export interface InterpolateOptions {
  /** Environment lookup; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Interpolate all `${env.VAR}` tokens in a parsed YAML tree.
 * Throws `MissingEnvVarError` if any referenced variable has no value and
 * no `:-fallback` was supplied.
 */
export function interpolateEnvTokens<T>(input: T, options: InterpolateOptions = {}): T {
  const env = options.env ?? process.env;
  const missing: Array<{ variable: string; path: string }> = [];
  const result = walk(input, "$", env, missing);
  if (missing.length > 0) {
    throw new MissingEnvVarError(missing);
  }
  return result as T;
}

function walk(
  value: unknown,
  path: string,
  env: Record<string, string | undefined>,
  missing: Array<{ variable: string; path: string }>,
): unknown {
  if (typeof value === "string") {
    return substituteString(value, path, env, missing);
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => walk(entry, `${path}[${index}]`, env, missing));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = walk(entry, `${path}.${key}`, env, missing);
    }
    return out;
  }
  return value;
}

function substituteString(
  source: string,
  path: string,
  env: Record<string, string | undefined>,
  missing: Array<{ variable: string; path: string }>,
): string {
  return source.replace(TOKEN_REGEX, (_match, variable: string, fallback?: string) => {
    const value = env[variable];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (typeof fallback === "string") {
      return fallback;
    }
    missing.push({ variable, path });
    return "";
  });
}
