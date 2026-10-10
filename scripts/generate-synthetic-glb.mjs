#!/usr/bin/env node
// scripts/generate-synthetic-glb.mjs
//
// Pure-Node minimal GLB builder for internal-prototype fixtures.
// No browser, no Three.js, no native modules — only node:fs / node:crypto /
// node:path / node:url.
//
// Determinism: fixed JSON key order (insertion order below), no timestamps,
// fixed float encoding, JSON chunk padded with 0x20, BIN chunk padded with
// 0x00. Same script version always emits byte-identical files.
//
// Usage:
//   node scripts/generate-synthetic-glb.mjs
//
// Writes:
//   examples/models/synthetic-block.glb  (flat-shaded box)
//   examples/models/synthetic-tetra.glb  (two-tetra abstract silhouette)

import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'examples', 'models');

// ---------------------------------------------------------------------------
// Small vec helpers (plain arrays, deterministic, no allocations that matter).
// ---------------------------------------------------------------------------
function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function centroid(points) {
  const c = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  c[0] /= points.length;
  c[1] /= points.length;
  c[2] /= points.length;
  return c;
}

// ---------------------------------------------------------------------------
// Mesh builder with automatic outward winding.
//
// addTri fixes the winding of each triangle so its face normal points away
// from the given solid center, then emits flat (per-face) vertices. Input
// winding therefore does not need to be hand-derived.
// ---------------------------------------------------------------------------
function createMeshBuilder() {
  return {
    positions: [],
    normals: [],
    indices: [],
    addTri(a, b, c, solidCenter) {
      let p1 = a;
      let p2 = b;
      let p3 = c;
      let n = cross(sub(p2, p1), sub(p3, p1));
      const fc = centroid([p1, p2, p3]);
      if (dot(n, sub(fc, solidCenter)) < 0) {
        p2 = c;
        p3 = b;
        n = cross(sub(p2, p1), sub(p3, p1));
      }
      const length = Math.hypot(...n);
      n = n.map(value => value / length);
      const base = this.positions.length / 3;
      this.positions.push(...p1, ...p2, ...p3);
      this.normals.push(...n, ...n, ...n);
      this.indices.push(base, base + 1, base + 2);
    },
    addQuad(a, b, c, d, solidCenter) {
      this.addTri(a, b, c, solidCenter);
      this.addTri(a, c, d, solidCenter);
    },
  };
}

// ---------------------------------------------------------------------------
// Model definitions (uncalibrated model-space coordinates; NOT millimetres).
// ---------------------------------------------------------------------------
function buildBox() {
  const mb = createMeshBuilder();
  const h = 0.5;
  const c = [0, 0, 0];
  // Six faces; winding is auto-corrected by addQuad.
  mb.addQuad([h, -h, -h], [h, -h, h], [h, h, h], [h, h, -h], c); // +X
  mb.addQuad([-h, -h, h], [-h, -h, -h], [-h, h, -h], [-h, h, h], c); // -X
  mb.addQuad([-h, h, -h], [h, h, -h], [h, h, h], [-h, h, h], c); // +Y
  mb.addQuad([-h, -h, h], [h, -h, h], [h, -h, -h], [-h, -h, -h], c); // -Y
  mb.addQuad([-h, -h, h], [-h, h, h], [h, h, h], [h, -h, h], c); // +Z
  mb.addQuad([h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, -h], c); // -Z
  return mb;
}

function baseTriangle(radius, y) {
  // Equilateral triangle in the XZ plane (angles 90/210/330 deg).
  return [
    [0, y, radius],
    [-0.8660254037844386 * radius, y, -0.5 * radius],
    [0.8660254037844386 * radius, y, -0.5 * radius],
  ];
}

function buildTetraPair() {
  const mb = createMeshBuilder();
  // Lower tetrahedron: upright, wide base (abstract lower-body silhouette).
  const [a, b, c2] = baseTriangle(0.55, -0.85);
  const apexLow = [0, 0.15, 0];
  const lowCenter = centroid([a, b, c2, apexLow]);
  mb.addTri(a, b, c2, lowCenter);
  mb.addTri(a, apexLow, b, lowCenter);
  mb.addTri(b, apexLow, c2, lowCenter);
  mb.addTri(c2, apexLow, a, lowCenter);
  // Upper tetrahedron: inverted, smaller (abstract upper-body silhouette).
  const [q, r, s] = baseTriangle(0.38, 0.95);
  const apexUp = [0, 0.3, 0];
  const upCenter = centroid([q, r, s, apexUp]);
  mb.addTri(q, r, s, upCenter);
  mb.addTri(q, r, apexUp, upCenter);
  mb.addTri(r, s, apexUp, upCenter);
  mb.addTri(s, q, apexUp, upCenter);
  return mb;
}

// ---------------------------------------------------------------------------
// glTF JSON assembly (fixed key order) + GLB container encoding.
// ---------------------------------------------------------------------------
function assembleGltf(mb, name, baseColorFactor) {
  const pos = new Float32Array(mb.positions);
  const nrm = new Float32Array(mb.normals);
  const idx = new Uint16Array(mb.indices);
  const posBytes = Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength);
  const nrmBytes = Buffer.from(nrm.buffer, nrm.byteOffset, nrm.byteLength);
  const idxBytes = Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength);

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }

  const bin = Buffer.concat([posBytes, nrmBytes, idxBytes]);
  const posOffset = 0;
  const nrmOffset = posBytes.length;
  const idxOffset = posBytes.length + nrmBytes.length;
  if (posOffset % 4 !== 0 || nrmOffset % 4 !== 0 || idxOffset % 4 !== 0) {
    throw new Error('bufferView offsets must be 4-byte aligned');
  }

  // NOTE: key insertion order is the on-disk field order — do not reorder.
  const json = {
    asset: { version: '2.0', generator: 'logotool-generate-synthetic-glb' },
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [
      {
        name,
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1 },
            indices: 2,
            material: 0,
            mode: 4,
          },
        ],
      },
    ],
    materials: [
      {
        name: `${name}-mat`,
        pbrMetallicRoughness: {
          baseColorFactor,
          metallicFactor: 0.0,
          roughnessFactor: 0.8,
        },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: pos.length / 3,
        type: 'VEC3',
        min,
        max,
      },
      { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: posOffset, byteLength: posBytes.length, target: 34962 },
      { buffer: 0, byteOffset: nrmOffset, byteLength: nrmBytes.length, target: 34962 },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };

  return { json, bin, vertexCount: pos.length / 3, triangleCount: idx.length / 3, min, max };
}

function encodeGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = jsonBytes.length + ((4 - (jsonBytes.length % 4)) % 4);
  const jsonChunk = Buffer.alloc(jsonPadded, 0x20);
  jsonBytes.copy(jsonChunk);

  const binPadded = bin.length + ((4 - (bin.length % 4)) % 4);
  const binChunk = Buffer.alloc(binPadded, 0x00);
  bin.copy(binChunk);

  const total = 12 + 8 + jsonPadded + 8 + binPadded;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0); // 'glTF'
  out.writeUInt32LE(2, 4); // version
  out.writeUInt32LE(total, 8); // length
  out.writeUInt32LE(jsonPadded, 12);
  out.writeUInt32LE(0x4e4f534a, 16); // 'JSON'
  jsonChunk.copy(out, 20);
  const binHeader = 20 + jsonPadded;
  out.writeUInt32LE(binPadded, binHeader);
  out.writeUInt32LE(0x004e4942, binHeader + 4); // 'BIN\0'
  binChunk.copy(out, binHeader + 8);
  return out;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
const MODELS = [
  {
    filename: 'synthetic-block.glb',
    name: 'synthetic-block',
    builder: buildBox,
    baseColorFactor: [0.16, 0.38, 0.85, 1.0],
  },
  {
    filename: 'synthetic-tetra.glb',
    name: 'synthetic-tetra',
    builder: buildTetraPair,
    baseColorFactor: [0.9, 0.45, 0.12, 1.0],
  },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const model of MODELS) {
  const mb = model.builder();
  const { json, bin, vertexCount, triangleCount, min, max } = assembleGltf(
    mb,
    model.name,
    model.baseColorFactor,
  );
  const glb = encodeGlb(json, bin);
  writeFileSync(join(OUT_DIR, model.filename), glb);
  const sha256 = createHash('sha256').update(glb).digest('hex');
  const fmt = (v) => (Array.isArray(v) ? v.map((n) => n.toFixed(4)).join(',') : v);
  console.log(
    `${model.filename}: bytes=${glb.length} sha256=${sha256} ` +
      `verts=${vertexCount} tris=${triangleCount} min=[${fmt(min)}] max=[${fmt(max)}]`,
  );
}
