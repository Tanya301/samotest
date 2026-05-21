/**
 * Inactivity heartbeat for long async waits.
 *
 * Per HARD RULE 10 + memory `no-dev-timeout`, the automated runner MUST
 * NOT wall-clock-kill LLM-bound waits (spec rounds, codegen, deploy).
 * Instead the runner polls a probe and emits a "still waiting" heartbeat
 * log line every `heartbeatMs`. The wait completes when the probe returns
 * `done: true`. The wait fails with `HeartbeatStaleError` ONLY when the
 * probe reports observable backwards-progress (e.g. fewer DOM mutations
 * across more than `staleAfterMs` of consecutive ticks) — never on raw
 * wall-clock.
 *
 * Callers may also pass `userAbortSignal` to support user-cancel.
 */

export interface HeartbeatProbeResult {
  done: boolean;
  /**
   * Optional progress fingerprint. The heartbeat declares "stale" only
   * when this string stays identical across all polls inside the
   * `staleAfterMs` window. If unset, the heartbeat never declares stale.
   */
  progress?: string;
  /** Human-readable status appended to the heartbeat line. */
  detail?: string;
}

export type HeartbeatProbe = () => Promise<HeartbeatProbeResult>;

export interface HeartbeatOptions {
  label: string;
  probe: HeartbeatProbe;
  pollMs?: number;
  heartbeatMs?: number;
  staleAfterMs?: number;
  signal?: AbortSignal;
  onHeartbeat?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class HeartbeatStaleError extends Error {
  constructor(label: string, staleAfterMs: number, lastProgress: string | undefined) {
    super(
      `Heartbeat for "${label}" reported no progress for ${(staleAfterMs / 1000).toFixed(0)}s (last fingerprint: ${lastProgress ?? "n/a"}).`,
    );
    this.name = "HeartbeatStaleError";
  }
}

export class HeartbeatAbortedError extends Error {
  constructor(label: string) {
    super(`Heartbeat for "${label}" was aborted by user signal.`);
    this.name = "HeartbeatAbortedError";
  }
}

/**
 * Wait for `probe` to report `done: true`, emitting one heartbeat line per
 * `heartbeatMs`. Returns the final probe result.
 */
export async function waitWithHeartbeat(options: HeartbeatOptions): Promise<HeartbeatProbeResult> {
  const pollMs = options.pollMs ?? 1_000;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const staleAfterMs = options.staleAfterMs ?? 0;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log =
    options.onHeartbeat ??
    ((line: string) => {
      // Heartbeat is intentionally chatty in CI; default goes to stderr so
      // it does not pollute the runner's structured stdout.
      process.stderr.write(`${line}\n`);
    });

  const start = now();
  let lastHeartbeatAt = start;
  let lastProgress: string | undefined;
  let lastProgressChangedAt = start;

  for (;;) {
    if (options.signal?.aborted) {
      throw new HeartbeatAbortedError(options.label);
    }

    const probeResult = await options.probe();
    const tNow = now();
    if (probeResult.done) {
      return probeResult;
    }

    if (probeResult.progress !== undefined) {
      if (probeResult.progress !== lastProgress) {
        lastProgress = probeResult.progress;
        lastProgressChangedAt = tNow;
      } else if (staleAfterMs > 0 && tNow - lastProgressChangedAt >= staleAfterMs) {
        throw new HeartbeatStaleError(options.label, staleAfterMs, lastProgress);
      }
    }

    if (tNow - lastHeartbeatAt >= heartbeatMs) {
      const elapsedSec = Math.round((tNow - start) / 1000);
      const detail = probeResult.detail ? ` (${probeResult.detail})` : "";
      log(`[heartbeat] still waiting for ${options.label} (${elapsedSec}s elapsed)${detail}`);
      lastHeartbeatAt = tNow;
    }

    await sleep(pollMs);
  }
}
