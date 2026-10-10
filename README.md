# LogoTool

Phase 1 Odoo discovery is in progress: initial findings are in [docs/odoo-discovery.md](docs/odoo-discovery.md), with a detailed local report under `private/`. Evidence-audit tooling is implemented and verified. A provisional TypeScript domain foundation is implemented; there is no customer configurator or delivered browser package yet.

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
npm run typecheck
npm test
python3 -m unittest discover -s tests -v
```

`npm test` builds the TypeScript code first; `npm run build` also works separately.
The customer package will not require Node or Python.

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

Schemas use `0.1.0-provisional`; Phase 1 remains incomplete. Safe-area geometry,
variant-transfer behavior, real calibration, 3D editing, binary project packaging,
operation PDFs and the Builder remain pending. An internal single-HTML asset inspector has been tested offline in macOS Chrome;
the customer package remains pending, and Windows Chrome/Edge over `file://` with networking disabled
remains the delivery acceptance test.


## Internal asset inspector (Phase 4 partial)

Run `npm run build`, then open `dist/asset-inspector.html` directly through `file://`.
Choose `examples/models/synthetic-block.glb` or `synthetic-tetra.glb` to inspect,
orbit, fit/reset, toggle wireframe and download original bytes plus provenance.
No server or network connection is needed. Fixtures are synthetic and uncalibrated.
Real FlexiTog assets, Tripo comparison and Windows verification remain pending.
See [asset pipeline](docs/asset-pipeline.md) and [prototype findings](docs/prototype-findings.md).
