# Architecture foundation

Status: provisional Phase 2–5 work. Portable domain utilities and an internal
offline GLB/calibration inspector are implemented. Customer editing, binary
packaging, PDF rendering and Odoo integration remain pending.

## Boundaries

`src/core` owns plain physical/project data, schema/reference validation, revision
and review rules, baseline comparison, canonical serialization and candidate
export. It imports no browser, Node filesystem/crypto, React, Three.js or service
APIs. Ajv compiles the checked-in draft 2020-12 JSON contracts without network
resolution; all external schema references are registered locally.

Hashing is an injected synchronous `canonicalText -> lowercase SHA-256 hex`
callback whose result shape is checked. Tests supply Node crypto. A future browser
adapter must provide a synchronous portable implementation or explicitly adapt
these operations to asynchronous Web Crypto; SubtleCrypto cannot directly satisfy
this synchronous interface.

Future layers follow brief §4:

```text
src/core         physical domain and workflow (implemented)
src/viewer       Three.js model inspection/picking (logo rendering future)
src/assets       offline external GLB import (generation providers future)
src/packaging    canonical project, hybrid ZIP, self-contained HTML (future)
src/platform     file/download/storage interfaces, browser and Tauri adapters (future)
src/ui           internal calibration draft (customer editor/Builder future)
```

Viewers derive geometry from mm data; inverse calibrated surface mapping translates
visual editing back into mm. Screens, cameras and mesh transforms are never
production units. Tripo and other generation providers remain replaceable;
external GLB import follows the same asset pipeline.

Calibration fitting and region geometry are standalone pure utilities
(`src/core/calibration`, `src/core/geometry`). The offline inspector draft layer
adds viewer picks/markers, the calibration panel and pure session helpers. A
provisional local save/restore envelope requires the exact current-asset hash,
discards imported fit values and recomputes the fit as pending review. These
utilities are not yet wired into product calibration records or production
output. Variant transfer remains pending.

## Delivery contract

The customer runtime must work after unzip via `file://` in Windows Chrome/Edge,
with networking disabled, no installation, server, CDN, fonts or remote assets.
Application code/dependencies must be bundled. Current emitted TypeScript modules
are developer build output, not a delivered customer application.

Hybrid HTML must load the project using Choose Project or drag/drop, not silently
fetch neighboring files. A self-contained HTML package embeds its issued project.
Both formats share the same canonical project semantics and explicit downloadable
return format. Persistence must not depend on browser storage or overwriting the
original. Binary assets are normal bytes behind packaging adapters, not domain
Base64 fields. Direct offline browser/package acceptance is pending.

## Trust and export

Customer returns are untrusted. `importCustomerReturn` validates against an internal
issued baseline and discards supplied internal approval. Candidate output carries
physical context but never claims production approval/readiness. Internal review is
local workflow state, not authenticated identity. UI flows must use this boundary.

Operation PDFs, previews and later production output must derive from the same
selected project revision. PDF generation and Odoo uploads/writes are separate
future layers and authorization; no live Odoo tests or integration is included.


## Phase 4 partial implementation

Portable GLB ingestion and provisional provenance live in `src/assets`; the
asynchronous validated entry point uses the bundled Khronos validator. Three.js
and browser ownership are isolated in `src/viewer` and `src/ui/asset-inspector`.
`tsconfig.viewer.json` supplies DOM types separately from the core build.
`scripts/build-inspector.mjs` emits one inline IIFE HTML for internal `file://`
inspection. This is not the hybrid project package or customer standalone export.
See `asset-pipeline.md` for trust boundaries and unsupported resource/extension paths.
