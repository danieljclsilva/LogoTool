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
