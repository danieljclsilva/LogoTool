import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Distribution contract for the single-entry Logo Station (Worker B).
// Pure Node: inspects dist/ after build (no browser needed).
// Full offline e2e on a fresh station copy is the lead's job.
const repoRoot = new URL("../../", import.meta.url);
const distDir = fileURLToPath(new URL("dist/", repoRoot));
const stationDir = fileURLToPath(new URL("dist/station/", repoRoot));
const entryUrl = new URL("dist/station/Logo%20Station.html", repoRoot);

// Known-obsolete generated staff HTMLs/fixtures: none of these may remain at
// the dist root. Production station lives ONLY at dist/station/Logo
// Station.html; dev utilities/fixtures ONLY under dist/dev/.
const REMOVED_DIST_ROOT_PATHS = [
  "internal-builder.html",
  "asset-inspector.html",
  "project-package-inspector.html",
  "customer-configurator.html",
  "customer-return-review.html",
  "synthetic-customer-self-contained.html",
  "synthetic-customer-prototype.zip",
  "synthetic-package-transport-preview.zip",
  "trusted-issued.logo-project",
  "synthetic-zero-placement.logo-project",
];

// Every byte the dev suite needs must have a dev-copy equivalent.
const REQUIRED_DEV_FILES = [
  "asset-inspector.html",
  "project-package-inspector.html",
  "customer-configurator.html",
  "customer-return-review.html",
  "synthetic-customer-self-contained.html",
  "synthetic-customer-prototype.zip",
  "synthetic-package-transport-preview.zip",
  "trusted-issued.logo-project",
  "synthetic-zero-placement.logo-project",
];

describe("distribution: single-entry station tree", () => {
  it("station directory holds exactly one root HTML entry and no assets folder", async () => {
    const names = (await readdir(stationDir)).sort();
    assert.deepEqual(
      names,
      ["Logo Station.html"],
      "dist/station/ must contain only the station entry (assets/ is omitted: the station is fully inline)",
    );
  });

  it("no legacy staff pages or customer examples sit alongside the station entry", async () => {
    const names = new Set(await readdir(stationDir));
    for (const legacy of REMOVED_DIST_ROOT_PATHS.filter((name) => name.endsWith(".html"))) {
      assert.ok(!names.has(legacy), `stray staff page in station distribution: ${legacy}`);
    }
  });

  it("no obsolete generated staff HTML or fixture remains at the dist root", async () => {
    const names = new Set(await readdir(distDir));
    for (const removed of REMOVED_DIST_ROOT_PATHS) {
      assert.ok(!names.has(removed), `obsolete generated output still at dist root: dist/${removed}`);
    }
  });

  it("every dev utility/fixture the suite needs exists under dist/dev/", async () => {
    const names = new Set(await readdir(join(distDir, "dev")));
    for (const required of REQUIRED_DEV_FILES) {
      const bytes = await readFile(join(distDir, "dev", required));
      assert.ok(names.has(required), `missing dev output: dist/dev/${required}`);
      assert.ok(bytes.length > 0, `empty dev output: dist/dev/${required}`);
    }
  });

  it("station entry is a non-trivial self-contained bundle with the embedded customer runtime", async () => {
    const html = await readFile(entryUrl, "utf8");
    assert.ok(html.length > 100_000, `station entry suspiciously small: ${html.length} bytes`);
    assert.ok(html.includes("__logoCustomerEditorHtml"), "station entry missing embedded marker: __logoCustomerEditorHtml");
    // Catalogue-free station: zero catalogue identifier, zero demo UI. The
    // dead embedded reader was removed with the demo UI it served, so even
    // a bare identifier occurrence fails the release contract.
    assert.ok(!html.includes("__logoBuilderCatalogue"), "station entry must not reference the example catalogue");
    assert.ok(!html.includes("demo-create"), "station entry must not reference demo creation");
    assert.ok(!html.includes("Try demo data"), "station entry must not offer demo data");
    // No example asset bytes or ids ride along in the station entry.
    // Asset URIs as authored in examples/logos/*.logo.json.
    for (const exampleAssetUri of ["logos/syn-mark-a.svg", "logos/syn-mark-b.svg"]) {
      assert.ok(!html.includes(exampleAssetUri), `station entry must not embed example asset: ${exampleAssetUri}`);
    }
    // Example logo/product ids as authored in examples/.
    for (const exampleId of ["SYN-LOGO-A", "SYN-LOGO-B", "SYN-TEE-001", "SYN-CAP-001", "SYN-TR-001"]) {
      assert.ok(!html.includes(exampleId), `station entry must not embed example id: ${exampleId}`);
    }
    // No base64 of the example logo artwork either.
    for (const exampleAsset of ["examples/logos/syn-mark-a.svg", "examples/logos/syn-mark-b.svg"]) {
      const bytes = await readFile(fileURLToPath(new URL(exampleAsset, repoRoot)));
      const embedded = Buffer.from(bytes).toString("base64");
      assert.ok(!html.includes(embedded), `station entry must not embed bytes of ${exampleAsset}`);
    }
    // The standalone reviewer is dev-only (dist/dev/): it must not ride
    // along in the production station entry.
    assert.ok(!html.includes("__logoCustomerReviewerHtml"), "station entry must not embed the reviewer runtime");
    assert.ok(!html.includes("<script src="), "station entry must not load external scripts");
    // Stylesheets must be inline or absent: reject network (http/https,
    // protocol-relative) and sibling-file stylesheet dependencies, while
    // allowing the embedded data-URI favicon (rel="icon" is not a stylesheet).
    for (const match of html.matchAll(/<link\b[^>]*>/g)) {
      const tag = match[0];
      const rel = /rel="([^"]*)"/.exec(tag)?.[1] ?? "";
      const href = /href="([^"]*)"/.exec(tag)?.[1] ?? "";
      assert.ok(
        rel.split(/\s+/).includes("icon") && href.startsWith("data:"),
        `station entry link must be an embedded data-URI favicon, got: ${tag.slice(0, 120)}`,
      );
    }
    // The favicon itself is an embedded data URI: no remote fetch, no
    // relative file that could 404 offline (e.g. /favicon.ico).
    assert.ok(
      /<link rel="icon" href="data:[^"]+"/.test(html),
      "station entry must carry an embedded data-URI favicon",
    );
  });

  it("station survives a fresh copy into a temp dir with spaces in path", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "logo station copy "));
    try {
      const dest = join(scratch, "station copy");
      await cp(stationDir, dest, { recursive: true });
      const copiedNames = (await readdir(dest)).sort();
      assert.deepEqual(copiedNames, ["Logo Station.html"]);
      const html = await readFile(join(dest, "Logo Station.html"), "utf8");
      assert.ok(html.includes("__logoCustomerEditorHtml"));
      assert.ok(!html.includes("__logoBuilderCatalogue"));
      assert.ok(!html.includes("demo-create"));
      const bytes = (await stat(join(dest, "Logo Station.html"))).size;
      assert.ok(bytes > 100_000, `copied station entry suspiciously small: ${bytes} bytes`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
