# LogoTool

Phase 1 Odoo discovery remains in progress; initial findings are in
[docs/odoo-discovery.md](docs/odoo-discovery.md), with detailed evidence under
`private/`. Evidence-audit tooling is implemented. Phase 8 now includes a
provisional transport preview plus editable synthetic planar customer/review
workflows. Real calibration, production readiness and Windows delivery are not
implemented or approved.

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

## Provisional foundations

Use Node.js 22.18+ (verified here on 26.10) for development only:

```sh
npm ci
npx playwright install chromium # setup only (may need network)
npm run typecheck
npm test
npm run test:e2e # offline inspector + Phase 8 workflows (build + Chromium)
python3 -m unittest discover -s tests -v
```

`npm test` builds the TypeScript code first; `npm run build` also works separately.
`npm run build:package-preview` builds the unchanged transport preview and the
synthetic customer/reviewer artifacts under ignored `dist/`. Run
`npm run build:customer-prototype` to build those package artifacts directly.
They are a functional synthetic prototype, not production output; see
[project packaging](docs/project-packaging.md).
Customer runtime packages are intended to need no Node or Python; build tooling is development-only.
Real Chrome/Edge runs: `npm run test:e2e:chrome`, `npm run test:e2e:edge`,
`npm run test:e2e:matrix`. See [offline testing](docs/offline-testing.md).

Implemented: generalized products/variants/regions, mm placements with explicit
frames and calibration references, schema and reference validation, canonical
JSON, content digests, revision-specific customer confirmation, separate internal
review, issued-baseline comparison and customer-return import. Candidate output
is deterministic and always pending review. Zero placements and repeated designs
are supported. Fixture artwork and measurements are entirely synthetic.

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
artwork rendering, 3D/curved mapping, production export/PDF, Odoo write path or
Windows release is claimed. Schemas remain provisional. See
[project packaging](docs/project-packaging.md) and
[customer workflow](docs/customer-project-workflow.md).
The maintained offline Playwright suite covers the internal asset inspector,
transport preview, customer editor and return reviewer. macOS Chromium/Chrome
results are engineering evidence only. Windows Chrome/Edge over `file://` with
networking disabled remains untested. See [offline testing](docs/offline-testing.md).
Operation PDFs and the internal Builder remain pending.

For draft variant transfer, capture the current calibrated placements as the
source, then author or restore the target variant using the existing inspector
controls. Enter explicit region rules and optional placement overrides, run the
transfer, review its millimetre measurements and fit verdicts, and download the
pending-review bundle. The source survives target asset changes; preview and
export leave the target's placements unchanged.


## Internal asset inspector (Phase 4 partial + Phase 5 draft panel)

Run `npm run build`, then open `dist/asset-inspector.html` directly through `file://`.
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

Run `npm run build:package-preview`, unzip
`dist/synthetic-package-transport-preview.zip`, and open
`OPEN_LOGO_CONFIGURATOR.html` through `file://`. Choose Project or drag/drop
loads the `.logo-project` for metadata and mm-placement inspection. This
transport-only page remains unchanged.

## Synthetic customer prototype (Phase 8 partial)

Run `npm run build:customer-prototype`, unzip
`dist/synthetic-customer-prototype.zip`, and open `customer-configurator.html`
through `file://`. The package contains `SYNTHETIC-CUSTOMER.logo-project`;
Choose Project or drag/drop opens it. The separate
`dist/customer-return-review.html` imports a return only against a separately
selected local issued baseline and downloads reviewed or revised project files.
The editor preserves asset bytes, edits mm placements/instructions, and labels
customer confirmation as pending internal review. Footprints are inert labelled
boxes on schematic synthetic regions, not artwork or garment renders. Real
calibration, physical validation and Windows Chrome/Edge release acceptance
remain unverified.

The same build also emits `dist/synthetic-customer-self-contained.html`
(Phase 9 partial). Copy this single HTML file anywhere and open it locally:
the synthetic issued project loads automatically, with no sibling files.
Choose Project/drop can replace it; draft and confirmed downloads use the same
editable `.logo-project` return as hybrid mode. See [project packaging](docs/project-packaging.md)
for limits and [offline testing](docs/offline-testing.md) for evidence and gaps.
