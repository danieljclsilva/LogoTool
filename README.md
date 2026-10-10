# LogoTool

Phase 1 Odoo discovery is in progress: initial findings are in [docs/odoo-discovery.md](docs/odoo-discovery.md), with a detailed local report under `private/`. Evidence-audit tooling is implemented and verified. There is no configurator, build, or customer package yet.

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

Planned stack is TypeScript / React / Three.js / Vite (not yet present). Python is developer tooling only, never a customer runtime requirement.

## Schema gate

Schema finalization awaits the unresolved Phase 1 exit criteria in [docs/odoo-discovery.md](docs/odoo-discovery.md). Progress through the remaining milestones is tracked in [docs/development-status.md](docs/development-status.md).
