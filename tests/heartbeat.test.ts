import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  HeartbeatAbortedError,
  HeartbeatStaleError,
  waitWithHeartbeat,
} from "../src/heartbeat.js";

describe("waitWithHeartbeat", () => {
  it("returns when the probe reports done:true", async () => {
    let calls = 0;
    const result = await waitWithHeartbeat({
      label: "demo",
      probe: async () => {
        calls += 1;
        return { done: calls >= 3 };
      },
      pollMs: 1,
      heartbeatMs: 1_000_000,
      sleep: async () => {},
    });
    assert.equal(result.done, true);
    assert.equal(calls, 3);
  });

  it("emits a heartbeat line at the configured interval and never wall-clock-kills", async () => {
    const lines: string[] = [];
    let elapsed = 0;
    let calls = 0;
    await waitWithHeartbeat({
      label: "spec-rounds",
      probe: async () => {
        calls += 1;
        return { done: calls >= 4, progress: `r${calls}`, detail: `round ${calls}` };
      },
      pollMs: 1,
      heartbeatMs: 30,
      sleep: async (ms) => {
        elapsed += ms;
      },
      now: () => {
        const value = elapsed;
        elapsed += 20; // simulated wall-clock advance per now() call
        return value;
      },
      onHeartbeat: (line) => lines.push(line),
    });
    assert.ok(lines.length >= 1, `expected heartbeat lines, got ${lines.length}`);
    for (const line of lines) {
      assert.match(line, /still waiting for spec-rounds/);
    }
  });

  it("throws HeartbeatStaleError when progress fingerprint stops changing past stale_after_ms", async () => {
    let elapsed = 0;
    let thrown: unknown;
    try {
      await waitWithHeartbeat({
        label: "stuck",
        probe: async () => ({ done: false, progress: "same" }),
        pollMs: 1,
        heartbeatMs: 10_000,
        staleAfterMs: 50,
        sleep: async (ms) => {
          elapsed += ms;
        },
        now: () => {
          const value = elapsed;
          elapsed += 20;
          return value;
        },
        onHeartbeat: () => {},
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof HeartbeatStaleError);
  });

  it("aborts when the AbortSignal is signaled", async () => {
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      await waitWithHeartbeat({
        label: "abort",
        probe: async () => ({ done: false }),
        signal: controller.signal,
        sleep: async () => {},
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof HeartbeatAbortedError);
  });
});
