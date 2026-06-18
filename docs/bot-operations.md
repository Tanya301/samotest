# samotest bot operations guide

Deep reference for operating `samotest` autonomously: the full `--automated`
action surface, the scenario YAML schema, env-var interpolation, and the
end-to-end flow a bot follows. Everything here is verified against `src/` on
`main`. See the [README](../README.md) for install, the credential checklist,
and the top-level command surface.

## End-to-end flow a bot follows

1. `bun install && bun run build` (the `dist/` build is git-ignored — a clone has
   no runnable CLI until you build).
2. `bunx playwright install chromium` (add `--with-deps` on a bare Linux runner).
3. `samotest doctor` → confirm the recorders you need are `available`.
4. Export the credentials the scenario references (`${env.*}`) and the provider
   token for posting.
5. `samotest scenario validate samo/scenarios/<id>.yaml`.
6. `samotest run <id> --automated --run-id <unique>` → writes
   `.samo/evidence/<id-or-runId>/manifest.json` and drives the browser.
7. `samotest gate check --manifest .samo/evidence/<runId>/manifest.json --format json`
   → local self-check (will report missing hosted URLs until uploaded).
8. `samotest evidence upload <runId-or-path> --provider <p> --pr|--mr|--issue <id> --repo <r> --dry-run`
   → verify, then drop `--dry-run` to post.
9. `samorev` runs `gate check` to read the final verdict.

## Scenario YAML schema

Validated by `src/scenarioValidation.ts`. **Required fields** (validation fails
otherwise):

- `id` — string
- `title` — string
- `owner` — string
- `priority` — string (use `required` to mark the scenario blocking; the manifest
  sets `run.required` from `priority === "required"`)
- `steps` — non-empty list
- `result.required_observations` — non-empty list of non-empty strings

**Optional, recognized fields** used by the runners:

- `url` / `target.url` / `browser.url` / `app.url` — browser URL for `record`'s
  single-format recorders (auto-detected).
- `command` / `target.command` / `recording.command` / `recording.shell` —
  terminal command for `record --format cast`.
- `recording.duration_ms` (or `durationMs` / `wait_before_close_ms` / `wait_ms`)
  — how long to keep the browser open before capture finishes.
- `recording.output_path` — also copy the published recording here (e.g.
  `docs/demo.gif`).
- `prerequisites` — string list, echoed at run start.

**Per step:**

- `id` — string (defaults to `step-<n>`)
- `instruction`, `expected` — strings (shown in guided mode)
- `evidence` — list (guided/record metadata)
- `phase` — string; the automated runner groups consecutive steps that share a
  `phase` into one consolidated summary callback (avoids comment spam). If absent,
  a step inherits the previous step's phase (or `default`).
- `action` — typed automated action (see below). **Required under `--automated`**;
  a step without an `action` fails the automated run. Scenarios without `action`
  blocks still run in guided mode.

## `${env.VAR}` interpolation

Source: `src/envInterpolation.ts`. Before an automated run launches the browser,
every string in the scenario tree is scanned for `${env.VAR_NAME}` tokens:

- `${env.RELEASE_GATE_TEST_EMAIL}` → replaced with the env var's value.
- `${env.VAR:-fallback}` → uses `fallback` when the var is empty/unset.
- A referenced var with no value and no fallback raises `MissingEnvVarError`,
  which the runner turns into exit code 3 and lists every missing
  `path -> ${env.VAR}` reference. The browser is never launched in this case, and
  a failure manifest is still written.

Use this for fixture credentials and any environment-specific URL — never inline
the secret.

## Automated action surface (`run --automated`)

The runner switches on `action.type` (source of truth: `ACTION_EXECUTORS` in
`src/automatedActions.ts`). An unknown type fails the step with the supported list.

| `type` | Required fields | Optional fields | Behavior |
| --- | --- | --- | --- |
| `navigate` | `url` | `wait_until` (default `load`), `wait_for_selector` | `page.goto`, then optionally wait for a selector. |
| `click` | `selector` | — | `page.click(selector)`. |
| `fill` | `selector`, `value` | — | `page.fill(selector, value)`. |
| `form_fill` | `fields` (array of `{selector, value}`) | `url`, `submit` (selector to click), `await` (URL → `waitForURL`, else `waitForSelector`) | Optionally navigate, fill each field, optionally submit, optionally wait. Ideal for login. |
| `wait_for_selector` | `selector` | `timeout_ms` (or `timeout`) | Wait until the selector appears. |
| `wait_for_inactivity` | `selector` | `poll_ms` (1000), `heartbeat_ms` (15000), `stale_after_ms` (30000), `expect_selector_present` | Poll a DOM fingerprint; success when it stops changing for `stale_after_ms`. For spec-rounds / codegen / deploy waits without a fixed timeout. |
| `assert_text` | `selector`, `expected` (string substring **or** `{ regex: "..." }`) | — | Fail unless the selector's text matches. |
| `assert_url_matches` | `regex` | — | Fail unless the current URL matches the regex. |
| `screenshot` | — | `name` (defaults to `<step-slug>-<NN>`) | Full-page PNG into `artifacts/`. |
| `play_record_video` | — | `phase`, `boundary` | Writes a segment marker JSON; the run video itself is recorded once per run by the driver. |
| `api_call` | `url` | `method` (GET), `headers`, `body`, `expect_status` (or `expected_status`), `expect_json_contains` | HTTP request; assert status and/or that the JSON contains the given subtree. Writes a sanitized transcript artifact. |
| `gh_assert` | `args` (string[]) | `expect_contains` | Run `gh <args>`; optionally assert stdout contains a substring. e.g. `args: ["api", "/repos/owner/repo/branches/main"]`. |

## Complete `--automated` scenario example

```yaml
id: login-and-screenshot
title: Login walk and dashboard screenshot
owner: "@bot"
priority: required
steps:
  - id: open-login
    phase: auth
    action:
      type: navigate
      url: "https://app.example.test/login"
      wait_for_selector: "[type=email]"
  - id: do-login
    phase: auth
    action:
      type: form_fill
      fields:
        - selector: "[type=email]"
          value: "${env.RELEASE_GATE_TEST_EMAIL}"
        - selector: "[type=password]"
          value: "${env.RELEASE_GATE_TEST_PASSWORD}"
      submit: "button[type=submit]"
      await: "https://app.example.test/dashboard"
  - id: dashboard-shot
    phase: verify
    action:
      type: screenshot
      name: dashboard
  - id: dashboard-assert
    phase: verify
    action:
      type: assert_url_matches
      regex: "/dashboard"
result:
  required_observations:
    - "Login succeeds and the dashboard renders."
    - "A full-page dashboard screenshot is captured."
```

Run it:

```sh
RELEASE_GATE_TEST_EMAIL=... RELEASE_GATE_TEST_PASSWORD=... \
  samotest run login-and-screenshot --automated --run-id walk-$(date +%s)
```

Output lands in `.samo/evidence/walk-<ts>/`: `manifest.json`,
`phase-summaries.json`, and `artifacts/` (`dashboard.png`, `run.webm`, `run.har`,
`console.log`, and a `<step>-crash.png` if a step fails).

## Cleanup and serialization

- Run **one** browser-driving command at a time. Concurrent Chromium launches on a
  small VM contend for CPU/RAM and can hang.
- The driver tears down browser + context in a `finally` block, so normal runs and
  step failures clean up after themselves.
- After a killed run, sweep stragglers: `pkill -f 'chromium|playwright'` and
  `rm -rf /tmp/samotest-* /tmp/playwright*`.

## Gate semantics (summary)

`gate check`/`gate report` exit codes: `0` pass/warn/waived, `1` required evidence
failed, `2` manifest unreadable, `3` bad usage, `4` reviewer artifact URLs
missing/unresolvable. Stable error codes include `stale_evidence`,
`evidence_status_failed`, `artifact_url_missing`, `local_only_evidence`,
`manifest_url_missing`, `evidence_summary_missing`, `artifact_url_unresolved`. A
local-only manifest passes the structural check but fails the reviewer gate until
`evidence upload` records provider-hosted URLs. Full contract:
[docs/samorev-integration.md](samorev-integration.md).
```
