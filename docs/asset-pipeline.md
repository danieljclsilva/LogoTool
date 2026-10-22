# Asset pipeline — Phase 4 partial prototype

This internal prototype imports external GLB bytes and inspects them offline. It
is not a customer configurator, a calibrated product, or a production export.
No real product photographs or Tripo generation were used in this pass.

## Boundaries and flow

`src/assets` owns container parsing, offline-resource policy, provisional sidecar
metadata and a replaceable `ModelGenerator` interface. It imports no React,
Three.js, browser or Node APIs. SHA-256 comes from an injected callback or a
caller-supplied digest; supplied digests are a caller trust boundary, not independently
verified by the synchronous metadata function. The browser hashes original bytes
with WebCrypto before ingestion.

Both manually imported bytes and `SyntheticModelGenerator.generate()` output
enter `ingestValidatedAsset`. This asynchronous entry point runs `ingestAsset`
(container/policy/provenance) and then the bundled
[Khronos glTF Validator](https://github.com/KhronosGroup/glTF-Validator) against
binary data. Rendering must use this validated entry point. `ingestAsset` alone
is a metadata/policy operation, not complete glTF validation. Errors block preview;
quantization advisory notes do not. No external-resource loader is supplied: an
explicit callback rejects any attempted resource resolution.

The intake limit is 32 MiB, checked before browser file reading and hashing.
Container lengths and four-byte alignment, strict UTF-8 JSON, actual BIN lengths,
references and accessor/buffer bounds are checked. Embedded data URIs are limited
to 8 MiB each and allowlisted buffer/image MIME types. Remote, sibling, `file:` and
`blob:` input references are rejected. Draco, meshopt, GPU instancing and unknown
required extensions are outside the supported subset. Larger or more complex
models need an explicit future compatibility/performance decision.

`src/viewer` owns Three.js GLTFLoader parsing from memory, OrbitControls,
fit/reset, wireframe and disposal. Framing changes only an internal wrapper and
camera. Physical data does not depend on these transforms. `src/ui/asset-inspector`
owns file input/drop, WebCrypto, explicit source labels, status and Blob downloads.
Read/parse generations prevent an older import from replacing a newer one.

## Original bytes and provisional provenance

The UI retains original bytes until replacement, offers a byte-identical GLB
download and a JSON sidecar with full raw-byte SHA-256, filename, source, explicit
operator/time, optional product/variant references and `uncalibrated` status.
Metadata is deterministic for identical bytes **and identical supplied metadata**;
new timestamps change a record. The shortened hash ID is only a local label;
full SHA-256 is retained. Source/operator labels are user supplied, not authenticated.

`declaredPositionAccessorBounds` echoes the first referenced POSITION accessor's
min/max declaration. It is not a computed whole-model/scene bounding box. glTF
coordinates follow model-space conventions; synthetic dimensions have no verified
physical scale. No field derives millimetres from model values. Calibration,
landmarks and production coordinate frames remain Phase 5 work.

## Build and inspect

```sh
npm ci
npm run typecheck
npm test
npm run generate:models
```

`npm run build` compiles the portable layers and bundles `dist/dev/asset-inspector.html`
with inline JS/CSS, Three.js and the validator. Open that file directly, disconnect
networking, and choose either tracked GLB in `examples/models/`. The browser needs
WebGL2 for preview and WebCrypto for hashing. All runtime dependencies are bundled;
no Node, server, CDN or installation is needed to open the artifact. The artifact
is an internal harness, not the customer delivery promised by later milestones.

The deterministic generator and synthetic originals remain tracked. Never put
customer originals under these examples: use the ignored `customer-input/` or
`private/` paths. Third-party GLB originals and photographs require separate
provenance and applicable upload authorization before Tripo or other providers.

## Open gates

Real FlexiTog multi-product images/meshes, authorized Tripo access and comparison,
model quality/texture assessment, measured calibration, placement and package
editing remain pending. Windows Chrome/Edge direct `file://` verification is still
required; local macOS Chrome success is not Windows evidence.


## Current private development asset (2026-10-11)

For manual development inspection, use
`private/development-assets/jacket/model.glb`. Its preview, source GLBs/photos,
SHA-256 manifest and texture-transfer report are beside it. This ignored asset
is for development only, has no measured physical calibration and retains
sleeve/side color defects. It now has a local offline inspector acceptance run
on macOS Chromium/Chrome
(2026-10-15), including surface-picked synthetic calibration and placement
save/restore; see `docs/offline-testing.md`. This is development evidence only:
planar placement checks do not validate appearance on the curved jacket, and
there is no Builder/customer model bridge. Do not replace synthetic automated-test
fixtures with this asset.

Local inference experiments have been retired and model creation is deferred.
Their compact private evidence archive is retained; model weights and the old
Python environment are removed. A flat-image workflow will be discussed with
the Logo Department; it is not yet an approved change to the product scope.
