import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ingestAsset,
  parseGlb,
  validateSelfContained,
  SyntheticModelGenerator,
  type AssetIssue,
  type GlbCodedError,
} from "../src/assets/index.js";

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function baseJson(): Record<string, unknown> {
  return {
    asset: { version: "2.0" },
    scene: 0,
    buffers: [{ byteLength: 72 }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 36 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 1],
        max: [1, 1, 1],
      },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 } }] },
      { primitives: [{ attributes: { POSITION: 1 } }] },
    ],
    nodes: [{ mesh: 0 }, { mesh: 1 }],
    scenes: [{ nodes: [0, 1] }],
  };
}

/** Minimal local GLB container builder: header + JSON chunk + BIN chunk. */
function buildGlb(json: unknown, bin: Uint8Array): Uint8Array {
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length + binPad;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  Buffer.from(jsonBytes).copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  const binStart = 20 + jsonBytes.length + jsonPad;
  out.writeUInt32LE(bin.length + binPad, binStart);
  out.writeUInt32LE(0x004e4942, binStart + 4);
  Buffer.from(bin).copy(out, binStart + 8);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function validBytes(): Uint8Array {
  return buildGlb(baseJson(), new Uint8Array(72));
}

function glbCodeOf(bytes: Uint8Array): string {
  try {
    parseGlb(bytes);
  } catch (error) {
    return (error as GlbCodedError).code;
  }
  throw new Error("expected parseGlb to throw");
}

function issueCodes(issues: AssetIssue[]): string {
  return issues.map((e) => `${e.code}@${e.path}`).join(", ");
}

function expectIssue(
  issues: AssetIssue[],
  code: string,
  pathPart: string,
): void {
  assert.ok(
    issues.some((e) => e.code === code && e.path.includes(pathPart)),
    `expected ${code}@*${pathPart}*, got: ${issueCodes(issues)}`,
  );
  for (const e of issues) {
    assert.ok(e.code.length > 0 && e.path.length > 0 && e.message.length > 0);
  }
}

describe("assets-glb: container framing", () => {
  it("valid external-style multi-mesh GLB parses with BIN chunk facts", () => {
    const parsed = parseGlb(validBytes());
    assert.equal(parsed.jsonByteLength > 0, true);
    assert.equal(parsed.binChunkLength, 72);
    assert.deepEqual(parsed.warnings, []);
    const json = parsed.json as Record<string, unknown>;
    assert.equal((json["meshes"] as unknown[]).length, 2);
    assert.equal((json["nodes"] as unknown[]).length, 2);
  });

  it("empty input is rejected with a coded error", () => {
    assert.equal(glbCodeOf(new Uint8Array(0)), "glb-too-small");
  });

  it("truncated container is rejected on declared length", () => {
    const bytes = validBytes().slice(0, validBytes().length - 4);
    assert.equal(glbCodeOf(bytes), "glb-length-mismatch");
  });

  it("mismatched declared length is rejected", () => {
    const bytes = Buffer.from(validBytes());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(8, bytes.length + 1, true);
    assert.equal(
      glbCodeOf(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
      "glb-length-mismatch",
    );
  });

  it("wrong magic is rejected", () => {
    const bytes = Buffer.from(validBytes());
    bytes.writeUInt32LE(0xdeadbeef, 0);
    assert.equal(
      glbCodeOf(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
      "glb-bad-magic",
    );
  });

  it("non-2.0 version is rejected", () => {
    const bytes = Buffer.from(validBytes());
    bytes.writeUInt32LE(1, 4);
    assert.equal(
      glbCodeOf(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
      "glb-unsupported-version",
    );
  });

  it("invalid JSON chunk is rejected with a coded error", () => {
    const jsonBytes = Buffer.from("{not valid json", "utf8");
    const pad = (4 - (jsonBytes.length % 4)) % 4;
    const total = 12 + 8 + jsonBytes.length + pad;
    const out = Buffer.alloc(total);
    out.writeUInt32LE(0x46546c67, 0);
    out.writeUInt32LE(2, 4);
    out.writeUInt32LE(total, 8);
    out.writeUInt32LE(jsonBytes.length + pad, 12);
    out.writeUInt32LE(0x4e4f534a, 16);
    jsonBytes.copy(out, 20);
    out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + pad);
    assert.equal(
      glbCodeOf(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)),
      "glb-invalid-json",
    );
  });
});

describe("assets-glb: self-contained subset validation", () => {
  it("valid multi-mesh payload has no issues", () => {
    const { json } = parseGlb(validBytes());
    assert.deepEqual(validateSelfContained(json), []);
  });

  it("dangling accessor reference is rejected", () => {
    const json = baseJson();
    const meshes = json["meshes"] as Record<string, unknown>[];
    const primitives = meshes[0]?.["primitives"] as Record<string, unknown>[];
    const attributes = primitives[0]?.["attributes"] as Record<string, unknown>;
    if (attributes !== undefined) attributes["POSITION"] = 99;
    expectIssue(
      validateSelfContained(json),
      "asset-bad-mesh-ref",
      "meshes/0/primitives/0/attributes/POSITION",
    );
  });

  it("remote buffer URI is rejected", () => {
    const json = baseJson();
    const buffers = json["buffers"] as Record<string, unknown>[];
    if (buffers[0] !== undefined) {
      buffers[0]["uri"] = "https://example.com/models/model.bin";
    }
    expectIssue(validateSelfContained(json), "asset-external-uri", "buffers/0/uri");
  });

  it("sibling .bin URI is rejected", () => {
    const json = baseJson();
    const buffers = json["buffers"] as Record<string, unknown>[];
    if (buffers[0] !== undefined) buffers[0]["uri"] = "model.bin";
    expectIssue(validateSelfContained(json), "asset-external-uri", "buffers/0/uri");
  });

  it("sibling .png image URI is rejected", () => {
    const json = baseJson();
    json["images"] = [{ uri: "texture.png" }];
    expectIssue(validateSelfContained(json), "asset-external-uri", "images/0/uri");
  });

  it("unsupported compression extension is rejected", () => {
    const json = baseJson();
    json["extensionsUsed"] = ["KHR_draco_mesh_compression"];
    json["extensionsRequired"] = ["KHR_draco_mesh_compression"];
    expectIssue(
      validateSelfContained(json),
      "asset-unsupported-compression",
      "extensionsUsed",
    );
  });

  it("GPU instancing extension is rejected as needing a decoder", () => {
    const json = baseJson();
    json["extensionsUsed"] = ["EXT_mesh_gpu_instancing"];
    expectIssue(
      validateSelfContained(json),
      "asset-needs-decoder",
      "extensionsUsed",
    );
  });

  it("quantization extension is advisory only, not blocking", () => {
    const json = baseJson();
    json["extensionsUsed"] = ["KHR_mesh_quantization"];
    const issues = validateSelfContained(json);
    expectIssue(issues, "asset-quantization-advisory", "extensionsUsed");
    assert.deepEqual(
      issues.filter((e) => !e.code.endsWith("-advisory")),
      [],
    );
  });
});

describe("assets-glb: provenance ingestion", () => {
  it("byte integrity: record digest matches input bytes, input unmutated", () => {
    const bytes = validBytes();
    const before = Buffer.from(bytes).toString("hex");
    const seen: string[] = [];
    const { record, issues } = ingestAsset({
      bytes,
      filename: "widget.glb",
      source: "manually-imported",
      recordedAt: "2026-10-10T12:00:00Z",
      operator: "synthetic-operator",
      hasher: (input) => {
        seen.push(Buffer.from(input).toString("hex"));
        return sha256Bytes(input);
      },
    });
    assert.deepEqual(issues, []);
    assert.equal(record.sha256Hex, sha256Bytes(bytes));
    assert.equal(seen.length, 1);
    assert.equal(seen[0], before);
    assert.equal(Buffer.from(bytes).toString("hex"), before);
    assert.equal(record.byteLength, bytes.length);
  });

  it("deterministic metadata: same inputs give identical records", () => {
    const first = ingestAsset({
      bytes: validBytes(),
      source: "synthetic-generated",
      generatedBy: "synthetic-stub/0.1.0",
      recordedAt: "2026-10-10T12:00:00Z",
      operator: "synthetic-operator",
      sha256Hex: sha256Bytes(validBytes()),
    });
    const second = ingestAsset({
      bytes: validBytes(),
      source: "synthetic-generated",
      generatedBy: "synthetic-stub/0.1.0",
      recordedAt: "2026-10-10T12:00:00Z",
      operator: "synthetic-operator",
      sha256Hex: sha256Bytes(validBytes()),
    });
    assert.deepEqual(first.record, second.record);
    assert.equal(JSON.stringify(first.record), JSON.stringify(second.record));
    assert.equal(first.record.schemaVersion, "0.1.0-provisional-asset");
    assert.equal(first.record.calibrationStatus, "uncalibrated");
    assert.equal(first.record.glb.nodeCount, 2);
    assert.equal(first.record.glb.meshCount, 2);
    assert.deepEqual(first.record.declaredPositionAccessorBounds, {
      min: [0, 0, 0],
      max: [1, 1, 0],
    });
  });

  it("record carries no millimetre fields", () => {
    const { record } = ingestAsset({
      bytes: validBytes(),
      source: "manually-imported",
      recordedAt: "2026-10-10T12:00:00Z",
      operator: "synthetic-operator",
      sha256Hex: sha256Bytes(validBytes()),
    });
    const text = JSON.stringify(record);
    assert.ok(!/mm/i.test(text.replace(/summ|comm/giu, "")), `mm leak: ${text}`);
    for (const key of Object.keys(record)) {
      assert.ok(!key.endsWith("Mm"), `mm field: ${key}`);
    }
  });

  it("missing hasher and digest is an explicit error", () => {
    assert.throws(
      () =>
        ingestAsset({
          bytes: validBytes(),
          source: "manually-imported",
          recordedAt: "2026-10-10T12:00:00Z",
          operator: "synthetic-operator",
        }),
      /no digest available/,
    );
  });

  it("external URIs surface as issues alongside the sidecar record", () => {
    const json = baseJson();
    const buffers = json["buffers"] as Record<string, unknown>[];
    if (buffers[0] !== undefined) buffers[0]["uri"] = "model.bin";
    const { record, issues } = ingestAsset({
      bytes: buildGlb(json, new Uint8Array(72)),
      source: "manually-imported",
      recordedAt: "2026-10-10T12:00:00Z",
      operator: "synthetic-operator",
      sha256Hex: "a".repeat(64),
    });
    expectIssue(issues, "asset-external-uri", "buffers/0/uri");
    assert.equal(record.byteLength > 0, true);
  });
});

describe("assets-glb: synthetic generator stub", () => {
  it("returns fixture bytes with the stub label, no network", async () => {
    const generator = new SyntheticModelGenerator(
      () => validBytes(),
      "synthetic-stub/test",
    );
    assert.equal(generator.provider, "synthetic");
    const output = await generator.generate({ seed: "s1" });
    assert.equal(output.generatedBy, "synthetic-stub/test");
    assert.deepEqual(validateSelfContained(parseGlb(output.bytes).json), []);
  });

  it("empty fixture bytes are rejected", async () => {
    const generator = new SyntheticModelGenerator(() => new Uint8Array(0));
    await assert.rejects(generator.generate({}), /non-empty Uint8Array/);
  });
});

describe('assets-glb: integrated validation regressions', () => {
  const input = (bytes: Uint8Array) => ({bytes, source: 'synthetic-generated' as const, recordedAt: '2026-10-10T12:00:00Z', operator: 'test', hasher: sha256Bytes});
  it('rejects declared embedded buffers larger than the actual BIN', () => {
    const json = baseJson();
    (json.buffers as {byteLength: number}[])[0]!.byteLength = 1000;
    expectIssue(ingestAsset(input(buildGlb(json, new Uint8Array(72)))).issues, 'asset-bin-length-mismatch', 'buffers/0/byteLength');
  });
  it('limits actual file bytes before invoking the hasher', () => {
    assert.throws(() => ingestAsset({...input(validBytes()), hasher: () => {throw new Error('hasher called');}}, {maxBytes: 16}), /intake byte limit/);
  });
  it('rejects invalid UTF-8 inside a JSON string', () => {
    const bytes = buildGlb({asset: {version: '2.0'}, extras: 'abc'}, new Uint8Array(0));
    const index = Buffer.from(bytes).indexOf('abc'); bytes[index] = 0xff;
    assert.equal(glbCodeOf(bytes), 'glb-invalid-json');
  });
  it('accepts both tracked synthetic fixtures through Khronos validation', async () => {
    const {readFile} = await import('node:fs/promises');
    const {ingestValidatedAsset} = await import('../src/assets/index.js');
    for (const name of ['synthetic-block', 'synthetic-tetra']) {
      const result = await ingestValidatedAsset(input(await readFile(`examples/models/${name}.glb`)));
      assert.deepEqual(result.issues, []);
    }
  });
  it('rejects accessor data ranges that overrun a valid bufferView', async () => {
    const {ingestValidatedAsset} = await import('../src/assets/index.js');
    const json = baseJson();(json.accessors as {count: number}[])[0]!.count = 6;
    const result = await ingestValidatedAsset(input(buildGlb(json, new Uint8Array(72))));
    assert.ok(result.issues.some(issue => issue.code.startsWith('gltf-')));
  });
});
