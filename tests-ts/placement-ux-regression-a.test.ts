/**
 * Worker A regression coverage: unified candidate/committed edit
 * transaction, ratio policy in both axes, lock persistence, provisional
 * sizing, and partial-text locality (issues 6-7).
 *
 * Pure domain tests only: no DOM, no browser, no network, no Odoo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  beginEdit,
  cancelEdit,
  commitEdit,
  editDiffers,
  parseSizeField,
  policyForLock,
  provisionalSizeMm,
  resetToArtworkRatio,
  resizeCorner,
  scaleCandidate,
  setCandidateCentre,
  setCandidateHeight,
  setCandidateRotation,
  setCandidateWidth,
  toggleLock,
} from "../src/core/placement-manipulation/edit-transaction.js";

const BASE = { xMm: 0, yMm: 0, widthMm: 120, heightMm: 60, rotationDeg: 0 };

describe("unified edit transaction", () => {
  it("locked height edit scales width (both axes consult the lock)", () => {
    const locked = toggleLock(beginEdit(BASE), true);
    assert.equal(locked.policy.locked, true);
    assert.equal(locked.policy.ratio, 2);
    const next = setCandidateHeight(locked, 75);
    assert.equal(next.candidate.heightMm, 75);
    assert.equal(next.candidate.widthMm, 150);
  });

  it("locked width edit scales height", () => {
    const locked = toggleLock(beginEdit(BASE), true);
    const next = setCandidateWidth(locked, 60);
    assert.equal(next.candidate.widthMm, 60);
    assert.equal(next.candidate.heightMm, 30);
  });

  it("unlocked axes edit independently", () => {
    const next = setCandidateHeight(beginEdit(BASE), 75);
    assert.equal(next.candidate.heightMm, 75);
    assert.equal(next.candidate.widthMm, 120);
  });

  it("commit preserves the lock (Apply must not clear it)", () => {
    const locked = toggleLock(beginEdit(BASE), true);
    const edited = setCandidateHeight(locked, 75);
    const committed = commitEdit(edited);
    assert.equal(committed.widthMm, 150);
    assert.equal(committed.heightMm, 75);
    // Policy is caller-persisted and untouched by commit: re-edit stays locked.
    const reopened = beginEdit(committed, edited.policy);
    assert.equal(reopened.policy.locked, true);
    assert.equal(reopened.policy.ratio, 2);
    const again = setCandidateWidth(reopened, 60);
    assert.equal(again.candidate.heightMm, 30);
  });

  it("toggling the lock never rolls back geometry", () => {
    const edited = setCandidateWidth(beginEdit(BASE), 90);
    const before = { ...edited.candidate };
    const locked = toggleLock(edited, true);
    assert.deepEqual(locked.candidate, before);
    const unlocked = toggleLock(locked, false);
    assert.deepEqual(unlocked.candidate, before);
  });

  it("locked corner drag preserves the ratio", () => {
    const locked = toggleLock(beginEdit(BASE), true);
    const next = resizeCorner(locked, 2, { xMm: 200, yMm: 200 });
    assert.ok(editDiffers(next), "corner drag must change the candidate");
    const ratio = next.candidate.widthMm / next.candidate.heightMm;
    assert.ok(Math.abs(ratio - 2) < 1e-9, `ratio ${ratio} must stay 2`);
    assert.ok(next.candidate.widthMm >= 1 && next.candidate.heightMm >= 1);
  });

  it("unlocked corner drag stays free-form", () => {
    const next = resizeCorner(beginEdit(BASE), 2, { xMm: 400, yMm: 10 });
    const ratio = next.candidate.widthMm / next.candidate.heightMm;
    assert.ok(Math.abs(ratio - 2) > 0.5, `ratio ${ratio} must drift when unlocked`);
  });

  it("invalid partial text stays local and never commits", () => {
    assert.equal(parseSizeField(""), null);
    assert.equal(parseSizeField("   "), null);
    assert.equal(parseSizeField("12x"), null);
    assert.equal(parseSizeField("-"), null);
    assert.equal(parseSizeField("1e"), null);
    assert.equal(parseSizeField("60"), 60);
    // Non-finite field input leaves the candidate untouched.
    const edit = beginEdit(BASE);
    const untouched = setCandidateWidth(edit, Number.NaN);
    assert.deepEqual(untouched.candidate, edit.candidate);
  });

  it("cancel returns the committed base; commit returns the candidate", () => {
    const edited = setCandidateWidth(beginEdit(BASE), 90);
    assert.ok(editDiffers(edited));
    assert.deepEqual(cancelEdit(edited), { ...BASE, rotationDeg: 0 });
    assert.equal(commitEdit(edited).widthMm, 90);
    assert.ok(!editDiffers(beginEdit(BASE)));
  });

  it("rotation and centre edits ignore the lock", () => {
    const locked = toggleLock(beginEdit(BASE), true);
    const rotated = setCandidateRotation(locked, 45);
    assert.equal(rotated.candidate.rotationDeg, 45);
    assert.equal(rotated.candidate.widthMm, 120);
    const moved = setCandidateCentre(locked, 5, -7);
    assert.equal(moved.candidate.xMm, 5);
    assert.equal(moved.candidate.widthMm, 120);
  });

  it("uniform scale steps preserve the ratio", () => {
    const grown = scaleCandidate(beginEdit(BASE), 1.05);
    assert.equal(grown.candidate.widthMm, 126);
    assert.equal(grown.candidate.heightMm, 63);
  });

  it("reset-to-artwork-ratio is explicit and geometry-neutral", () => {
    const locked = toggleLock(beginEdit(BASE), true);
    const reset = resetToArtworkRatio(locked, 200, 50);
    assert.deepEqual(reset.candidate, locked.candidate);
    assert.equal(reset.policy.ratio, 4);
    const bad = resetToArtworkRatio(locked, 0, 50);
    assert.equal(bad.policy.ratio, locked.policy.ratio);
  });

  it("policyForLock captures the current placement ratio", () => {
    assert.deepEqual(policyForLock(BASE), { locked: true, ratio: 2 });
    assert.equal(policyForLock({ ...BASE, widthMm: 0 }).locked, false);
  });
});

describe("provisional sizing", () => {
  it("known millimetre sizes pass through", () => {
    assert.deepEqual(
      provisionalSizeMm({ spanX: 200, spanY: 200 }, 2, { widthMm: 120, heightMm: 60 }),
      { widthMm: 120, heightMm: 60 },
    );
  });

  it("unknown sizes fit the calibrated region preserving aspect", () => {
    const size = provisionalSizeMm({ spanX: 200, spanY: 160 }, 2, null)!;
    assert.ok(size !== null);
    assert.ok(Math.abs(size.widthMm / size.heightMm - 2) < 1e-9);
    assert.ok(size.widthMm <= 100 && size.heightMm <= 80);
    assert.ok(size.widthMm > 0 && size.heightMm > 0);
  });

  it("tall artwork fits by height", () => {
    const size = provisionalSizeMm({ spanX: 200, spanY: 160 }, 0.5, null)!;
    assert.ok(Math.abs(size.widthMm / size.heightMm - 0.5) < 1e-9);
    assert.ok(size.heightMm <= 80);
  });

  it("no aspect falls back to a bounded square; no span yields null", () => {
    assert.deepEqual(provisionalSizeMm({ spanX: 200, spanY: 160 }, null, null), {
      widthMm: 80,
      heightMm: 80,
    });
    assert.equal(provisionalSizeMm(null, 2, null), null);
    assert.equal(provisionalSizeMm({ spanX: 0, spanY: 10 }, 2, null), null);
  });
});
