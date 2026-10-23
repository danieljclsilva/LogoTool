# Visual workflow simplification — implementation specification

Date: 23 October 2026. Baseline: `a087f2f` on `main`.

## Outcome and authority

The operation sheet is the tool's purpose. Staff prepare a real product visually,
send a simple customer editor, reopen the customer's choices, and add the logo
department's measurements/instructions to the branded sheet. Technical complexity
belongs in implementation, not the normal operator path.

This document covers all nine proposed simplifications. It is a delivery backlog,
not a claim that every item can safely ship overnight. The user authorizes local
implementation through OpenCode, independent Codex review, and committing/pushing
completed changes. Hard stop: **23 October 2026, 06:45 Europe/Amsterdam (CEST,
UTC+02:00; 04:45 UTC)**. No hosting, Pages activation, external uploads, installs,
live Odoo, or changes to existing publishing settings are authorized.

## Existing behavior to preserve

- One staff entry: `dist/station/Logo Station.html` and its assets. All delivered
  customer output works through offline `file://` without server/CDN/install.
- Empty release start; no embedded demo catalogue/products/logos. Tests use
  explicitly supplied synthetic fixtures; real jacket/EDEKA evidence stays private.
- Physical geometry is millimetres in explicit region frames/calibration; pixels
  and mesh transforms are presentation. Reuse evaluated affine photo mapping.
  A real reference with sufficient known lengths remains necessary. No inferred
  scale, fabricated anchors, mesh projection, or production approval.
- Different categories, variants, zero to many placements, and relevant actual
  views; both self-contained HTML and hybrid ZIP formats remain supported.
- Original assets and evidence remain intact. Package integrity, immutable issued
  baselines, revision/confirmation invalidation, deterministic production exports,
  minimal operator JSON and accepted adaptive branded sheet remain authoritative.
- Customer notes are context; departmental operational instructions are authored
  by staff and are the only instructions printed as operational instructions.

## Target operator journey

1. Create an empty job or open its existing file.
2. Add product files together. Assign photos to Front/Back/Left/Right visually.
3. Select a product/view. Draw safe area and place anchors on the photo. Supply
   missing known physical reference lengths only when needed.
4. Add logos on the intended view; adjust using direct manipulation, with exact
   millimetres available contextually. Select relevant product options once.
5. Enter customer/job details and create the customer file. HTML is the default;
   ZIP remains secondary. Keep an office copy.
6. Open the customer return in the same station. Choose an anchor and logo edge
   visually to define each operation dimension; write departmental instructions.
7. Inspect the live branded sheet and save PDF/operator data.

## Delivery order and time budget

| Tranche | Scope | Completion boundary |
|---|---|---|
| A — first | Add/replace side photos on an existing product | In-place asset intake, binding invalidation, safe persistence and roundtrip |
| B — second | Visual anchor-to-logo-edge dimensions | Complete usable visual dimension interaction and correct printed/exported values |
| C — third | Contextual workspace controls and scoped draft safety | Selected-object controls, keyboard access, no silent draft loss |
| D — optional | Batch photo intake with thumbnail side assignment | Atomic batch validation and clear collision handling |
| E — optional | Product cards and conditional options | Same selection/subset semantics, no hidden or dropped configurations |
| F — optional | Automatic setup save with Undo | Serialized validated persistence, recoverable history and dirty/failure feedback |
| G — optional | Drop logos onto views and duplicate | Real domain placement validation and exact revision invalidation |
| H — optional | Live operation-sheet preview | Debounced shared renderer, staff-only instructions, readable responsive layout |
| I — audit | Single primary customer-file action | Already largely implemented; remove only verified remaining duplicate choices |

Start A and B with bounded non-overlapping owners after interface investigation.
Integrate/validate one tranche at a time; do not carry speculative changes into
shared files ahead of a verified checkpoint. C follows after A/B unless one is
blocked. Optional tranches start only with a realistic validation window.

At **06:00 CEST**, stop starting new tranches. By **06:15**, freeze implementation
and finish/revert only the lead's incomplete changes to the last complete
checkpoint. Reserve **06:15–06:35** for independent checks and corrections limited
to completed scope. By **06:35**, Codex commits and pushes the completed result.
By **06:45**, all agents/builds stop; report completed, deferred and unverified
items. If time is short, ship less. Never disable validation to meet the deadline.

## A. In-place product photos

### User experience

An existing product has an obvious Add view action adjacent to its view tabs.
The operator chooses an image and assigns its named side using a thumbnail.
Replacing an existing side is explicit and identifies which side is replaced.
Do not require recreating a model-only product to attach a photo. Adding a photo
must retain its original model, other photos, logos, options and measured regions.

### Contracts and implementation

Investigate intake in `src/ui/internal-builder/main.ts`, presentation manifest,
photo mappings and package APIs before writing. Extract a bounded pure intake
service where practical; browser file reading/decoding remains at the UI boundary.
Do not add another HTML entry or a second package format.

- Target a stable product ID and explicit variant scope (product-wide versus one
  variant), plus named side. Capture source session identity before async reading.
- Validate size, raster signature and decoded dimensions before mutation. Preserve
  exact original bytes using collision-safe asset paths; no image conversion.
- Build candidate manifest/assets/mappings, package and reparse, then commit once.
  Failed, stale, cancelled or partially invalid operations keep the prior project.
- Adding a previously absent side starts unmeasured. Do not copy front geometry
  onto a back/left/right view. Retain all unrelated mappings/regions.
- Replacing a photo never silently reuses its old pixel binding. Invalidate only
  mappings and visual drafts bound to the replaced photo/scope; retain canonical
  millimetre geometry and unrelated mappings. Clearly request a new visual reference
  setup before measured authoring/overlays on the replacement.
- Avoid product-wide/variant override shadowing: test both fallback and explicit
  variant records. Preserve original assets as evidence even when superseded.
- Mutations occur in preparation. Issued baseline/returned project calibration
  cannot be edited through return review; preserve its immutability guarantees.
- Saving/reopening master and issuing both formats must retain the new view,
  original model bytes, geometry, anchors and correct mapping eligibility.

### Acceptance

Upload a model-only synthetic product, add a front photo to that SAME product,
measure it, add back, save/reopen and issue/reopen both formats. Product count/ID
and original model digest remain unchanged. Replace front; stale mapping/drafts
must not survive while back's binding does. Exercise malformed/oversized files,
cancel, source replacement during async intake, variant overrides and side collision.

## B. Visual operation dimensions

### User experience

In staff operation authoring, choose Add measurement, click an existing named
anchor on the product, then choose an actual logo edge. Show a proposed dimension
with clear black exterior witness/arrow lines and readable value. Horizontal or
vertical is selected explicitly where ambiguous; labels use business names.
Escape cancels an unfinished selection; Delete/removal is reversible until saved.
Keep accessible keyboard/select fallbacks under contextual controls/Advanced.

### Contracts and implementation

Use existing dimension bindings (`logoRef`, `anchorId`, edge, convention), existing
operation draft serialization and the same core edge-to-anchor arithmetic as the
sheet. Do not introduce a pixel-distance export, alternate rounding algorithm or
unversioned production schema. Reuse mapped artwork corners and orientation.

- Pointer hit targets represent the actual mapped anchor/artwork edge. Coordinates
  select identities; the dimension is computed from canonical millimetres.
- Rotated artwork uses the existing physical edge/extent convention. Supporting
  line extension is explicit and matches printed arrows; no nearest-pixel shortcut.
- Horizontal binds only compatible left/right edges; vertical only top/bottom.
  If the current mapping cannot represent a target honestly, retain the accessible
  physical selector fallback and explain the missing reference locally.
- A finite, in-scope anchor and valid logo edge are required before commit.
  View/variant/configuration changes cancel partial selection and never bind to
  another side's anchor or stale placement. Zero placements shows a useful empty
  state rather than fake artwork.
- Keep arbitrary numbers of dimensions and logos. A completed binding appears in
  both the visual diagram and concise removable measurement list.
- Customer editing cannot author departmental measurement bindings/instructions.
  Changing a dimension does not forge customer confirmation or production approval.
- Actual PDF and operator JSON derive from the existing shared operation model;
  retain branded adaptive pagination and readable exterior dimensions.

### Acceptance

Front/back two distinct logos and anchors: create two dimensions per logo by real
pointer/keyboard actions; inspect exact serialized bindings, mm values, printable
arrows and minimal JSON. Test rotated logo, incompatible edge/convention, missing
mapping, no anchors, 0/1/3+ placements, Escape, delete, view switch and draft reopen.
Actual PDF must remain readable at normal A4 size, not just have a matching DOM
count or one-page assertion. Preserve the accepted real EDEKA trial geometry.

## C. Contextual controls and draft safety

Select an anchor, safe-area vertex or logo to show its name/remove/precision
controls. Hide irrelevant lists and repeated hints while keeping discoverable
tool labels, focused-item description and keyboard navigation. A shared region
must state its effect on other options before saving.

Inventory the current keyed edit store and `sourceRev`/photo/transform identities.
Switching side/product/variant must either restore the correct scoped draft or
explicitly protect unsaved work; never silently discard it or apply it elsewhere.
Prune drafts only for real source-session replacement, removed assets/scopes or
binding/calibration changes. Avoid retaining obsolete drafts across project reopen.
Tests must distinguish saved geometry, unsaved scoped edits, cancelled drawing and
pending async saves. Retain atomic save acknowledgements and invalid-edit recovery.

## D. Batch intake and thumbnail assignment

Accept multiple raster files and at most one model per intake transaction. Show
thumbnail cards with side assignments, optional human labels and remove/replace.
No filename heuristic silently assigns a side; suggestions require operator
confirmation. Prevent duplicate side/scope assignments. Preserve exact files;
validate the entire batch before committing. Support adding to an existing product
through A's service and creating a new product through the same validated service.
File input, keyboard side selectors and drag/drop are equivalent accessible paths.

## E. Product cards

Replace nested selection rows with thumbnail/name cards. A card's include control
is separate from opening its workspace. Single-option products do not demand a
second redundant decision; multi-option products reveal their actual choices.
Use human fallback labels, never generated IDs. Preserve ordinary default applicable
configuration selection and deliberate advanced subsets. Do not equate product
selection with selecting every configuration after a user deliberately narrowed it.
Keep logo counts and issue summary derived from the exact selection contract.

## F. Automatic setup save and Undo

This is optional until atomic manual-save behavior is proven in the new flows.
Completed valid edits may save automatically after a short debounce; pointer
movement, incomplete polygons and unfinished names must not commit. Reuse the
serialized commit queue and stale-session guards. Show Saving/Saved/Unable to save
beside the workspace; preserve failed dirty edits and offer Retry. Autosave means
the current local session/master content, not durable disk storage: never claim
browser reload safety without a real persisted/reopened master.

Undo/Redo stores bounded scoped domain snapshots or commands, not screen pixels.
Group one drag into one undo step; keep photo replacement/scale changes separate.
Undo must pass the same validator and serialize through the same queue. Do not undo
into another project session, invalidate immutable baselines, or recreate missing
asset references. Warn before closing/replacing a source with unsaved/failed edits.

## G. Direct logo placement and duplication

Artwork dropped on a mapped product view selects the correct product/option/region
and opens only required method/width input. Pixel dimensions determine aspect ratio
only; never physical size. If no permitted method/known physical width exists, ask
for it. Unmapped views offer the reference setup route rather than fake placement.
Pointer resize/rotate uses existing physical transforms and safe-area validation.
Duplicate creates a fresh collision-safe placement identity and preserves artwork,
size and method; validate the target region and let staff reposition. Do not quietly
move an unsafe duplicate into a supposedly approved position. All customer edits
use existing revision/confirmation invalidation and 0..N placement semantics.

## H. Live sheet preview

Use the existing operation view model and branded renderer, debounced on completed
valid department edits. A desktop split view keeps document and relevant controls
visible; narrow screens use a clear preview toggle. Render only relevant views,
all included logos and legitimate overflow pages; preserve print layout independent
of screen zoom. No second implementation of measurements or export. Protect focus,
scroll position and draft state; avoid re-creating WebGL viewers per keystroke.
Customer notes remain visibly distinct read-only context and never auto-print.

## I. Customer delivery action audit

The baseline already defaults to self-contained HTML and places ZIP in More options.
Do not redo that behavior. Audit for remaining redundant primary actions, retain
Save office copy and Save customer file as distinct purposes, and ensure both
outputs open offline and roundtrip equivalently. No automatic email/upload action.

## Ownership and integration

Codex coordinates and independently approves. A fresh OpenCode v2 lead uses exact
`opencode-go/muse-spark-1.3-contributor`; previous completed lead is stopped and its
older duplicate chain remains HOLD. Before workers start, lead records a bounded
ownership map, interfaces, dependencies and completion tests in the task plan.

Suggested split: A worker owns new photo-intake core/helper module + unit tests;
B worker owns bounded visual-measurement module + pure tests. Lead exclusively
owns shared `internal-builder/main.ts`, `template.html`, integration/e2e/docs.
Workers preserve others' changes; no nested agents without lead approval. Only
independent tasks run concurrently. One owner runs builds/tests at a time.

Each tranche handoff includes changed paths, exact commands/exits, screenshots,
known limitations and a complete/incomplete manifest. Root pauses writes for
validation. Only Codex stages/commits/pushes. Maintain a tested checkpoint patch
or equivalent recoverable artifact before starting the next tranche; if incomplete
work shares files, lead must remove only its own unfinished diff and preserve all
completed/root/user edits. No `reset --hard`, destructive clean, force push or
blanket checkout. No incomplete placeholders, disabled tests or hidden feature stubs.

## Verification matrix and evidence

Use actual repository commands: `npm run typecheck`, `npm test`; targeted repo-local
Playwright opens fresh copied station and generated outputs through offline
`file://`. Chromium then installed Chrome sequentially with `--workers=1`; report
real exit codes, OS/browser/version, viewport, zero console/page errors and HTTP(S)
requests. Missing branded Edge fails explicitly; macOS evidence is not Windows
acceptance. Full suite once if broad integration warrants; after focused corrections
repeat only affected checks. No unbounded retries or pipe-to-tail masking failures.

Capture meaningful desktop and narrow screenshots. Validate actual saved packages,
asset digests, bindings, reopened drafts and operator JSON, not only UI messages.
Render actual PDF pages and inspect labels/arrows at normal print size. At a final
completed checkpoint repeat private real jacket/two-EDEKA workflow in fullscreen
native Chrome with DevTools closed where accessible, preserving original files.
Synthetic tracked tests only; private evidence remains ignored/local.

## Completion and deferred work

Update this document's delivery status and operator guide for shipped behavior.
Task-local progress/report records the latest completed checkpoint and remaining
tranches for resumption. Final user report names commits/push result, completed
features, deferred items and concrete failures/gaps. Physical accuracy/calibration,
mesh projection, operator approval and Windows/Edge acceptance remain unverified
unless actual new evidence establishes them. Disable scheduled wakes at completion
or the hard deadline, even when optional backlog remains.

## Delivery status

- Specification: written; implementation starts with A/B.
- A: independently reviewed and validated; ready for checkpoint commit. In-place
  side photos retain original assets/model and invalidate only their own mapping;
  stale customer outputs require regeneration. Root typecheck/unit working tree
  671 tests (657 baseline+A plus 14 parked B unit tests), six affected offline
  browser checks each on Chromium and Chrome pass. Thumbnail/batch assignment
  remains in D; this checkpoint uses explicit side/scope controls.
- B: Complete and independently validated: photo-based anchor/edge picks, keyboard/manual fallback, scoped cancellation, draft roundtrip and unchanged printed/exported millimetres.
  Constant-CSS-px markers (screen-CTM + ResizeObserver, bbox minimums
  asserted at desktop/narrow/native-2000px), direct marker selection with
  strict blank-surface gating, Save measurement vs Add another labels.
  Same green matrix; evidence refreshed.
- C–H: pending implementation/review.
- I: baseline largely satisfies it; audit pending.
