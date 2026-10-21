# Operator pilot checklist — Logo Station end-to-end (physical)

This checklist is for a human operator trying the Logo Station flow end to end
with **real intent**: real products, real measurements, a real decision about a
customer return. The scripted suite (`docs/release-acceptance.md`) only proves
that synthetic journeys run offline without errors. It proves nothing about
physical truth. This page lists what must be true, what is unknown, and who
signs off — so a pilot produces evidence instead of assumptions.

Status of this checklist itself: **UNTESTED with operators.** No pilot run has
been performed. Every section below is a proposal awaiting its first real use.

Conventions: each section ends with **Unknowns** (write answers down during the
pilot) and **Sign-off** (who must confirm before proceeding). Anything marked
**NOT ESTABLISHED** has no evidence anywhere in the project — do not treat the
synthetic fixtures as substitutes.

## 1. Preparation — products, variants, logos, artwork

Before opening the Builder, assemble the job inputs:

- [ ] Identify the exact product(s) and variant(s) for this job (names, sizes,
      colours). Record where each definition comes from (measured garment,
      supplier sheet, guess).
- [ ] Collect every logo: original artwork files (PNG/JPEG/WebP/SVG), who
      supplied each, and which product/variant/region each logo belongs to.
- [ ] Confirm how many placements the job needs, including the **zero-placement**
      case (a configuration with no logos must stay representable).
- [ ] Open `dist/internal-builder.html` offline and use **Create a project**
      (synthetic catalogue) or **Open an existing project** for the prepared
      definitions. Confirm the issue starts at revision 1 with a fresh project ID.

**Unknowns:** Are the bundled example products an adequate stand-in for the
operator's real products? What artwork formats do customers actually supply?
Who owns the artwork-approval decision?

**Sign-off:** Operator confirms the product/variant/logo list matches the real
job sheet. **NOT ESTABLISHED:** no real product catalogue exists; all bundled
definitions are explicitly synthetic.

## 2. Calibration authoring — real measurements

Calibration turns model/photo geometry into millimetres. This is the step where
a wrong number becomes a wrong garment, so measure twice.

- [ ] For each calibrated region, pick anchors on the actual product
      representation and record **at least one known distance** measured with a
      ruler or caliper on the physical item (not estimated from pixels).
- [ ] Record for every measurement: tool used (ruler/caliper/model number),
      measured value in mm, who measured, date, and estimated tolerance
      (e.g. ±0.5 mm). The tooling stores numbers, not this provenance — keep a
      written log alongside.
- [ ] Check the fit result: a stale or inconsistent fit must be resolved
      (re-measure, re-pick anchors), never exported as-is. Pending-review
      bundles are drafts, never approvals.
- [ ] For planar regions, verify the frame axes (X red / Y green, 100 mm) sit
      where you expect on the preview, and that safe polygons plus exclusions
      match the physical keep-out areas (seams, zips, pockets).

**Unknowns:** What tolerance is acceptable per product type? How are curved
surfaces handled — flat-quads on a curved garment are **NOT ESTABLISHED** to
render or measure correctly (the jacket test model showed planar footprints
passing while logos were not visibly seated). What is the datum convention on
the factory floor (which edge is the origin, which way is +Y)?

**Sign-off:** A second person re-measures at least one known distance per
region and agrees within the recorded tolerance. No calibration ships on a
single person's numbers.

## 3. Placement review — millimetres on the product

- [ ] For each placement, read back centre x/y, width/height and clockwise
      rotation in mm from the review screen and compare against the job sheet —
      do not trust the picture alone.
- [ ] Check every footprint verdict: `fits:false` placements stay pending and
      must be moved, resized, or explicitly rejected — never confirmed as-is.
- [ ] Confirm repeated logos and multi-region placements each carry the intended
      artwork reference (references are inert text labels, not rendered artwork).
- [ ] Confirm the customer confirmation step identifies exactly what was
      confirmed (product definitions, artwork, placements, instructions). Note:
      confirmation is unauthenticated bookkeeping — it does **not** identify who
      clicked, and it is **not** an approval.

**Unknowns:** Do customers understand the mm diagrams without guidance? Are
inert footprint boxes (no real artwork rendering) sufficient for a customer to
confirm? What happens on a return with zero placements?

**Sign-off:** Operator confirms every placement's numbers match the job sheet;
reviewer confirms no `fits:false` placement was confirmed.

## 4. Candidate review + operation document printing

- [ ] In **Review a return**, load the saved office copy first, then the
      customer return, and read the full diff (products, placements,
      instructions, confirmation/fit status) before any decision.
- [ ] Open **Preview operation document**: check the business logo
      names/codes, actual width×height mm, readable side/position, method,
      selected anchor-to-edge dimensions with honest arrows/labels, and the
      department operational instructions. Confirm NO digest, revision,
      config/logo/frame/calibration ids, appendix or customer notes print
      on the sheet.
- [ ] **Print / save PDF** via the browser dialog and inspect the page:
      branded header, job identity, draft badge only when unfinished,
      no clipped photos/panels, dimension arrows meeting the chosen
      anchor/logo edges. The ordinary one-product/two-logo job prints
      exactly one A4 landscape page. Remember the sheet never presents
      itself as approved production instructions — approval lives in the
      review UI, not on the sheet.
- [ ] Save the minimal operator JSON and verify it carries the same
      business data with no ids or digests (the technical candidate JSON
      remains the advanced diagnostic download).

**Unknowns:** Native print-dialog settings and printer scaling are unvalidated —
does the printed A4 match the on-screen mm diagrams? Is the operation document
understandable to whoever sews/presses the garment? What does the ticket/BoM
attachment workflow actually require (filenames, formats)?

**Sign-off:** Reviewer initials the printed PDF and the candidate JSON digest
as "matches the reviewed return", explicitly noting pending-review status.

## 5. Return handoff

- [ ] Save the office copy (issued baseline) **before closing the browser** —
      browser memory is lost on reload and there is no server copy.
- [ ] Deliver the customer file manually (the Builder never sends anything).
      Record how it was sent (email, USB, shared drive) and to whom.
- [ ] Attach the returned project, candidate JSON and checked PDF to the
      ticket/BoM manually. The Builder performs no Odoo writes.
- [ ] File the acceptance report folder (`docs/release-acceptance.md` §5)
      with the job record.

**Unknowns:** Who is responsible for the office copy if the operator's machine
fails? What is the retention policy for returns and baselines? How are revised
proposals tracked against old revisions?

**Sign-off:** Handoff owner confirms office copy saved, customer file sent, and
ticket/BoM attachments recorded.

## Explicitly NOT ESTABLISHED (do not claim otherwise)

- Real garment dimensions for any FlexiTog product; every bundled number is synthetic.
- Curved-surface logo behaviour (placement on, and rendering over, 3D curvature).
- Production approval by anyone, at any step; all outputs are pending-review drafts.
- Windows Chrome/Edge offline delivery (`docs/release-acceptance.md` gate UNTESTED).
- That any operator can complete this flow without introduction (no usability
  evidence with representative operators exists).
- Odoo integration: no writes, no attachment automation, no finalized mapping.
