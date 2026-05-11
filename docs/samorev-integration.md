# samorev integration

This document defines the `samotest` side of the `samorev` manual evidence gate.

## Gate invocation

`samorev` reads the authoritative machine contract by running:

```sh
samotest gate check --manifest <manifest.json> --base <base-ref> --head <head-sha> --format json
```

Contract:

- `stdout` is one JSON object matching `GateReport` schema version `0.1`.
- `stderr` is empty for valid command usage.
- `--manifest` is required and points to one evidence manifest.
- `--base` is optional. When present, `manifest.source.base_ref` must match it if the manifest includes `base_ref`.
- `--head` is optional but expected for PR/MR gates. When present, `manifest.source.commit` must equal this PR/MR head SHA.
- `gate.status` is one of `pass`, `fail`, `warn`, or `waived`.
- `gate.manifest_url` is copied from `manifest.review.manifest_url` when available.
- `scenarios[].artifacts[].url` is required for every required scenario artifact in PR/MR review. Missing or unreachable URLs fail the gate.
- `manifest.review.manifest_url` and `manifest.review.summary.url` are required for passing PR/MR gates. Link-only evidence, including locally forged summary metadata without a provider comment/note URL, fails until `samotest evidence upload` posts and records the provider-owned summary comment/note.
- `errors[]` contains stable machine codes such as `stale_evidence`, `evidence_status_failed`, `artifact_url_missing`, `local_only_evidence`, `manifest_url_missing`, `evidence_summary_missing`, and `artifact_url_unresolved`.

Exit codes:

- `0`: `gate.status` is `pass`, `warn`, or `waived`.
- `1`: required evidence failed the gate.
- `2`: the manifest cannot be read, parsed, or validated.
- `3`: command usage is invalid.
- `4`: required reviewer artifact URLs are missing or cannot be resolved.

`samorev` should treat the JSON body as authoritative even when the process exits non-zero. This lets review notes show the exact failing scenario, reason, and evidence link state.

## Review note section

When posting a review note, embed the `samotest gate check --format json` result together with reviewer-visible evidence links. The section should follow this shape:

````markdown
## samorev review note: samotest

Status: `pass`
Checked: 2026-05-08T20:00:00.000Z
Head: `abc123`
Summary: 1 passed, 0 failed, 0 warned, 0 waived
Manifest: [manifest](https://example.test/evidence/pass/manifest.json)

### Scenario evidence
- `checkout-discount-demo`: `pass` (required, fresh)
  - Reason: Evidence passed and matches the requested refs.
  - Evidence: [gate-contract](https://example.test/evidence/pass/artifacts/gate-contract.log)

<details>
<summary>samotest gate check JSON</summary>

```json
{
  "schema_version": "0.1",
  "tool": {
    "name": "samotest",
    "version": "0.1.5"
  },
  "gate": {
    "status": "pass"
  }
}
```

</details>
````

See [samples/samorev/review-note.md](../samples/samorev/review-note.md) for a complete sample with the embedded JSON body. The fixture tests in `tests/samorevReviewNote.test.ts` cover passing evidence, failed evidence, and missing artifact URL rendering.

## samorev change requirement

No `Tanya301/samorev` code change is required for this contract as long as `samorev` can execute the command above, parse the JSON from stdout, preserve the exit code, and render the review note section. If `samorev` needs a native parser or formatter later, that should be implemented in `Tanya301/samorev` against this documented contract and linked back to `Tanya301/samotest` issue #21.
