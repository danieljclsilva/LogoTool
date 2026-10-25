# Operator workflow implementation specification

Date: 25 October 2026. UX owner: Codex. Implementation: OpenCode lead using
`opencode-go/muse-spark-1.3-contributor`. This is the agreed implementation
contract, not permission to invent additional product flows.

## 1. Outcome and boundaries

An operator can create/open a job, add calibrated products and logos, set
0..N placements, review the actual operational document, and print/save it
without issuing a customer file, importing a customer return, or inventing
customer confirmation. Customer approval is an optional branch. Both routes
use the same canonical project geometry and shared operation-document renderer.

Preserve all existing uncommitted intake/calibration work. Preserve original
assets, legacy saved-project readers, flexible named views, exact mm/frame
geometry, deterministic packages and offline file:// operation. No new
production/Odoo schema finalization, no live Odoo, installs, uploads, publishing,
commits or pushes. No new UI framework, external fonts, CDN, or invented data.
3D placement remains limited to supported planar mappings: use the calibrated
mm diagram when a truthful mesh overlay is unavailable. Do not fake projection.

## 2. Navigation and visual structure (exact)

Use the existing FlexiTog header, fonts, colours, spacing and button styles.
No rebrand, illustration, new dashboard or decorative cards. White background,
existing red primary buttons, existing blue focus ring, existing error colour.

Header: Logo Station at left; secondary actions `Save job`, `Open job`,
`New job` at right. A single persistence line below reads
`Changes are held in this browser. Save job to keep them.` when dirty, and
`Job file download started. Keep the downloaded file to reopen this job.`
after download. Never claim a download was saved to disk or an autosave occurred.

Empty landing: heading `Prepare an operational document`, one sentence
`Create a job or open a saved job to begin.`, primary `Create job`, secondary
`Open job`, secondary link `Open customer response`. No empty workspace,
product list, document preview or duplicated help message on the landing.

After create/open: ONE three-step navigation, labels exactly:
`1 Prepare job` → `2 Set logo placements` → `3 Review document`.
No parallel Prepare-project/Review-return workflows and no four-step customer
packaging wizard in the normal path. Existing compatibility hooks may be
retained internally but must not expose a second operator workflow.
Back/step tabs preserve state and never generate files or reset a project.
Forward tabs enforce the same gates as primary actions and focus the first
specific unresolved field. Browser Back is not repurposed to lose edits.

Desktop >= 1000 px: existing max-width shell; main content ~2/3, contextual
rail ~1/3, gap 32px. At <= 820 px stack stage first, controls second, actions
last; no horizontal page scroll. Between 821–999 px fluid columns may shrink.
No sticky element covers canvas or a focused field. Buttons minimum 44px tall,
normal text >=14px, form labels always visible. Each step has one red primary
progress action; Save/Open remain secondary. Existing full-screen product
setup may be a subview, not another top-level step.

## 3. Step 1: Prepare job

Heading `Prepare the job`. Intro `Add the products and artwork for this job.`
Order: Customer + Job reference + Prepared by (three short inputs), Products,
Logos. Names/refs may remain blank during setup; review requires Customer and
Job reference. Prepared by is optional internally and required for issuing a
customer file only if the current issue contract requires it. IDs never appear
as normal editable fields. No duplicated Customer fields in later steps.

Products reuse the current explicit Images/3D intake, arbitrary named views,
Add product and set up action, and calibrated product workspace. First empty
product section shows intake open once. After products exist, `Add product`
opens it; avoid showing all intake and editing controls at once. New product
opens its setup subview directly; `Done with product setup` returns to Step 1,
preserving unsaved staged geometry and clearly offering Save setup before
leaving if dirty. Do not say staged geometry was saved without acknowledgement.

Each product card: thumbnail/model icon, product name, option count only when
>1, inclusion checkbox labelled `Include [name]`, status, and `Set up`.
Status is the first applicable: `Needs measurements`, `Needs safe areas`,
`Setup saved`. Setup saved means configuration completeness, NEVER physical
production approval. Optional label alongside workspace:
`Measurements are provisional until physically checked.`
Menu `More` contains replace media/remove product only where supported; do
not silently drop placed logos. Removing a product with placements requires
explicit confirmation naming affected placement count; cancellation preserves
everything. Preserve unselected products in the editable job, omit them only
from deliberately scoped issue/document outputs. Options use human labels;
single-option selectors are hidden.

Logos: preview + name cards, `Add logo` chooser, Replace/Remove in More.
Use exact original artwork bytes and existing bounds/validation. Multiple and
zero logos are valid. Uploading a logo does not create a placement or a product.
Never ask operator to choose artwork bbox sizes in pixels. Removing artwork
used by placements must explain/refuse or explicitly remove its dependent
placements with confirmation; no dangling references.

Primary `Set logo placements`: enabled with at least one included product and
structurally valid job; product calibration incompleteness is shown on Step 2,
not a reason to trap the operator here. If none included, inline
`Include at least one product to continue.` No generic banner repetition.

## 4. Product setup terminology

Retain approved two-click image/model calibration and named safe-area setup.
Normal labels: `Reference measurement`, `Pick point A`, `Pick point B`,
`Distance (mm)`, `Set scale`, `Safe areas`, `Add safe area`, `Save setup`.
Explain once: `Mark two points and enter their real straight-line distance.`
Image-mode flat/front-on assumption and 3D chord/planar limits remain concise
and visible near calibration. Do not remove safety semantics for prettier UI.

Distinguish calibration from operation measurements: calibration is
`Reference measurement`; anchor-to-logo operational distance is
`Placement measurement`. Named landmarks may retain `Anchor` inside setup.
Normal setup never exposes JSON, raw vectors, matrix coefficients, hashes,
manual IDs, side buckets or schema versions. Existing advanced tools remain
in a collapsed `Advanced` disclosure. Images and 3D retain separate visibility
buttons for reference anchors, safe areas and actual product geometry.

## 5. Step 2: Set logo placements

Heading `Set logo placements`. Top row Product selector (hide if only one),
Option selector (hide if only one), named view tabs where Images has >1.
For a model, camera controls inspect the existing model; when editing on a
planar diagram, label `Measured placement diagram` and allow `View model`.
Do not make photo upload mandatory in model mode or invent 3D draping.

Main stage shows product with calibrated overlays where supported; otherwise
the authoritative region-mm diagram. Never use pixels/model bounds as scale.
Show named safe areas. Click a placed logo selects it; pointer gestures for
logo movement and camera orbit are distinct and labelled. Drag uses existing
inverse mapping/geometry behavior; cannot change stored units under zoom.

Rail order: `Placements` list; selected-placement fields; validation message;
secondary `Send for customer approval`; primary `Review document`; Back.
Placement list row: artwork thumbnail/name, safe-area name, concise physical
size. Never label placement identity with raw UUID. Stable placement IDs allow
multiple placements of the same artwork. Add action `Add logo placement`.
No active placement: explanatory empty state + Add action; no disabled wall
of numeric inputs. If no logos exist: `Add artwork before adding a placement.`
with link `Add logo` returning/focusing the correct Step 1 control.

Add action opens a small inline form (no nested modal): Logo, Safe area,
Width (mm), Height (mm), Method, primary `Add placement`, `Cancel`.
Only current product/option's current configured safe areas appear. Empty/
retired regions cannot be selected as valid targets. Method choices come
from that region's existing allowedMethods; one choice is shown as text.
If artwork has explicit known physical dimensions, prefill those; otherwise
require width/height (optionally use artwork aspect ratio only AFTER a width
is deliberately entered and Keep proportions chosen). Never invent mm sizes.
Starting position is the existing validated region-centre convention; if the
footprint does not fit, show that result and allow correction as a draft,
without claiming a valid placement. No auto-shrink or auto-reposition.

Selected-placement normal controls, in this order:
- Logo display name and named Safe area select.
- Width (mm), Height (mm), `Keep proportions` (optional aspect constraint).
- Rotation (degrees).
- `Placement measurements` summary and `Add measurement`.
- Secondary `Duplicate placement`, `Remove placement`.
- Inline `Apply changes` visible/enabled only while form edits are pending.
`Precise position` disclosure contains X centre/Y centre (mm) and coordinate
convention explanation. Method is normal only if multiple choices exist.
Per-logo technique settings/colour/code use existing authoring contracts under
`Production details`, not required jargon in placement geometry controls.

Operational measurement form: Anchor (human name), Logo edge (left/right/top/
bottom), Direction (Horizontal/Vertical/Shortest). Reuse existing compatible
edge/convention validation and visual picker. Show resulting mm distance.
Do not accept a horizontal/top-edge or vertical/left-edge mismatch. Missing
landmarks show `Set up an anchor on this product` → exact product setup scope.
Multiple measured rows per placement supported. No manual invented distances.

Duplicate copies selected artwork, region, method and exact mm geometry with
a fresh stable ID; selects the new copy. No implicit positional offset.
Remove deletes only selected placement, selects remaining first entry or empty.
Invalid fit message names the reason and object, e.g.
`[Logo] extends outside [Area]. Move it or reduce its size.` Use actual geometry
reason; do not assert pocket/seam causes unless data supports them.
For missing calibration: `Set up measurements for [Product] before placing a
logo.` + `Set up product`. For no current safe area: `Add a safe area for
[Product] before placing a logo.` + same scoped action. No broken selectors.

Zero placements are valid. Review explicitly says `No logo placements for
this option.` Never invent a required placement or suppress an included option.
`Review document` requires valid structures and no unapplied form edits; known
unsafe/incomplete placements may enter review with actionable issue list, but
cannot masquerade as complete. Editing/drag/apply invalidates generated
customer files, confirmations/review status per existing revision contracts,
preview/export caches and stale dimensions. Navigation alone changes none.

## 6. Step 3: Review document

Heading `Review operational document`. Main column ALWAYS contains the actual
shared operation-sheet renderer for the current canonical revision, with
artwork and named view references; no separate approximate preview. No preview
toggle or Send screen prerequisite. Preview refreshes after committed changes
without stealing focus or discarding dirty forms.

Rail, in order: job summary (Customer/Job/Product count/Placement count),
`Items to check`, `Operational instructions`, optional `Technique settings`,
primary `Print / save PDF`, secondary `Save job`, `Back to placements`.
Use the browser print dialog and existing A4 stylesheet. Do not silently
create a fake PDF download or claim native print settings are verified.

Operational instructions are staff-authored and shared with the output.
Customer notes remain clearly labelled read-only context and NEVER become
staff instructions automatically. Changing instruction text refreshes preview
on blur/debounce, updates dirty state, and persists on Save job; no extra
mandatory save button per text field. Avoid repainting focused input nodes.

Issue list contains only actual unresolved items, each with specific `Fix`
link selecting the affected product/option/placement or Step 1 identity field.
Blocking: missing customer/job reference; no included products; malformed
project/asset; placement without valid calibration/current configured area;
invalid footprint; missing physical dimensions/method; unapplied geometry edits.
Use existing operation-sheet missing-code/missing-binding signals as actionable
incomplete items (do not invent production rules or weaken validation).
`Print / save PDF` disabled for blocking/incomplete items; nearby reason points
to the first Fix action. A secondary `Print draft` is available for structurally
valid but incomplete jobs and uses the renderer's DRAFT/pending markings and
reasons. Never offer unmarked production-ready output from this provisional app.
A configured zero-placement option is informational and may print its explicit
no-placement statement. Physical-unverified status remains visible even when
all software checks pass; no production approval is conferred.

Clicking a placement summary in document preview (or an adjacent accessible
`Edit [logo]` action associated with that summary) returns to Step 2 with exact
product/option/placement selected. Do not change printed content to add edit
buttons. Print CSS excludes navigation/actions/inputs; paper uses the SAME
current renderer/model as screen and structured operator JSON.
`More output options` (collapsed) contains Save operator data / diagnostic
export; output generated from same snapshot as preview, no stale lastReturn.

## 7. Optional customer-approval branch

Entry: secondary `Send for customer approval` on Step 2. It opens a single
branch subview, NOT a fourth required top-level step. Header
`Send for customer approval`; summary of job and exact current selection;
format default Self-contained HTML; ZIP alternative under `More options`.
One primary `Create customer file`, then a two-file handoff group:
`Save office copy` + `Save customer file` with brief purpose text.
No email/upload/send tools: local downloads only. Back `Back to placements`.
Build customer issue from CURRENT operator placement geometry — do not use the
old builder policy that creates empty placements for this new branch. Preserve
artwork/assets/calibration/regions/notes and exact mm values; issue-specific
identity/revision/confirmation clearing follows existing contract. Store the
byte-exact issued baseline for comparison. Repeated unchanged input remains
deterministic; content changes invalidate prior files and require regeneration.

`Open customer response` is available as secondary action in this branch and
landing/header menu. Uses current issued office copy if one exists; otherwise
asks `Open office copy` first. Then `Open customer response`. Existing checks
must reject wrong baseline/project/product changes, bad assets, malformed or
oversized files atomically. Failure preserves active operator job and outputs.

Successful validated response opens a change summary, primary
`Use customer changes`, secondary `Keep current job`. No automatic merging.
Use customer changes installs the exact validated content, rebuilds placements
and document authoring context, preserves customer notes as read-only context,
and opens Step 2. No lost source files/baseline. Keep current job leaves it
unchanged. Subsequent staff geometry changes require fresh customer confirmation
if that job had customer-confirmed content, per existing workflow contracts.
Never manufacture a customer confirmation to enable direct document preparation.
Internal review decisions remain optional bookkeeping under Advanced review;
do not mark local work approved or bypass physical/manufacturing checks.

## 8. State, persistence and integration contracts

One authoritative editable job project + original package assets. Use existing
pure project-editor add/update/remove placement and newRevision semantics.
An Apply/drag commit is one logical transaction; no revision per keystroke;
no-op changes stay no-op. Preserve histories; invalid/unapplied edits cannot
leak into print, customer generation or Save job without clear Apply prompt.

Refactor operation authoring away from mandatory lastReturn: introduce an
explicit authoring context discriminated `operator` vs `customer-response`,
containing current ProjectDocument, package assets, recomputed candidate/digest,
reference views and identity. Local direct path builds its candidate through
existing buildCandidateExport. Do NOT call importCustomerReturn on the same
local project or populate fake return filenames/confirmation to satisfy UI.
Keep genuine baseline/response validation as a separate provenance boundary.
Both contexts feed the same sheet authoring, geometry, operation renderer and
operator export. Share existing validators/geometry; no duplicate math engine.
Extract reusable UI/renderer modules rather than copying entire customer app
or embedding a generated customer file and requiring its download/reimport.

Save job downloads one editable .logo-project containing exact current
geometry, original assets, presentation/calibration and named view sidecars,
selection, job identity and staff operation-authoring metadata. Use a bounded,
versioned provisional additional-asset sidecar for missing UI/job metadata;
reuse existing operation-draft contracts where applicable. Persisted measurement
bindings must be bound to exact project/config/placement/frame/calibration
identities and recomputed, not trusted on import. Existing files without this
sidecar still open with sensible empty metadata, never invented measurements.
If scope changes remove/move referenced geometry, mark dependent measurements
unresolved, not silently rebind. Failed/stale async reads never overwrite newer
sessions. No browser storage of customer data or implied autosave.

Opening a new file or New job with dirty changes requires inline choice
`Save job`, `Discard changes`, `Keep editing`; only explicit Discard or a
successful user-chosen continuation may replace current state. Save triggers
download, explains reopening, and does not pretend browser can verify disk.
If truly empty draft cannot package under existing invariants, Save disabled
with `Add a product before saving this job.` No fake placeholder product.

Direct document path must never call generateCustomerProject or require a
baseline. Optional issue/response uses the actual current job projection.
Do not weaken customer tamper checks, issue identity, confirmation freshness,
asset limits, deterministic bytes or production-pending status to simplify UI.

## 9. Required acceptance journeys

All actual station via file:// with networking disabled, synthetic files only.
Every journey asserts zero application console/page errors and HTTP(S) requests.
Use desktop 1280x900 and narrow 390x844; installed Chrome separate from Chromium.

A. Direct Images job: create → identity → named image → reference calibration →
2 named safe areas → 2 logos/3 placements (same artwork repeated) → measurement
bindings → review actual sheet → print request/print CSS + operator data →
Save job → fresh station Open → exact geometry/labels/instructions restored.
Assert NO customer issue/return/baseline occurred or was required.
B. Direct model-only job: no image UI, calibrate/add named planar safe area →
placement on supported mm diagram → review/print; no invented mesh projection.
C. Zero-logo/zero-placement included option stays present, prints explicit no-
placement statement. Incomplete preview-only product has actionable setup route.
D. Invalid/outside-safe placement and incompatible measurement choices show
scoped issue, preserve draft, disable complete print; explicit Print draft is
marked. Fix link selects exact item; edit refreshes actual output/digest.
E. Apply/Cancel/navigation preserve scoped staged edits; focus stable while
instructions change; duplicate/remove target IDs correctly; stale async import
cannot replace newer job. Unsaved-file replacement prompts and cancellation.
F. Actual self-contained AND ZIP customer issue contain already-authored
placements; save byte-exact office copy; customer moves a logo/confirms/returns;
validate against baseline → keep/use actions → use opens correct placements/
review; mismatched/tampered response leaves local job unchanged. Later staff
geometry edit clears current confirmation/review and makes generated files stale.
G. Existing legacy master/issued/return/draft paths still open; five freely named
views retained; labels/asset replacement preserve current scoped protections.
H. Desktop/narrow screenshots capture Prepare job, selected placement and actual
Review document (not unrelated old Send page). Inspect overlap, empty states,
primary actions, fields hidden for model/single-option, keyboard navigation.

Run npm run typecheck; npm test; targeted station/domain e2e in Chromium and
installed Chrome workers=1. Once integrated run full Chromium suite once;
triage failures rather than weakening assertions. Keep Chrome CVDisplayLink
host failures separately caveated even if isolated reruns pass. Missing Edge
fails explicitly; Windows Chrome/Edge remains untested delivery gate.
Record OS/browser/version/viewport/offline/results. Actual session has no
Browser-plugin tools (verify inventory); repository Playwright primary per
AGENTS.md. No servers, installs or live Odoo tests. Remove scratch tests/logging.

## 10. Delegation and handoff

Codex owns this UX specification and final review. Lead must not redesign it.
Before worker dispatch, assign explicit file/module ownership and contracts,
required checks and completion criteria; shared main.ts/template.html each have
one designated owner (prefer lead). Independent new placement workspace,
pure job/session helpers and reusable document-context adapters can be separate
workers; never overlapping broad edits to main.ts. Workers are not alone and
must preserve earlier changes; lead integrates and checks every result. Use
Contributor model for lead/workers. No worker commits/pushes.

Implement in checkpoints: (1) pure job/editor context+persistence contracts;
(2) three-step shell + direct placement; (3) shared document review + optional
approval branch; (4) integration+acceptance. These are internal checkpoints,
not permission to hand off disconnected UI or unfinished advertised buttons.
If a behavior cannot be implemented within actual contracts, report exact
blocker to Codex rather than substitute a misleading flow. No UX guessing.

Deliver changed-file list, checkpoints, exact test evidence, screenshots,
remaining real limitations and all workers stopped in the local result.md.
Do not claim production-ready, Windows-tested, or all-green Chrome matrix.
