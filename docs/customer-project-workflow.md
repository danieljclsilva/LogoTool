# Customer project round trip

Requirement agreed from the user's workflow direction on 2026-10-10. This is
the target behavior. Phase 8 currently has only a binary transport and offline
inspection preview; no customer editor or end-to-end workflow exists yet.
Exact schema fields remain subject to domain design and evidence review.

## Handoff

1. FlexiTog prepares a project with selected garments/variants, calibrated regions,
   allowed placement areas, decoration constraints, artwork and optional defaults.
2. The client loads it, places/resizes/rotates logos visually and sees physical
   measurements. Coordinates come from the prepared surface mapping; visual
   choices become mm data without the client supplying a calibration.
3. The client reviews all products/placements, enters instructions and confirms
   a specific revision. This is customer pre-approval, pending Logo Station review.
4. The client downloads the updated `.logo-project` and attaches it to their email.
   A draft can be saved without confirmation. The application works offline and
   does not send email itself.
5. Logo Station imports the return, checks its identity/revision and compares it
   with the issued product definitions. The review displays exact dimensions,
   placement references, constraints, previews and customer confirmation.
6. Logo Station approves the revision for production or returns a new proposal.
   Customer-visible changes require a new customer confirmation. An optional
   production result is derived from the internally approved revision.

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

## Round-trip acceptance criteria

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
