# Provisional `.logo-project` transport

Status: Phase 8 foundation only. The archive transport and offline inspection
preview work end to end with synthetic fixtures. There is no customer placement
editor, production importer/review workflow, production export, or released
customer package. Core and production schemas remain provisional pending Phase 1
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

Run `npm run build:package-preview` to build the HTML and issue synthetic
artifacts under ignored `dist/`:

- `project-package-inspector.html` — standalone inspection harness;
- `synthetic-zero-placement.logo-project` — empty fixture used by acceptance;
- `synthetic-package-transport-preview.zip` — hybrid transport preview containing
  exactly `OPEN_LOGO_CONFIGURATOR.html` and
  `SYNTHETIC_PACKAGE_TRANSPORT_PREVIEW.logo-project` at the ZIP root.

The multi-placement project comes from `examples/projects/project-multi.project.json`
and its exact referenced bytes from `examples/logos/`; the zero-placement
fixture comes from `examples/projects/project-empty.project.json`. All are
synthetic. The HTML is labelled as a transport preview, not a customer editor.
`npm run build` also emits these artifacts. No customer runtime installation,
server, CDN, remote asset, font, or network connection is used.

## Scope and release gate

The maintained Playwright suite extracts the generated hybrid ZIP into a
space-containing temporary directory, opens the HTML through `file://` in an
offline context, and covers chooser/drop, load/save/reopen, byte/domain
preservation, empty and mixed zero-placement configurations, atomic failure, and
obsolete reads. Results and environment evidence are recorded in
[`offline-testing.md`](offline-testing.md).

This is not full Phase 8: the harness does not edit placements, render products
or artwork, confirm revisions, import against an issued baseline, review for
production, or export production data. macOS Chromium/Chrome results are
engineering evidence only. Actual Windows Chrome and Edge over `file://` with
networking disabled remain untested release gates; no Edge result is claimed.
