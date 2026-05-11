import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "bun:test";

import { checkGate, formatSamorevReviewNote, type EvidenceManifest } from "../src/gate.js";

const fixtureRoot = join(process.cwd(), "tests", "fixtures", "samorev");

describe("samorev review note rendering", () => {
  it("embeds a passing gate result with manifest and artifact links", async () => {
    const report = await gateReportFromFixture("pass-manifest.json", true);
    const note = formatSamorevReviewNote(report);

    assert.match(note, /^## samorev review note: samotest$/m);
    assert.match(note, /Status: `pass`/);
    assert.match(note, /Manifest: \[manifest\]\(https:\/\/example\.test\/evidence\/pass\/manifest\.json\)/);
    assert.match(note, /- `checkout-discount-demo`: `pass` \(required, fresh\)/);
    assert.match(note, /  - Evidence: \[gate-contract\]\(https:\/\/example\.test\/evidence\/pass\/artifacts\/gate-contract\.log\)/);
    assert.match(note, /<summary>samotest gate check JSON<\/summary>/);
    assert.match(note, /"status": "pass"/);
    assert.match(note, /"manifest_url": "https:\/\/example\.test\/evidence\/pass\/manifest\.json"/);
  });

  it("renders failed evidence as an actionable samorev note", async () => {
    const report = await gateReportFromFixture("fail-manifest.json", true);
    const note = formatSamorevReviewNote(report);

    assert.match(note, /Status: `fail`/);
    assert.match(note, /- `checkout-discount-demo`: `fail` \(required, fresh\)/);
    assert.match(note, /  - Reason: Required evidence status is failed\./);
    assert.match(note, /  - Evidence: \[gate-contract\]\(https:\/\/example\.test\/evidence\/fail\/artifacts\/gate-contract\.log\)/);
    assert.match(note, /### Gate errors/);
    assert.match(note, /- `evidence_status_failed` for `checkout-discount-demo`: Required evidence status is failed\./);
    assert.match(note, /"code": "evidence_status_failed"/);
  });

  it("renders missing reviewer evidence links without hiding the JSON contract", async () => {
    const report = await gateReportFromFixture("missing-evidence-manifest.json", false);
    const note = formatSamorevReviewNote(report);

    assert.match(note, /Status: `fail`/);
    assert.match(note, /Manifest: `.*missing-evidence-manifest\.json`/);
    assert.match(note, /- `checkout-discount-demo`: `fail` \(required, fresh\)/);
    assert.match(note, /  - Evidence: missing URL for `artifacts\/gate-contract\.log`/);
    assert.match(note, /- `artifact_url_missing` for `checkout-discount-demo`: Artifact artifacts\/gate-contract\.log is missing a URL required for review\./);
    assert.match(note, /"code": "artifact_url_missing"/);
  });
});

async function gateReportFromFixture(name: string, artifactUrlsResolve: boolean) {
  const manifestPath = join(fixtureRoot, name);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as EvidenceManifest;
  const result = await checkGate({
    manifestPath,
    baseRef: manifest.source.base_ref,
    headSha: manifest.source.commit,
    now: new Date("2026-05-08T20:00:00.000Z"),
    resolveArtifactUrl: async () => artifactUrlsResolve,
  });

  return result.report;
}
