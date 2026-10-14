import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ProjectDocument } from "../src/core/types.js";
import {
  PROJECT_PACKAGE_LIMITS,
  createProjectPackage,
  parseProjectPackage,
} from "../src/packaging/project-package/index.js";
import {
  MAX_EMBEDDED_PROJECT_BASE64_CHARS,
  decodeEmbeddedProjectBase64,
  EMBEDDED_PROJECT_SCRIPT_ID,
  EMBEDDED_PROJECT_MARKER,
  createSelfContainedHtml,
  extractEmbeddedProjectPackage,
} from "../src/packaging/self-contained-html/index.js";

const sha256 = async (bytes: Uint8Array): Promise<string> =>
  createHash("sha256").update(bytes).digest("hex");

function readProject(name: string): ProjectDocument {
  const text = readFileSync(
    new URL(`../../examples/projects/${name}.project.json`, import.meta.url),
    "utf8",
  );
  return JSON.parse(text) as ProjectDocument;
}

function readBytes(path: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`../../examples/${path}`, import.meta.url)),
  );
}

function makeHtmlTemplate(body: string): string {
  return `<!DOCTYPE html><html><head></head><body>${body}</body></html>`;
}

function makeValidHtml(): string {
  return makeHtmlTemplate(EMBEDDED_PROJECT_MARKER);
}

function extractBase64Segment(html: Uint8Array): string {
  const htmlString = new TextDecoder().decode(html);
  const open = `<script id="${EMBEDDED_PROJECT_SCRIPT_ID}" type="application/x-logo-project">`;
  const openIndex = htmlString.indexOf(open);
  assert.notEqual(openIndex, -1);
  const closeIndex = htmlString.indexOf("</script>", openIndex);
  assert.notEqual(closeIndex, -1);
  return htmlString.slice(openIndex + open.length, closeIndex);
}

describe("self-contained HTML packaging", () => {
  it("round-trips a project package through create and extract", async () => {
    const project = readProject("project-empty");
    const projectPackage = await createProjectPackage(
      { project, assets: [] },
      { sha256 },
    );
    const html = makeValidHtml();

    const selfContained = createSelfContainedHtml({ html, projectPackage });
    const extracted = extractEmbeddedProjectPackage(selfContained);
    assert.ok(extracted);
    assert.deepEqual(extracted, projectPackage);

    const parsed = await parseProjectPackage(extracted, { sha256 });
    assert.deepEqual(parsed.project, project);
    assert.deepEqual(parsed.assets, []);
  });

  it("round-trips a project package with referenced assets", async () => {
    const project = readProject("project-multi");
    for (const logo of project.logos) {
      for (const asset of logo.assets) {
        asset.sha256Hex = createHash("sha256").update(readBytes(asset.uri)).digest("hex");
      }
    }
    const paths = new Set(
      project.logos.flatMap((logo) => logo.assets.map((asset) => asset.uri)),
    );
    const assets = [...paths].sort().map((path) => ({ path, bytes: readBytes(path) }));
    const projectPackage = await createProjectPackage({ project, assets }, { sha256 });
    const html = makeValidHtml();

    const selfContained = createSelfContainedHtml({ html, projectPackage });
    const extracted = extractEmbeddedProjectPackage(selfContained);
    assert.ok(extracted);
    assert.deepEqual(extracted, projectPackage);

    const parsed = await parseProjectPackage(extracted, { sha256 });
    assert.deepEqual(parsed.project, project);
    assert.equal(parsed.assets.length, 2);
    for (const asset of parsed.assets) {
      assert.equal(asset.kind, "referenced");
    }
  });

  it("produces deterministic output for identical inputs", async () => {
    const project = readProject("project-empty");
    const projectPackage = await createProjectPackage(
      { project, assets: [] },
      { sha256 },
    );
    const html = makeValidHtml();

    const first = createSelfContainedHtml({ html, projectPackage });
    const second = createSelfContainedHtml({ html, projectPackage });
    assert.deepEqual(first, second);
  });

  it("throws when the marker is missing", async () => {
    const project = readProject("project-empty");
    const projectPackage = await createProjectPackage(
      { project, assets: [] },
      { sha256 },
    );
    const html = makeHtmlTemplate("");

    assert.throws(
      () => createSelfContainedHtml({ html, projectPackage }),
      /exactly one embedded project marker/,
    );
  });

  it("throws when the marker appears multiple times", async () => {
    const project = readProject("project-empty");
    const projectPackage = await createProjectPackage(
      { project, assets: [] },
      { sha256 },
    );
    const html = makeHtmlTemplate(
      `${EMBEDDED_PROJECT_MARKER}${EMBEDDED_PROJECT_MARKER}`,
    );

    assert.throws(
      () => createSelfContainedHtml({ html, projectPackage }),
      /multiple embedded project markers/,
    );
  });

  it("rejects a project package larger than the archive limit", async () => {
    const oversized = new Uint8Array(PROJECT_PACKAGE_LIMITS.maxArchiveBytes + 1);
    const html = makeValidHtml();

    assert.throws(
      () => createSelfContainedHtml({ html, projectPackage: oversized }),
      new RegExp(
        `projectPackage exceeds ${PROJECT_PACKAGE_LIMITS.maxArchiveBytes} bytes`,
      ),
    );
  });

  it("rejects an empty project package", () => {
    const html = makeValidHtml();
    assert.throws(
      () => createSelfContainedHtml({ html, projectPackage: new Uint8Array(0) }),
      /projectPackage must not be empty/,
    );
  });

  it("embeds base64 that contains no HTML-special characters", async () => {
    const project = readProject("project-empty");
    const projectPackage = await createProjectPackage(
      { project, assets: [] },
      { sha256 },
    );
    const html = makeValidHtml();

    const selfContained = createSelfContainedHtml({ html, projectPackage });
    const base64 = extractBase64Segment(selfContained);
    for (const char of ["<", ">", "&", '"', "'"]) {
      assert.equal(
        base64.includes(char),
        false,
        `base64 payload must not contain ${JSON.stringify(char)}`,
      );
    }
  });

  it("remains valid when the template contains </script> near the marker", async () => {
    const project = readProject("project-empty");
    const projectPackage = await createProjectPackage(
      { project, assets: [] },
      { sha256 },
    );
    const html = makeHtmlTemplate(`</script>${EMBEDDED_PROJECT_MARKER}<script>alert(1)</script>`);

    const selfContained = createSelfContainedHtml({ html, projectPackage });
    const extracted = extractEmbeddedProjectPackage(selfContained);
    assert.ok(extracted);
    assert.deepEqual(extracted, projectPackage);
  });

  it("returns null when the embedded script is missing", async () => {
    const html = makeHtmlTemplate("");
    assert.equal(extractEmbeddedProjectPackage(html), null);
  });

  it("throws when the embedded script id is duplicated", async () => {
    const project = readProject("project-empty");
    const projectPackage = await createProjectPackage(
      { project, assets: [] },
      { sha256 },
    );
    const html = makeValidHtml();
    const selfContained = createSelfContainedHtml({ html, projectPackage });
    const selfContainedString = new TextDecoder().decode(selfContained);
    const duplicated = selfContainedString.replace(
      "</body>",
      `<script id="${EMBEDDED_PROJECT_SCRIPT_ID}" type="application/x-logo-project">abcd</script></body>`,
    );

    assert.throws(
      () => extractEmbeddedProjectPackage(duplicated),
      /embedded project script id is duplicated/,
    );
  });

  it("throws when the embedded base64 is malformed", () => {
    const html = makeHtmlTemplate(
      `<script id="${EMBEDDED_PROJECT_SCRIPT_ID}" type="application/x-logo-project">!!!!</script>`,
    );
    assert.throws(
      () => extractEmbeddedProjectPackage(html),
      /embedded base64 contains invalid characters/,
    );
  });

  it("accepts HTML input as Uint8Array", async () => {
    const project = readProject("project-empty");
    const projectPackage = await createProjectPackage(
      { project, assets: [] },
      { sha256 },
    );
    const htmlBytes = new TextEncoder().encode(makeValidHtml());

    const selfContained = createSelfContainedHtml({ html: htmlBytes, projectPackage });
    const extracted = extractEmbeddedProjectPackage(selfContained);
    assert.ok(extracted);
    assert.deepEqual(extracted, projectPackage);
  });
  it("rejects oversized embedded text before decoding", () => {
    assert.throws(() => decodeEmbeddedProjectBase64('A'.repeat(MAX_EMBEDDED_PROJECT_BASE64_CHARS + 4)), /exceeds archive size limit/);
  });

  it("rejects malformed padding and noncanonical base64", () => {
    for (const value of ['', 'A===', 'A', 'AAAA=', 'AA=A', 'AB==', 'AAB=', ' AA==', 'AA==\n']) {
      assert.throws(() => decodeEmbeddedProjectBase64(value), /base64/);
    }
    assert.deepEqual(decodeEmbeddedProjectBase64('AA=='), new Uint8Array([0]));
    assert.deepEqual(decodeEmbeddedProjectBase64('AAE='), new Uint8Array([0, 1]));
  });

  it("encodes arbitrary bytes including HTML termination strings without interpolation", () => {
    const bytes = new TextEncoder().encode('</script><script>throw new Error("injected")</script><!-- $& $` $\' -->');
    const output = createSelfContainedHtml({ html: makeValidHtml(), projectPackage: bytes });
    assert.deepEqual(extractEmbeddedProjectPackage(output), bytes);
    assert.equal(new TextDecoder().decode(output).includes('injected'), false);
  });

  it("matches standard base64 across padding and encoder chunk boundaries", () => {
    for (const size of [1, 2, 3, 12_287, 12_288, 12_289, 25_000]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => i % 256);
      const output = createSelfContainedHtml({ html: makeValidHtml(), projectPackage: bytes });
      assert.equal(extractBase64Segment(output), Buffer.from(bytes).toString('base64'));
      assert.deepEqual(extractEmbeddedProjectPackage(output), bytes);
    }
  });

});
