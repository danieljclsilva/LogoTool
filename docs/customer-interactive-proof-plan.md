# Customer interactive proof: implementation brief

Updated 29 October 2026 following the user's clarification.

## Product goal

Replace the static branded PDF approval exchange with a limited interactive
branded proof. The customer sees their prepared product with the actual logos,
can make allowed placement changes and provide instructions, then returns the
exact reviewed version. The customer is not reviewing an operational document
and should not need to understand calibration, coordinate frames, production
methods, setup evidence or internal approval workflow.

The existing physical/domain contracts remain authoritative. A minimal interface
must not invent dimensions, waive safe-area constraints or imply production
approval. Operator setup determines the allowed areas, artwork, methods and
physical reference. Customer edits are constrained to that prepared scope.

## Revised interpretation of the usability findings

The first question is whether a non-technical person can see and edit the
expected branded garment. An abstract measured-area diagram and a separate bare
3D model do not satisfy this requirement, even if the returned numeric data is
valid. Review is the continuation of that same visual workspace, not a second
technical/document screen.

The highest priorities are:

1. The same validated model/photo mapping and artwork rendering must work before
   issue, in the customer package, and after the returned changes are adopted.
2. Placement and project instructions must be first-class customer input and
   have explicit before/after comparisons in the office return review. A note-only
   return must never look like an unchanged size comparison.
3. The normal customer interface should expose only garment views, named logos,
   constrained movement/size and instructions. Other capabilities remain optional
   or operator-owned, with no overwhelming wall of controls.
4. Navigation, edit feedback and final confirmation must be clear, stable and
   scoped to the exact reviewed revision. Production documents are downstream.

## Intended customer experience

- Open directly onto the prepared garment proof with applied logos and sensible
  framing. Use a calibrated photo or model when available. Clearly label a
  fallback rather than pretending an uncalibrated projection is authoritative.
- Provide obvious Front/Back or supplied named-view controls and readable logo
  cards/chips. Hide one-option selectors and internal identifiers.
- Select a logo on the garment or in its named card; drag inside its approved
  area. Resize with artwork proportions protected by default where valid.
  Keep rotation/precise values secondary unless needed for the job.
- Keep the proof visible while editing, including on narrow screens. Normal
  editing must not expose calibration or allow changing preparation constraints.
- Put a short placement instruction field next to the selected logo and a clear
  place for overall requests. Distinguish requests from department-authorized
  manufacturing instructions.
- Show both views/placements and every requested change in review. Preserve
  draft/reopen and revision-specific confirmation. The returned file is local;
  the application does not send email or upload customer data.

## Delivery phases and acceptance

### Foundation

Share the existing validated model scene resolver instead of duplicating
coordinate math. Preserve correctly scoped, asset-bound mapping evidence through
package selection/issue/return. Validate scope, asset identity, calibration
version and agreement with current physical regions. Unselected/stale/unrelated
attachments must not leak into the issue. Show all meaningful instruction,
method, position, size and rotation differences on customer return.

### Limited customer workspace

Reuse the existing rendering, physical edit transactions and validation with a
customer mode. Avoid importing the full operator toolbar or creating another
incompatible canvas/geometry implementation. Preserve supported photo/image
flows, multi-product/variant projects and 0..N placements. The first view and
primary actions should explain the visual task without technical knowledge.

### Independent validation

Use synthetic offline regression tests for exact mapping retention across issue,
customer edit, draft/reopen and adoption; applied artwork rendering; real pointer
move/resize; rejected invalid edits; instruction-only differences; stale/forged
mapping; scope isolation and revision confirmation. Run typecheck, unit/domain
suite and relevant built-file Playwright checks in bundled Chromium and installed
Chrome. Inspect desktop and narrow layouts visually, then repeat the private
real-jacket workflow without uploading or committing customer assets.

A passing numeric round trip alone is insufficient. The visible proof must
remain recognizable and editable throughout. Record the actual OS/browser,
viewport, offline status and console/network health. Actual Windows Chrome/Edge
remains a delivery validation requirement; macOS results cannot satisfy it.

## Implementation boundaries

Follow AGENTS.md and the configurator specification. Preserve domain independence,
millimetres, explicit frames/calibration and original bytes. No new Odoo/schema
assumptions or live calls. No external publication or customer file sending.
OpenCode Contributor implementation is independently reviewed and validated by
Codex. Changes remain uncommitted until the user authorizes commit/push.


## Implemented result and follow-up

The shared mapping resolver, evidence retention, customer model adapter, named
logo selection, prominent placement instructions, compact optional controls and
explicit office instruction comparisons are implemented. Synthetic offline
acceptance and the private garment round trip are documented in
[offline-testing.md](offline-testing.md#interactive-customer-garment-proof--2026-10-30).

The customer can move and proportionally resize prepared artwork, inspect
Front/Back, add requests, confirm the exact version and save a local return.
Out-of-area pointer edits roll back. Save/review/confirmation stay blocked while
a model edit is in progress. The measured diagram remains available under
More actions; calibration and safe-area preparation remain operator-owned.

Usability follow-up should use a real non-technical customer and a real touch
device. In particular, verify whether selecting a back logo should also orient
the model, using an explicitly prepared view association rather than guessing
from filenames. Physical garment calibration and Windows offline delivery
validation remain required. Existing unrelated operator regression failures are
recorded with unchanged-baseline evidence instead of being hidden.
