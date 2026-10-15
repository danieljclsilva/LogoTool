# Architecture foundation

Status: provisional Phase 2–8 foundations. Phase 8 now includes binary project
transport, a fully inline synthetic planar customer editor, and a separate
internal return-review harness. These are workflow prototypes only; real
calibration, product/artwork visualization, production export/PDF and Odoo
integration remain future work.

## Boundaries

`src/core` owns plain physical/project data, schema/reference validation, revision
and review rules, baseline comparison, canonical serialization and candidate
export. It imports no browser, Node filesystem/crypto, React, Three.js or service
APIs. Ajv compiles the checked-in draft 2020-12 JSON contracts without network
resolution; all external schema references are registered locally.

Core hashing remains an injected synchronous `canonicalText -> lowercase
SHA-256 hex` callback. Node tests supply Node crypto. Browser operations use
`src/ui/shared/browser-hasher.ts`: it canonicalizes `contentEnvelope(project)`,
awaits Web Crypto, and stores the exact text/digest pair before core calls. Its
synchronous callback throws for every text that was not explicitly prepared;
SubtleCrypto itself never enters `src/core`.

Future layers follow brief §4:

```text
src/core         physical domain and workflow (implemented)
src/viewer       Three.js model inspection/picking and planar synthetic-logo preview
src/assets       offline external GLB import (generation providers future)
src/packaging    provisional binary project ZIP transport and inline package builds
src/platform     file/download/storage interfaces, browser and Tauri adapters (future)
src/ui           internal calibration, transport inspector, synthetic customer editor/reviewer and provisional Internal Builder
```

Viewers derive geometry from mm data; inverse calibrated surface mapping translates
visual editing back into mm. Screens, cameras and mesh transforms are never
production units. Tripo and other generation providers remain replaceable;
external GLB import follows the same asset pipeline.

Calibration fitting and region geometry are standalone pure utilities
(`src/core/calibration`, `src/core/geometry`, `src/core/planar-region` for provisional oriented planar frames, `src/core/region-areas` for nullable safe polygons + named exclusions bound to exact frame snapshots with a deterministic area bundle, `src/core/logo-placements` for 0..N synthetic-logo placements with recomputed rotated footprints checked against those areas plus a deterministic placement bundle, `src/core/logo-placement-restore` for its atomic local restore). The offline inspector draft layer
adds viewer picks/markers/region axes/placement overlays (procedural asymmetric synthetic artwork textures UV-mapped to footprint corners with fit outlines, disposed on refresh/clear; depth-buffer bias prevents surface flicker without moving physical corners), the calibration panel (anchor/measure plus planar-frame fieldset plus safe-area subpanel with 2D mm preview plus logo-placement editor with numeric fields, per-placement statuses, 2D mm preview and physical-data-driven 3D overlays) and pure session helpers. A
provisional local save/restore envelope requires the exact current-asset hash,
discards imported fit values and recomputes the fit as pending review; planar region bundles are a separate deterministic provisional export with no restore path, while the dedicated area bundle has a local restore path (`src/core/region-areas-restore`, 8 MiB chars, max 128 regions, 512 ring vertices, 64 exclusions/region, 65536 total vertices; nested session limits unchanged). The placement bundle (`0.1.0-provisional-logo-placements`, max 256 placements / 64 logos) has the same trust posture: exact asset hash, recomputed fit/regions/areas/footprints, supplied approval/footprint/status never echoed, malformed/reference-invalid files fail atomically while geometrically-invalid-but-wellformed placements stay editable with explicit non-fitting statuses. These
utilities are not yet wired into product calibration records or production
output. The provisional Phase 7 transfer kernel and inspector panel exist, but
real variant calibration and production mapping remain unvalidated.

## Delivery contract

The customer runtime must work after unzip via `file://` in Windows Chrome/Edge,
with networking disabled, no installation, server, CDN, fonts or remote assets.
Application code/dependencies must be bundled. The build emits a hybrid synthetic
customer prototype and standalone inline editor/reviewer HTML. Their file chooser
and drop flows do not fetch neighboring files. A separate transport-only preview
remains available. Persistence uses explicit downloads, not browser storage or
overwriting the original. Binary assets remain bytes behind packaging adapters,
not domain Base64 fields. Synthetic macOS offline `file://` acceptance is
engineering evidence only; Windows Chrome/Edge release acceptance remains pending.

## Trust and export

Customer returns are untrusted. `importCustomerReturn` validates against an internal
issued baseline and discards supplied internal approval. Candidate output carries
physical context but never claims production approval/readiness. Internal review is
local workflow state, not authenticated identity. UI flows must use this boundary.

Operation documents, previews and later production output must derive from the
same selected project revision. The return reviewer shares its canonical candidate
snapshot with a pure `src/core/operation-document` view model and a DOM/SVG print
renderer in `src/ui/shared/operation-document`. Browser Print / Save as PDF is
local and always pending review; direct production PDF generation and Odoo
uploads/writes remain separate future layers. No live Odoo tests or integration
is included.


## Phase 4 partial implementation

Portable GLB ingestion and provisional provenance live in `src/assets`; the
asynchronous validated entry point uses the bundled Khronos validator. Three.js
and browser ownership are isolated in `src/viewer` and `src/ui/asset-inspector`.
`tsconfig.viewer.json` supplies DOM types separately from the core build.
`scripts/build-inspector.mjs` emits one inline IIFE HTML for internal `file://`
inspection. This is not the hybrid project package or customer standalone export.
See `asset-pipeline.md` for trust boundaries and unsupported resource/extension paths.

## Phase 8 synthetic project workflow

`src/packaging/project-package` writes and validates a separately versioned
provisional ZIP envelope around an unchanged `ProjectDocument` and binary assets.
`src/core/project-editor` supplies immutable placement/instruction revisions and
full rotated-box safe/exclusion verdicts; it changes no current schemas.
`src/ui/customer-editor` is a fully inline 2D mm editor using inert labelled
footprints, not original-art rendering or real garment mapping. It saves drafts,
confirms the current content digest, and gates submissions on confirmation plus
current geometry/method checks.

`src/ui/customer-return-review` requires distinct user-selected issued and
returned archives, compares identity/definitions plus exact asset bytes, calls
`importCustomerReturn` (discarding returned internal review), and records review
only after current fit/validation. Customer-visible edits create a new revision
and clear current confirmation/review. The returned file's customer confirmation
is evidence text, and the local baseline/reviewer identity are not authentication.

`scripts/build-package-preview.mjs` preserves the previous transport preview and
emits `dist/customer-configurator.html`, `dist/customer-return-review.html`,
`dist/synthetic-customer-prototype.zip`, and development-only
`dist/trusted-issued.logo-project`. The issue project is a clean revision-1 clone
of a synthetic source fixture; source examples and binary assets are unchanged.
Phase 9 adds `src/packaging/self-contained-html`, a browser-independent wrapper
that inserts the issued package as bounded inert base64 into the inline editor.
`self-contained-bootstrap.ts` decodes the data and uses the same atomic source
loader as files, including editor limits and obsolete-load rejection. Both modes
save the same project transport; `src/core` and canonical schemas are unchanged.
The build emits `dist/synthetic-customer-self-contained.html` alongside the hybrid
artifacts. Real calibration, curved/3D mapping, production output, Windows delivery
remain outside this prototype. Phase 11 adds a local-source Internal Builder; see `internal-builder.md`.
Transport format, path/decompression limits and ZIP restrictions are documented
in [project packaging](project-packaging.md).
