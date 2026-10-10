# Asset prototype findings — 2026-10-10

## Observed implementation and checks

OMP delegated importer and viewer/UI/fixture work to separate workers. Its lead
reached the time limit before final integration. Codex completed bundle wiring,
independently reviewed it and corrected WebGL probing on the render canvas,
actual BIN length checks, strict UTF-8 parsing, intake limits, stale preview
clearing, wireframe reset, camera framing and unnormalized tetrahedron normals.
The bundled Khronos validator supplements the local offline-resource policy.

- `npm run typecheck`, build and 88 Node tests passed.
- Existing discovery audit: 18 synthetic Python tests passed; no live Odoo tests.
- Browser plugin unavailable; regular Playwright used installed Google Chrome
  154.0.8037.98 on macOS, headless, offline context, direct `file://` HTML.
- Desktop 1280×900 and narrow 390×844 inspection: both synthetic fixtures rendered,
  controls worked, original download matched bytes and SHA-256 matched the JSON
  sidecar. No HTTP(S) requests or console/page errors; no horizontal overflow.
- File selection and drag-and-drop both rendered. External HTTP buffer references
  were rejected before loading; malformed GLB rejected and previous preview cleared. Binary ranges and malformed
  UTF-8 have regression tests. Source fixtures are synthetic, not garment evidence.

Local QA scripts, logs, downloads and screenshots are under `/tmp/logotool-*` and
are intentionally not tracked. Recreate the build and checks for durable release
acceptance; this report records this development pass, not a Windows release test.

## Assumptions and unanswered questions

The supported resource/extension subset is deliberately bounded; real provider
output may need additional decoders or texture support after inspection. The 32
MiB budget is a prototype choice, not an observed production requirement. Browser
intake is not a hostile-file sandbox and large/nested assets may still need stronger
worker isolation and performance limits before customer use.

No FlexiTog images were acquired, no Tripo request ran, no real physical dimensions
were verified, and no production placement conclusions follow from these meshes.
Phase 4 remains partial until actual multi-product asset quality and generation
are compared through an authorized route. Phase 1 evidence gates and provisional
production/domain contracts remain unchanged.
