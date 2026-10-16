# Customer project round trip

This document describes the target customer round trip. The current Phase 8
prototype now exercises editable synthetic planar projects and a separate
issued-baseline return-review workflow. It is not a production configurator or
Windows release; schema fields remain provisional pending evidence review.

## Handoff

1. FlexiTog prepares a project with selected garments/variants, calibrated regions,
   allowed placement areas, decoration constraints, artwork and optional defaults.
2. The target uses prepared physical surface mappings so visual editing yields
   mm values without customer calibration. The current prototype instead edits
   schematic region-frame measurements from synthetic fixtures; it makes no
   claim of real garment, photograph, curved-surface or 3D mapping.
3. The client reviews all products/placements, enters instructions and confirms
   a specific revision. This is customer pre-approval, pending Logo Station review.
4. The client downloads the updated `.logo-project` and attaches it to their email.
   A draft can be saved without confirmation. The application works offline and
   does not send email itself.
5. Logo Station imports the return against a separately selected issued baseline,
   verifies definitions and original/relevant asset bytes, and displays exact
   placement differences and current geometry/confirmation status.
6. A local review decision is separate workflow bookkeeping. Customer-visible
   changes create a new revision that requires a new customer confirmation.
   Production release, PDFs and operational exports remain future work.

## Information to preserve

| Information | Purpose |
| --- | --- |
| Project identity and issued/returned revision relationship | Match the returned file to the request and compare changes |
| Relevant product and variant definitions and assets | Reopen the project offline and identify the actual garment |
| Physical frames, calibration and surface mapping versions | Reproduce measurements independently of camera or mesh transforms |
| Regions, allowed areas, exclusions and method constraints | Bound visual choices and support internal validation |
| Original artwork and its role/applicability | Distinguish production artwork from prior-job references and proofs |
| Per-placement region, mm position, width/height and rotation | Generate operational placement data |
| Variant applicability and transfer overrides | Avoid silently applying one placement to incompatible variants |
| Customer instructions and garment modifications | Preserve requirements beyond the logo, including factory specials |
| Confirmation tied to the exact configuration revision/digest | Preserve what the client actually reviewed |
| Separate internal review and revision decisions | Distinguish customer intent from authorization to manufacture |

No case-specific values or limits are invented. Initial implementation can use
explicitly synthetic product fixtures; real production use requires validated
product calibration and constraints. Unknown historical coordinates remain
unknown rather than blocking the creation of this editing workflow.

## Approval semantics

Draft, customer-confirmed/pending-review and Logo Station-approved are distinct
workflow conditions. Record confirmation as revision-specific evidence rather
than a mutable project-wide approved flag. A saved return preserves the exact
confirmed configuration; later edits leave that confirmation in history and
require another confirmation. Merely opening, saving or importing a project
does not confer approval. Customer-entered confirmation details are not proof of
authenticated identity or a cryptographic signature.

The internal importer must review returned content against the internally issued
baseline, not accept changed calibration or constraints as internal authority.
The same project format serves repeated review cycles and future reorders.

## Implemented synthetic prototype boundary

The generated `dist/synthetic-customer-prototype.zip` contains a fully inline
editor and a synthetic issued `.logo-project`. The build clones the multi-product
fixture as a new revision-1 issue, deliberately clearing current confirmation,
internal review and prior approval histories; it never edits the source example.
The prototype supports multiple configurations and variants, 0..N placements,
mm position/dimensions, clockwise-positive rotation, allowed methods,
instructions, fit feedback, direct 2D movement, draft saves, confirmation and
reopen. Measured boxes are labelled footprints over schematic safe/exclusion
outlines. Original artwork bytes are preserved. Bounded PNG/JPEG/WebP thumbnails
can display separately; SVG and other production files remain unrendered.

Placement centre coordinates use the selected region's declared physical frame
and calibration reference; frame origin and axis labels are shown from that
definition. These are synthetic fixture values, not real product measurements,
photo landmarks or a surface mapping. The prototype is planar; it makes no 3D or
curved-surface placement claim.

`dist/customer-return-review.html` is a separate internal harness with two
explicit file pickers: a locally selected trusted-issued baseline and a separate
customer return. The page guides opening both files, checking the return and
recording a review. Differences stay visible before the decision. Optional
layout changes and export data use separate collapsed sections; the printable
operation document remains linked from the review. It imports through `importCustomerReturn`,
compares project identity/definitions/revision and exact asset bytes, discards
returned review fields, and gates review decisions on current structural, method
and geometry checks. Internal reviewer identity is self-entered and
unauthenticated. A customer-visible proposal is a new revision; previous
confirmation/review stays in history, current approval is cleared, and the
customer must reconfirm.
Neither a file's review field nor this synthetic local workflow proves
manufacturing authority.

## Guided Position, Size, Review flow

The customer page is a guided proof desk: a white top bar with the FlexiTog
mark, Logo Station wordmark and a small **Save draft** action; a Position /
Size / Review step nav; a large measured-placement canvas on the left and a
single open task rail on the right. One main task shows at a time, separated
by thin rules. Step tabs and Back preserve pending form edits without changing
the project. The primary Continue / Review layout action applies pending edits
atomically before advancing; invalid edits keep the customer on the current task.
An explicit **Apply my changes** action also appears when edits are pending.
Undo and Start-over restore content as new revisions. Add another logo starts
a new placement through the same guided steps; opening a step alone adds nothing.

The job opens preconfigured. The rail shows the prepared product, variant,
logo area and artwork as readable context; a selector appears only when
meaningful alternatives exist, so a fixed single option never shows a
redundant dropdown. Multi-configuration, multi-product, multi-variant,
repeated and zero-placement projects all stay supported.

Position offers the named approved area choices; exact X/Y offsets live in an
optional precise section. Size offers width first with an aspect-ratio lock
defaulting on where the starting ratio is valid; height and rotation live in
its precise section but independent width/height remain a domain capability,
so unlocking (or typing a height) always sticks. Review exposes the exact
all-configuration artwork, areas, exact mm dimensions, methods, fit and supplied
notes. Each placement has a Position and rotation disclosure with its exact
offsets, reference point, axis directions and rotation. Empty configurations
remain explicit. Schema IDs, frame IDs and calibration versions sit behind
the advanced reference section.
Customer name, confirm and save-return stay clearly separated from internal
approval. **Save draft file** (also in the top bar) is always available when
edits are applied; **Save confirmed return file** needs a fresh confirmation
and all-fit geometry. Downloads remain manual files the customer attaches to
their email.

## Presentation-only boundary

The canonical domain has no garment-photo calibrated placement mapping, so no
reference photo ever gets a pretend live physically mapped logo overlay: the
measured placement diagram is driven by exact domain millimetres. A valid
product reference photo opens automatically when supplied; otherwise the page
opens the diagram. An explicit Product reference / Placement diagram toggle
keeps both views accessible; the diagram is the
source of truth and switching views never changes saved physical values.
Safe logo thumbnails may render from bounded, allowlisted raster bytes already
inside the package; hostile, oversized or non-raster inputs fail safe (hidden
thumbnail, diagram stays visible) and original artwork bytes stay preserved
and untouched.

An optional provisional presentation manifest (for example
`presentation/preview.json` plus raster images) travels inside
`.logo-project` strictly external to the canonical production/domain schema:
only explicitly referenced, product/variant-matched assets render, never URL
fetches or filename-inferred choices, and invalid presentation metadata is
ignored for display with a concise reference warning (customer saves preserve
the opened package assets). Reference photos and thumbnails are
visual aids only — Logo Station rechecks every measurement separately, and
neither a reference image nor a thumbnail proves manufacturing authority.

The adapter currently reads this provisional additional asset format:

```json
{"version":1,"references":[{"productId":"SYN-PRODUCT","variantId":"SYN-VARIANT","image":"presentation/product.png","label":"Product reference"}]}
```

`variantId` and `label` are optional; variant-specific references take precedence
over product-wide references. The manifest is limited to 64 KiB and 32 entries.
Images must be package-local PNG/JPEG/WebP, at most 2 MiB, 16 megapixels and
8192 pixels per edge. Header dimensions are checked before native decoding;
decoded dimensions must agree. Remote URLs, traversal and disguised SVG are
rejected. Obsolete asynchronous loads cannot replace the current selection.
Switching views cancels an unfinished drag and leaves committed bytes unchanged.
The Builder retains only references matching issued selections, rewrites the
manifest deterministically and excludes unrelated additional assets. This is
presentation metadata, not a calibrated photo mapping or production schema.

## Loading and saving offline

Hybrid output contains fully bundled HTML plus the project file. Choose Project
and drag/drop are the required loading routes. Sharing a folder does not provide
reliable silent file access from `file://`: local files generally have opaque
origins, and neighbouring files can trigger CORS restrictions. See
[MDN's same-origin policy documentation](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy).

Use self-contained HTML with an embedded issued project for automatic opening.
Both distribution modes export the same editable `.logo-project` return.
Saving via download is the baseline, independent of native filesystem handles
or browser persistence. Optional enhanced file access is not an acceptance-test
dependency; browser file pickers require user interaction, as described in
[Chrome's File System Access documentation](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).

## Ticket handoff

On internal import, prepare ticket-ready structured details, an approval summary,
previews and the returned project attachment. The candidate production data
remains pending departmental approval. The Builder also exports an operation PDF
for ticket and BoM attachments, enriching proof-style product views with physical
placement diagrams, instructions and revision/review information. See
`operation-pdf.md`. Creating/updating Odoo records is a
separate future integration, outside current read-only discovery authorization.

## Full workflow target acceptance (future release gates)

- Load both packaged modes in Windows Chrome/Edge through `file://` with network
  disabled, no flags, server or installation.
- Configure multiple products, variants and 0..N placements within allowed areas.
- Show/edit mm dimensions and reference distances; changing camera or viewport
  does not change saved physical values.
- Save/reopen a draft and a confirmed return with complete relevant assets and
  identical placements, instructions and revision-specific confirmation.
- Generate previews and structured summaries from the exact saved configuration.
- Detect changes after confirmation; require reconfirmation for submission.
- Import internally, compare against the issued baseline, approve or return a
  revision and preserve the review history.
- Derive deterministic operational data from the same configuration; no separate
  editable production coordinates or live Odoo calls in automated tests.
- Export an operation PDF whose product views, placement measurements,
  instructions and approval status match the selected project revision.
