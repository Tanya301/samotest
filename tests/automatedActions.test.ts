import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import {
  ACTION_EXECUTORS,
  executeAction,
  type ActionContext,
  type PlaywrightLike,
} from "../src/automatedActions.js";

interface MockPage extends PlaywrightLike {
  calls: Array<{ method: string; args: unknown[] }>;
  textValue?: string;
  currentUrl?: string;
  fingerprint?: () => string;
}

function createMockPage(overrides: Partial<MockPage> = {}): MockPage {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const page: MockPage = {
    calls,
    goto: async (url, options) => {
      calls.push({ method: "goto", args: [url, options] });
    },
    click: async (selector, options) => {
      calls.push({ method: "click", args: [selector, options] });
    },
    fill: async (selector, value, options) => {
      calls.push({ method: "fill", args: [selector, value, options] });
    },
    waitForSelector: async (selector, options) => {
      calls.push({ method: "waitForSelector", args: [selector, options] });
    },
    waitForURL: async (urlOrPredicate, options) => {
      calls.push({ method: "waitForURL", args: [urlOrPredicate, options] });
    },
    url: () => overrides.currentUrl ?? "https://example.test/",
    screenshot: async (options) => {
      calls.push({ method: "screenshot", args: [options] });
      await Bun.write(options.path, "fake-png-bytes");
    },
    textContent: async (selector) => {
      calls.push({ method: "textContent", args: [selector] });
      return overrides.textValue ?? "";
    },
    evaluate: async (fn) => {
      calls.push({ method: "evaluate", args: [] });
      const next = overrides.fingerprint?.() ?? "stable-fingerprint";
      return next as never;
    },
    ...overrides,
  };
  return page;
}

async function withRunDir<T>(fn: (runDir: string, ctx: ActionContext, page: MockPage) => Promise<T>): Promise<T> {
  const runDir = await mkdtemp(join(tmpdir(), "samotest-action-"));
  try {
    let index = 0;
    const page = createMockPage();
    const ctx: ActionContext = {
      page,
      runDir,
      nextScreenshotIndex: () => {
        index += 1;
        return index;
      },
    };
    return await fn(runDir, ctx, page);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}

describe("automatedActions registry", () => {
  it("registers every advertised v0.3 action type", () => {
    const expected = [
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
    ];
    for (const type of expected) {
      assert.ok(ACTION_EXECUTORS[type], `missing executor for ${type}`);
    }
  });

  it("returns a clear failure for unknown action.type values", async () => {
    await withRunDir(async (_runDir, ctx) => {
      const result = await executeAction({ type: "frobnicate" }, "step-x", ctx);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.reason, /Unknown action\.type/);
      }
    });
  });
});

describe("navigate / click / fill", () => {
  it("navigate goes to the URL and optionally waits for a selector", async () => {
    await withRunDir(async (_runDir, ctx, page) => {
      const result = await executeAction(
        { type: "navigate", url: "https://x.test/dash", wait_for_selector: "#root" },
        "go-dash",
        ctx,
      );
      assert.equal(result.ok, true);
      assert.deepEqual(page.calls.map((call) => call.method), ["goto", "waitForSelector"]);
    });
  });

  it("click clicks the supplied selector", async () => {
    await withRunDir(async (_runDir, ctx, page) => {
      const result = await executeAction({ type: "click", selector: "[data-testid=go]" }, "click", ctx);
      assert.equal(result.ok, true);
      assert.equal(page.calls[0]?.method, "click");
      assert.equal(page.calls[0]?.args[0], "[data-testid=go]");
    });
  });

  it("fill fills selector with value", async () => {
    await withRunDir(async (_runDir, ctx, page) => {
      const result = await executeAction({ type: "fill", selector: "#email", value: "u@e.com" }, "fill", ctx);
      assert.equal(result.ok, true);
      assert.deepEqual(page.calls[0]?.args, ["#email", "u@e.com", undefined]);
    });
  });
});

describe("form_fill", () => {
  it("navigates, fills each field, clicks submit, and awaits the target URL", async () => {
    await withRunDir(async (_runDir, ctx, page) => {
      const result = await executeAction(
        {
          type: "form_fill",
          url: "https://x.test/login",
          fields: [
            { selector: "#email", value: "u@e.com" },
            { selector: "#password", value: "pw" },
          ],
          submit: "[data-testid=submit]",
          await: "https://x.test/dashboard",
        },
        "login",
        ctx,
      );
      assert.equal(result.ok, true);
      assert.deepEqual(
        page.calls.map((call) => call.method),
        ["goto", "fill", "fill", "click", "waitForURL"],
      );
    });
  });

  it("rejects malformed fields[] arrays loudly", async () => {
    await withRunDir(async (_runDir, ctx) => {
      const result = await executeAction(
        { type: "form_fill", fields: [{ selector: "x" }] },
        "bad",
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.reason, /requires non-empty selector and value/);
      }
    });
  });
});

describe("wait_for_selector + wait_for_inactivity", () => {
  it("wait_for_selector calls page.waitForSelector with the configured timeout", async () => {
    await withRunDir(async (_runDir, ctx, page) => {
      const result = await executeAction(
        { type: "wait_for_selector", selector: "#ready", timeout_ms: 5000 },
        "wait",
        ctx,
      );
      assert.equal(result.ok, true);
      assert.deepEqual(page.calls[0]?.args, ["#ready", { timeout: 5000 }]);
    });
  });

  it("wait_for_inactivity succeeds when the DOM fingerprint stops changing (no wall-clock timeout)", async () => {
    await withRunDir(async (_runDir, ctx) => {
      const fingerprints = ["a", "b", "c", "d", "d", "d", "d"];
      let i = 0;
      ctx.page = createMockPage({
        fingerprint: () => {
          const value = fingerprints[Math.min(i, fingerprints.length - 1)] ?? "d";
          i += 1;
          return value;
        },
      });
      let elapsed = 0;
      ctx.now = () => {
        const value = elapsed;
        return value;
      };
      ctx.sleep = async (ms) => {
        elapsed += ms;
      };
      const result = await executeAction(
        {
          type: "wait_for_inactivity",
          selector: "#anything",
          poll_ms: 100,
          heartbeat_ms: 60_000,
          stale_after_ms: 300,
        },
        "wait-inactivity",
        ctx,
      );
      assert.equal(result.ok, true);
    });
  });
});

describe("assert_text + assert_url_matches", () => {
  it("assert_text passes when expected substring is present", async () => {
    await withRunDir(async (_runDir, ctx) => {
      ctx.page = createMockPage({ textValue: "Welcome u@e.com" });
      const result = await executeAction(
        { type: "assert_text", selector: "#hello", expected: "Welcome" },
        "hello",
        ctx,
      );
      assert.equal(result.ok, true);
    });
  });

  it("assert_text fails clearly when the substring is absent", async () => {
    await withRunDir(async (_runDir, ctx) => {
      ctx.page = createMockPage({ textValue: "ok" });
      const result = await executeAction(
        { type: "assert_text", selector: "#hello", expected: "Welcome" },
        "hello",
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /does not include "Welcome"/);
    });
  });

  it("assert_url_matches uses a regex over page.url()", async () => {
    await withRunDir(async (_runDir, ctx) => {
      ctx.page = createMockPage({ currentUrl: "https://x.test/dashboard?a=1" });
      const ok = await executeAction({ type: "assert_url_matches", regex: "^https://x\\.test/dashboard" }, "u", ctx);
      assert.equal(ok.ok, true);
      const fail = await executeAction({ type: "assert_url_matches", regex: "^https://nope" }, "u", ctx);
      assert.equal(fail.ok, false);
    });
  });
});

describe("screenshot + play_record_video", () => {
  it("screenshot writes a png and records an artifact entry", async () => {
    await withRunDir(async (runDir, ctx) => {
      const result = await executeAction({ type: "screenshot" }, "open-cart", ctx);
      assert.equal(result.ok, true);
      if (result.ok) {
        assert.equal(result.artifacts?.length, 1);
        const artifactPath = join(runDir, result.artifacts?.[0]?.path ?? "");
        const bytes = await readFile(artifactPath, "utf8");
        assert.equal(bytes, "fake-png-bytes");
      }
    });
  });

  it("play_record_video writes a per-step marker JSON", async () => {
    await withRunDir(async (runDir, ctx) => {
      const result = await executeAction(
        { type: "play_record_video", boundary: "start" },
        "spec-rounds",
        ctx,
      );
      assert.equal(result.ok, true);
      if (result.ok) {
        const markerPath = join(runDir, result.artifacts?.[0]?.path ?? "");
        const json = JSON.parse(await readFile(markerPath, "utf8"));
        assert.equal(json.step_id, "spec-rounds");
        assert.equal(json.boundary, "start");
      }
    });
  });
});

describe("api_call", () => {
  it("performs an api_call and asserts the expected status", async () => {
    await withRunDir(async (_runDir, ctx) => {
      ctx.fetchImpl = (async (input: unknown) => {
        const url = typeof input === "string" ? input : "(other)";
        const body = JSON.stringify({ version: "v0.0.123" });
        return new Response(body, { status: 200, headers: { "x-url": url } });
      }) as unknown as typeof fetch;
      const result = await executeAction(
        {
          type: "api_call",
          method: "GET",
          url: "https://samo.team/api/version",
          expect_status: 200,
          expect_json_contains: { version: "v0.0.123" },
        },
        "ver",
        ctx,
      );
      assert.equal(result.ok, true);
    });
  });

  it("fails when expect_status does not match", async () => {
    await withRunDir(async (_runDir, ctx) => {
      ctx.fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
      const result = await executeAction(
        { type: "api_call", url: "https://x.test/y", expect_status: 200 },
        "ver",
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /expected status 200/);
    });
  });

  it("fails clearly when expect_json_contains does not match the body", async () => {
    await withRunDir(async (_runDir, ctx) => {
      ctx.fetchImpl = (async () =>
        new Response(JSON.stringify({ version: "v0.0.999" }), { status: 200 })) as unknown as typeof fetch;
      const result = await executeAction(
        {
          type: "api_call",
          url: "https://x.test/api/version",
          expect_status: 200,
          expect_json_contains: { version: "v0.0.123" },
        },
        "ver",
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /JSON did not contain expected fields/);
    });
  });
});

describe("gh_assert", () => {
  it("invokes gh with the provided args and asserts expect_contains", async () => {
    await withRunDir(async (_runDir, ctx) => {
      ctx.execFileImpl = async (file, args) => {
        assert.equal(file, "gh");
        assert.deepEqual(args, ["api", "/repos/o/r/branches/main"]);
        return { stdout: '{"name":"main"}', stderr: "" };
      };
      const result = await executeAction(
        {
          type: "gh_assert",
          args: ["api", "/repos/o/r/branches/main"],
          expect_contains: '"name":"main"',
        },
        "gh",
        ctx,
      );
      assert.equal(result.ok, true);
    });
  });

  it("fails clearly when stdout lacks the expected substring", async () => {
    await withRunDir(async (_runDir, ctx) => {
      ctx.execFileImpl = async () => ({ stdout: "other", stderr: "" });
      const result = await executeAction(
        { type: "gh_assert", args: ["api", "/x"], expect_contains: "missing" },
        "gh",
        ctx,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /did not contain "missing"/);
    });
  });
});
