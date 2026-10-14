# Provisional `.logo-project` transport

Status: Phase 8 now has a provisional binary `.logo-project` transport, an
editable offline synthetic planar customer prototype, and a separate internal
return-review harness. These workflows remain prototypes: no real product
calibration, approved production schema/export, customer deployment, or Windows
release gate. Core and production schemas remain provisional pending Phase 1
Odoo evidence review.

## Archive contract

`src/packaging/project-package` implements a ZIP archive with a canonical UTF-8
`manifest.json` and binary files at their unchanged in-package paths. The
manifest has its own version, independent of the unchanged `ProjectDocument`:

```json
{
  "assets": [
    {
      "kind": "referenced",
      "path": "logos/synthetic-mark.svg",
      "sha256Hex": "<lowercase SHA-256>",
      "size": 123
    }
  ],
  "format": "logo-project",
  "formatVersion": "0.1.0-provisional",
  "project": { "schemaVersion": "0.1.0-provisional" }
}
```

The displayed values are illustrative; the package stores the complete original
project document, not a reduced example. The `assets` index is sorted by path
and records each entry's `path`, `kind`, byte `size`, and SHA-256. Every existing
`logos[].assets[].uri` reference must have exactly one referenced binary entry.
Optional `additionalAssets` are allowed only as indexed `additional` entries;
they do not add product/domain mappings. The transport preserves project fields,
including mm placements, instructions, revision/confirmation, review, and their
histories. It does not sanitize the project or establish trust in confirmation
or review fields.

Writer output uses sorted ZIP paths, canonical JSON, a fixed 1980-01-01 ZIP
DOS timestamp, and only stored or DEFLATE compression. The reader intentionally
accepts a narrow classic ZIP profile: no ZIP64 or multi-disk archives, comments,
extra fields, directory entries, symlinks, encryption, data descriptors, or
other compression methods. Names must be portable relative paths with no
traversal, absolute/drive paths, reserved Windows names, unsafe separators, or
case-insensitive collisions. Duplicate, unindexed, missing, or mismatched
entries fail closed. SHA-256 and ZIP CRC-32, declared lengths, and actual output
lengths are checked. Imported HTML/SVG and other assets remain inert bytes; the
inspector never executes or renders them.

The reader scans the complete central directory and local headers, checking
archive, per-entry, manifest, entry-count, and total decompression budgets before
allocating file output. DEFLATE input is fed to the pinned `fflate@0.8.2`
streaming inflater in 64-byte chunks; output is copied into an exact-size buffer
only after declared budgets pass, and the callback aborts if actual output
exceeds it. The module documents the inflater's bounded transient allocation.
The ZIP parser relies on the pinned inflater's stream state to reject incomplete
or trailing DEFLATE data; a dependency upgrade requires review of this bound and
stream check.

| Limit | Maximum |
| --- | ---: |
| Archive bytes | 48 MiB |
| Manifest bytes | 4 MiB |
| One binary asset | 16 MiB |
| Sum of binary assets | 40 MiB |
| Total decompressed bytes, including the manifest | 42 MiB |
| ZIP entries, including `manifest.json` | 256 |
| UTF-8 path length | 1,024 bytes |

The hash adapter is injected as an asynchronous `Uint8Array -> lowercase
SHA-256 hex` callback. Browser UI uses Web Crypto; Node tests and the synthetic
build script use Node crypto. `src/core` remains unchanged and browser/Node
independent.

## Offline transport preview

`src/ui/project-package-inspector` builds to the fully inline
`dist/project-package-inspector.html`. It supports Choose Project and drag/drop,
validates before replacing the current in-memory project, and ignores stale
asynchronous reads. It shows project/revision, an explicitly untrusted customer
confirmation and pending-review summary, a millimetre placement table (including
named zero-placement configurations), and asset metadata only. Download saves
the same `.logo-project` format; there is no editing UI or persistence
requirement. Arbitrary imported strings are inserted as text, not HTML.

Run `npm run build:customer-prototype` to emit ignored development artifacts
under `dist/` (also emitted by `npm run build`):

- `project-package-inspector.html` — unchanged transport-only inspection harness;
- `synthetic-zero-placement.logo-project` — zero-placement fixture;
- `synthetic-package-transport-preview.zip` — unchanged two-entry transport preview;
- `customer-configurator.html` — fully inline synthetic customer editor;
- `customer-return-review.html` — separate fully inline internal-review harness;
- `trusted-issued.logo-project` — development-only issued baseline for review tests;
- `synthetic-customer-prototype.zip` — `customer-configurator.html` plus
  `SYNTHETIC-CUSTOMER.logo-project` at the ZIP root.

The customer and reviewer pages bundle all runtime code; they use no server,
CDN, remote fonts, sibling-file fetch, network, or installation. The issued
package is a clone of `examples/projects/project-multi.project.json` plus the
exact original bytes from `examples/logos/`. The clone starts a new authored
issue at revision 1 with confirmation, review, and their histories deliberately
cleared; the source example is never modified. All names, placements, products,
coordinates and assets are synthetic.

The editor displays measured boxes in region millimetres over schematic safe and
exclusion outlines. Artwork bytes stay inert and are not rendered. This is not a
3D, photograph, garment-surface or real-calibration mapping. The prototype can
edit well-formed geometry-invalid drafts, but confirmation, submission and
internal approval require current safe-area/exclusion and method checks. A
structurally valid non-fitting draft can receive a changes-requested review. Submission
means customer-confirmed/pending-internal-review, never production approval.

The editor rejects oversized counts, coordinates and polygon rings before
rendering. A combined 8,000,000-unit geometry-work budget also bounds repeated
quadratic ring validation across placements; these are engineering guards, not
manufacturing limits.

## Scope and release gate

The maintained Playwright suite extracts the generated customer ZIP into a
space-containing temporary directory and opens the inline editor through
`file://` while offline. DOM-level acceptance covers project chooser/drop,
editing and dragging measured boxes, drafts and fresh confirmation, saved/reopened
assets and revision data, and stale-operation rejection. A separate reviewer
spec loads an explicitly selected issued baseline and return, compares definitions
and exact archive asset bytes, rejects stale/forged approval data atomically,
records local review bookkeeping, and exports a revised proposal with prior
confirmation/review retained only as history. Results and environment evidence
are recorded in [`offline-testing.md`](offline-testing.md).

This is functional synthetic workflow evidence, not the full Phase 8 delivery
gate. Product calibration and coordinates are invented; there is no artwork
preview, curved/3D surface mapping, production export/PDF, authenticated review,
or Odoo write integration. macOS Chromium/Chrome runs are engineering evidence
only. Actual Windows Chrome and Edge over `file://` with networking disabled
remain untested release gates; no Edge result is claimed.
