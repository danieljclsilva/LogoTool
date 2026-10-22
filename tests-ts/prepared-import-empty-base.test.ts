import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendPreparedProduct } from '../src/core/project-builder/prepared-import.js';
import type { ProjectDocument } from '../src/core/types.js';

// Lead-owned: prepared import must accept a well-formed but still-empty draft
// (zero products, straight from Create) as its base. Regression guard for the
// release-clean station where the first real product can arrive through the
// prepared-JSON path.
function emptyDraft(): ProjectDocument {
  return {
    schemaVersion: '0.1.0-provisional',
    projectId: 'SYN-PROJ-EMPTY-001',
    revision: 1,
    products: [],
    logos: [],
    configurations: [],
  };
}

test('prepared import appends to an empty draft base', async () => {
  const parsed: unknown = JSON.parse(
    await readFile(resolve(process.cwd(), 'e2e/fixtures/prepared-bridge-product.json'), 'utf8'),
  );
  const appended = appendPreparedProduct(emptyDraft(), parsed);
  assert.equal(appended.ok, true);
  if (!appended.ok) return;
  assert.equal(appended.project.products.length, 1);
  assert.ok(appended.project.products[0]!.regions.length > 0);
});

test('prepared import still rejects an invalid candidate on an empty base', async () => {
  const appended = appendPreparedProduct(emptyDraft(), { not: 'a product' });
  assert.equal(appended.ok, false);
});

test('malformed empty base returns validation failure instead of throwing', async () => {
  const parsed: unknown = JSON.parse(
    await readFile(resolve(process.cwd(), 'e2e/fixtures/prepared-bridge-product.json'), 'utf8'),
  );
  // products:[] but configurations missing: only the two legitimate
  // empty-products minimums are waived, the missing-configurations error
  // must still fail the append (never throw on `.map` below).
  const malformed = {
    schemaVersion: '0.1.0-provisional',
    projectId: 'SYN-PROJ-EMPTY-001',
    revision: 1,
    products: [],
    logos: [],
  };
  let appended: { ok: boolean; errors?: Array<{ code: string; path: string }> };
  try {
    appended = appendPreparedProduct(malformed as unknown as ProjectDocument, parsed) as typeof appended;
  } catch (error) {
    assert.fail(`must not throw on a malformed empty base: ${String(error)}`);
  }
  assert.equal(appended.ok, false);
  assert.ok((appended.errors ?? []).length > 0, 'expected structural errors for the malformed base');
});

test('prepared import still rejects a corrupt non-empty base', async () => {
  const parsed: unknown = JSON.parse(
    await readFile(resolve(process.cwd(), 'e2e/fixtures/prepared-bridge-product.json'), 'utf8'),
  );
  const corrupt = { schemaVersion: '0.1.0-provisional', projectId: '', revision: 0, products: [{ id: '' }], logos: {}, configurations: [] };
  const appended = appendPreparedProduct(corrupt as unknown as ProjectDocument, parsed);
  assert.equal(appended.ok, false);
});
