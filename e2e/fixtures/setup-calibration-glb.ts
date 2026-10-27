// Shared synthetic cube-GLB fixture builder (W3-owned).
// Minimal self-contained unit-cube GLB (double-sided): deterministic bytes,
// no browser/Three.js needed. Used by e2e/setup-calibration.spec.ts.

/** Minimal synthetic self-contained cube GLB (unit cube, double-sided). */
export function cubeGlb(raisedFront = false, withNormals = true): Uint8Array {
  const h = 0.5;
  type V = [number, number, number];
  const faces: Array<{ n: V; v: [V, V, V, V] }> = [
    { n: [1, 0, 0], v: [[h, -h, -h], [h, -h, h], [h, h, h], [h, h, -h]] },
    { n: [-1, 0, 0], v: [[-h, -h, h], [-h, -h, -h], [-h, h, -h], [-h, h, h]] },
    { n: [0, 1, 0], v: [[-h, h, -h], [h, h, -h], [h, h, h], [-h, h, h]] },
    { n: [0, -1, 0], v: [[-h, -h, h], [h, -h, h], [h, -h, -h], [-h, -h, -h]] },
    { n: [0, 0, 1], v: [[-h, -h, h], [-h, h, h], [h, h, h], [h, -h, h]] },
    { n: [0, 0, -1], v: [[h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, -h]] },
  ];
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const face of faces) {
    const [a, b, c, d] = face.v;
    const vertices = raisedFront && face.n[2] === 1
      ? [a, b, [0, 0, 0.65] as V, b, c, [0, 0, 0.65] as V, c, d, [0, 0, 0.65] as V, d, a, [0, 0, 0.65] as V]
      : [a, b, c, a, c, d];
    // With no NORMAL attribute the renderer derives normals from winding.
    // Use outward triangles for that fixture; retain legacy bytes by default.
    if (!withNormals) for (let at = 0; at < vertices.length; at += 3) {
      const second = vertices[at + 1]!; vertices[at + 1] = vertices[at + 2]!; vertices[at + 2] = second;
    }
    for (let index = 0; index < vertices.length; index += 1) {
      const p = vertices[index]!;
      pos.push(p[0], p[1], p[2]);
      let normal: V = face.n;
      if (raisedFront && face.n[2] === 1) {
        const at = index - (index % 3);
        const a = vertices[at]!, b = vertices[at + 1]!, c = vertices[at + 2]!;
        const u = b.map((value, i) => value - a[i]!);
        const v = c.map((value, i) => value - a[i]!);
        const n: V = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        const scale = (n[2] < 0 ? -1 : 1) / Math.hypot(...n);
        normal = n.map((value) => value * scale) as V;
      }
      nrm.push(...normal);
    }
  }
  const posArray = new Float32Array(pos);
  const nrmArray = new Float32Array(nrm);
  const posBuf = Buffer.from(posArray.buffer, posArray.byteOffset, posArray.byteLength);
  const nrmBuf = Buffer.from(nrmArray.buffer, nrmArray.byteOffset, nrmArray.byteLength);
  const bin = Buffer.concat([posBuf, nrmBuf]);
  const json = {
    asset: { version: '2.0', generator: 'logotool-setup-calibration-fixture' },
    scene: 0,
    scenes: [{ name: 'syn-cube', nodes: [0] }],
    nodes: [{ name: 'syn-cube', mesh: 0 }],
    meshes: [{
      name: 'syn-cube',
      primitives: [{ attributes: withNormals ? { POSITION: 0, NORMAL: 1 } : { POSITION: 0 }, material: 0, mode: 4 }],
    }],
    materials: [{ name: 'syn-cube-mat', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.8, 1.0], metallicFactor: 0, roughnessFactor: 0.8 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: [-h, -h, -h], max: [h, h, raisedFront ? 0.65 : h] },
      { bufferView: 1, componentType: 5126, count: nrm.length / 3, type: 'VEC3' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: posBuf.length, byteLength: nrmBuf.length, target: 34962 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length + jsonPad, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBytes.copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  const binStart = 20 + jsonBytes.length + jsonPad;
  out.writeUInt32LE(bin.length, binStart);
  out.writeUInt32LE(0x004e4942, binStart + 4);
  bin.copy(out, binStart + 8);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
