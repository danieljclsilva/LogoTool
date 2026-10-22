import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canCloseDrawnPolygon,
  polygonIsSelfIntersecting,
  polygonSignedAreaMm,
  segmentsIntersectMm,
  validateSafeAreaPolygon,
} from '../src/ui/internal-builder/anchor-setup.js';
import {
  anchorCoordinateRows,
  applySaveOutcome,
  createWorkspaceEditStore,
  isProductSetupPhotoView,
  ProductSetupSaver,
  resolveInitialSide,
  safeAreaCoordinateRows,
  selectWorkspaceView,
  shortScopeLabel,
  transformKeyOf,
  validateSaveRequest,
  viewIdentityKey,
  workspaceMmToPhoto,
  workspacePhotoToMm,
} from '../src/ui/internal-builder/product-setup-view.js';
import type {
  ProductSetupPhotoView,
  ProductSetupWorkspaceInput,
} from '../src/ui/internal-builder/product-setup-view.js';
import type { AnchorSetupMm, AnchorSetupPhoto } from '../src/ui/internal-builder/anchor-setup.js';
import type { AnchorDef } from '../src/core/operation-measurements/types.js';

function mm(x: number, y: number): AnchorSetupMm {
  return { x, y };
}

const SQUARE: AnchorSetupMm[] = [mm(0, 0), mm(10, 0), mm(10, 10), mm(0, 10)];
/** Bowtie with nonzero area: edges (0,0)->(10,8) and (10,0)->(0,10) cross. */
const BOWTIE: AnchorSetupMm[] = [mm(0, 0), mm(10, 8), mm(10, 0), mm(0, 10)];

test('a valid rectangle is accepted with its signed area', () => {
  assert.equal(validateSafeAreaPolygon(SQUARE).ok, true);
  assert.equal(polygonSignedAreaMm(SQUARE), 100);
  assert.equal(polygonIsSelfIntersecting(SQUARE), false);
});

test('winding flips the signed area without invalidating the polygon', () => {
  const clockwise = [...SQUARE].reverse();
  assert.equal(polygonSignedAreaMm(clockwise), -100);
  assert.equal(validateSafeAreaPolygon(clockwise).ok, true);
});

test('fewer than 3 corners are refused with an actionable reason', () => {
  for (const corners of [[], [mm(0, 0)], [mm(0, 0), mm(10, 0)]] as AnchorSetupMm[][]) {
    const result = validateSafeAreaPolygon(corners);
    assert.equal(result.ok, false);
    assert.ok(result.reason !== null && result.reason.length > 0, 'reason must be actionable');
    assert.match(result.reason!, /3/);
  }
});

test('non-finite corners are refused', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const result = validateSafeAreaPolygon([mm(0, 0), mm(10, 0), mm(bad, 10)]);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /finite/);
  }
});

test('a zero-area (collinear) polygon is refused', () => {
  const collinear = [mm(0, 0), mm(5, 5), mm(10, 10)];
  assert.equal(polygonSignedAreaMm(collinear), 0);
  const result = validateSafeAreaPolygon(collinear);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /zero area/);
});

test('coincident corners are refused, including the wrap edge', () => {
  const doubled = [mm(0, 0), mm(10, 0), mm(10, 0), mm(0, 10)];
  assert.equal(validateSafeAreaPolygon(doubled).ok, false);
  assert.match(validateSafeAreaPolygon(doubled).reason!, /coincide/);
  const wrapDoubled = [mm(0, 0), mm(10, 0), mm(10, 10), mm(0, 0)];
  assert.equal(validateSafeAreaPolygon(wrapDoubled).ok, false);
});

test('a self-crossing bowtie is refused', () => {
  assert.equal(polygonIsSelfIntersecting(BOWTIE), true);
  const result = validateSafeAreaPolygon(BOWTIE);
  assert.equal(result.ok, false);
  assert.match(result.reason!, /cross/);
});

test('a vertex touching a non-adjacent edge counts as self-intersecting', () => {
  // (5,0) sits exactly on the non-adjacent edge (0,0)->(10,0); area is nonzero.
  const touched = [mm(0, 0), mm(10, 0), mm(10, 10), mm(5, 0), mm(5, 10), mm(0, 10)];
  assert.notEqual(polygonSignedAreaMm(touched), 0);
  assert.equal(polygonIsSelfIntersecting(touched), true);
  assert.equal(validateSafeAreaPolygon(touched).ok, false);
});

test('segment intersection covers crossing, touching, overlap and disjoint cases', () => {
  assert.equal(segmentsIntersectMm(mm(0, 0), mm(10, 10), mm(0, 10), mm(10, 0)), true);
  assert.equal(segmentsIntersectMm(mm(0, 0), mm(10, 0), mm(0, 10), mm(10, 10)), false);
  assert.equal(segmentsIntersectMm(mm(0, 0), mm(10, 0), mm(10, 0), mm(20, 0)), true);
  assert.equal(segmentsIntersectMm(mm(0, 0), mm(10, 0), mm(5, 0), mm(15, 0)), true);
  assert.equal(segmentsIntersectMm(mm(0, 0), mm(10, 0), mm(0, 1), mm(10, 1)), false);
});

test('close/finish rules: 3+ finite corners close, fewer or non-finite do not', () => {
  assert.equal(canCloseDrawnPolygon([mm(0, 0), mm(10, 0)]).ok, false);
  assert.match(canCloseDrawnPolygon([mm(0, 0), mm(10, 0)]).reason!, /more corner/);
  assert.equal(canCloseDrawnPolygon([]).ok, false);
  assert.equal(canCloseDrawnPolygon(SQUARE).ok, true);
  const nonFinite = [mm(0, 0), mm(10, 0), mm(Number.NaN, 10)];
  assert.equal(canCloseDrawnPolygon(nonFinite).ok, false);
  assert.match(canCloseDrawnPolygon(nonFinite).reason!, /finite/);
});

test('close is offered before full validation; commit still refuses crossings', () => {
  // Three finite corners may finish the gesture; the self-intersection is
  // caught at commit time so invalid geometry is never staged.
  assert.equal(canCloseDrawnPolygon(BOWTIE.slice(0, 3)).ok, true);
  assert.equal(validateSafeAreaPolygon(BOWTIE).ok, false);
});

// ---- Round 2: per-view scopes, stable draft identity, labels, save roundtrip ----

function photoFixture(widthPx: number, heightPx: number, seed: number): AnchorSetupPhoto {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (seed + i) & 0xff;
  return { bytes, widthPx, heightPx, label: 'synthetic' };
}

function anchorFixture(name: string, x: number, y: number, regionId: string): AnchorDef {
  return {
    id: `test-${name}`,
    name,
    productId: 'prod-1',
    variantId: 'var-1',
    regionId,
    frameId: 'frame-x',
    calibrationId: 'cal-x',
    calibrationVersion: '1',
    posMm: [x, y],
  };
}

function viewFixture(overrides: Partial<ProductSetupPhotoView> & { side: 'front' | 'back' }): ProductSetupPhotoView {
  const { side, ...rest } = overrides;
  const front = side === 'front';
  return {
    scope: {
      productId: 'prod-1',
      variantId: 'var-1',
      regionId: front ? 'region-front' : 'region-back',
      frameId: front ? 'frame-front' : 'frame-back',
      calibrationId: front ? 'cal-front' : 'cal-back',
      calibrationVersion: front ? '7' : '9',
      regionName: front ? 'Chest' : 'Back print',
      side,
    },
    photoId: front ? 'photo-front-abc' : 'photo-back-def',
    sourceRev: 'rev-1',
    photo: photoFixture(200, 100, front ? 1 : 2),
    transform: front
      ? { a: 1 / 200, b: 0, c: 0, d: 0, e: -1 / 100, f: 1 }
      : { a: 1 / 400, b: 0, c: 0.25, d: 0, e: -1 / 200, f: 0.75 },
    mappingStatus: 'review',
    safeArea: SQUARE,
    anchors: [],
    ...overrides,
  };
}

function workspaceFixture(): ProductSetupWorkspaceInput {
  return {
    initialSide: 'front',
    views: { front: viewFixture({ side: 'front' }), back: viewFixture({ side: 'back' }) },
  };
}

test('A: each tab resolves its own actual scope — never a swapped top-level scope', () => {
  const input = workspaceFixture();
  const front = selectWorkspaceView(input, 'front');
  const back = selectWorkspaceView(input, 'back');
  assert.equal(isProductSetupPhotoView(front), true);
  assert.equal(isProductSetupPhotoView(back), true);
  if (!isProductSetupPhotoView(front) || !isProductSetupPhotoView(back)) return;
  assert.equal(front.scope.regionId, 'region-front');
  assert.equal(front.scope.frameId, 'frame-front');
  assert.equal(front.scope.calibrationId, 'cal-front');
  assert.equal(front.scope.calibrationVersion, '7');
  assert.equal(back.scope.regionId, 'region-back');
  assert.equal(back.scope.frameId, 'frame-back');
  assert.equal(back.scope.calibrationId, 'cal-back');
  assert.equal(back.scope.calibrationVersion, '9');
  const missing = selectWorkspaceView(input, 'left');
  assert.equal(isProductSetupPhotoView(missing), false);
  assert.match((missing as { error: string }).error, /Left/);
});

test('A: the same region-mm point maps to different photo positions per view', () => {
  const input = workspaceFixture();
  const front = selectWorkspaceView(input, 'front');
  const back = selectWorkspaceView(input, 'back');
  assert.equal(isProductSetupPhotoView(front), true);
  assert.equal(isProductSetupPhotoView(back), true);
  if (!isProductSetupPhotoView(front) || !isProductSetupPhotoView(back)) return;
  const probe = mm(10, 20);
  const frontPx = workspaceMmToPhoto(front, 'front', probe);
  const backPx = workspaceMmToPhoto(back, 'back', probe);
  assert.ok(frontPx && backPx, 'both views must forward-map the probe');
  assert.notDeepEqual(frontPx, backPx, 'identical mm must land on different photo pixels per view');
  // And each view round-trips through its own inverse mapping.
  const backMm = workspacePhotoToMm(back, 'back', backPx!.x, backPx!.y);
  assert.ok(backMm, 'back inverse mapping must resolve');
  assert.ok(Math.abs(backMm!.x - probe.x) < 1e-9 && Math.abs(backMm!.y - probe.y) < 1e-9);
});

test('resolveInitialSide prefers the operator tab, then the hint, then the first view', () => {
  const input = workspaceFixture();
  assert.equal(resolveInitialSide(input, 'back'), 'back');
  assert.equal(resolveInitialSide(input, null), 'front');
  assert.equal(resolveInitialSide({ views: input.views }, null), 'front');
  assert.equal(resolveInitialSide({ views: {} }, null), null);
  const backOnly = selectWorkspaceView(input, 'back');
  assert.equal(isProductSetupPhotoView(backOnly), true);
  if (!isProductSetupPhotoView(backOnly)) return;
  assert.equal(resolveInitialSide({ views: { back: backOnly } }, null), 'back');
});

test('B: identical identity inputs share one bucket; any change re-initialises', () => {
  const view = viewFixture({ side: 'front' });
  const base = viewIdentityKey(view);
  assert.equal(viewIdentityKey(viewFixture({ side: 'front' })), base);
  // Same-size/same-length replacement photo: only the photoId changes.
  const swappedPhoto = viewFixture({ side: 'front' });
  swappedPhoto.photo = photoFixture(200, 100, 99);
  swappedPhoto.photoId = 'photo-front-xyz';
  assert.equal(swappedPhoto.photo.bytes.length, view.photo.bytes.length);
  assert.notEqual(viewIdentityKey(swappedPhoto), base);
  // Calibration bump, source-project change, mapping change all invalidate.
  assert.notEqual(
    viewIdentityKey(viewFixture({ side: 'front', scope: { ...view.scope, calibrationVersion: '8' } })),
    base,
  );
  assert.notEqual(viewIdentityKey(viewFixture({ side: 'front', sourceRev: 'rev-2' })), base);
  const remapped = viewFixture({ side: 'front' });
  remapped.transform = { ...remapped.transform!, c: 0.5 };
  assert.notEqual(viewIdentityKey(remapped), base);
  const unmapped = viewFixture({ side: 'front' });
  unmapped.transform = null;
  assert.notEqual(viewIdentityKey(unmapped), base);
  assert.equal(transformKeyOf(null), 'null');
});

test('B: the store retains edits across tab switches and drops stale identities', () => {
  const store = createWorkspaceEditStore();
  const front = viewFixture({ side: 'front' });
  const back = viewFixture({ side: 'back' });
  const frontKey = viewIdentityKey(front);
  const backKey = viewIdentityKey(back);
  const frontBucket = store.bucketFor(frontKey, () => ({
    safeArea: [],
    anchors: [anchorFixture('A1', 1, 2, 'region-front')],
    dirty: true,
  }));
  store.setDraft(backKey, [mm(0, 0), mm(1, 1)]);
  // "Switch away and back": both keys retained, objects identical, edits intact.
  store.retainBuckets(new Set([frontKey, backKey]));
  store.retainDrafts(new Set([frontKey, backKey]));
  const revived = store.bucketFor(frontKey, () => {
    throw new Error('must not re-initialise an unchanged scope');
  });
  assert.equal(revived, frontBucket);
  assert.equal(revived.dirty, true);
  assert.deepEqual(revived.anchors[0]!.posMm, [1, 2]);
  assert.deepEqual(store.draftFor(backKey), [mm(0, 0), mm(1, 1)]);
  // A calibration bump is a new identity: old geometry is dropped, never reinterpreted.
  const bumped = viewFixture({ side: 'front', scope: { ...front.scope, calibrationVersion: '8' } });
  const bumpedKey = viewIdentityKey(bumped);
  store.retainBuckets(new Set([bumpedKey, backKey]));
  store.retainDrafts(new Set([bumpedKey, backKey]));
  assert.equal(store.draftFor(frontKey), undefined);
  const fresh = store.bucketFor(frontKey, () => ({ safeArea: [], anchors: [], dirty: false }));
  assert.equal(fresh.dirty, false);
  assert.equal(fresh.anchors.length, 0);
});

test('C: normal labels are short and human; ids never leak into them', () => {
  const scope = viewFixture({ side: 'front' }).scope;
  const label = shortScopeLabel(scope);
  assert.match(label, /Chest/);
  assert.match(label, /Front/);
  for (const secret of ['prod-1', 'var-1', 'region-front', 'frame-front', 'cal-front']) {
    assert.ok(!label.includes(secret), `label must not leak "${secret}": ${label}`);
  }
  const nameless = shortScopeLabel({ ...scope, regionName: null });
  assert.match(nameless, /Front/);
  assert.ok(!nameless.includes('null'));
  for (const secret of ['region-front', 'frame-front', 'cal-front']) {
    assert.ok(!nameless.includes(secret));
  }
});

test('C: coordinate tables are pure Advanced-disclosure data (normal panels stay clean)', () => {
  const cornerRows = safeAreaCoordinateRows(SQUARE);
  assert.equal(cornerRows.length, 4);
  assert.match(cornerRows[0]!, /Corner 1/);
  assert.match(cornerRows[0]!, /mm/);
  const anchorRows = anchorCoordinateRows([anchorFixture('A1', 1.5, 2.5, 'region-front')]);
  assert.equal(anchorRows.length, 1);
  assert.match(anchorRows[0]!, /A1/);
  assert.match(anchorRows[0]!, /1\.5/);
});

test('D: save validation refuses empty/invalid geometry before any callback', () => {
  const empty = validateSaveRequest([], []);
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? '' : empty.error, /safe area/);
  const badAnchors = validateSaveRequest(SQUARE, [
    anchorFixture('A1', 1, 2, 'region-front'),
    anchorFixture('A1', 3, 4, 'region-front'),
  ]);
  assert.equal(badAnchors.ok, false);
  const good = validateSaveRequest(SQUARE, [anchorFixture('A1', 1, 2, 'region-front')]);
  assert.equal(good.ok, true);
  if (!good.ok) return;
  // The payload is a deep copy: mutating it cannot touch caller state.
  good.result.safeArea[0]!.x = 999;
  assert.equal(SQUARE[0]!.x, 0);
});

test('D: the saver serialises saves, awaits async callbacks, and never rejects', async () => {
  const saver = new ProductSetupSaver();
  assert.equal(saver.isPending, false);
  assert.deepEqual(await saver.run(() => ({ ok: true })), { ok: true });
  assert.deepEqual(await saver.run(() => ({ ok: false, error: 'disk full' })), {
    ok: false,
    error: 'disk full',
  });
  assert.equal(saver.isPending, false);
  const rejected = await saver.run(() => Promise.reject(new Error('boom')));
  assert.equal(rejected.ok, false);
  assert.match(rejected.ok ? '' : rejected.error, /boom/);
  const thrown = await saver.run(() => {
    throw new Error('sync boom');
  });
  assert.equal(thrown.ok, false);
  assert.equal(saver.isPending, false);
  const malformed = await saver.run(() => undefined as unknown as { ok: true });
  assert.equal(malformed.ok, false);
});

test('D: overlapping saves are refused; the first task runs exactly once', async () => {
  const saver = new ProductSetupSaver();
  let calls = 0;
  let release!: (value: { ok: true }) => void;
  const gate = new Promise<{ ok: true }>((resolve) => {
    release = resolve;
  });
  const first = saver.run(() => {
    calls += 1;
    return gate;
  });
  assert.equal(saver.isPending, true);
  const refused = await saver.run(() => ({ ok: true }));
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.error, /already in progress/);
  release({ ok: true });
  assert.deepEqual(await first, { ok: true });
  assert.equal(calls, 1);
  assert.equal(saver.isPending, false);
  assert.deepEqual(await saver.run(() => ({ ok: true })), { ok: true });
});

// ---- Round 3: side in the identity key, synchronous save-pending ----

test('identity key includes the tab side: same-everything-except-side never shares a bucket', () => {
  const front = viewFixture({ side: 'front' });
  const twin = viewFixture({ side: 'back' });
  // Force every identity field except the side to match the front view.
  twin.photoId = front.photoId;
  twin.sourceRev = front.sourceRev;
  twin.photo = front.photo;
  twin.transform = front.transform ? { ...front.transform } : null;
  twin.scope = { ...front.scope, side: 'back' };
  twin.safeArea = front.safeArea;
  twin.anchors = front.anchors;
  assert.notEqual(viewIdentityKey(twin), viewIdentityKey(front));
  const store = createWorkspaceEditStore();
  const frontBucket = store.bucketFor(viewIdentityKey(front), () => ({
    safeArea: [],
    anchors: [anchorFixture('Front-only', 1, 2, 'region-front')],
    dirty: true,
  }));
  const backBucket = store.bucketFor(viewIdentityKey(twin), () => ({
    safeArea: [],
    anchors: [],
    dirty: false,
  }));
  assert.notEqual(backBucket, frontBucket);
  assert.equal(backBucket.anchors.length, 0);
  assert.equal(backBucket.dirty, false);
  assert.equal(frontBucket.anchors[0]!.name, 'Front-only');
});

test('save-pending marks synchronously at run() entry, before async work settles', async () => {
  const saver = new ProductSetupSaver();
  let release!: (value: { ok: true }) => void;
  const gate = new Promise<{ ok: true }>((resolve) => {
    release = resolve;
  });
  // No await before this assertion: pending must already be observable,
  // exactly what the click handler needs before its re-render.
  const pending = saver.run(() => gate);
  assert.equal(saver.isPending, true);
  release({ ok: true });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(saver.isPending, false);
});

test('a deferred async failure keeps the draft dirty with the exact status text', async () => {
  const saver = new ProductSetupSaver();
  let release!: (value: { ok: false; error: string }) => void;
  const gate = new Promise<{ ok: false; error: string }>((resolve) => {
    release = resolve;
  });
  const bucket = {
    safeArea: SQUARE.map((corner) => ({ ...corner })),
    anchors: [anchorFixture('A1', 1, 2, 'region-front')],
    dirty: true,
  };
  const validated = validateSaveRequest(bucket.safeArea, bucket.anchors);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const pending = saver.run(() => gate);
  assert.equal(saver.isPending, true);
  // Fail on a later tick, after the click-time re-render would have run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  release({ ok: false, error: 'late failure' });
  const outcome = await pending;
  assert.equal(saver.isPending, false);
  const status = applySaveOutcome(bucket, validated.result, 'Chest · Front', outcome);
  assert.equal(status, 'Save failed: late failure. Your edits are intact.');
  assert.equal(bucket.dirty, true);
  assert.equal(bucket.anchors.length, 1);
});

test('applySaveOutcome clears dirty only for an unchanged bucket', () => {
  const bucket = {
    safeArea: SQUARE.map((corner) => ({ ...corner })),
    anchors: [anchorFixture('A1', 1, 2, 'region-front')],
    dirty: true,
  };
  const validated = validateSaveRequest(bucket.safeArea, bucket.anchors);
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  const okStatus = applySaveOutcome(bucket, validated.result, 'Chest · Front', { ok: true });
  assert.match(okStatus, /Saved Chest · Front \(4 safe-area corners, 1 anchors\)/);
  assert.equal(bucket.dirty, false);
  // A mid-save edit diverges the bucket: success must not clobber it.
  const racing = {
    safeArea: SQUARE.map((corner) => ({ ...corner })),
    anchors: [anchorFixture('A1', 1, 2, 'region-front')],
    dirty: true,
  };
  const racingValidated = validateSaveRequest(racing.safeArea, racing.anchors);
  assert.equal(racingValidated.ok, true);
  if (!racingValidated.ok) return;
  racing.anchors = [...racing.anchors, anchorFixture('A2', 3, 4, 'region-front')];
  const diverged = applySaveOutcome(racing, racingValidated.result, 'Chest · Front', { ok: true });
  assert.match(diverged, /save again/);
  assert.equal(racing.dirty, true);
});
