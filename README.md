# samotest

Manual test scenario runner, browser/E2E walk driver, and evidence gate CLI for reviewer-visible dogfooding.

![samotest demo](docs/demo.gif)

> **Operating samotest from a bot?** This README is self-contained: it lists every
> environment variable, every command, and every gotcha needed to run samotest
> from a fresh clone with no human in the loop. The deep reference (full
> `--automated` action surface, scenario schema, troubleshooting) lives in
> [docs/bot-operations.md](docs/bot-operations.md).

## Release status

`samotest` v0.2.2 is ready for early real use through a local checkout, a local
tarball from `bun pm pack`, or a published package once available. Evidence
upload/comment posting is available for GitHub PRs with `GITHUB_TOKEN` or
authenticated `gh`, and for GitLab MRs/issues with `GITLAB_TOKEN` or `GLAB_TOKEN`;
use `--dry-run` to inspect the exact upload and comment actions without posting.

## 1. What it is

`samotest` is a [Bun](https://bun.sh)-based CLI that runs manual or automated test
scenarios (defined as YAML under `samo/scenarios/`), captures evidence
(screenshots, video, HAR/network logs, console logs, terminal casts), packages
that evidence into a stable `manifest.json`, posts a reviewer-readable summary to
a GitHub PR or GitLab MR/issue, and exposes a machine-readable evidence **gate**
that `samorev` consumes to decide PASS/FAIL. It can drive a real browser end to
end (Playwright Chromium) via `samotest run --automated`, so an autonomous agent
can walk a deployed app, prove a flow works, and attach the proof — all from the
repo alone.

## 2. Install and runtime

Requirements (verified against `package.json` `engines`):

- **Bun `>=1.3.13`** — the `samotest` bin runs on Bun. (`node >=20` also declared.)
- **The `dist/` build is NOT committed** (it is git-ignored). After cloning you
  MUST build before `samotest` exists. There is no published npm package yet;
  use the repo checkout.

From a fresh clone:

```sh
bun install        # installs deps incl. Playwright (devDependency)
bun run build      # tsc -> dist/cli.js (+ chmod +x). REQUIRED: dist/ is git-ignored.
bun link           # optional: puts `samotest` on PATH
samotest --help    # or: bun dist/cli.js --help
```

If you do not `bun link`, invoke the built CLI directly with `bun dist/cli.js <command>`
or `bun run start <command>` (the latter runs `src/cli.ts` via Bun without building).
All examples below use `samotest`; substitute `bun dist/cli.js` if it is not linked.

To test the installable package path without publishing:

```sh
bun install
bun pm pack --dry-run
bun pm pack
bun add -g ./samotest-0.2.2.tgz
samotest --version
```

Verify the version (must print `0.2.2`):

```sh
samotest --version
```

For browser/recorder capabilities you also need a Chromium install and, optionally,
`ffmpeg` / `asciinema` (see the setup checklist). Confirm with:

```sh
samotest doctor    # prints availability of screenshot / video / gif / cast recorders
```

## 3. Credential / setup checklist (for an autonomous bot)

Run these once, in order, before driving any real flow. Env vars are named only —
never write secret values into the repo, scenarios, or PR/issue bodies.

1. **Bun on PATH** — `bun --version` prints `>=1.3.13`.
2. **Clone + install + build** — `bun install && bun run build`. `dist/cli.js` must
   exist afterward (it is git-ignored, so a clone alone is not enough).
3. **Chromium for Playwright** — required for `record` (browser formats) and for
   `run --automated`. Install with `bunx playwright install chromium` (or
   `bunx playwright install --with-deps chromium` on a bare Linux runner to pull
   the system libraries). Confirm with `samotest doctor` → `screenshot`/`video`
   rows say `available`.
4. **`ffmpeg`** (optional) — only for `record --format gif`. Without it, `gif`
   falls back to a video artifact. `samotest doctor` → `gif` row.
5. **`asciinema`** (optional) — only for `record --format cast` (terminal
   recordings). `samotest doctor` → `cast` row.
6. **`git`** on PATH — the manifest writer reads `git rev-parse HEAD` for the
   source commit (falls back to `"unknown"`).
7. **Fixture test account for the app under test** (only for live login walks) —
   the bot must NOT sign up; the account is provisioned out-of-band by a human and
   reused forever. Credentials are supplied as **environment variables**, referenced
   inside the scenario YAML with `${env.VAR_NAME}` tokens (the automated runner
   interpolates them at run time and FAILS LOUDLY if any referenced var is unset).
   Choose your own names and export them; existing scenarios use:
   - `RELEASE_GATE_TEST_EMAIL`
   - `RELEASE_GATE_TEST_PASSWORD`

   (For the samo fixture, the maya@postgres.ai account file is referenced by
   env-var name elsewhere; never inline the password.)
8. **Provider token for posting evidence** (only for `evidence upload` without
   `--dry-run`):
   - GitHub PRs: `GITHUB_TOKEN` **or** an authenticated `gh` CLI (`gh auth status`
     must pass; samotest falls back to `gh auth token`).
   - GitLab MRs/issues: `GITLAB_TOKEN` **or** `GLAB_TOKEN` (either works).
   - `GITLAB_URL` (optional) — self-managed GitLab base URL; defaults to
     `https://gitlab.com`.

   Use `samotest evidence upload ... --dry-run` to validate everything before any
   token is required.

## 4. Command surface

Every command below is verified against `src/cli.ts` on `main`. Run `samotest --help`
for the canonical list. Exit codes: `0` ok / gate pass-warn-waived, `1` gate fail
or scenario failed, `2` manifest/IO error, `3` invalid usage, `4` reviewer artifact
URLs missing/unresolved.

### init

Scaffold `samo/scenarios/` (committed scenarios) and `.samo/evidence/` (generated
output, auto-added to `.gitignore`), plus `.samo/config.yaml`.

```sh
samotest init
```

### scenario validate

Validate one scenario file, or every `*.yaml`/`*.yml` under `samo/scenarios/` when
no path is given. Exits non-zero with `field: message` lines on invalid scenarios.

```sh
samotest scenario validate samo/scenarios/my-scenario.yaml
samotest scenario validate           # validate all scenarios in samo/scenarios/
```

> Note: `samotest scenario list` is listed in `--help` but is **not implemented**
> (it prints `scenario list is not implemented yet` and exits 1). To list
> scenarios, read the YAML files in `samo/scenarios/` directly.

### run (guided — manual status entry)

Walk a scenario step by step, reading PASS/FAIL status and attachment lines from
stdin, and write `<output>/<runId>/run.json`. For unattended use, pipe the answers
on stdin. A scenario id matches either the `id:` field or the filename stem.

```sh
samotest run my-scenario --output .samo/evidence --run-id local-smoke
```

Per step, stdin expects: a status line (`passed|failed|blocked|skipped|waived`), an
optional note line, then zero or more attachment lines and a blank line:

```text
screenshot path/to/screenshot.png
log path/to/output.log
```

Flags: `--output <dir>` (default `.samo/evidence`), `--run-id <id>`,
`--profile <name>`, `--pr <id>`, `--mr <id>`, `--automated` (see below).

### run --automated (browser-driven, no stdin)

Launch one headless Chromium per run and execute each step's typed `action`
against a single long-lived page. Captures full-page screenshots, a run video
(`run.webm`), a network HAR (`run.har`), and a console log (`console.log`),
writes the evidence `manifest.json` plus a `phase-summaries.json` sidecar, and
fails loudly on the first failing step (with a crash screenshot). `${env.VAR}`
tokens in the scenario are interpolated from the environment; a missing required
var aborts before launching the browser (exit 3).

```sh
RELEASE_GATE_TEST_EMAIL=... RELEASE_GATE_TEST_PASSWORD=... \
  samotest run e2e-full-walk-prod --automated --output .samo/evidence --run-id walk-$(date +%s)
```

Under `--automated` **every step must declare an `action`** (steps without one
fail the run). Supported action types: `navigate`, `click`, `fill`, `form_fill`,
`wait_for_selector`, `wait_for_inactivity`, `assert_text`, `assert_url_matches`,
`screenshot`, `play_record_video`, `api_call`, `gh_assert`. Full field reference
and a complete scenario example are in [docs/bot-operations.md](docs/bot-operations.md).

### record (single-format recorder)

Capture one recording for a scenario that declares a browser URL or terminal
command, and write a manifest. Formats: `screenshot`, `video`, `gif`, `cast`.

```sh
samotest doctor
samotest record my-browser-scenario --format screenshot
samotest record my-browser-scenario --format video
samotest record my-browser-scenario --format gif      # needs ffmpeg; falls back to video
samotest record my-terminal-scenario --format cast    # needs asciinema
```

Browser screenshots/videos use Playwright Chromium; GIF samples browser frames
over `recording.duration_ms` and converts with `ffmpeg`.
When `ffmpeg` is unavailable but browser video works, `record --format gif` writes video fallback evidence and says how to install `ffmpeg`.
Artifacts land under
`<output>/<runId>/artifacts/` with sha256 checksums in `manifest.json`. Set a
scenario's `recording.output_path` to also refresh a docs/demo copy. Flags:
`--output <dir>`, `--run-id <id>`, `--format <screenshot|gif|video|cast>`.

### evidence inspect

Print a committed or generated manifest (and whether it is gate-ready).

```sh
samotest evidence inspect samples/evidence/sprint1-cli-smoke/manifest.json
samotest evidence inspect samples/evidence/sprint1-cli-smoke --format json
```

### evidence package

Zip a run directory for handoff. **Only `--format zip` is supported** (the help
text mentions `dir`, but `--format dir` exits 3 with "Invalid --format. Expected zip.").

```sh
samotest evidence package samples/evidence/sprint1-cli-smoke --format zip
```

### evidence upload

Render the gate summary markdown and post it as a PR comment (GitHub) or MR/issue
note (GitLab), uploading artifacts + manifest to the provider and recording the
provider-owned URLs back into the manifest. Always dry-run first.

```sh
# Inspect the exact upload/comment actions without posting or needing a token:
samotest evidence upload .samo/evidence/walk-123 --provider gitlab --mr 400 --dry-run

# Post for real (requires the matching provider token from the checklist):
samotest evidence upload .samo/evidence/walk-123 --provider github --pr 42 --repo Tanya301/samotest
samotest evidence upload .samo/evidence/walk-123 --provider gitlab --mr 400 --repo group/project
samotest evidence upload .samo/evidence/walk-123 --provider gitlab --issue 660
```

Flags: `--provider github|gitlab`, `--pr <id>` (GitHub), `--mr <id>` / `--issue <id>`
(GitLab), `--repo <owner/repo or group/project>`, `--output <markdown-path>`,
`--dry-run`. Provider/target/repo default to values in `manifest.review` when present.

### gate check / gate report

The machine contract `samorev` reads. `gate check` emits `text` or `json`;
`gate report` adds `markdown`. Both honor `--base <ref>` and `--head <sha>`.

```sh
samotest gate check --manifest samples/evidence/sprint1-cli-smoke/manifest.json --format json
samotest gate report --manifest samples/evidence/sprint1-cli-smoke/manifest.json --format markdown
```

The full exit-code/JSON contract is in [docs/samorev-integration.md](docs/samorev-integration.md).

### doctor

Report Playwright/ffmpeg/asciinema availability so a bot can pre-flight before
recording.

```sh
samotest doctor
```

## 5. Gotchas and troubleshooting

- **`samotest: command not found` / missing `--automated`** — the `dist/` build is
  git-ignored and not in the clone. Run `bun install && bun run build`. A stale
  `dist/` from an old checkout can also lack newer flags; rebuild after pulling.
- **Recorders show `missing` in `samotest doctor`** — install the underlying tool:
  Chromium via `bunx playwright install chromium` (add `--with-deps` on bare Linux),
  `ffmpeg` for gif, `asciinema` for cast. `screenshot`/`video` both need Chromium.
- **`Missing required environment variable(s) ...`** (exit 3 on `run --automated`) —
  a `${env.VAR}` token in the scenario has no value. Export the var, or give the
  token a fallback (`${env.VAR:-default}`). The error lists every missing path.
- **Login walk fails / stays on `/login`** — the fixture account must be
  provisioned out-of-band; the walker never signs up. Treat a failed login as a
  hard FAIL, not a reason to create an account.
- **Chromium runs headless by default; serialize browser runs** — each
  `run --automated` / `record` launches and closes its own browser. Run **one at a
  time**; concurrent Chromium launches on a small VM contend for CPU/RAM and can
  hang. The driver closes the browser/context in a `finally` block, so a normal
  failure cleans up. If a run is killed (SIGKILL) mid-flight, sweep stragglers:
  `pkill -f 'chromium|playwright'` and remove temp profiles
  (`rm -rf /tmp/samotest-* /tmp/playwright*`).
- **Run heavy browser/LLM walks on a dedicated runner**, not the app's prod
  control-plane VM — Chromium is memory-hungry.
- **`evidence upload` without a token** — without `--dry-run`, GitHub needs
  `GITHUB_TOKEN` or authenticated `gh`; GitLab needs `GITLAB_TOKEN`/`GLAB_TOKEN`.
  A local markdown fallback is always written even when posting fails.
- **Gate fails with `local_only_evidence` / `manifest_url_missing` /
  `evidence_summary_missing`** — required artifacts need provider-hosted URLs, a
  hosted `manifest.review.manifest_url`, and a posted summary URL. Run
  `evidence upload` (not just a local manifest) before treating the gate as passed.
- **Secrets** — never inline tokens or fixture passwords into scenarios, manifests,
  or PR/issue bodies; reference them only by `${env.NAME}`. Manifests are written
  with `environment.redacted: true`.

## 6. What runs where / where evidence lands

- **`samo/scenarios/*.yaml`** — committed, human/bot-reviewable scenario specs.
- **`.samo/`** — runtime: `.samo/config.yaml` and `.samo/evidence/` (generated
  output; `.samo/evidence/` is git-ignored by `init`).
- **A run writes to `<output>/<runId>/`** (default output `.samo/evidence`):
  - `run.json` (guided runs) or `manifest.json` + `phase-summaries.json`
    (automated runs)
  - `artifacts/` — screenshots (`*.png`), `run.webm` (video), `run.har`
    (network), `console.log`, terminal casts (`*.cast`), api-call transcripts,
    crash screenshots on failure. Every artifact is sha256-checksummed in the
    manifest.
- **`evidence package`** zips the run dir; **`evidence upload`** pushes artifacts +
  manifest to the provider and rewrites the manifest with hosted URLs.
- **Browser** is headless Chromium (Playwright), launched and torn down per run.
- **`gate check`/`gate report`** read a manifest and emit the verdict to stdout;
  `samorev` consumes the JSON.

## PR checks

Pull requests (and any pre-push check) run:

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run build
```
