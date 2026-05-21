# samotest Product Specification

## Summary

`samotest` is a manual testing and evidence capture tool for development teams that need every pull request or merge request to include reviewable proof that the change was exercised. It is designed to work with `samorev` review gates by producing structured test evidence, linking that evidence to PR/MR checks, and making sprint-by-sprint alignment explicit.

The first version should focus on reproducible manual test scenarios for local and CI-like environments, with screenshots, terminal casts, GIFs, and short videos as first-class artifacts.

## Product Goals

- Capture manual test evidence for code changes in a repeatable, reviewable format.
- Support multiple scenario types: CLI workflows, web UI workflows, service/API checks, and demo recordings.
- Make evidence easy to attach to GitHub pull requests and GitLab merge requests.
- Provide a machine-readable manifest that `samorev` can use as a review gate input.
- Encourage spec-first delivery: each sprint starts with spec review, every implementation PR includes evidence, and each sprint closes with demo/evidence review.
- Make local-first usage simple enough for individual contributors while preserving enough metadata for team review and audit.

## Non-Goals

- `samotest` does not attempt to certify correctness without human review of the resulting evidence.
- It does not execute untrusted scenarios from external contributors without explicit opt-in.
- It does not store evidence in a hosted SaaS service in the initial product.
- It does not provide pixel-perfect visual regression comparison in Sprint 1.
- It does not implement a full browser automation framework from scratch; it wraps Playwright (Chromium) under the automated runner and orchestrates proven tools elsewhere.

> v0.2 listed "not an automated test runner replacement" as a non-goal.
> v0.3 amends that: `samotest run --automated <scenario>` is now a
> first-class capability. Scenarios that opt into automation by declaring
> `action:` blocks on every step become the canonical release-gate
> walker and replace bespoke Playwright drivers. Scenarios without
> `action:` blocks continue to run as guided-manual, unchanged.

## Primary Users

- **Contributor:** runs scenarios locally, captures evidence, and attaches it to a PR/MR.
- **Reviewer:** inspects the evidence manifest and artifacts before approving a change.
- **Maintainer:** defines required scenarios and configures `samorev` gates.
- **Release/Sprint Lead:** reviews scenario coverage and evidence at sprint boundaries.

## Core Concepts

- **Scenario:** A named manual or semi-automated workflow that describes what to test, how to set it up, what steps to perform, and what evidence to capture.
- **Evidence Artifact:** A screenshot, GIF, video, terminal cast, log, or note produced while running a scenario.
- **Evidence Manifest:** A structured JSON file describing executed scenarios, artifacts, environment metadata, result status, timestamps, and source revision.
- **Evidence Bundle:** A directory or archive containing the manifest and all referenced artifacts.
- **Review Gate:** A GitHub/GitLab or `samorev` policy that requires acceptable evidence before approval or merge.
- **Demo Tape:** A reproducible recording script inspired by VHS-style `.tape` files and terminal casts, used for demos that should be easy to re-render.

## User Workflows

### 1. Create a Scenario

1. A maintainer creates a scenario file under `samo/scenarios/`.
2. The scenario declares the purpose, prerequisites, commands or manual steps, expected observations, and required evidence types.
3. The scenario can include optional recording instructions for terminal, browser, or desktop capture.
4. The scenario is reviewed with the product/spec change before implementation begins.

### 2. Run a Manual Test Locally

1. A contributor checks out a branch.
2. The contributor runs `samotest run <scenario>`.
3. `samotest` guides the contributor through setup and steps.
4. The contributor captures required evidence at each checkpoint.
5. `samotest` writes an evidence bundle under `.samo/evidence/<run-id>/`.
6. The contributor attaches or uploads the bundle and references it from the PR/MR.

### 3. Record a Reproducible Demo

1. A contributor runs `samotest record <scenario> --format gif`.
2. `samotest` uses the scenario's recording instructions and local recorder dependencies to produce a screenshot, browser video, GIF, or terminal cast.
3. Browser screenshots/videos use Playwright Chromium, GIF recording samples browser frames for the configured recording duration and uses `ffmpeg`, and terminal casts use `asciinema`.
4. If `ffmpeg` is unavailable for GIF conversion, `samotest` records browser video fallback evidence when Playwright video is available and prints an actionable install message.
5. Generated artifacts are referenced by the evidence manifest with sha256 checksums.
6. Reviewers can inspect the final recording and, where possible, re-render it from the scenario inputs.

### 4. Enforce Evidence on a PR/MR

1. A PR/MR is opened.
2. `samorev` asks `samotest` for required scenario evidence or reads the committed/uploaded evidence manifest.
3. The gate checks that required scenarios have passing evidence for the target revision.
4. Missing, stale, or incomplete evidence blocks approval or merge.
5. A reviewer can explicitly waive a scenario with a reason, depending on repository policy.

### 5. Sprint Alignment

1. At sprint start, the team reviews this spec and scenario coverage.
2. During implementation, every PR/MR includes evidence for changed behavior.
3. At sprint close, the team reviews produced demos, evidence quality, and gaps.
4. Spec updates are made before the next sprint starts.

## CLI Shape

The CLI should be explicit, scriptable, and local-first.

```text
samotest init
samotest scenario list
samotest scenario validate [path]
samotest run <scenario-id> [--automated] [--profile <name>] [--output <dir>] [--pr <id>] [--mr <id>]
samotest record <scenario-id> [--format screenshot|gif|video|cast] [--output <dir>]
samotest evidence inspect <run-id-or-path>
samotest evidence package <run-id-or-path> [--format dir|zip]
samotest evidence upload <run-id-or-path> [--provider github|gitlab]
samotest gate check --manifest <path> [--base <ref>] [--head <ref>] [--format text|json]
samotest gate report --manifest <path> [--format text|json|markdown]
samotest doctor
```

### Command Responsibilities

- `init`: creates the shared `samo/` and `.samo/` structure plus a starter config.
- `scenario list`: lists scenarios, owners, tags, and required evidence.
- `scenario validate`: validates scenario syntax and required fields.
- `run`: starts a scenario run and captures evidence. Without `--automated`, the run is interactive and guided. With `--automated`, every step's `action:` block is executed against a Playwright Chromium session and evidence is captured automatically (see "Automated Mode" below).
- `record`: creates screenshot/GIF/video/cast artifacts from scenario recording instructions.
- `evidence inspect`: prints a human-readable and machine-readable summary.
- `evidence package`: builds a portable evidence bundle.
- `evidence upload`: publishes artifacts to GitHub/GitLab-native storage when configured.
- `gate check`: validates one explicit manifest, prints text or the stable JSON gate report, and exits non-zero when required evidence is missing, stale, malformed, waived without authority, or failing.
- `gate report`: renders the same manifest and gate result for reviewer consumption as text, JSON, or Markdown without changing gate semantics.
- `doctor`: checks local dependencies such as browser drivers, terminal recorders, capture tools, and auth.

## Repository Layout

```text
samo/
  scenarios/
    <scenario-id>.yaml
.samo/
  config.yaml
  evidence/
    <run-id>/
      manifest.json
      artifacts/
      notes.md
  tapes/
    <scenario-id>.tape
```

Visible, human-reviewable project artifacts live under `samo/`. Hidden runtime/config artifacts live under `.samo/`. Evidence directories may be ignored by default for large artifacts, while small scenario definitions and reproducible tape files should be committed.

## Scenario Format

Scenarios should be written in YAML for human review and easy diffs.

```yaml
id: checkout-discount-demo
title: Checkout discount manual demo
owner: "@team-web"
tags: ["web", "checkout", "manual"]
priority: required
applies_to:
  paths:
    - "web/checkout/**"
    - "api/discounts/**"
  labels:
    - "area:checkout"
environment:
  profile: local
  services:
    - name: web
      command: "npm run dev"
      url: "http://localhost:3000"
prerequisites:
  - "Seed demo account with an active discount code."
steps:
  - id: open-cart
    instruction: "Open the cart page for the seeded demo account."
    evidence:
      - type: screenshot
        name: cart-before-discount
  - id: apply-code
    instruction: "Apply discount code SAVE10."
    expected: "Order summary shows a 10% discount and updated total."
    evidence:
      - type: screenshot
        name: cart-after-discount
      - type: video
        name: apply-discount-flow
result:
  required_observations:
    - "Discount appears once."
    - "Total updates without page refresh."
    - "No error toast appears."
recording:
  mode: browser
  duration_ms: 3500
  output_path: docs/demo.gif
  preferred_formats: ["gif", "video"]
  tape: "samo/tapes/checkout-discount-demo.tape"
```

Steps that opt into automated execution add a `phase:` label and an
`action:` block. Example:

```yaml
steps:
  - id: login
    phase: auth
    instruction: "Fill login form with fixture creds."
    expected: "Redirect to /dashboard."
    action:
      type: form_fill
      url: "${env.RELEASE_GATE_BASE_URL}/login"
      fields:
        - selector: "#email"
          value: "${env.RELEASE_GATE_TEST_EMAIL}"
        - selector: "#password"
          value: "${env.RELEASE_GATE_TEST_PASSWORD}"
      submit: "[data-testid=login-submit]"
      await: "${env.RELEASE_GATE_BASE_URL}/dashboard"
    evidence:
      - type: screenshot
        name: dashboard-loaded
```

Action types and their parameters are listed in the "Automated Mode"
section below.

### Required Scenario Fields

- `id`
- `title`
- `owner`
- `priority`
- `steps`
- `result.required_observations`

### Optional Scenario Fields

- `tags`
- `applies_to.paths`
- `applies_to.labels`
- `environment`
- `prerequisites`
- `recording`
  - `duration_ms`: optional browser recording hold time before close for video and GIF capture.
  - `output_path`: optional repo-relative path for a copy of the final requested recording artifact, such as `docs/demo.gif`.
- `risk`
- `waiver_policy`
- Per-step `phase` (string label, used by `--automated` for consolidated phase comments).
- Per-step `action` (typed automated action; see "Automated Mode" below).

## Automated Mode (v0.3)

`samotest run --automated <scenario-id>` executes every step's
`action:` block programmatically against a Playwright Chromium session.
It exists so the canonical release-gate walker can be a thin
`samotest run --automated <scenario>` call instead of a bespoke
Playwright spec per repository.

### When to use

- Continuous release-gate walks against a deployed environment.
- Per-tag deploy verification (`samotest walk after every deploy` rule).
- Any scenario where every step is mechanical and a human reviewer
  inspects the resulting evidence rather than authoring the keystrokes.

Scenarios without `action:` blocks on their steps continue to run as
guided-manual under `samotest run`. Mixing modes in one scenario fails
loudly: under `--automated`, every step must declare an `action:`.

### Action types

Each step's `action:` is an object with a `type:` field plus type-specific
parameters. The v0.3 supported types are:

| `type`                | Required fields                                              | Behaviour                                                                                                  |
| --------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `navigate`            | `url`                                                        | `page.goto(url)`. Optional `wait_for_selector` waits for a selector after load.                            |
| `click`               | `selector`                                                   | `page.click(selector)`.                                                                                    |
| `fill`                | `selector`, `value`                                          | `page.fill(selector, value)`.                                                                              |
| `form_fill`           | `fields[]` (each `selector` + `value`)                       | Optional `url` navigates first. Fills each field. Optional `submit` selector clicks. Optional `await` waits for URL or selector. |
| `wait_for_selector`   | `selector`                                                   | `page.waitForSelector(selector)`. Optional `timeout_ms`.                                                   |
| `wait_for_inactivity` | `selector`                                                   | Polls the DOM and declares success when the fingerprint stops changing for `stale_after_ms` (default 30s). NO wall-clock kill (HARD RULE 10). |
| `assert_text`         | `selector`, `expected` (string substring or `{ regex: "" }`) | Fails clearly when the selector's text doesn't contain the substring or match the regex.                   |
| `assert_url_matches`  | `regex`                                                      | Fails clearly when `page.url()` doesn't match the regex.                                                   |
| `screenshot`          | (none)                                                       | Captures a full-page PNG under `artifacts/`. Auto-numbered or `name:`-overridden.                          |
| `play_record_video`   | (none)                                                       | Writes a per-step boundary marker (`start`/`stop`/`mark`) for the run-level video Playwright records.      |
| `api_call`            | `url`                                                        | `fetch(url, { method, headers, body })`. Optional `expect_status` + `expect_json_contains` assertions. Persists a sanitized request/response transcript as a `log` artifact. |
| `gh_assert`           | `args[]`                                                     | Runs `gh <args...>`. Optional `expect_contains` asserts a substring in stdout. For repo / branch / commit checks during release walks. |

Unknown `action.type` values fail validation at scenario load time and
also fail at execution time — no half-measures, no silent skip.

### Phases

Each step can carry a `phase:` label. Consecutive steps that share the
same `phase:` are grouped into one consolidated comment posted by the
runner (per `consolidated-status-not-spam`). The default phase, used
when no `phase:` is declared, is `default`.

A typical release-gate walk uses phases like `bootstrap`, `auth`,
`wizard`, `spec`, `accept`, `codegen`, `deploy`, `app-flow`, `cleanup`.

### Environment interpolation

Any string value in the scenario YAML may contain
`${env.VAR_NAME}` or `${env.VAR_NAME:-fallback}` tokens. The runner
substitutes them from the process environment at scenario load time.
Missing required variables (no fallback supplied AND no value present)
cause the run to fail loudly with `MissingEnvVarError` listing every
missing reference; the runner never silently treats a missing var as
an empty string. This matches the canonical release-gate walker's
fail-loudly contract.

### Inactivity heartbeat (HARD RULE 10)

Long LLM-bound or deploy-bound waits use `wait_for_inactivity`, which
runs a probe + DOM fingerprint loop and:

- emits one `[heartbeat] still waiting for <step> (<n>s elapsed)`
  line every `heartbeat_ms` (default 15s) on stderr;
- declares success when the fingerprint has been identical for
  `stale_after_ms` (default 30s);
- never wall-clock-kills.

This is the canonical pattern for spec-rounds, codegen progress, and
deploy probes inside scenario runs.

### Evidence captured automatically

Every automated run produces:

- one `recordVideo` WebM under `artifacts/run.webm`;
- one `recordHar` JSON under `artifacts/run.har`;
- a `console.log` of every console + pageerror event;
- a full-page screenshot for every `screenshot` action;
- a per-step transcript for every `api_call`;
- a per-step boundary marker for every `play_record_video` action;
- a crash screenshot at the failure point if any step fails.

All of the above are referenced in the same `manifest.json` schema
(`schema_version: "0.1"`) that the guided mode emits, so `samorev`,
`gate check`, and the GitHub/GitLab upload paths require no changes.

A v0.3 `phase-summaries.json` sidecar is also written under the run
directory with one entry per logical phase for downstream consolidated
comment renderers.

## Evidence Artifacts

`samotest` should support these artifact types:

- `screenshot`: PNG or JPEG image.
- `gif`: short animated GIF for quick PR review.
- `video`: MP4 or WebM recording for longer demos.
- `cast`: terminal session recording such as asciinema-compatible casts.
- `log`: captured command output or service logs.
- `note`: human-written Markdown observation.
- `bundle`: packaged directory or ZIP containing multiple artifacts.

### Evidence Manifest

Every run produces `manifest.json`.

```json
{
  "schema_version": "0.1",
  "tool": {
    "name": "samotest",
    "version": "0.1.0"
  },
  "run": {
    "id": "2026-05-08T190500Z-checkout-discount-demo",
    "scenario_id": "checkout-discount-demo",
    "status": "passed",
    "started_at": "2026-05-08T19:05:00Z",
    "finished_at": "2026-05-08T19:08:41Z"
  },
  "source": {
    "repo": "Tanya301/samotest",
    "base_ref": "main",
    "head_ref": "feature/discount",
    "commit": "HEAD"
  },
  "environment": {
    "os": "linux",
    "profile": "local",
    "browser": "chromium",
    "redacted": true
  },
  "artifacts": [
    {
      "type": "screenshot",
      "name": "cart-after-discount",
      "path": "artifacts/cart-after-discount.png",
      "sha256": "...",
      "url": "https://github.com/Tanya301/samotest/actions/runs/123/artifacts/456"
    }
  ],
  "observations": [
    {
      "step_id": "apply-code",
      "status": "passed",
      "note": "Discount applied once and total updated."
    }
  ],
  "review": {
    "pr": "123",
    "provider": "github",
    "uploaded_urls": []
  }
}
```

### Artifact Rules

- Artifacts must be referenced from the manifest by relative path and checksum.
- Artifacts uploaded to provider storage must also include a reviewer-accessible `url`.
- Large artifacts should be uploaded to provider storage or build artifacts instead of committed.
- The manifest must identify the source revision so stale evidence can be detected.
- Evidence status must be one of `passed`, `failed`, `blocked`, `skipped`, or `waived`.
- Waived evidence must include reviewer, timestamp, and reason.
- Local-only evidence is allowed before upload, but PR/MR gates require either reachable provider URLs or an approved waiver explaining why artifacts remain local-only.

## GitHub Integration

`samotest` should support GitHub pull request workflows:

- Detect PR metadata from environment variables in GitHub Actions.
- Upload evidence bundles as workflow artifacts.
- Generate Markdown summary comments for PR review.
- Expose `samotest gate check` as a required status check.
- Support mapping changed paths and labels to required scenarios.
- Allow maintainers to configure required evidence per repository.

### GitHub Artifact Discovery Contract

For a GitHub PR, reviewers and `samorev` discover evidence in this order:

1. Read the PR comment or check summary containing `samotest-manifest-url`.
2. If absent, inspect the required `samotest evidence gate` workflow run for the PR head commit.
3. Download the workflow artifact named `samotest-evidence-<pr-number>-<head-sha>`.
4. Read `<bundle>/manifest.json`; every uploaded artifact in the manifest must include `path`, `sha256`, and `url`.

The GitHub artifact retention period must be at least 30 days or the repository default, whichever is longer. Local evidence can be uploaded outside CI with `samotest evidence upload --provider github`, but the resulting PR comment or check summary must point to the same manifest URL and artifact URLs that CI would expose. If evidence remains local-only, the gate fails unless a maintainer or configured code owner adds an authorized waiver.

Example GitHub Actions usage:

```yaml
name: samotest evidence gate
on:
  pull_request:
jobs:
  evidence:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: samotest gate check --manifest .samo/evidence/latest/manifest.json --base origin/main --head HEAD --format json
      - run: samotest gate report --manifest .samo/evidence/latest/manifest.json --format markdown >> "$GITHUB_STEP_SUMMARY"
```

## GitLab Integration

`samotest` should support GitLab merge request workflows:

- Detect MR metadata from GitLab CI variables.
- Upload evidence bundles as job artifacts.
- Generate Markdown reports for MR comments or job summaries.
- Expose `samotest gate check` as a CI job that can block merge.
- Support mapping changed paths and labels to required scenarios.

### GitLab Artifact Discovery Contract

For a GitLab MR, reviewers and `samorev` discover evidence in this order:

1. Read the MR note or job summary containing `samotest-manifest-url`.
2. If absent, inspect the required `samotest:evidence` CI job for the MR head SHA.
3. Download the job artifact named `samotest-evidence-<mr-iid>-<head-sha>`.
4. Read `<bundle>/manifest.json`; every uploaded artifact in the manifest must include `path`, `sha256`, and `url`.

The GitLab job artifact retention period must be at least 30 days or the project default, whichever is longer. Local evidence can be uploaded outside CI with `samotest evidence upload --provider gitlab`, but the resulting MR note or job summary must expose the same manifest URL and artifact URLs that CI would expose. If evidence remains local-only, the gate fails unless a maintainer or configured code owner adds an authorized waiver.

## samorev Integration

`samorev` should treat `samotest` as the evidence provider for manual testing gates.

Expected integration contract:

- `samotest gate check --manifest <path> --base <base-ref> --head <head-sha> --format json` is the Sprint 1 machine contract for `samorev`.
- `samotest gate report --manifest <path> --format json` may emit the same JSON shape for reporting, but `samorev` gates consume `gate check` because its exit code is authoritative.
- `samorev` review notes should include a `## samorev review note: samotest` section with the gate status, manifest link, per-scenario evidence links, gate errors, and the embedded `samotest gate check` JSON in a details block. The exact shape is documented in `docs/samorev-integration.md`.
- `samorev` can require:
  - at least one evidence bundle per PR/MR;
  - all required scenarios for changed paths;
  - fresh evidence for the current head commit;
  - reviewer acknowledgement for failed, skipped, blocked, or waived scenarios.
- `samorev` can render missing evidence as actionable review comments.
- `samorev` should link directly to evidence artifacts when provider URLs exist.

Sprint 1 gate statuses:

- `pass`: required evidence exists and is fresh.
- `fail`: required evidence is missing, failed, stale, or malformed.
- `warn`: optional evidence is missing or low quality.
- `waived`: required evidence was waived according to policy.

Sprint 1 exit semantics:

- Exit `0`: overall status is `pass` or `warn`.
- Exit `1`: overall status is `fail`.
- Exit `2`: the manifest cannot be read, parsed, or validated.
- Exit `3`: command usage or configuration is invalid.
- Exit `4`: an uploaded artifact URL required for review cannot be resolved.

Freshness rules:

- When `gate.require_fresh_head` is true, `manifest.source.commit` must equal the PR/MR head SHA passed with `--head` or discovered from CI.
- `manifest.source.base_ref` and `manifest.source.head_ref` must match supplied refs when `--base` or `--head` are provided.
- Each required scenario must have a finished run whose status is `passed` or an authorized `waived`.
- Stale, missing, malformed, failed, skipped, blocked, unauthorized waived, checksum-mismatched, or URL-unresolved evidence produces `fail`.

Stable Sprint 1 JSON gate report:

```json
{
  "schema_version": "0.1",
  "tool": {
    "name": "samotest",
    "version": "0.1.0"
  },
  "gate": {
    "status": "fail",
    "checked_at": "2026-05-08T19:15:00Z",
    "base_ref": "main",
    "head_ref": "feature/discount",
    "head_sha": "abc123",
    "manifest_path": ".samo/evidence/run-1/manifest.json",
    "manifest_url": "https://github.com/Tanya301/samotest/actions/runs/123/artifacts/456",
    "summary": {
      "required": 1,
      "passed": 0,
      "failed": 1,
      "warned": 0,
      "waived": 0
    }
  },
  "scenarios": [
    {
      "id": "checkout-discount-demo",
      "required": true,
      "status": "fail",
      "fresh": false,
      "reason": "manifest source commit does not match head_sha",
      "artifacts": [
        {
          "type": "screenshot",
          "name": "cart-after-discount",
          "path": "artifacts/cart-after-discount.png",
          "sha256": "...",
          "url": "https://github.com/Tanya301/samotest/actions/runs/123/artifacts/456"
        }
      ],
      "waiver": null
    }
  ],
  "errors": [
    {
      "code": "stale_evidence",
      "message": "Evidence was captured for a different commit.",
      "scenario_id": "checkout-discount-demo"
    }
  ]
}
```

## Alignment Loop

Every sprint must follow this loop:

1. **Sprint-start spec review:** Before implementation starts, review `SPEC.md`, open questions, and scenario coverage. Update the spec before building if product behavior has changed.
2. **PR review gate:** Every implementation PR/MR must be reviewed against the current spec. Reviewers should reject changes that drift from the agreed behavior without a spec update.
3. **Test evidence gate:** Every implementation PR/MR must include `samotest` evidence or an explicit waiver. `samorev` should block merge when required evidence is missing, stale, or malformed.
4. **Sprint-close demo/evidence review:** At sprint close, review the produced screenshots, GIFs, videos, casts, manifests, and gate reports. Capture gaps as spec updates or next-sprint issues.

### Required Sprint Artifacts and Gates

The alignment loop is enforceable through required artifacts, status checks, waiver authority, and signoff points:

| Stage | Required artifact | Required check | Signoff |
| --- | --- | --- | --- |
| Sprint start | A spec/scenario coverage review issue or PR comment listing in-scope behavior, required scenarios, deferred gaps, and waiver policy. | Planning cannot begin until the artifact is approved. | Sprint lead plus maintainer or configured code owner. |
| Implementation PR/MR | A spec-alignment section in the PR/MR body linking changed behavior to `SPEC.md`, scenario files, and the evidence manifest URL. | PR/MR template checklist must be complete before review. | Reviewer verifies spec alignment before approval. |
| Evidence gate | `manifest.json`, uploaded artifact URLs, `samotest gate check --manifest <path> --format json` output, and provider check/job link. | Required CI status `samotest evidence gate` must pass. Missing, stale, malformed, URL-unresolved, checksum-mismatched, failed, skipped, blocked, or unauthorized waived evidence fails. | `samorev`/CI enforces; reviewer confirms artifacts are inspectable. |
| Waiver | Waiver record in the manifest or PR/MR comment with scenario id, reason, approver, timestamp, and expiration or follow-up issue. | `samotest gate check` accepts only authorized waivers. | Maintainer or configured code owner; authors cannot waive their own required evidence. |
| Sprint close | Sprint-close evidence review issue or PR comment linking manifest(s), screenshots, GIF/video/cast artifacts, gate reports, demo notes, and follow-up gaps. | Next sprint spec update cannot begin until sprint-close review is recorded. | Sprint lead plus maintainer or configured code owner. |

Implementation PR/MR template minimum:

```markdown
## Spec Alignment
- SPEC.md sections:
- Scenarios exercised:
- Evidence manifest URL:
- Artifact URLs:
- Waivers:

## samotest Gate
- [ ] `samotest gate check --manifest <path> --format json` passed or authorized waiver is linked.
- [ ] Manifest source commit matches this PR/MR head SHA.
- [ ] Reviewers can open every required artifact URL.
```

Required CI checks:

- `samotest scenario validate` for changed scenario files.
- `samotest gate check --manifest <path> --head <sha> --format json` for every implementation PR/MR.
- Provider artifact availability check for the manifest URL and each artifact URL.

Required signoff points:

- Sprint-start approval signs off scenario coverage before implementation starts.
- PR/MR approval signs off spec alignment and evidence availability for the change.
- Sprint-close approval signs off demo quality, known gaps, and whether the next sprint requires spec updates.

## Security and Privacy Constraints

- `samotest` must never upload artifacts without explicit configuration or command invocation.
- Secrets must be redacted from logs, terminal casts, browser URLs, cookies, headers, and environment snapshots.
- Scenario files are executable-adjacent and must be treated as trusted repository content.
- Running a scenario from a fork or external contribution should require explicit approval in CI.
- Evidence manifests should store environment metadata conservatively and avoid sensitive host details by default.
- Screenshots and videos may contain customer or developer data; the tool must support local-only evidence and configurable retention.
- Artifact checksums should be recorded so reviewers can detect tampering after capture.
- The default evidence directory should be easy to exclude from version control.
- Provider upload tokens must come from standard CI secrets or local credential helpers, never from scenario files.

## Configuration

`.samo/config.yaml` should define repository-level policy.

```yaml
schema_version: "0.1"
evidence:
  default_output: ".samo/evidence"
  commit_artifacts: false
  allowed_formats: ["screenshot", "gif", "video", "cast", "log", "note"]
gate:
  require_fresh_head: true
  require_for_every_pr: true
  required_statuses: ["passed"]
  allow_waivers: true
providers:
  github:
    upload: actions-artifact
  gitlab:
    upload: job-artifact
redaction:
  enabled: true
  patterns:
    - "token=[^&\\s]+"
    - "Authorization: .*"
```

## Sprint 1 Scope

Sprint 1 should produce a thin vertical slice of the spec-first workflow, not a complete product. The slice is: initialize repository config, validate one scenario schema, run one guided text scenario, attach existing files, generate a manifest with checksums, inspect that manifest, and run a minimal gate check against an explicit manifest path.

### Acceptance Criteria

- Repository contains reviewed `SPEC.md` as the source of product truth.
- `samotest init` can create `.samo/config.yaml`, `samo/scenarios/`, and `.samo/evidence/`.
- `samotest scenario validate` can validate the required fields for one YAML scenario schema.
- `samotest run <scenario-id>` can guide a contributor through text-based manual steps and collect notes plus file attachments.
- Evidence manifest schema `0.1` is generated with run metadata, source revision, observations, artifacts, and checksums.
- `samotest evidence inspect` can summarize a manifest in text and JSON.
- `samotest gate check --manifest <path> --format json` can fail when explicit manifest evidence is missing, stale, malformed, URL-unresolved, or not passed.
- The stable Sprint 1 gate JSON report and exit semantics documented in this spec are implemented.
- One sample CLI scenario exists and can produce notes plus one attached file artifact.
- Sprint-close demo includes one manifest, one screenshot or log attachment, gate JSON output, and demo notes.

Deferred beyond Sprint 1 unless capacity is explicitly confirmed:

- Path-aware or label-aware scenario resolution.
- Provider upload automation for GitHub or GitLab.
- Full GitHub/GitLab comment/report publishing.
- Browser/UI scenario execution beyond static sample documentation.
- `.tape` generation.
- Evidence packaging beyond the manifest directory needed by the thin slice.

Sprint 1 recording expectation:

- `.tape` files may be included as documented examples only; they are not required to be runnable in Sprint 1.
- GIF, video, and cast files are accepted as attached evidence produced by external tools.
- Sprint 3 adds native Playwright browser video, optional `ffmpeg` GIF conversion, and `asciinema` terminal cast generation through `samotest record`.
- Recorder dependencies are optional for CI. `samotest doctor` reports Playwright, `ffmpeg`, and `asciinema` availability; missing tools produce clear record errors or GIF video fallback.

## Proposed First Sprint Issue Breakdown

1. **Create project skeleton and CLI entrypoint**
   - Define language/runtime choice.
   - Add packaging metadata.
   - Implement `samotest --help` and command stubs.

2. **Add repository initialization**
   - Implement `samotest init`.
   - Generate starter `.samo/config.yaml`.
   - Ensure generated evidence directories are ignored when appropriate.

3. **Define scenario schema and validator**
   - Implement YAML scenario parsing.
   - Validate required fields.
   - Return actionable errors with file and field context.

4. **Implement guided manual run**
   - Load a scenario by ID.
   - Walk through prerequisites and steps.
   - Collect pass/fail/block status and Markdown notes.
   - Allow attaching existing screenshot, GIF, video, cast, or log files.

5. **Generate evidence manifest**
   - Write schema version `0.1`.
   - Include repo, commit, run, environment, observations, artifacts, and checksums.
   - Keep paths relative to the evidence bundle.

6. **Inspect evidence**
   - Implement `samotest evidence inspect`.
   - Provide both text and JSON output.

7. **Implement first gate check**
   - Read config, scenarios, and one explicit manifest path.
   - Detect missing, stale, malformed, URL-unresolved, failed, skipped, blocked, and unauthorized waived evidence.
   - Emit stable JSON for `samorev`.

8. **Document provider discovery**
   - Document the GitHub/GitLab artifact discovery contracts.
   - Document that provider upload automation is deferred beyond Sprint 1.

9. **Create sample scenario and demo evidence**
   - Add one CLI scenario.
   - Attach one externally captured screenshot or log for sprint-close review.

10. **Run sprint-close alignment review**
    - Review the spec against implementation.
    - Review evidence quality.
    - Open follow-up issues for gaps discovered during the demo.

## Open Questions

- Should Sprint 1 choose a specific implementation language, or should that remain open until issue planning?
- Should scenario evidence be committed for small repositories, or should all artifacts live only in CI/provider storage?
- Should browser capture use Playwright as the first supported implementation?
- Should terminal recordings standardize on asciinema-compatible casts, VHS tapes, or both?
