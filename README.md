# samotest

Manual test scenario runner and evidence gate CLI for reviewer-visible dogfooding.

## Release Status

`samotest` is preparing `v0.1.0`, but no release tag should be created until Sprint 2 closeout has passing demo evidence. The package target is the npm package name `samotest` with the `samotest` bin. Current dogfooding should use a local checkout through `npm link` or a local tarball from `npm pack`.

## Install For Local Dogfooding

From this repository:

```sh
npm ci
npm run build
npm link
samotest --help
```

To test the installable package path without publishing:

```sh
npm ci
npm pack --dry-run
npm pack
npm install -g ./samotest-0.1.0.tgz
samotest --version
```

## Quickstart

Initialize a repository for local scenarios and evidence:

```sh
samotest init
```

Add or copy scenario YAML files into `.samotest/scenarios/`. The committed sample scenarios in this repo are under `.samotest/scenarios/` and can be used as schema examples.

Validate scenarios:

```sh
samotest scenario validate .samotest/scenarios/my-scenario.yaml
```

The scenario validation library is covered by tests today, but the CLI command is still a reviewed placeholder and exits with `scenario validate is not implemented yet`. Until that command is wired, validate by running:

```sh
npm test -- tests/scenarioValidation.test.ts
```

Run a guided scenario and record step results:

```sh
samotest run my-scenario --output .samotest/evidence --run-id local-smoke
```

Attach evidence during the prompt with lines such as:

```text
screenshot path/to/screenshot.png
log path/to/output.log
```

Inspect committed or generated evidence manifests:

```sh
samotest evidence inspect samples/evidence/sprint1-cli-smoke/manifest.json
samotest evidence inspect samples/evidence/sprint1-cli-smoke --format json
```

Check the evidence gate in the stable JSON format consumed by `samorev`:

```sh
samotest gate check --manifest samples/evidence/sprint1-cli-smoke/manifest.json --format json
```

The committed sample manifest uses immutable raw GitHub URLs so this local quickstart can pass before the package is published. For real PR/MR review evidence, required artifacts still need provider-uploaded, reviewer-accessible URLs; local file paths alone are not enough for the gate.

The exact `samorev` invocation, exit-code contract, and review note shape are documented in [docs/samorev-integration.md](docs/samorev-integration.md). A complete sample review note lives at [samples/samorev/review-note.md](samples/samorev/review-note.md).

Package or report evidence:

```sh
samotest evidence package samples/evidence/sprint1-cli-smoke --format zip
samotest gate report --manifest samples/evidence/sprint1-cli-smoke/manifest.json --format markdown
```

Evidence package, provider upload/comment, and markdown report commands are tracked in issue #20 and are currently placeholders in this branch. Until issue #20 lands, attach the evidence directory or manifest path directly to the PR and include the `samotest gate check --format json` output in review notes.

## PR Checks

Pull requests run:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Run the same commands locally before opening or updating a PR.
