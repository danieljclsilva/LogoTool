import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * fixtures.ts — synthetic offline fixtures for the asset-inspector e2e suite.
 *
 * The GLB starts from the checked-in `examples/models/synthetic-block.glb`
 * with a single-node translate/scale/rotate patch in the reference field
 * order (translation, scale, rotation). Calibration session and area-bundle
 * payloads live in `e2e/fixtures/` with a `__ASSET_SHA256__` token replaced
 * at runtime by the transformed asset hash. No network, no scratch paths.
 */

export const TRANSFORM = {
  translation: [5, 2, -3],
  scale: [2, 1.5, 1],
  // 45° about Z as (x, y, z, w).
  rotation: [0, 0, 0.3826834323650898, 0.9238795325112867],
} as const;

const TOKEN = '__ASSET_SHA256__';

export interface InspectorFixtures {
  glbBuffer: Buffer;
  sessionText: string;
  areaText: string;
  expectedHash: string;
}

let cache: InspectorFixtures | null = null;

function patchNodeTransform(glb: Buffer): Buffer {
  const jsonLength = glb.readUInt32LE(12);
  const raw = glb
    .subarray(20, 20 + jsonLength)
    .toString('utf8')
    .replace(/\s+$/, '');
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || !('nodes' in parsed))
    throw new Error('Base GLB JSON has no nodes array.');
  const nodes = parsed.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0)
    throw new Error('Base GLB has no nodes to transform.');
  const first: unknown = nodes[0];
  if (
    first === null ||
    typeof first !== 'object' ||
    !('name' in first) ||
    !('mesh' in first)
  )
    throw new Error('Base GLB first node has an unexpected shape.');
  // Rebuild the node in the reference field order so bytes stay stable.
  nodes[0] = {
    name: first.name,
    mesh: first.mesh,
    translation: [...TRANSFORM.translation],
    scale: [...TRANSFORM.scale],
    rotation: [...TRANSFORM.rotation],
  };
  const jsonBytes = Buffer.from(JSON.stringify(parsed), 'utf8');
  const paddedLength = (jsonBytes.length + 3) & ~3;
  const padded = Buffer.alloc(paddedLength, 0x20);
  jsonBytes.copy(padded);
  const rest = glb.subarray(20 + jsonLength);
  const total = 12 + 8 + paddedLength + rest.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(paddedLength, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(out, 20);
  rest.copy(out, 20 + paddedLength);
  return out;
}

export async function loadFixtures(): Promise<InspectorFixtures> {
  if (cache !== null) return cache;
  const base = await readFile(
    resolve(process.cwd(), 'examples/models/synthetic-block.glb'),
  );
  const glbBuffer = patchNodeTransform(base);
  const expectedHash = createHash('sha256').update(glbBuffer).digest('hex');
  const [sessionTemplate, areaTemplate] = await Promise.all([
    readFile(resolve(process.cwd(), 'e2e/fixtures/session.json'), 'utf8'),
    readFile(resolve(process.cwd(), 'e2e/fixtures/area-bundle.json'), 'utf8'),
  ]);
  if (!sessionTemplate.includes(TOKEN) || !areaTemplate.includes(TOKEN))
    throw new Error('Fixture templates are missing the asset-hash token.');
  const sessionText = sessionTemplate.split(TOKEN).join(expectedHash);
  const areaText = areaTemplate.split(TOKEN).join(expectedHash);
  // Fail fast on template drift before any test navigates.
  JSON.parse(sessionText);
  JSON.parse(areaText);
  cache = { glbBuffer, sessionText, areaText, expectedHash };
  return cache;
}

export interface BundleFitJson {
  productionApproved: boolean;
  scaleMmPerUnit: number;
  inconsistent: boolean;
  assetFullSha256: string;
}

export interface BundleEvidenceJson {
  assetFullSha256: string;
}

export interface AreaRecordJson {
  exclusions: Array<{ polygon: Array<{ x: unknown; y: unknown }> }>;
}

export interface AreaBundleJson {
  schemaVersion: string;
  productionApproved: boolean;
  pendingReview: boolean;
  regions: Array<{ origin: { x: number; y: number; z: number } }>;
  areas: AreaRecordJson[];
  session: { evidence: BundleEvidenceJson; fit: BundleFitJson };
}

export interface PlacementJson {
  id: string;
  logoId: string;
  regionId: string;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
}

export interface PlacementBundleJson {
  schemaVersion: string;
  productionApproved: boolean;
  pendingReview: boolean;
  placements: PlacementJson[];
  regions: Array<{ origin: { x: number; y: number; z: number } }>;
  statuses: Array<{ id: string; fits: boolean; reason: string }>;
  session: { evidence: BundleEvidenceJson; fit: BundleFitJson };
}

// Test seam: specs read and mutate self-generated provisional bundles whose
// shape is fixed by the app's deterministic exporters, so a single boundary
// cast per helper keeps every spec free of inline shape fabrications.
export function parseAreaBundle(bundleText: string): AreaBundleJson {
  const bundle = JSON.parse(bundleText) as AreaBundleJson;
  return bundle;
}

export function parsePlacementBundle(bundleText: string): PlacementBundleJson {
  const bundle = JSON.parse(bundleText) as PlacementBundleJson;
  return bundle;
}

export function mutateAreaBundle(
  bundleText: string,
  mutate: (bundle: AreaBundleJson) => void,
): string {
  const bundle = parseAreaBundle(bundleText);
  mutate(bundle);
  return JSON.stringify(bundle);
}

export function mutatePlacementBundle(
  bundleText: string,
  mutate: (bundle: PlacementBundleJson) => void,
): string {
  const bundle = parsePlacementBundle(bundleText);
  mutate(bundle);
  return JSON.stringify(bundle);
}
