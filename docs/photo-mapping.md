# Photo mapping (optional, presentation-only)

Optional file `presentation/photo-mappings.json` (kind `additional`) maps
region millimetres to normalized image UV for reference-photo previews.
It never affects production geometry, validation, or export: the measured
placement diagram stays authoritative, and `provisional` status is a visual
trial, never production approval.

## Shape (version 1)

```json
{"version": 1, "mappings": [{
  "productId": "p", "variantId": "v", "regionId": "r1",
  "view": "front", "image": "presentation/front.png",
  "transform": {"a": 0.005, "b": 0, "c": 0, "d": 0, "e": -0.01, "f": 1},
  "calibrationId": "cal-1", "calibrationVersion": "3",
  "status": "provisional", "note": "trial"}]}
```

Keying is exact `(productId, variantId?, regionId, view, image)`; `image`
must equal an explicitly listed presentation raster path. No side/region
inference from labels or filenames.

## Math convention

Region mm are Y-up; UV has v = 0 at the TOP (raster row 0). The flip lives
in the coefficients (typically `e < 0`); the adapter applies the raw affine
with no hidden negation. `u = a*x+b*y+c`, `v = d*x+e*y+f`. Transforms must
be finite with `|det| > 1e-12`; the inverse is the exact algebraic inverse.

## API (`src/ui/customer-editor/presentation-photo-mapping.ts`)

- `parsePhotoMappings(bytes)` → `{version, mappings} | null` (malformed →
  null, never throws, never mutates input).
- `validatePhotoMapping(entry)` → `string[]` (empty = valid).
- `forwardPhotoMapping(entry, {xMm, yMm})` → `{u, v} | null`.
- `inversePhotoMapping(entry, {u, v})` → `{xMm, yMm} | null`.
- `selectPhotoMapping(m, present, productId, variantId, regionId, view,
  imagePath, lookup, context?)` → `{mapping, warning}`. Missing file → unmapped, no
  warning (legacy fallback); unusable → null + warning. Variant-scoped wins.
  When `context` (a `PhotoMappingContext`) is supplied, the entry must also
  agree with the CURRENT selection, region calibration (`calibrationId` +
  `calibrationVersion`) and a declared preview image/view binding
  (`validateMappingContext`), otherwise it is stale and falls back with a
  truthful warning — never a mislabelled photo or a calibrated-overlay claim.
- `serializePhotoMappings(m)` → deterministic bytes (sorted entries, fixed
  key order, no whitespace).

Issue filtering is built into `selectPresentationPackageAssets`, which keeps
only configuration-matching mappings whose image is a retained raster, and
appends the rewritten file after the preview manifest. Unmapped photos are
labelled reference-only; editing always uses the measured diagram.
