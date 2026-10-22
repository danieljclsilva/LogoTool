import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Distribution contract for the public Pages demo staging (lead).
// Pure Node: invokes scripts/prepare-demo.mjs with bounded explicit args
// (no shell); never depends on dist/demo already existing.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(repoRoot, "scripts/prepare-demo.mjs");
const STATION_ENTRY = join(repoRoot, "dist/station/Logo Station.html");

let directory = "";
before(() => {
  directory = mkdtempSync(join(tmpdir(), "logotool prepare-demo "));
});
after(() => {
  rmSync(directory, { recursive: true, force: true });
});

function run(args: string[], cwd: string = repoRoot): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fixture(name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, body);
  return path;
}

describe("prepare-demo staging contract", () => {
  it("stages a synthetic entry byte-for-byte as exactly index.html + .nojekyll", () => {
    const source = fixture("station.html", "<!doctype html><html><body>synthetic station</body></html>");
    const out = join(directory, "out-clean");
    const result = run([source, out]);
    assert.equal(result.status, 0, `staging failed: ${result.stderr}`);
    assert.deepEqual(readdirSync(out).sort(), [".nojekyll", "index.html"]);
    assert.ok(readFileSync(join(out, "index.html"), "utf8") === readFileSync(source, "utf8"));
    assert.equal(readFileSync(join(out, ".nojekyll"), "utf8"), "");
  });

  it("rebuilds the output directory clean so stale files never ship", () => {
    const source = fixture("station2.html", "<!doctype html><html><body>v2</body></html>");
    const out = join(directory, "out-stale");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "old.html"), "stale staff page");
    writeFileSync(join(out, "index.html"), "stale bytes");
    const result = run([source, out]);
    assert.equal(result.status, 0, `staging failed: ${result.stderr}`);
    assert.deepEqual(readdirSync(out).sort(), [".nojekyll", "index.html"]);
    assert.ok(readFileSync(join(out, "index.html"), "utf8").includes("v2"));
  });

  it("fails clearly when the station entry has not been built", () => {
    const result = run([join(directory, "missing.html"), join(directory, "out-missing")]);
    assert.notEqual(result.status, 0, "staging a missing entry must fail");
    assert.ok(
      (result.stderr + result.stdout).includes("build:station"),
      `error must name the build step: ${result.stderr}${result.stdout}`,
    );
  });

  it("stages the built station entry byte-identically into a temp dir", () => {
    // npm test always builds first, so dist/station/Logo Station.html exists.
    const out = join(directory, "out-built");
    const result = run([STATION_ENTRY, out]);
    assert.equal(result.status, 0, `staging failed: ${result.stderr}`);
    assert.deepEqual(readdirSync(out).sort(), [".nojekyll", "index.html"]);
    assert.ok(
      readFileSync(join(out, "index.html")).equals(readFileSync(STATION_ENTRY)),
      "demo index.html must be byte-identical to the station entry",
    );
  });

  it("refuses an output that is or contains the working directory", () => {
    // Run with a temp cwd so even a broken guard could only harm temp dirs.
    const sandbox = mkdtempSync(join(tmpdir(), "logotool prepare-demo sandbox "));
    try {
      const source = join(sandbox, "station.html");
      writeFileSync(source, "<!doctype html><html><body>x</body></html>");
      for (const out of [".", sandbox]) {
        const result = run([source, out], sandbox);
        assert.notEqual(result.status, 0, `dangerous output must be rejected: ${out}`);
        assert.ok(
          (result.stderr + result.stdout).includes("working directory"),
          `error must name the danger: ${result.stderr}${result.stdout}`,
        );
      }
      assert.ok(readFileSync(source, "utf8").includes("x"), "rejected run must not delete the source");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("refuses an output that would delete the station source", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "logotool prepare-demo sandbox "));
    try {
      const nested = join(sandbox, "nested");
      mkdirSync(nested, { recursive: true });
      const source = join(nested, "station.html");
      writeFileSync(source, "<!doctype html><html><body>y</body></html>");
      const result = run([source, nested], sandbox);
      assert.notEqual(result.status, 0, "source-containing output must be rejected");
      assert.ok(
        (result.stderr + result.stdout).includes("station source"),
        `error must name the danger: ${result.stderr}${result.stdout}`,
      );
      assert.ok(readFileSync(source, "utf8").includes("y"), "rejected run must not delete the source");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
