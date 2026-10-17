# Logo Station proof desk

The approved B+C direction combines a white FlexiTog proof desk with a guided
Position → Size → Review flow. It follows familiar business-software navigation
and the supplied product-proof hierarchy: product first, artwork and one task
beside it. It does not introduce a new dashboard or require customer setup.

## Visual rules

Use white surfaces, graphite text, muted secondary labels, thin neutral separators
and FlexiTog red for the active step and main action. The original brand image
is bundled inline. System fonts keep delivery independent of font services.
Shared brand/header styles also identify the Builder and return reviewer.

Show only the current task. Fixed choices become readable labels. Alternative
products and artwork live in a disclosure; precise measurements and technical
references have separate contextual disclosures. Width is the initial Size
control. Continue applies edits before advancing, while step tabs preserve
pending edits. Review groups every product and placement, with exact sizes,
method, area, fit and supplied notes; position/rotation remain accessible.

Product photography is an unmapped visual reference. A separate placement
diagram uses the saved millimetre geometry. Neither a photo nor a customer
confirmation supplies real calibration or manufacturing approval.

## Visual acceptance ledger — 2026-10-16

Codex compared the accepted combined concept with rendered offline screenshots
at the same native 1536×1024 viewport, then inspected 1280×900 and 390×844 layouts.
Private concept, original-asset demonstration and screenshots remain outside
tracked public fixtures. Screenshots were inspected with `view_image`.

| Comparison | Implemented result / intentional difference |
| --- | --- |
| Layout | Approximately 65/35 product/task split, one rail, thin divider, generous white space. Product pane stays stable during long reviews. Mobile stacks product before task. |
| Branding | Exact supplied red FlexiTog source mark and Logo Station title; white header with small Save draft. No generated replacement logo. |
| Typography | Large graphite task heading, readable labels, restrained secondary text. Native system font replaces the concept's approximate font to keep delivery offline. |
| Palette | White, graphite, muted blue-grey, fine neutral rules and red active/primary actions match the concept hierarchy. Fit feedback stays green or explicit red text. |
| Assets | Original extracted raster artwork and product source replace ImageGen approximations. Their original framing/transparent margins remain, so the garment occupies less space than in the concept. No product-specific crop or fake logo overlay. |
| Controls | Width first; height, rotation, method and ratio control disclosed. Fixed selectors disappear. Continue/Review layout is primary; Undo and More actions sit below the canvas. |
| Copy | Position, Size, Review; readable product/artwork context; concise fit feedback. Schema/calibration identifiers are disclosed. Review replaces the original dense text dump with product and placement groups. |
| Necessary additions | Compact project-file/details strip, explicit diagram/reference toggle and truthful synthetic status. These support local loading, measurement clarity and the prototype boundary. |

No horizontal overflow, console/page errors or HTTP(S) requests were observed in
nine private-demo task/viewport captures or eight public-entrypoint captures.
The mobile task screenshots intentionally scroll to the active task; initial
mobile captures separately check header/product ordering. Review can scroll for
multiple products or expanded details. Automated checks cover keyboard disclosure,
ratio unlock, primary-action creation of zero/repeated placements, confirmation,
actual downloads, exact-byte round trips and cancellation of a drag on view switch.

See `offline-testing.md` for commands, browser versions, counts and release gaps.

## Internal Builder — 2026-10-17

The internal Builder now uses the same proof-desk language. Two header modes
separate preparing a customer delivery from checking a return. Preparation shows
one step: Open project → Choose items → Customer details → Save & send. The
return flow starts with the saved office copy, followed by the customer return
and Check & prepare. Future tasks are unavailable until their prerequisites exist.

The default staff journey needs three familiar details: customer name, job
reference and prepared by. A local issue identifier is generated once and stays
stable across navigation and repeated generation; manual overrides, a new-ID
action and ZIP format live in More options. Staff save two clearly named files:
an office copy retained for comparison and a customer file sent manually.
No action claims files were sent or persisted just because downloading started.

Return checks show readable file names, customer confirmation, fit and exact
before/after changes. Unchanged logos are omitted from the concise comparison;
all original comparison/measurement evidence stays available in a disclosure.
Changed positions and rotations remain explicit; origin/axis definitions are
available on demand. Pending internal review stays distinct from approval.
The operation document is available through a preview action and native print.

### Builder visual comparison

Codex inspected both ImageGen references and the latest offline browser captures
using `view_image` at native1536×1024, with1280×900 and390×844 checks. References
are ignored `private/design-concepts/2026-10-17/internal-builder/choose-items.png`
and `review-return.png`; prompts are saved alongside them. No generated screenshot
is shipped as the application UI. Browser evidence is under
`/tmp/logotool-builder-redesign/visual/`.

| Comparison | Final implementation |
| --- | --- |
| Brand and palette | Exact existing FlexiTog image, white header/background, graphite text, red primary actions and active steps, thin neutral rules. |
| Page structure | Open content/task rail, preparation and return modes, one current task; the previous long stack of panels is removed. |
| Typography and spacing | Shared system font and customer-interface hierarchy; wide laptop gutters and readable row spacing. |
| Control hierarchy | One primary task action; three default identity fields, advanced settings collapsed, two clearly described downloads. |
| Selection copy | Reference heading and lede retained; real synthetic fixture names/counts replace concept sample values. Internal IDs are hidden from readable rows. |
| Return comparison | Real before/after dimensions, notes and status replace raw technical output. Measurements and exact original diffs remain accessible. |
| Responsive behavior | Compact two-column step navigation on narrow screens; content precedes task actions, with no horizontal overflow. |
| Necessary differences | Full reviewer is downloaded, so its action says Save full reviewer rather than falsely claiming to open it. Step navigation changes input files; no redundant Change file links. A preview toggle keeps the operation document out of the default task. The generated INTERNAL BUILDER eyebrow and decorative icons are omitted to preserve the existing brand system. |

Material drift corrected during review: raw IDs in choice labels, technical
return dumps, hidden load errors, incorrect selected-option counts, navigation
to empty download screens, oversized mobile progress navigation, long unwrapped
technical text and handoff actions pushed below lengthy comparisons. The
implemented surfaces were verified faithfully against the design references
with these explicit functional differences.

## Create a project — 2026-10-17

Start now offers a primary **Create a project** action and a collapsed **Open an
existing project** path. Creation assembles a fresh draft from an inline prepared
example catalogue; it does not open or rename a previous customer job. The
catalogue is explicitly synthetic, with no claim of production calibration.
New product definition/calibration authoring is a separate workflow.

Choose items adds **Add a customer logo**. PNG/JPEG/WebP imports preserve original
bytes, provide readable names and select the new artwork. Product, option,
specific-setup and existing artwork choices remain unchanged. Options for unticked
products collapse without losing their checkbox state. Counts use singular or
plural labels appropriately. New logos have pixel dimensions and an original
artwork role; physical sizes remain customer choices in the measured editor.

Codex inspected the scoped extension against the established Builder proof-desk
references with `view_image`. White surfaces, original red brand, graphite type,
thin separators, task rail, primary-action hierarchy and compact mobile navigation
remain consistent. Start copy now explicitly describes creation versus opening;
no unrelated controls or new visual system were introduced. Native-size1536×1024,
1280×900 and390×844 screenshots cover Start, choices, imported artwork, details,
download and return review. Evidence is outside tracked source under
`/tmp/logotool-create-project/visual-final/`. No new generated raster UI was needed
for this extension of the existing design system.
