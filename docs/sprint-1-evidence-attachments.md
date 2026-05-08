# Sprint 1 Evidence Attachments

Sprint 1 accepted artifacts produced by external tools and recorded them as attachments during a guided `samotest run`. Sprint 3 adds native recorder generation for Playwright browser screenshots/videos, optional `ffmpeg` GIF conversion, and `asciinema` terminal casts.

Use this attachment workflow for externally produced screenshots, GIFs, videos, terminal casts, logs, and notes:

1. Produce the artifact with an external tool, such as the OS screenshot utility, a browser capture extension, QuickTime, OBS, asciinema, or a terminal log redirect.
2. Review the artifact before attaching it. Remove secrets, tokens, private URLs, customer data, and unnecessary desktop context.
3. Keep local artifacts under a reviewable path while running the scenario. Large GIF/video/cast files should be uploaded as provider artifacts instead of committed.
4. Run the scenario and enter one attachment per line when prompted:

```text
screenshot path/to/screen.png
gif path/to/demo.gif
video path/to/demo.webm
cast path/to/session.cast
log path/to/output.log
note path/to/notes.md
```

5. End the attachment list with a blank line. The run record captures the attachment kind and path for reviewer follow-up.
6. For manifest-based review, include the artifact inside the evidence bundle's `artifacts/` directory so `manifest.json` can reference it by relative path with a checksum.
7. Run `samotest evidence inspect <bundle-or-run-id>` before sharing the evidence.

Committed examples in this repository intentionally use a tiny text log fixture. Native recorder output should still be reviewed for secrets before sharing, and generated artifacts are written into the evidence bundle with manifest checksums.

For native generation, run `samotest doctor` first. Missing Playwright or `asciinema` dependencies make `record` fail with install guidance; missing `ffmpeg` makes `record --format gif` fall back to browser video when Playwright video recording is available.
