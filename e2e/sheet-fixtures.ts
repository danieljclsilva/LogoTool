import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createProjectPackage, parseProjectPackage } from '../src/packaging/project-package/index.js';
import type { ProjectPackageSha256 } from '../src/packaging/project-package/index.js';
import { newRevision } from '../src/core/index.js';
import type { ProjectDocument } from '../src/core/index.js';
import { revealBuilderControl } from './helpers.js';

// Shared synthetic fixtures for operation-sheet browser acceptance (lead-owned
// extraction; single implementation used by operation-sheet-print.spec.ts and
// station-entry.spec.ts). Tracked fixtures stay synthetic only; private
// real-jacket assets never enter automated tests.

export const sha256: ProjectPackageSha256 = async (bytes) => createHash('sha256').update(bytes).digest('hex');
export const TRUSTED_SOURCE_PATH = resolve(process.cwd(), 'dist/dev/trusted-issued.logo-project');

function builder(page: Page, name: string) {
  return page.locator(`[data-builder-hook="${name}"]`);
}

async function shown(page: Page, name: string) {
  await revealBuilderControl(page, name);
  return ['builder-next', 'builder-back'].includes(name)
    ? builder(page, name).filter({ visible: true }).first()
    : builder(page, name);
}

/** Real decodable PNGs rendered in-browser at realistic sizes (a 1x1 photo
 *  would make the SVG marker hit-areas cover the whole overlay). */
export async function makePngs(page: Page): Promise<{ front: Uint8Array; back: Uint8Array; left: Uint8Array; chestArt: Uint8Array; backArt: Uint8Array }> {
  const shot = async (w: number, h: number, fill: string): Promise<Uint8Array> => {
    const base64 = await page.evaluate((spec: string) => {
      const [width, height, color] = JSON.parse(spec) as [number, number, string];
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.fillStyle = color; context.fillRect(0, 0, width, height);
      return canvas.toDataURL('image/png').split(',')[1] as string;
    }, JSON.stringify([w, h, fill]));
    return new Uint8Array(Buffer.from(base64, 'base64'));
  };
  return {
    // Real-shaped product photos: 2000px wide so printed SVG labels must
    // scale to stay legible (fixed viewBox-px text would print minuscule).
    front: await shot(2000, 1600, '#dfe7ec'),
    back: await shot(2000, 1600, '#e8e2d5'),
    left: await shot(2000, 1600, '#e3e8ec'),
    chestArt: await shot(80, 40, '#1d6f3a'),
    backArt: await shot(60, 30, '#7a1f1f'),
  };
}

/** A single-product two-logo front+back customer return: the ordinary
 *  one-page job (tee chest embroidery + back print), revision +1 with a
 *  customer note. The trusted fixture's trousers configuration is dropped so
 *  the view is exactly one sheet. Both archives carry the same photo,
 *  manifest, mapping and raster artwork assets: front AND back product
 *  photos, a v2 sided manifest, evaluated chest+back mappings and a raster
 *  PNG per logo (chest art on SYN-LOGO-A, back art on a distinct SYN-LOGO-C),
 *  so anchors can be created on each photo and arrows composite onto both. */
export async function makeReturnBytes(photos: { front: Uint8Array; back: Uint8Array; left: Uint8Array; chestArt: Uint8Array; backArt: Uint8Array }): Promise<{ baseline: Uint8Array; returned: Uint8Array }> {
  const { front, back, left, chestArt, backArt } = photos;
  const baselineBytes = new Uint8Array(await readFile(TRUSTED_SOURCE_PATH));
  const parsed = await parseProjectPackage(baselineBytes, { sha256 });
  const single = structuredClone(parsed.project);
  single.configurations = single.configurations.filter((entry) => entry.id === 'SYN-CFG-TEE-M');
  single.products = single.products.filter((entry) => entry.id === 'SYN-TEE-001');
  // Distinct business logos per side: chest keeps SYN-LOGO-A, the back
  // placement moves to a new SYN-LOGO-C with its own raster original.
  single.logos.find((entry) => entry.id === 'SYN-LOGO-A')!.assets.push(
    { uri: 'logos/chest.png', role: 'original', mediaType: 'image/png' },
  );
  // Long synthetic business identity (real-shaped trial data).
  single.logos.find((entry) => entry.id === 'SYN-LOGO-A')!.name =
    'Synthetic Chest Emblem Extended Product Line for Field Trials';
  single.logos.push({
    schemaVersion: single.schemaVersion,
    id: 'SYN-LOGO-C',
    name: 'Synthetic Back Emblem Extended Product Line for Field Trials',
    assets: [{ uri: 'logos/back.png', role: 'original', mediaType: 'image/png' }],
  });
  const teeConfig = single.configurations.find((entry) => entry.id === 'SYN-CFG-TEE-M')!;
  teeConfig.placements.find((entry) => entry.regionId === 'SYN-TEE-BACK')!.logoId = 'SYN-LOGO-C';
  const manifest = new TextEncoder().encode(JSON.stringify({
    version: 2,
    views: [
      { productId: 'SYN-TEE-001', variantId: 'SYN-TEE-M', view: 'front', label: 'Front', image: 'presentation/front.png' },
      { productId: 'SYN-TEE-001', variantId: 'SYN-TEE-M', view: 'back', label: 'Back', image: 'presentation/back.png' },
      // Left is supplied but hosts no selected logos and has no evaluated
      // mapping: the focused sheet must omit it from print (kept internally).
      { productId: 'SYN-TEE-001', variantId: 'SYN-TEE-M', view: 'left', label: 'Left', image: 'presentation/left.png' },
    ],
  }));
  const mappings = new TextEncoder().encode(JSON.stringify({
    version: 1,
    mappings: [
      {
        productId: 'SYN-TEE-001', variantId: 'SYN-TEE-M', regionId: 'SYN-TEE-CHEST',
        view: 'front', image: 'presentation/front.png',
        transform: { a: 1 / 200, b: 0, c: 0.5, d: 0, e: -1 / 160, f: 0.5 },
        calibrationId: 'CAL-SYN-001', calibrationVersion: 'v1', status: 'provisional',
      },
      {
        productId: 'SYN-TEE-001', variantId: 'SYN-TEE-M', regionId: 'SYN-TEE-BACK',
        view: 'back', image: 'presentation/back.png',
        transform: { a: 1 / 220, b: 0, c: 0.5, d: 0, e: -1 / 180, f: 0.5 },
        calibrationId: 'CAL-SYN-001', calibrationVersion: 'v1', status: 'provisional',
      },
    ],
  }));
  const referenced = parsed.assets.filter((asset) => asset.kind === 'referenced')
    .map(({ path, bytes }) => ({ path, bytes }));
  const sharedReferenced = [
    ...referenced,
    { path: 'logos/chest.png', bytes: chestArt },
    { path: 'logos/back.png', bytes: backArt },
  ];
  const sharedAdditional = [
    ...parsed.assets.filter((asset) => asset.kind === 'additional').map(({ path, bytes }) => ({ path, bytes })),
    { path: 'presentation/preview.json', bytes: manifest },
    { path: 'presentation/front.png', bytes: front },
    { path: 'presentation/back.png', bytes: back },
    { path: 'presentation/left.png', bytes: left },
    { path: 'presentation/photo-mappings.json', bytes: mappings },
  ];
  const packFor = async (project: ProjectDocument): Promise<Uint8Array> => createProjectPackage(
    { project, assets: sharedReferenced, additionalAssets: sharedAdditional }, { sha256 },
  );
  const revised = newRevision(single, (draft: ProjectDocument) => {
    draft.instructions = `${draft.instructions ?? ''}\nBuilder trial customer note.`.trim();
  });
  return { baseline: await packFor(single), returned: await packFor(revised) };
}

export async function openCheckWithReturn(page: Page, baseline: Uint8Array, returned: Uint8Array): Promise<void> {
  await (await shown(page, 'mode-review')).click();
  await (await shown(page, 'baseline-file')).setInputFiles({
    name: 'office-copy.logo-project', mimeType: 'application/zip', buffer: Buffer.from(baseline),
  });
  await expect(builder(page, 'office-summary')).toContainText('Office copy ready', { timeout: 15000 });
  await (await shown(page, 'step-return')).click();
  await (await shown(page, 'return-file')).setInputFiles({
    name: 'customer-return.logo-project', mimeType: 'application/zip', buffer: Buffer.from(returned),
  });
  await expect(await shown(page, 'review-panel')).toBeVisible({ timeout: 15000 });
  await (await shown(page, 'step-check')).click();
  await expect(await shown(page, 'operation-container')).not.toHaveAttribute('hidden', { timeout: 15000 });
}

export function countPdfPages(pdf: Uint8Array): number {
  const text = Buffer.from(pdf).toString('latin1');
  const matches = text.match(/\/Type\s*\/Page(?![\w/])/g);
  return matches === null ? 0 : matches.length;
}

export function readMediaBox(pdf: Uint8Array): [number, number] | null {
  const text = Buffer.from(pdf).toString('latin1');
  const match = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}
