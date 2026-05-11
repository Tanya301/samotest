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
    "version": "0.1.4"
  },
  "gate": {
    "status": "pass",
    "checked_at": "2026-05-08T20:00:00.000Z",
    "base_ref": "main",
    "head_ref": "codex/issue-21-samorev-integration",
    "head_sha": "abc123",
    "manifest_path": "tests/fixtures/samorev/pass-manifest.json",
    "manifest_url": "https://example.test/evidence/pass/manifest.json",
    "summary": {
      "required": 1,
      "passed": 1,
      "failed": 0,
      "warned": 0,
      "waived": 0
    }
  },
  "scenarios": [
    {
      "id": "checkout-discount-demo",
      "required": true,
      "status": "pass",
      "fresh": true,
      "reason": "Evidence passed and matches the requested refs.",
      "artifacts": [
        {
          "type": "log",
          "name": "gate-contract",
          "path": "artifacts/gate-contract.log",
          "sha256": "0123456789abcdef",
          "url": "https://example.test/evidence/pass/artifacts/gate-contract.log"
        }
      ],
      "waiver": null
    }
  ],
  "errors": []
}
```

</details>
