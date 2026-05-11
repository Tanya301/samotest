## samotest evidence gate: fail

Checked: 2026-05-11T17:27:12.938Z
Head: unknown
Run: samoteam-prod-video-259
Scenario: samoteam-prod-video
Provider: unknown
Target: unknown
Command: unknown
Summary: 0 passed, 1 failed, 0 warned, 0 waived
Review completeness: incomplete - hosted artifact URLs are required before review.
Manifest: /root/tmp/samoteam-ui-dogfood-259/work/.samotest/evidence/samoteam-prod-video-259/manifest.json

| Scenario | Requirement | Status | Fresh | Evidence | Reason |
| --- | --- | --- | --- | --- | --- |
| samoteam-prod-video | required | fail | fresh | artifacts/video.webm | Artifact artifacts/video.webm is missing a URL required for review. |

### Gate errors
- artifact_url_missing: Artifact artifacts/video.webm is missing a URL required for review.
