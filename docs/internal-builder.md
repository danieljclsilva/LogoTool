# Internal Builder (Phase 11)

The provisional Builder creates customer deliveries from a local validated
`.logo-project` catalogue snapshot. It uses the existing domain, customer editor,
return-import and operation-document contracts. No Odoo connection, upload or
schema finalization is involved.

## Start and issue

Run `npm run build`, then open `dist/internal-builder.html` directly with the
network disabled. For a synthetic demonstration, choose the generated
`dist/trusted-issued.logo-project` as the source.

1. Choose or drop a source package. Imported artwork remains inert original
   bytes; the Builder displays its logo definitions rather than rendering it.
2. Select products, their variants and the artwork to supply. All start selected.
   Unselected artwork removes its default placements; selecting no artwork is
   valid. Measurements, frames, safe areas and calibration remain from source.
3. The configuration list optionally selects specific prepared configurations.
   Leaving all checked uses automatic selection: only selected products/variants
   survive, and variants without a default receive an empty editable
   configuration. Explicit configuration subsets keep only those configurations.
4. Enter customer label, job reference, issuer and a unique issued project ID.
   The ID binds subsequent returns to this issue. Use a different ID for a new
   customer issue; the application cannot enforce uniqueness across saved files.
5. Choose self-contained HTML or hybrid ZIP and generate. Exact output sizes
   appear before downloading. Generation is deterministic for identical inputs.
6. Download the delivery AND the retained baseline before handoff. Store the
   baseline internally with the job. Browser memory is lost on close/reload.

The issue starts at revision 1 with the explicitly entered project ID. Source
confirmation, internal review and their histories are cleared; original source
files are unchanged. Customer/job/issuer labels are descriptive local data,
not authenticated identities. Only artwork referenced by selected logos ships;
additional source assets are omitted. The current schema has no product-model
binary references; no real product asset mapping is claimed.

Hybrid delivery is `<JOB>.zip` containing `OPEN_LOGO_CONFIGURATOR.html` and
`<JOB>.logo-project`. After extraction, customers open the HTML and choose/drop
that project. Self-contained delivery is `OPEN_LOGO_CONFIGURATOR.html` with the
same project bytes embedded and automatically loaded. Both save editable
`.logo-project` returns. The separate retained baseline download is byte-identical
to the issued project in either format. Regenerating identical input produces
identical project, HTML and ZIP bytes.

Changing a selection, identity or format clears generated downloads and the
return preview. Inputs lock during asynchronous work; operation tokens discard
obsolete completions. Files are size-checked before reading, validated before
replacement and bounded by package/editor limits. Failed imports retain the
previous valid source/baseline/review. Core Builder limits are 64 products,
64 logos, 64 issued configurations and 256 characters per ID/identity field.

## Return review and ticket/BoM preparation

The Builder compares a return against the current generated baseline, or use
**Choose saved issued baseline** to restore the exact internally saved file in a
fresh session. Selecting a saved baseline switches the review context and clears
generated delivery downloads; it does not issue another project. A loaded saved
baseline can be downloaded again without regenerating it. Treat a customer-sent
file as a return, never as the trusted baseline.

Choose the returned package to compare definitions, exact asset kinds/bytes,
revision and customer confirmation through `importCustomerReturn`. Returned
internal review fields never confer authority. Inspect configuration/instruction
differences, confirmation and geometry status. Download the deterministic
candidate JSON and preview the operation document from that same revision and
digest. **Print operation document** uses the browser's Print / Save as PDF path.
Native print-dialog settings and printer scaling require operator review.

The handoff summary identifies the actual return, baseline and candidate
filenames and PDF steps. Candidate JSON and operation documents always remain
`candidate-pending-review`. Attach the returned project, candidate and checked PDF
manually to the ticket/BoM as appropriate; the Builder performs no Odoo writes.

**Download full return reviewer** saves a separate inline HTML page for internal
decisions and revised customer proposals. Open it offline and select the saved
baseline and return. Its existing approval/reconfirmation rules still apply.
The Builder's embedded preview itself does not record internal decisions.

## Remaining gates

All fixtures/calibrations are synthetic. Real calibration, garment/artwork
rendering, curved mapping, authenticated review, finalized production/Odoo
contracts and direct production PDF generation remain pending. Browser Print /
Save as PDF is the current document export. Actual Windows Chrome/Edge offline
`file://` delivery remains untested. See `offline-testing.md` for development
acceptance evidence.
