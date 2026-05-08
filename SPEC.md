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

- `samotest` is not an automated test runner replacement for unit, integration, or end-to-end suites.
- It does not attempt to certify correctness without human review.
- It does not execute untrusted scenarios from external contributors without explicit opt-in.
- It does not store evidence in a hosted SaaS service in the initial product.
- It does not provide pixel-perfect visual regression comparison in Sprint 1.
- It does not implement a full browser automation framework from scratch; it should wrap or orchestrate proven tools where needed.

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

1. A maintainer creates a scenario file under `.samotest/scenarios/`.
2. The scenario declares the purpose, prerequisites, commands or manual steps, expected observations, and required evidence types.
3. The scenario can include optional recording instructions for terminal, browser, or desktop capture.
4. The scenario is reviewed with the product/spec change before implementation begins.

### 2. Run a Manual Test Locally

1. A contributor checks out a branch.
2. The contributor runs `samotest run <scenario>`.
3. `samotest` guides the contributor through setup and steps.
4. The contributor captures required evidence at each checkpoint.
5. `samotest` writes an evidence bundle under `.samotest/evidence/<run-id>/`.
6. The contributor attaches or uploads the bundle and references it from the PR/MR.

### 3. Record a Reproducible Demo

1. A contributor runs `samotest record <scenario> --format gif`.
2. `samotest` uses the scenario's recording instructions to produce a GIF/video/cast.
3. The generated artifact is referenced by the evidence manifest.
4. Reviewers can inspect the final recording and, where possible, re-render it from the scenario inputs.

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
samotest run <scenario-id> [--profile <name>] [--output <dir>] [--pr <id>] [--mr <id>]
samotest record <scenario-id> [--format screenshot|gif|video|cast] [--output <dir>]
samotest evidence inspect <run-id-or-path>
samotest evidence package <run-id-or-path> [--format dir|zip]
samotest evidence upload <run-id-or-path> [--provider github|gitlab]
samotest gate check [--manifest <path>] [--base <ref>] [--head <ref>]
samotest gate report [--format text|json|markdown]
samotest doctor
```

### Command Responsibilities

- `init`: creates `.samotest/` structure and a starter config.
- `scenario list`: lists scenarios, owners, tags, and required evidence.
- `scenario validate`: validates scenario syntax and required fields.
- `run`: starts an interactive guided test run and captures evidence.
- `record`: creates screenshot/GIF/video/cast artifacts from scenario recording instructions.
- `evidence inspect`: prints a human-readable and machine-readable summary.
- `evidence package`: builds a portable evidence bundle.
- `evidence upload`: publishes artifacts to GitHub/GitLab-native storage when configured.
- `gate check`: exits non-zero when required evidence is missing, stale, or failing.
- `gate report`: produces review comments or `samorev` gate input.
- `doctor`: checks local dependencies such as browser drivers, terminal recorders, capture tools, and auth.

## Repository Layout

```text
.samotest/
  config.yaml
  scenarios/
    <scenario-id>.yaml
  evidence/
    <run-id>/
      manifest.json
      artifacts/
      notes.md
  tapes/
    <scenario-id>.tape
```

Evidence directories may be ignored by default for large artifacts, while small scenario definitions and reproducible tape files should be committed.

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
  preferred_formats: ["gif", "video"]
  tape: ".samotest/tapes/checkout-discount-demo.tape"
```

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
- `risk`
- `waiver_policy`

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
      "sha256": "..."
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
- Large artifacts should be uploaded to provider storage or build artifacts instead of committed.
- The manifest must identify the source revision so stale evidence can be detected.
- Evidence status must be one of `passed`, `failed`, `blocked`, `skipped`, or `waived`.
- Waived evidence must include reviewer, timestamp, and reason.

## GitHub Integration

`samotest` should support GitHub pull request workflows:

- Detect PR metadata from environment variables in GitHub Actions.
- Upload evidence bundles as workflow artifacts.
- Generate Markdown summary comments for PR review.
- Expose `samotest gate check` as a required status check.
- Support mapping changed paths and labels to required scenarios.
- Allow maintainers to configure required evidence per repository.

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
      - run: samotest gate check --base origin/main --head HEAD
      - run: samotest gate report --format markdown >> "$GITHUB_STEP_SUMMARY"
```

## GitLab Integration

`samotest` should support GitLab merge request workflows:

- Detect MR metadata from GitLab CI variables.
- Upload evidence bundles as job artifacts.
- Generate Markdown reports for MR comments or job summaries.
- Expose `samotest gate check` as a CI job that can block merge.
- Support mapping changed paths and labels to required scenarios.

## samorev Integration

`samorev` should treat `samotest` as the evidence provider for manual testing gates.

Expected integration contract:

- `samotest gate check --format json` emits a stable JSON report.
- `samorev` reads the report and evaluates repository policy.
- `samorev` can require:
  - at least one evidence bundle per PR/MR;
  - all required scenarios for changed paths;
  - fresh evidence for the current head commit;
  - reviewer acknowledgement for failed, skipped, blocked, or waived scenarios.
- `samorev` can render missing evidence as actionable review comments.
- `samorev` should link directly to evidence artifacts when provider URLs exist.

Initial gate statuses:

- `pass`: required evidence exists and is fresh.
- `fail`: required evidence is missing, failed, stale, or malformed.
- `warn`: optional evidence is missing or low quality.
- `waived`: required evidence was waived according to policy.

## Alignment Loop

Every sprint must follow this loop:

1. **Sprint-start spec review:** Before implementation starts, review `SPEC.md`, open questions, and scenario coverage. Update the spec before building if product behavior has changed.
2. **PR review gate:** Every implementation PR/MR must be reviewed against the current spec. Reviewers should reject changes that drift from the agreed behavior without a spec update.
3. **Test evidence gate:** Every implementation PR/MR must include `samotest` evidence or an explicit waiver. `samorev` should block merge when required evidence is missing, stale, or malformed.
4. **Sprint-close demo/evidence review:** At sprint close, review the produced screenshots, GIFs, videos, casts, manifests, and gate reports. Capture gaps as spec updates or next-sprint issues.

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

`.samotest/config.yaml` should define repository-level policy.

```yaml
schema_version: "0.1"
evidence:
  default_output: ".samotest/evidence"
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

Sprint 1 should produce a usable spec-first prototype, not a complete product.

### Acceptance Criteria

- Repository contains reviewed `SPEC.md` as the source of product truth.
- `samotest init` can create `.samotest/config.yaml`, `.samotest/scenarios/`, and `.samotest/evidence/`.
- `samotest scenario validate` can validate required scenario fields.
- `samotest run <scenario-id>` can guide a contributor through text-based manual steps and collect notes plus file attachments.
- Evidence manifest schema `0.1` is generated with run metadata, source revision, observations, artifacts, and checksums.
- `samotest evidence inspect` can summarize a manifest in text and JSON.
- `samotest gate check` can fail when required evidence is missing, stale, malformed, or not passed.
- A sample GitHub Actions workflow is documented.
- A sample GitLab CI job is documented.
- A sample `samorev` integration report format is documented.
- At least two sample scenarios exist: one CLI scenario and one browser/UI scenario.
- Sprint-close demo includes at least one screenshot and one GIF or terminal cast captured as evidence.

## Proposed First Sprint Issue Breakdown

1. **Create project skeleton and CLI entrypoint**
   - Define language/runtime choice.
   - Add packaging metadata.
   - Implement `samotest --help` and command stubs.

2. **Add repository initialization**
   - Implement `samotest init`.
   - Generate starter `.samotest/config.yaml`.
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

6. **Inspect and package evidence**
   - Implement `samotest evidence inspect`.
   - Implement `samotest evidence package`.
   - Provide both text and JSON output.

7. **Implement first gate check**
   - Read config, scenarios, changed paths, and manifests.
   - Detect missing, stale, malformed, failed, skipped, blocked, and waived evidence.
   - Emit stable JSON for `samorev`.

8. **Document GitHub/GitLab integration**
   - Add example GitHub Actions workflow.
   - Add example GitLab CI job.
   - Document artifact upload expectations.

9. **Create sample scenarios and demo evidence**
   - Add one CLI scenario.
   - Add one browser/UI scenario.
   - Capture at least one screenshot and one GIF or terminal cast for sprint-close review.

10. **Run sprint-close alignment review**
    - Review the spec against implementation.
    - Review evidence quality.
    - Open follow-up issues for gaps discovered during the demo.

## Open Questions

- Should Sprint 1 choose a specific implementation language, or should that remain open until issue planning?
- Should scenario evidence be committed for small repositories, or should all artifacts live only in CI/provider storage?
- What exact JSON contract does `samorev` expect today, if any?
- Should browser capture use Playwright as the first supported implementation?
- Should terminal recordings standardize on asciinema-compatible casts, VHS tapes, or both?
- What waiver authority is acceptable: author, reviewer, maintainer, or code owner only?

