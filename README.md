# LogoTool — make the operation sheet

LogoTool is FlexiTog's offline Logo Station: staff prepare a customer project,
issue the customer file, review the return, and produce ONE branded operation
sheet (A4 landscape) plus minimal operator data for production. Everything runs
offline from local files — no installation, server, CDN, or network connection.

## Operator Quickstart — one entry, one flow

Build once, then open exactly one staff page:

```sh
npm run build
# then open dist/station/Logo Station.html directly via file://, networking disabled
```

One guided flow in that same tool:

1. **Prepare** — Start (create a project or open an existing one) → Choose items
   (products, options, logos) → Customer details → Save & send. Keep the saved
   **office copy**: browser memory is lost on reload.
2. **Customer** — send the customer file; the customer edits, confirms and
   returns a `.logo-project` (by email, USB or drive — the station never sends
   anything itself).
3. **Return** — Review a return: choose the office copy first, then the return,
   and read the full diff. Optionally record the office decision or revise the
   proposal in place; a revised update needs the customer to reconfirm before
   any approval.
4. **Sheet** — Check & prepare: author department instructions and selected
   anchor-to-logo dimensions, then Preview operation document →
   **Print / save PDF** (exactly one A4 landscape page for the ordinary
   one-product/two-logo job) and **Save operator data** (minimal JSON carrying
   the same business data, no ids or digests).

Full steps, limits and honesty rules: [docs/internal-builder.md](docs/internal-builder.md).
Physical pilot checklist: [docs/operator-pilot-checklist.md](docs/operator-pilot-checklist.md).
Release gate: [docs/release-acceptance.md](docs/release-acceptance.md)
(UNTESTED on Windows so far) plus `scripts/run-windows-acceptance.ps1`.
Public demo and automatic updates on pushes to `main`:
[docs/github-pages-demo.md](docs/github-pages-demo.md).

## Customer delivery formats (same canonical project, your choice at issue)

- **One file the customer opens directly** (recommended): self-contained HTML
  with the issued project embedded — nothing to unzip.
- **ZIP with the setup files inside**: `OPEN_LOGO_CONFIGURATOR.html` plus the
  `<JOB>.logo-project`, opened with Choose Project or drag and drop.

Regenerating identical input produces identical bytes. Both formats preserve
exact original artwork bytes, and customer notes never become department
instructions automatically.

## Output tree and commands

```text
dist/station/Logo Station.html   # the only staff application (open via file://)
dist/station/assets/             # only if the station build needs support files
dist/dev/                        # developer-only inspection/fixture pages (never shipped)
```

```sh
npm run build                # station + dev (default)
npm run build:station        # station entry only
npm run build:dev:preview    # dev-only synthetic customer/reviewer artifacts
npm run build:dev:inspector  # dev-only asset inspector
npm run typecheck && npm test
npm run test:e2e             # offline Chromium gate (build + file:// suite)
npm run test:e2e:chrome      # real Google Chrome (needs the browser installed)
npm run test:e2e:edge        # real Microsoft Edge (needs the browser installed)
```

Customer runtime packages need no Node or Python; build tooling and the
commands above are development-only. See [offline testing](docs/offline-testing.md)
for suite layout and evidence, and the [release gate](docs/release-acceptance.md)
for the Windows procedure.

## Developer and historical detail

The sections below record developer tooling, domain state and milestone
history. Operators can stop at the Quickstart above.


## Phase 1 evidence audit

```sh
python3 scripts/discovery_audit.py --input-dir private/odoo-discovery --output private/odoo-audit/manifest.json
python3 -m unittest discover -s tests -v
```

Write the manifest outside the capture dir (`private/odoo-audit/`, never inside `private/odoo-discovery/`): the scanner reads only `capture-*.json` inputs, and the output name must neither match that pattern nor overwrite an input. Output must stay under the ignored `private/` directory.

Exit code is `2` on any validation failure; the diagnostic manifest is still written when captures are readable. Missing, non-directory, or empty (zero-capture) input also exits `2` and writes no manifest — an empty evidence set is never reported as success.

Each manifest capture carries `sha256Hex` of the raw capture bytes plus hash-only provenance (`queryHash`, `domainHash`, `projectionHash`); no record values, error text, request ordering strings, or off-grammar filenames leave the audit. Output is deterministic: reruns over the same inputs are byte-identical.

Evidence completeness limits: attachments are complete only at offset 0 with explicit `has_more: false`; chatter is complete only at offset 0 with explicit `complete: true` and distinct row IDs covering `visible_total`; tracking is always `unknown` (two-dimensional cursors need cross-page reconciliation); search/read stay `unknown` without an explicit exhaustion signal; count metadata is never the underlying count.

## Privacy

Credentials and customer evidence stay private under the ignored `private/` directory. Raw captures are private; the audit manifest is private with hash-only query provenance and no record values.

## Stack

TypeScript core and developer tooling are present. Three.js powers the internal asset inspector. React / Vite remain planned. Python is developer tooling only, never a customer runtime requirement.

## Schema gate

Schema finalization awaits the unresolved Phase 1 exit criteria in [docs/odoo-discovery.md](docs/odoo-discovery.md). Progress through the remaining milestones is tracked in [docs/development-status.md](docs/development-status.md).

## Provisional foundations (developer commands)

Use Node.js 22.18+ (verified here on 26.10) for development only. Main build/test
commands live in [Output tree and commands](#output-tree-and-commands) above;
additionally `python3 -m unittest discover -s tests -v` runs the Python
developer-tooling tests.


Implemented: generalized products/variants/regions, mm placements with explicit
frames and calibration references, schema and reference validation, canonical
JSON, content digests, revision-specific customer confirmation, separate internal
review, issued-baseline comparison and customer-return import. Candidate output
is deterministic and always pending review. Zero placements and repeated designs
are supported. Fixture artwork and measurements are entirely synthetic.
Inspector calibration/region-area exports convert to prepared product
definitions through `scripts/convert-area-bundle.mjs` (explicit labels, atomic
validation); the Internal Builder imports them with original evidence, issues
customer files, and reviews returns against the saved baseline.

Confirmation binds product definitions, artwork, placements and operational
instructions. Customer-return imports compare internal definitions and discard
returned internal approval. Customer confirmation identifies what was confirmed;
it does not authenticate a person. Internal approval is workflow bookkeeping,
not proof of physical feasibility.

See [domain model](docs/domain-model.md), [architecture](docs/architecture.md),
[decisions](docs/decisions.md) and [status](docs/development-status.md).

Schemas use `0.1.0-provisional`; Phase 1 remains incomplete. A standalone
calibration/geometry kernel exists (Phase 5 partial: scale fitting, planar
mapping, polygon containment; synthetic fixtures only, no production wiring —
see [calibration](docs/calibration.md)). A provisional variant-transfer kernel plus an offline inspector panel
exist (Phase 7 partial: absolute/normalized/proportional/override across
explicit variant contexts, 50 Node tests, frozen-source capture with atomic
draft transfer and deterministic pending-review export — see
[variant transfer](docs/variant-transfer.md)). Phase 8 remains partial: binary
`.logo-project` transport, an editable offline synthetic planar customer editor,
and a separate internal return-review harness now exercise the issue/edit/
confirm/save/reopen/import/revise/reconfirm workflow. No real product calibration,
artwork rendering, 3D/curved mapping, production-ready export/PDF, Odoo write path or
Windows release is claimed. Schemas remain provisional. See
[project packaging](docs/project-packaging.md) and
[customer workflow](docs/customer-project-workflow.md).
The maintained offline Playwright suite covers the internal asset inspector,
transport preview, customer editor and return reviewer. macOS Chromium/Chrome
results are engineering evidence only. Windows Chrome/Edge over `file://` with
networking disabled remains untested. See [offline testing](docs/offline-testing.md).
The internal return reviewer now previews and downloads deterministic
pending-review operational candidate JSON and a printable operation document
with physical footprint diagrams (Phase 10 partial). Use the browser print
dialog to print or save as PDF. Direct production PDF generation,
production-ready output remains pending. The provisional internal Builder now
creates packages, imports prepared planar products and reviews returns locally.

For draft variant transfer, capture the current calibrated placements as the
source, then author or restore the target variant using the existing inspector
controls. Enter explicit region rules and optional placement overrides, run the
transfer, review its millimetre measurements and fit verdicts, and download the
pending-review bundle. The source survives target asset changes; preview and
export leave the target's placements unchanged.


## Internal asset inspector (developer utility)

Run `npm run build`, then open `dist/dev/asset-inspector.html` directly through `file://`.
Choose `examples/models/synthetic-block.glb` or `synthetic-tetra.glb` to inspect,
orbit, fit/reset, toggle wireframe and download original bytes plus provenance.
The provisional calibration draft below the preview supports armed surface
picking (click, not drag), anchor IDs with generic roles, 1..N known-distance
measurements in mm, uniform-scale fit with stale/inconsistent handling, a
pending-review session-JSON download (never approved; does NOT include regions), and local restore of a
previously downloaded session file (exact current-asset SHA-256 required;
imported fit ignored and recomputed pending review). A provisional planar-frame draft authors 0..N oriented region frames from existing anchors (origin/+X-side/+Y-side with explicit off-plane tolerance), shows the active frame's X (red) / Y (green) 100 mm axes on the preview, probes anchors through the frame, labels stale regions, and downloads a separate pending-review region bundle (no region restore path). A safe-area subpanel authors per-region safe polygons plus named exclusions in frame millimetres (concave allowed; JSON text with documented limits), checks draft footprints against safe-minus-exclusions, previews all three in a 2D mm SVG (+Y up, origin marker, legend), and downloads a dedicated deterministic `0.1.0-provisional-region-areas` bundle (pending review, never approved; null safe allowed as draft-only) with a local same-asset restore path (`parseAreaBundleRestore`: exact version + asset-hash match, fit recomputed and never imported, 8 MiB chars, max 128 regions, 512 ring vertices, 64 exclusions/region, 65536 total vertices; replaces calibration+regions+areas atomically). Session exports still exclude frames/areas; session restore still uses its own 1 MiB limits and clears regions/areas. The draft below the preview stays pending review, never approved, and works fully offline as a file://
draft. No server or network connection is needed. Fixtures are synthetic and uncalibrated.
Real FlexiTog assets, Tripo comparison and Windows verification remain pending.
See [asset pipeline](docs/asset-pipeline.md) and [prototype findings](docs/prototype-findings.md).

## Project package transport preview

Run `npm run build`, unzip
`dist/dev/synthetic-package-transport-preview.zip`, and open
`OPEN_LOGO_CONFIGURATOR.html` through `file://`. Choose Project or drag/drop
loads the `.logo-project` for metadata and mm-placement inspection. This
transport-only page remains unchanged.

## Synthetic customer prototype (Phase 8 partial)

Run `npm run build`, unzip
`dist/dev/synthetic-customer-prototype.zip`, and open `customer-configurator.html`
through `file://`. The package contains `SYNTHETIC-CUSTOMER.logo-project`;
Choose Project or drag/drop opens it. The dev-only
`dist/dev/customer-return-review.html` imports a return only against a separately
selected local issued baseline and downloads reviewed or revised project files.
The editor preserves asset bytes, edits mm placements/instructions, and labels
customer confirmation as pending internal review. Footprints are inert labelled
boxes on schematic synthetic regions, not artwork or garment renders. Real
calibration, physical validation and Windows Chrome/Edge release acceptance
remain unverified.

The same build emits `dist/dev/synthetic-customer-self-contained.html`
(Phase 9 partial). Copy this single HTML file anywhere and open it locally:
the synthetic issued project loads automatically, with no sibling files.
Choose Project/drop can replace it; draft and confirmed downloads use the same
editable `.logo-project` return as hybrid mode. See [project packaging](docs/project-packaging.md)
for limits and [offline testing](docs/offline-testing.md) for evidence and gaps.
