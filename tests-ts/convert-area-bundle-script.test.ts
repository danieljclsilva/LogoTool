import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREPARED_IMPORT_LIMITS } from "../src/core/project-builder/prepared-import.js";
import { fitUniformScale } from "../src/core/calibration/index.js";
import { buildEvidence, snapshotEvidence } from "../src/core/calibration-session/index.js";
import { createPlanarRegion } from "../src/core/planar-region/index.js";
import {
  addExclusion,
  buildAreaBundle,
  serializeAreaBundle,
  setSafePolygon,
  type AreasMap,
} from "../src/core/region-areas/index.js";

const SCRIPT = "scripts/convert-area-bundle.mjs";
const AREA_BUNDLE = "e2e/fixtures/bridge-area-bundle.json";
const LABELS = "e2e/fixtures/bridge-labels.json";
const PRODUCT_FIXTURE = "e2e/fixtures/prepared-bridge-product.json";
const HASH = "ab".repeat(32);

let directory = "";
before(() => {
  directory = mkdtempSync(join(tmpdir(), "logotool convert-area-bundle "));
});
after(() => {
  rmSync(directory, { recursive: true, force: true });
});

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Serialized kernel-valid area bundle with `holeCount` 512-vertex exclusions. */
function buildBigBundleText(holeCount: number): string {
  const fields = {
    product: "SYN-BRIDGE",
    variant: "SYN-BRIDGE-V1",
    calibrationId: "CAL-SYN-B1",
    frameId: "FRAME-SYN-B1",
    provisionalVersion: "v1",
    toleranceMm: 0.5,
    relativeTolerance: 0.01,
    assetFullSha256: HASH,
  };
  const anchors = [
    { id: "O", model: { x: 0, y: 0, z: 0 } },
    { id: "X", model: { x: 10, y: 0, z: 0 } },
    { id: "Y", model: { x: 3, y: 5, z: 0 } },
  ];
  const built = buildEvidence(fields, anchors, [{ a: "O", b: "X", distanceMm: 100 }]);
  assert.ok(built.ok);
  const ev = built.evidence;
  const fit = fitUniformScale(ev);
  const snap = snapshotEvidence(ev);
  const made = createPlanarRegion(
    { regionId: "SYN-BRIDGE-CHEST", frameId: "FRAME-SYN-BRIDGE", originAnchorId: "O", xAnchorId: "X", yAnchorId: "Y", offPlaneToleranceMm: 0.01 },
    anchors,
    ev,
    snap,
  );
  assert.ok(made.ok);
  let areas: AreasMap = {};
  const safe = setSafePolygon(areas, made.region, "[[-100,-80],[100,-80],[100,80],[-100,80]]");
  assert.ok(safe.ok);
  areas = safe.areas;
  for (let hole = 0; hole < holeCount; hole += 1) {
    const cx = 20 + (hole % 8) * 3;
    const cy = 20 + Math.floor(hole / 8) * 3;
    const ring: Array<[number, number]> = [];
    for (let v = 0; v < 512; v += 1) {
      const angle = (v / 512) * Math.PI * 2;
      ring.push([+(cx + Math.cos(angle)).toFixed(6), +(cy + Math.sin(angle)).toFixed(6)]);
    }
    const added = addExclusion(areas, made.region, `hole-${hole}`, `Hole ${hole}`, JSON.stringify(ring));
    assert.ok(added.ok);
    areas = added.areas;
  }
  const bundle = buildAreaBundle(ev, fit, [made.region], areas, snap);
  assert.ok(bundle.ok);
  return serializeAreaBundle(bundle.bundle);
}

describe("convert-area-bundle.mjs", () => {
  it("round-trips the checked-in fixtures to the checked-in prepared product", () => {
    const out = join(directory, "prepared.json");
    const result = run([
      "--area-bundle", AREA_BUNDLE,
      "--labels", LABELS,
      "--expected-asset-sha256", HASH,
      "--out", out,
    ]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const produced = JSON.parse(readFileSync(out, "utf8"));
    const checkedIn = JSON.parse(readFileSync(PRODUCT_FIXTURE, "utf8"));
    assert.deepEqual(produced.product, checkedIn.product);
    assert.deepEqual(produced.sidecar, checkedIn.sidecar);
    assert.equal(produced.areaBundleText, checkedIn.areaBundleText);
    assert.equal(produced.areaBundleSha256, checkedIn.areaBundleSha256);
    assert.equal(
      createHash("sha256").update(produced.areaBundleText, "utf8").digest("hex"),
      produced.areaBundleSha256,
    );
    // Verbatim evidence: the carried text is byte-identical to the source export.
    assert.equal(produced.areaBundleText, readFileSync(AREA_BUNDLE, "utf8"));
  });

  it("rejects a wrong expected asset hash without writing output", () => {
    const out = join(directory, "rejected.json");
    const result = run([
      "--area-bundle", AREA_BUNDLE,
      "--labels", LABELS,
      "--expected-asset-sha256", "cd".repeat(32),
      "--out", out,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /conversion rejected/);
    assert.throws(() => readFileSync(out));
  });

  it("rejects a tampered bundle (stale content vs labels) without writing output", () => {
    const tampered = join(directory, "tampered.json");
    const parsed = JSON.parse(readFileSync(AREA_BUNDLE, "utf8"));
    parsed.areas[0].safePolygon = [[0, 0], [1, 0], [1, 1]];
    writeFileSync(tampered, JSON.stringify(parsed));
    const out = join(directory, "tampered-out.json");
    const result = run([
      "--area-bundle", tampered,
      "--labels", LABELS,
      "--expected-asset-sha256", HASH,
      "--out", out,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /conversion rejected/);
    assert.throws(() => readFileSync(out));
  });

  it("refuses to overwrite an existing output and never touches inputs", () => {
    const out = join(directory, "existing.json");
    writeFileSync(out, "keep me");
    const beforeArea = readFileSync(AREA_BUNDLE, "utf8");
    const beforeLabels = readFileSync(LABELS, "utf8");
    const result = run([
      "--area-bundle", AREA_BUNDLE,
      "--labels", LABELS,
      "--expected-asset-sha256", HASH,
      "--out", out,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /refusing to overwrite/);
    assert.equal(readFileSync(out, "utf8"), "keep me");
    assert.equal(readFileSync(AREA_BUNDLE, "utf8"), beforeArea);
    assert.equal(readFileSync(LABELS, "utf8"), beforeLabels);
  });

  it("refuses an output path that aliases an input", () => {
    const result = run([
      "--area-bundle", AREA_BUNDLE,
      "--labels", LABELS,
      "--expected-asset-sha256", HASH,
      "--out", AREA_BUNDLE,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /must not alias an input/);
  });

  it("rejects unknown, duplicated and missing flags with usage", () => {
    const base = ["--area-bundle", AREA_BUNDLE, "--labels", LABELS, "--expected-asset-sha256", HASH];
    const unknown = run([...base, "--out", join(directory, "u.json"), "--nope", "x"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown flag/);
    const duplicated = run([...base, "--out", join(directory, "d.json"), "--out", join(directory, "d2.json")]);
    assert.equal(duplicated.status, 2);
    assert.match(duplicated.stderr, /duplicate flag/);
    const missing = run(["--area-bundle", AREA_BUNDLE]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /missing required flag/);
    const badHash = run([...base.slice(0, 5), "xyz", "--out", join(directory, "h.json")]);
    assert.equal(badHash.status, 2);
    assert.match(badHash.stderr, /hex chars/);
  });

  it("rejects non-JSON and missing input files", () => {
    const notJson = join(directory, "plain.txt");
    writeFileSync(notJson, "hello");
    const result = run([
      "--area-bundle", notJson,
      "--labels", LABELS,
      "--expected-asset-sha256", HASH,
      "--out", join(directory, "n.json"),
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not valid JSON/);
    const absent = run([
      "--area-bundle", join(directory, "does-not-exist.json"),
      "--labels", LABELS,
      "--expected-asset-sha256", HASH,
      "--out", join(directory, "n2.json"),
    ]);
    assert.equal(absent.status, 2);
    assert.match(absent.stderr, /cannot stat/);
  });

  it("supports a leading BOM explicitly and preserves it byte-identically", () => {
    const bomInput = join(directory, "bom-area-bundle.json");
    const source = readFileSync(AREA_BUNDLE);
    writeFileSync(bomInput, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), source]));
    const out = join(directory, "bom-out.json");
    const result = run([
      "--area-bundle", bomInput,
      "--labels", LABELS,
      "--expected-asset-sha256", HASH,
      "--out", out,
    ]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const produced = JSON.parse(readFileSync(out, "utf8"));
    assert.ok(produced.areaBundleText.startsWith("\uFEFF"));
    assert.equal(
      createHash("sha256").update(produced.areaBundleText, "utf8").digest("hex"),
      produced.areaBundleSha256,
    );
    const checkedIn = JSON.parse(readFileSync(PRODUCT_FIXTURE, "utf8"));
    assert.deepEqual(produced.product, checkedIn.product);
    assert.deepEqual(produced.sidecar, checkedIn.sidecar);
  });

  it("rejects invalid UTF-8 instead of converting lossy text", () => {
    const bad = join(directory, "bad-utf8.json");
    const source = Buffer.from(readFileSync(AREA_BUNDLE));
    source[100] = 0xff;
    writeFileSync(bad, source);
    const out = join(directory, "bad-utf8-out.json");
    const result = run([
      "--area-bundle", bad,
      "--labels", LABELS,
      "--expected-asset-sha256", HASH,
      "--out", out,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not valid UTF-8/);
    assert.throws(() => readFileSync(out));
  });

  it("preserves non-ASCII labels exactly", () => {
    const labelsPath = join(directory, "unicode-labels.json");
    const labels = JSON.parse(readFileSync(LABELS, "utf8"));
    labels.labels.product.name = "合成 Bridge Jackét 🌅";
    writeFileSync(labelsPath, JSON.stringify(labels));
    const out = join(directory, "unicode-out.json");
    const result = run([
      "--area-bundle", AREA_BUNDLE,
      "--labels", labelsPath,
      "--expected-asset-sha256", HASH,
      "--out", out,
    ]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const produced = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(produced.product.name, "合成 Bridge Jackét 🌅");
    assert.equal(produced.sidecar.labels.product.name, "合成 Bridge Jackét 🌅");
  });

  it("rejects source evidence text above the Builder intake bound", () => {
    // 64 exclusions x 512 vertices: kernel-valid, but the source text itself
    // (~2.9M chars pretty-printed) exceeds the 1 MiB intake evidence bound.
    const text = buildBigBundleText(64);
    assert.ok(text.length > PREPARED_IMPORT_LIMITS.maxAreaBundleChars);
    const bigInput = join(directory, "big-area-bundle.json");
    writeFileSync(bigInput, text);
    const out = join(directory, "big-out.json");
    const result = run([
      "--area-bundle", bigInput,
      "--labels", LABELS,
      "--expected-asset-sha256", HASH,
      "--out", out,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /source evidence text is .* above the Builder intake bound/);
    assert.throws(() => readFileSync(out));
  });

  it("rejects an envelope above the Builder import bound before installing output", () => {
    // 15 exclusions x 512 vertices: source text stays within the 1 MiB
    // intake evidence bound, but the converted envelope (which carries the
    // product, sidecar, and verbatim text) exceeds the 1 MiB Builder
    // prepared-import file bound.
    const text = buildBigBundleText(15);
    assert.ok(text.length <= PREPARED_IMPORT_LIMITS.maxAreaBundleChars);
    const bigInput = join(directory, "envelope-area-bundle.json");
    writeFileSync(bigInput, text);
    const out = join(directory, "envelope-out.json");
    const result = run([
      "--area-bundle", bigInput,
      "--labels", LABELS,
      "--expected-asset-sha256", HASH,
      "--out", out,
    ]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /prepared-import file bound/);
    assert.throws(() => readFileSync(out));
  });
});
