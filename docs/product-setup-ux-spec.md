# Product setup: visible calibration and direct area tools

25 October 2026. Baseline `b39e3c3`. UX decisions are owned by Codex;
OpenCode `opencode-go/muse-spark-1.3-contributor` implements this contract.
Preserve the reviewed lean refactor and existing three-step workflow.

## Layout and controls

The product setup subview uses the entire available width of the existing
application shell. The photo/model stage is a full-width row, never constrained
by the old 720 px cap or a two-column desk rail. Keep normal page gutters.
Put the following immediately above the stage, in this order:

1. Existing named view tabs (Images only; never ask a model product for photos).
2. Tools: reference measurement, safe area and anchors as applicable to mode.
3. View controls: `−`, percentage selector/readout, `+`, `Fit`; visibility
   toggles `Anchors`, `Safe areas`, `Product`. These belong to a clearly labelled
   compact toolbar touching the preview, not beneath long forms. Wrap it at
   narrow widths. Use existing styles, 44 px targets and keyboard focus rings.

The stage shows the whole product at Fit. At desktop widths >=1000 px,
its width fills the setup content and its initial usable height is roughly
55–65vh (bounded to avoid enormous portrait photos); on narrow screens use
the available width and a sensible 320–60vh height. Use contain, not crop or
stretch. Controls and status/measurement entry are outside the image, never
covering selectable product points. Details and named-area rows follow below.
Do not make the whole page horizontally scroll or add another top-level step.

Visibility controls remain adjacent when scrolling within a zoomed preview.
Do not duplicate controls above and below. Hiding a layer changes display
only: no loss of endpoints, area points, calibration, names or dirty drafts.
Anchors includes reference endpoints and their connecting measurement.
Safe areas includes their fill/outline/edit handles. Product hides only the
photo/mesh; overlays remain. Preserve the existing model-hidden picking guard.

## Reference measurement

Show point markers `A` and `B`. As soon as both are placed, connect them with
a dotted line, approximately 2 CSS px wide, and a readable midpoint label with
a white backing. Before a positive finite length is entered, label it
`Enter distance`; after entry show, for example, `1,300 mm`. Update while the
input changes, without requiring blur. Do not display an invented length.
The line and label stay aligned under resizing, zoom, pan and model orbit.
They remain visible after calibration and after saving/reopening the exact
photo/model scope. Replacing its asset must not reuse another scope's line.

An incomplete reference remains visibly incomplete. Replacing an endpoint
follows the existing stale/recalibration rules; do not silently approve or
recompute dependent physical areas. One valid two-point reference remains
sufficient. Model length is the straight span in native model coordinates
scaled to millimetres; no claim of curved/geodesic distance.

## Safe areas

Show every staged/saved named area's closed outline and a translucent blue
fill over the product (roughly 15–25% opacity; selected area distinguishable).
Connect draft points as the operator works and fill the draft once it has
three points. The photo/model must remain visible through the area. Keep
names readable and keep selection independent of overlapping fills.

Inside the Safe area tool provide two choices: `Freehand` and `Rectangle`.
Reuse the existing named-area list, rename/select/delete and Save setup.

For the 3D preview, place `Rotate model`, `Rectangle` and `Freehand` beside
the stage. Selecting a drawing tool enables it immediately, without a second
Start action. Suspend orbit at pointer-down before OrbitControls handles it;
release, cancellation and Escape restore navigation. Keep one mode hint and
action feedback beside the stage. Area names are optional while drawing;
generate a distinct default name when none was supplied. Completing an area
returns to Rotate mode with the selected area's handles available.

Visual safe-area fills must follow the asset triangles rather than a flat
fan cutting through garment folds. A polygon-masked surface decal is display
only: keep the picked points, calibrated region plane and mm data unchanged.
Do not paint the reverse side of a thin product or bypass depth occlusion.

- **Freehand:** press, drag to trace, release to close one area. Also retain
  clicking corners plus the existing Finish action for precision/keyboard
  use, in the same mode. Do not treat a tap as a completed freehand stroke.
  Simplify sampled traces within the existing polygon-point bound; reject
  degenerate/self-crossing/out-of-scope rings with a specific status instead
  of inventing a hull. A failed trace preserves the previous valid draft.
- **Rectangle:** press at one corner and drag to the opposite corner. Preview
  the closed filled rectangle while dragging. Release creates one four-corner
  area, not many pointer-move commits. Show corner and side-midpoint handles.
  Dragging a side moves that side with its two corners, preserving a rectangle;
  the opposite side stays fixed. Corner drags preserve rectangular shape.
  Reject zero-size/inverted/collapsed geometry without replacing the last
  valid area. Supply keyboard adjustments through the existing point controls.

Pointer capture keeps a drag coherent; Escape/pointercancel rolls it back.
Drawing/resizing stages one dirty change; Save setup is the persistence step.
Switching views/areas preserves each scoped draft. Rectangles persist as the
existing ordinary polygon representation; do not add a parallel area schema.
Reopened rectangular areas remain editable with side handles (recognize the
geometry using a documented tolerance). General polygons keep their vertices.

For **3D**, points must come from actual model surface picks. Keep native
model coordinates and existing planar region validation. Temporarily suppress
orbit while drawing/resizing, then restore it. Do not connect a freehand
stroke across missed surface hits or manufacture invisible surface points.
Rectangle corners/edge edits must resolve on a consistent planar model surface;
if a valid rectangle cannot be obtained, preserve the last valid draft and
explain that the surface cannot support this planar rectangle. Do not project
a flat rectangle onto an unsupported curved surface and call it calibrated.
Model safe-area meshes need translucent fills as well as outlines; dispose
replaced overlay resources. View changes never alter the stored polygons.

## Zoom

Use `50%`, `75%`, `100%`, `125%`, `150%`, `200%`, `300%`, `400%` plus Fit.
Define 100% as the fitted product view for this stage, not native image pixels.
Fit resets to that view and reads 100%. Plus/minus step through these values;
disable at bounds. Existing wheel/pan/orbit may remain if the percentage
readout stays consistent. Offer panning/scrolling inside a magnified stage
without stealing safe-area/reference gestures or causing page overflow.

Zoom is purely display/camera state. Picking and handles use the inverse of
the actual view transform; SVG/image coordinates must agree. Markers/labels
stay readable at a constant CSS size. Never apply zoom to calibration or mm
values, mesh geometry, saved safe areas, output measurements or production
status. Test this at 50%, 100% and 200%, including after resize/reopen.

## Remove unnecessary operator configuration

Remove the empty **Advanced product setup** disclosure from rendered setup.
Remove **Map artwork photos (optional visual trial)** and its manual
reference-pair form from the normal operator UI, together with handlers used
only by that form. Do not leave empty disclosures or dummy hidden controls
to satisfy old tests. Preserve automatic calibrated photo mapping, sidecar
parsing/persistence, reference images and the existing mm geometry pipeline.
An uncalibrated/unmapped view stays honestly uncalibrated; do not auto-invent
measurements. Useful existing precision controls may remain in their relevant
tool; show a disclosure only if it has real content.

## Acceptance

Use synthetic offline `file://` fixtures. Demonstrate dotted A/B + entered
length before/after calibration/reopen, filled named areas, freehand and
rectangle creation, side/corner resize, cancel/invalid rollback, visibility
without data loss, wide/narrow layout and zoom-invariant mm coordinates for
Images and supported planar 3D. Verify the real canvas/WebGL result, not just
presence of a toolbar or a stubbed viewer. Inspect desktop/narrow screenshots
with actual overlays. Preserve all exact geometry, counts, deterministic
Save/Open/issue behavior and zero network/page/console-error assertions.
No extra framework, installs, network assets, Odoo, private/customer data,
uploads/publishing, commits or pushes. Windows Chrome/Edge remains an
unverified delivery gate; macOS evidence must be labelled accurately.
