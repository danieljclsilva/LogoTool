# FlexiTog Logo Station 3D Configurator
## Codex Project Handoff

## 1. Objective

Build an offline 3D logo-placement system for FlexiTog's Logo Station operation.

The system must let FlexiTog prepare a customer-specific project containing one or more products. The customer should be able to open the supplied tool locally, visualize products in 3D, place one or more logos, edit their positions and dimensions, enter relevant instructions, and export the structured information required for Logo Station production.

The primary customer handoff is a round-trip project: FlexiTog issues a project,
the customer configures it and records pre-approval of the exact configuration,
then saves and emails the updated project back. Logo Station reviews that return
before approving production. Customer measurements are optional inputs; the tool
creates structured placement measurements from visual editing on prepared products.

Before finalizing the domain model, inspect real Logo Station data in Odoo.

Odoo discovery is the first major task.

Do not assume that the production workflow, product hierarchy, placement rules, BoM structure, product categories, or logo data work exactly as described below. Verify them against actual records.

Treat Odoo discovery as read-only unless explicitly instructed otherwise.

---

# 2. Core product philosophy

The system is not fundamentally:

```text
put a logo on a 3D shirt
```

It is:

```text
customer visual decision
        ↓
structured physical placement
        ↓
production specification
        ↓
Logo Station manufacturing
```

The 3D model is a visualization layer over structured physical production data.

Production measurements must not depend on pixels, camera perspective, screen resolution, or approximate visual interpretation of the 3D model.

---

# 3. Hard requirements

## No hosting

The customer-facing configurator must not require:

- a hosted website;
- cloud hosting;
- application server;
- backend API;
- database server;
- localhost server;
- Node.js;
- Python;
- browser extension;
- CDN;
- Internet connection after package delivery.

Everything necessary to configure the job must be available locally.

## Low customer friction

Assume customers:

- can download files;
- can unzip ZIP archives;
- can open normal HTML files;
- may not be permitted to execute supplied `.exe`, `.msi`, `.app`, or similar applications.

Primary runtime:

```text
modern desktop browser
```

Primary initial target:

```text
Windows + Chrome / Edge
```

No installation should be necessary.

---

# 4. Architecture direction

The initial implementation should use web technologies but be structured so that the same application can later be wrapped in Tauri without rewriting core logic.

Recommended baseline:

```text
TypeScript
React
Three.js
Vite
```

The browser is currently the deployment runtime, not the architectural boundary.

Keep business logic independent of browser APIs.

Conceptually:

```text
src/
├── core/
│   ├── products/
│   ├── variants/
│   ├── anchors/
│   ├── regions/
│   ├── placements/
│   ├── logos/
│   ├── production/
│   ├── calibration/
│   ├── validation/
│   └── serialization/
│
├── viewer/
│   ├── three/
│   ├── models/
│   ├── surface-mapping/
│   └── logo-rendering/
│
├── assets/
│   ├── generation/
│   ├── import/
│   ├── optimization/
│   └── validation/
│
├── packaging/
│   ├── project-package/
│   ├── hybrid-package/
│   └── self-contained-html/
│
├── ui/
│   ├── builder/
│   ├── calibration/
│   └── customer-configurator/
│
├── platform/
│   ├── interfaces/
│   └── browser/
│
└── shared/
```

A future Tauri version should mostly add:

```text
platform/tauri/
```

Do not tightly couple domain code to:

```text
window
document
localStorage
browser downloads
<input type="file">
```

Wrap these behind interfaces/adapters.

---

# 5. Main system components

There are three primary internal workflows.

## A. Product Asset Creation

Creates and calibrates reusable product definitions.

Responsibilities include:

- create/import 3D model;
- associate model with Odoo product(s);
- define product category;
- define variants;
- define semantic anchors;
- enter real measurements;
- define decoratable surface regions;
- define safe placement regions;
- define exclusion zones;
- define permitted decoration methods;
- define variant-transfer rules;
- validate the 3D mapping.

## B. Logo Package Builder

Internal FlexiTog-facing tool.

Responsibilities:

- select customer/job;
- select relevant products;
- select variants;
- associate relevant Odoo records;
- associate known logos when applicable;
- choose only required product assets;
- generate customer project;
- generate either supported distribution format;
- validate package;
- display estimated package size.

## C. Customer Logo Configurator

Customer-facing tool.

Responsibilities:

- load supplied project;
- select product / variant;
- inspect product in 3D;
- add one or more logos;
- select placement region;
- move, resize, rotate and configure each logo;
- enforce constraints;
- show physical measurements;
- accept written instructions;
- review complete configuration;
- export structured production result.

---

# 6. Distribution modes

The same canonical project must support two packaging modes.

These are packaging choices, not separate applications.

## Mode A — Self-contained HTML

Example:

```text
ABC_Logistics_Plover.html
```

Everything is embedded:

- application code;
- CSS;
- dependencies;
- project manifest;
- models;
- textures;
- calibration;
- product data;
- customer/job information.

Appropriate when:

- package is reasonably small;
- one-file delivery is useful.

Do not let this packaging format dictate the internal domain architecture.

---

## Mode B — HTML application + project package

Default expected mode.

Example:

```text
ABC_LOGISTICS_JOB.zip
│
├── OPEN_LOGO_CONFIGURATOR.html
└── ABC_LOGISTICS.logo-project
```

`OPEN_LOGO_CONFIGURATOR.html` contains the complete application.

`.logo-project` contains customer/project-specific data and assets.

The project format may internally be a ZIP with a custom extension.

Example:

```text
ABC_LOGISTICS.logo-project
│
├── manifest.json
├── products/
│   ├── plover.glb
│   └── trousers.glb
├── product-data/
│   ├── plover.json
│   └── trousers.json
├── thumbnails/
├── logos/
└── metadata/
```

The customer should:

```text
unzip
↓
open HTML
↓
choose / drag project file
↓
use tool
```

Avoid relying on `fetch()` against sibling files under `file://`.

Load project data using:

- File API;
- drag/drop;
- Blob;
- ArrayBuffer;
- in-memory decompression.

---

# 7. Canonical project principle

The system should conceptually be:

```text
Canonical Project
      │
      ├──→ Self-contained HTML
      │
      └──→ HTML + .logo-project ZIP
```

Packaging must not change semantics.

The same source project should produce equivalent behavior and equivalent production results in both modes.

---

# 8. Odoo discovery — first major phase

Codex should inspect real Logo Station records before finalizing the product schema or production-output schema.

Investigate several representative jobs end-to-end.

Prefer examples covering:

- different product types;
- one-logo jobs;
- multiple-logo jobs;
- different variants;
- customer-specific products;
- repeated/reordered finished products;
- unusual placements;
- different decoration methods if available.

Known product/example references may include:

```text
REWESW2-FO1000-05
Cotton T-Shirt PLOVER

S325806
S287206
S305742

04368
150383
00303
33507
04185
```

Determine what each record actually represents before relying on it.

---

# 9. Product-category discovery

Inspect BoMs, products and finished products to determine the common categories FlexiTog Logo Station already processes.

We currently expect examples such as:

```text
T-shirts
Polo shirts
Sweatshirts
Gilets
Trousers
Salopettes
Coveralls
Hi-visibility vests
Caps
```

But do not use this as the definitive taxonomy.

Use Odoo evidence.

Determine:

- common product categories;
- subcategories;
- frequency where reasonably inferable;
- common placement regions by category;
- common number of logos per finished product;
- common decoration methods;
- common variant structures.

Produce an evidence-based category model rather than building the application specifically around shirts.

---

# 10. Odoo workflow reconstruction

Trace representative jobs through relevant records.

Investigate relationships conceptually similar to:

```text
Customer / request
        ↓
Sales order / ticket / Logo Station request
        ↓
Base product
        ↓
Variant
        ↓
Logo component(s)
        ↓
Placement information
        ↓
BoM
        ↓
Manufacturing / work order
        ↓
Finished logo product
        ↓
Finished SKU
```

The real Odoo chain may differ.

Document reality, not assumptions.

---

# 11. Odoo information to inspect

## Customer/job

Determine where the following live:

- customer;
- sales order;
- Logo Station request;
- internal job number;
- revisions;
- responsible employee;
- status;
- dates;
- related attachments.

## Base product

Determine:

- `product.template`;
- `product.product`;
- SKU/internal reference;
- attributes;
- size;
- color;
- product category;
- relevant custom fields.

## Finished product

Determine:

- finished SKU;
- relation to base product;
- relation to customer;
- relation to logo design;
- relation to variant;
- whether each finished configuration receives a separate SKU;
- whether finished product templates are reused.

## Logos

Determine:

- whether logos exist as inventory products;
- SKU/internal reference;
- customer ownership;
- design identity;
- dimensions;
- variants;
- colors;
- production method;
- quantity;
- attachments/artwork;
- BoM usage.

## BoMs

Inspect:

- finished product;
- components;
- base garment;
- logo components;
- quantity;
- variants;
- operations;
- work centers;
- instructions;
- attachments;
- custom fields.

Multiple-logo products are expected.

Do not assume:

```text
one product = one logo
```

A finished item may have:

```text
left chest logo
+
back logo
+
sleeve logo
```

or other combinations.

## Work/manufacturing orders

Determine what Logo Station operators actually receive and use.

Inspect whether records such as:

```text
NLVW/PC/XXXXX
NLVW/Pre-Production
```

are relevant and how.

Determine what information operators actually need to manufacture the item.

---

# 12. Odoo discovery output

Create:

```text
docs/odoo-discovery.md
```

Include:

## Record chains

For representative jobs:

```text
model / record
↓
model / record
↓
model / record
```

## Technical fields

Record:

- Odoo model;
- technical field name;
- type;
- example;
- relationship;
- standard/custom if determinable.

## Source-of-truth matrix

Example:

```text
Information            Source                       Confidence
Finished SKU           product.product              High
Logo component         mrp.bom.line / product       High
Placement instruction  ???                          Medium
```

## Product-category findings

Document:

- common categories;
- examples;
- common variants;
- common logo counts;
- common placement areas;
- common production methods.

## Data gaps

Identify information that production needs but Odoo does not currently structure.

These gaps may be exactly where this tool should introduce better structured data.

## Observed vs proposed

Keep separate:

```text
Observed current workflow
```

and:

```text
Proposed improvement
```

---

# 13. Generalized product model

Do NOT design application logic around clothing-specific product types.

The fundamental abstraction should be:

```text
Product
│
├── Variant(s)
├── 3D model
├── Semantic anchors
└── Placement regions
     ├── physical coordinate system
     ├── mesh mapping
     ├── safe area
     ├── exclusion zones
     ├── physical dimensions
     └── constraints
```

Product categories help initialize templates but should not determine fundamental placement logic.

---

# 14. Placement region abstraction

A placement region is any decoratable physical surface.

Examples:

```text
T-shirt        → left chest
Polo           → right chest
Sweatshirt     → center front
Gilet          → upper back
Trousers       → left thigh
Salopette      → bib front
Coverall       → chest / sleeve / leg
Hi-vis vest    → back panel
Cap            → front crown
```

The application should not need custom placement code for each.

Each region should have its own local physical coordinate system measured in millimetres.

Example:

```text
placement:
    region = "left_chest"
    x_mm = -72
    y_mm = 145
    width_mm = 90
    height_mm = 38
    rotation_deg = 0
```

This structured physical representation is authoritative.

---

# 15. Coordinate-system principle

Maintain three distinct coordinate systems.

## Production space

Authoritative.

```text
millimetres
```

## Model space

Approximate 3D geometry.

```text
mesh coordinates
```

## Screen space

Visualization only.

```text
pixels
```

Direction of conversion:

```text
production mm
     ↓
surface mapping
     ↓
3D model
     ↓
camera projection
     ↓
screen pixels
```

Do not derive production measurements from rendered pixels.

For visual editing, use the pointer to select a point on the product surface,
then use that region's calibrated inverse surface mapping to obtain physical
coordinates. Resize and rotate in physical units, updating the visual from those
values. Camera zoom, viewpoint and screen resolution must not change the saved
placement. Product calibration is prepared internally and reused; the customer
does not need to supply the physical coordinate frame.

In other words:

```text
calculate pixels from mm
```

not:

```text
calculate mm from pixels
```

---

# 16. Semantic anchors

Each product should contain semantic landmarks.

Anchors vary by product.

Examples:

## Upper-body garment

```text
neck_center
left_shoulder
right_shoulder
left_armpit
right_armpit
center_front
hem_center
left_side
right_side
```

## Trousers

```text
waist_center_front
left_hip
right_hip
left_knee
right_knee
left_hem
right_hem
outer_leg_seam
```

## Cap

```text
front_center
crown_top
left_front_seam
right_front_seam
visor_center
```

Do not hardcode these into application logic.

Generic model:

```text
Anchor {
    id
    semanticRole
    meshPosition
    metadata
}
```

---

# 17. Physical calibration

AI or photogrammetry geometry should not automatically be considered dimensionally authoritative.

Calibration should be based on known real measurements.

Example:

```text
neck_center → hem_center = 720 mm
left_shoulder → right_shoulder = 470 mm
```

The calibration tool should allow an internal user to:

```text
click anchor A
click anchor B
enter real distance in mm
```

Multiple measurements should be used where practical.

Use them to determine or validate mesh-to-physical mapping.

Do not use screen pixels as the unit of calibration.

---

# 18. Surface mapping

Each placement region needs a function conceptually equivalent to:

```text
2D physical coordinates (mm)
        ↓
3D mesh surface
```

Define a common interface such as:

```text
SurfaceMapping

map2DTo3D(xMm, yMm)
map3DTo2D(point)
```

Possible implementations may include:

```text
PlanarMapping
UVMapping
BarycentricMeshMapping
WarpedPatchMapping
```

The rest of the application should not care which mapping implementation a region uses.

Flat areas may use simple mappings.

Curved areas such as:

```text
cap crown
sleeve
shoulder
trouser leg
```

may require warped or UV-based mappings.

---

# 19. Safe placement areas

Safe areas should not be assumed rectangular.

Represent them as arbitrary polygons in the region's physical coordinate system.

Example:

```text
safeArea = [
    [x1, y1],
    [x2, y2],
    [x3, y3],
    ...
]
```

Support exclusion zones.

Examples:

```text
zipper
pocket
seam
reflective strip
reinforced panel
button area
```

Validation should be geometric.

Possible outcomes:

```text
valid
warning
invalid
```

---

# 20. Decoration constraints

Placement constraints may depend on production method.

Potential methods:

```text
embroidery
heat transfer
screen print
badge
other
```

Determine actual methods from Odoo.

A placement region may define:

```text
allowedMethods[]
```

and method-specific constraints.

Do not invent production limits without evidence.

---

# 21. Multiple-logo support

Multiple logos are a first-class requirement.

A product configuration should contain:

```text
placements[]
```

not:

```text
logo
```

Conceptually:

```text
Configuration
└── placements[]
    ├── logoId
    ├── placementRegion
    ├── decorationMethod
    ├── xMm
    ├── yMm
    ├── widthMm
    ├── heightMm
    ├── rotationDeg
    ├── constraints
    └── instructions
```

The same product may contain:

```text
different logos
```

or:

```text
multiple instances of the same logo
```

in different regions.

Investigate BoMs to understand common patterns.

---

# 22. Variant transfer

Variants may differ in:

```text
size
color
cut
geometry
SKU
BoM
placement area
```

Do not assume all variants share exactly the same calibration.

Support transfer strategies such as:

```text
absolute offset
relative position
proportional scaling
fixed-size logo
variant-specific override
```

Example:

```text
semantic:
xRatio = -0.30
yRatio = 0.22
```

can resolve differently for:

```text
M
XL
```

based on real dimensions.

Some production rules may instead be absolute:

```text
120 mm below collar
```

Support both.

---

# 23. Shared topology / UVs

If future model generation produces variants with identical topology and UV layouts, use this to simplify placement transfer.

For example:

```text
UV = (0.42, 0.31)
```

could correspond to the same semantic position across variants.

However, do not require this initially.

AI-generated models may not naturally share topology.

Preferred fallback hierarchy:

```text
shared topology / UV
        ↓
semantic anchors + normalized position
        ↓
variant-specific anchor calibration
        ↓
manual correction
```

---

# 24. Product category templates

Once Odoo discovery reveals the common categories, create reusable setup templates.

Example:

```text
Upper-body template
Lower-body template
Full-body template
Headwear template
```

More specific templates may follow:

```text
T-shirt
Polo
Sweatshirt
Trousers
Coverall
Cap
```

Templates should suggest:

- semantic anchors;
- likely placement regions;
- common constraints.

They must remain editable.

Product category is metadata and setup assistance, not core placement logic.

---

# 25. 3D asset pipeline

3D assets are an explicit upstream subsystem.

Conceptually:

```text
Source photographs / external model
        ↓
3D Asset Pipeline
        ↓
Master Product Asset
        ├── model.glb
        ├── textures
        ├── dimensions
        ├── anchors
        ├── calibration
        ├── regions
        └── provenance
        ↓
Logo Package Builder
```

---

# 26. 3D model creation — Tripo API

For initial prototype work, use Tripo's API as the preferred automated generation route.

Input should support multi-view product photographs when available.

Likely useful views:

```text
front
back
left
right
```

or the best corresponding views available from the FlexiTog website.

Do not hardcode the system so Tripo is required forever.

Implement generation behind an abstraction such as:

```text
ModelGenerator
```

Example implementation:

```text
TripoModelGenerator
```

The output should enter the same asset pipeline as any externally supplied GLB.

Do not hardcode API secrets.

Use environment/configuration mechanisms appropriate for the development environment.

---

# 27. External 3D model import

The Product Asset tool must also allow direct import of a 3D model.

This is necessary for models created by:

```text
RealityScan
Polycam
Blender
manual modelling
future AI tools
external suppliers
other photogrammetry systems
```

Initial preferred runtime format:

```text
GLB / glTF
```

The workflow should therefore support both:

```text
Generate 3D model
```

and:

```text
Import existing model
```

Both then proceed into the same calibration workflow.

---

# 28. Prototype model source

For the first prototype:

1. select a well-photographed FlexiTog website product;
2. use its existing website photographs;
3. generate a model through Tripo API;
4. export/import GLB;
5. visually inspect;
6. calibrate physical dimensions manually;
7. define regions and anchors.

Do not treat this prototype generation procedure as guaranteed production methodology.

---

# 29. Future photography procedure

When existing photographs are inadequate, the system should support a controlled source-capture process.

A product should preferably be:

- placed on a standardized mannequin/form where applicable;
- steamed/arranged consistently;
- photographed under stable diffuse lighting;
- photographed against a contrasting background;
- photographed using one camera/lens configuration;
- kept geometrically unchanged through capture.

For AI multi-view generation, capture at minimum useful views such as:

```text
front
back
left
right
```

and additional ¾ views where helpful.

For photogrammetry, use substantially greater overlap and coverage.

Do not require photogrammetry-level photography for every product if AI multi-view generation proves adequate.

---

# 30. Product Asset Calibration workflow

A product setup workflow should eventually resemble:

```text
Create Product Asset
        ↓
Associate Odoo product
        ↓
Choose / infer category
        ↓
Generate model OR import GLB
        ↓
Inspect model
        ↓
Mark semantic anchors
        ↓
Enter known real measurements
        ↓
Calibrate physical mapping
        ↓
Define placement regions
        ↓
Draw safe areas
        ↓
Draw exclusion zones
        ↓
Set permitted methods
        ↓
Configure variant transfer
        ↓
Validate
        ↓
Save master product definition
```

---

# 31. Product definition

Design a generic canonical schema capable of representing:

```text
identity
Odoo references
category
base product
finished-product relationships
variants
3D models
textures/materials
semantic anchors
physical measurements
calibration
placement regions
surface mappings
safe areas
exclusion zones
decoration methods
variant-transfer rules
version
provenance
```

Do not overfit the schema to Plover.

Test against multiple substantially different product categories discovered in Odoo.

---

# 32. Logo definition

A logo entity should be independent from its placement.

Conceptually:

```text
Logo
├── identity
├── Odoo references
├── customer
├── source artwork
├── design metadata
├── dimensions if known
├── production metadata
└── variants if applicable
```

Placement references a logo.

This allows:

```text
same logo + multiple placements
different logos + same product
```

---

# 33. Project format

Define a versioned canonical project manifest.

Conceptually:

```json
{
  "formatVersion": 1,
  "projectId": "...",
  "customer": {},
  "odoo": {},
  "products": [],
  "logos": [],
  "configurations": [],
  "metadata": {}
}
```

Final fields should be based on Odoo discovery.

Use explicit versioning from the beginning.

The canonical project must also support the customer-to-Logo-Station round trip:

- retain the issued project identity, revision and relevant product, calibration,
  region, constraint and artwork definitions so the return can reopen offline;
- store editable configurations for the selected products and variants, with
  0..N placements, physical positions and logo dimensions in mm, rotation,
  coordinate-frame references, applicability and customer instructions;
- preserve original artwork separately from references and generated previews;
- record customer pre-approval against an exact configuration revision/content
  digest, with confirmation details and validation results;
- preserve separate Logo Station review decisions and revision history;
- allow a draft save without pre-approval and a clearly identified submission
  export with customer pre-approval, pending Logo Station review.

These are required capabilities, not a finalized list of manifest field names.
Editing a confirmed configuration makes its previous pre-approval historical;
the changed configuration must be confirmed again. Customer confirmation is
distinct from Logo Station authorization to manufacture. An imported customer
return never creates internal approval by itself.

The internal importer compares the return with the issued project, validates it
against the internal product definitions and presents differences for review.
Customer edits must not silently replace internal calibration or placement rules.
Returned projects can be used to prepare richer ticket content and attachments;
automatic Odoo ticket creation is a later write integration requiring separate
authorization. The offline customer tool only saves the return for the customer
to attach to email; it does not require email or Odoo connectivity.

---

# 34. Production result

Do not finalize this schema until Odoo discovery establishes actual requirements.

Architecturally support a versioned result container such as:

```text
ABC_LOGISTICS.logo-result
```

Potential contents:

```text
manifest.json
production.json
preview-front.png
preview-back.png
original-logo-files/
production-report.pdf
```

Only include artifacts proven useful.

Structured data is authoritative.

PDF/images are human-readable representations.

The customer's returned `.logo-project` is the primary editable submission.
It includes the candidate operational specification and customer pre-approval.
A `.logo-result` is an optional downstream production handoff, derived from a
Logo Station-approved project revision. Avoid two independently edited sources
of placement truth. Customer previews represent the same saved configuration.

The internal Builder must export an operation PDF from a selected project
revision for attachment to the ticket and BoM. Follow the useful structure of
the discovered proofs: product views with applied logos and accompanying logo,
method, size, position and colour panels. Enrich them with numbered placements,
clean dimension arrows from selected anchor-to-edge measurements, and
department operational instructions. Customer notes stay labelled source
context and never print as operational instructions.

The default handoff is ONE branded operation sheet: an ordinary
one-product/two-logo front+back job prints EXACTLY one A4 landscape page at
default settings with legible text. The sheet carries ONLY what the operator
needs: human job/customer/article identity, relevant product/variant, logo
business identity, side/position, method, logo size, selected anchor-to-edge
measurements, department instructions and supplied method parameters. Never
print digests, hashes, schema/calibration/frame/project/config IDs,
timestamps, history, appendices, audit pages, duplicate unbranded photos or
generic disclaimer lists. For unusually large jobs, select a product/variant
or create additional operation sheets in the same output when content truly
cannot fit — never clip, truncate silently, shrink text unreadably, or
overlap. A clear amount/selection summary precedes print so no
product/variant is silently lost.

Generate measurements and visuals from the same structured placement data as
the project and production output, rather than transcribing screenshots. Label
product views as illustrative unless generated and verified as scale drawings.
Include recorded method settings and garment modifications; clearly identify
unresolved values instead of inventing them. One concise business
draft/status indicator only where it changes an operator decision; keep
approval semantics honest without warning walls.

Permit a pending-review sheet for the ticket and an approved sheet for
production. The same selected revision supplies the ticket and BoM so their
instructions match. Earlier revisions remain historical, with the current
approved revision clearly identified. The Builder previews and prints the
sheet locally and offers a minimal operator JSON export (same business data,
no technical envelope) alongside the existing advanced diagnostic candidate
export; manual attachment is the initial handoff. Automatic Odoo attachment
is a separate write integration requiring authorization, outside current
read-only discovery grants. See `docs/operation-pdf.md` for content and
acceptance criteria.

---

# 35. Customer configurator workflow

Target:

```text
Open project
    ↓
Select product / variant
    ↓
Inspect 3D product
    ↓
Add/select logo
    ↓
Choose placement region
    ↓
Place / resize / rotate
    ↓
Add additional logo if needed
    ↓
Validate
    ↓
Add instructions
    ↓
Review all placements
    ↓
Review physical dimensions and positioning references
    ↓
Confirm this configuration (customer pre-approval)
    ↓
Save updated .logo-project
    ↓
Customer attaches the saved project to email
    ↓
Logo Station imports and validates the returned revision
    ↓
Approve for production or request a revision
```

Support:

```text
0..N placements
```

during editing, subject to project requirements.

Show logo width/height, region, rotation and useful distances from named product
landmarks while editing and in the final review. Permit numerical adjustments
as well as visual manipulation. Internally prepared placement areas, safe zones
and exclusion zones constrain the choices. All confirmation summaries and
previews must describe the exact revision saved in the return file.

Customer pre-approval does not bypass Logo Station's method, fit, artwork and
manufacturing checks. If Logo Station changes customer-visible size, position,
colour, artwork or garment selection, create a new revision for customer
confirmation rather than inheriting the previous confirmation.

---

# 36. Customer UX requirements

Prioritize:

- obvious workflow;
- minimal technical terminology;
- no login;
- no account;
- no network;
- no installation;
- clearly displayed product/SKU;
- clearly displayed physical measurements;
- easy switching between logos;
- easy switching between product regions;
- undo/reset;
- validation feedback;
- clear warnings for unsafe placement.

Camera controls and logo-manipulation controls must not conflict unnecessarily.

---

# 37. Builder workflow

The internal Builder should eventually allow something like:

```text
Customer:
ABC Logistics

Products:
☑ Plover
☑ Hi-Vis Gilet
☐ Trousers

Output:
○ Self-contained HTML
● HTML + project ZIP

[ Generate ]
```

Include only required product assets.

Do not ship the full FlexiTog catalogue with every project.

Show estimated size.

The Builder also imports returned customer projects, supports Logo Station
review and previews/exports operation PDFs. The same selected revision supplies
the ticket and BoM documents. Document generation is local functionality;
uploading or attaching documents to Odoo is a separate authorized integration.

---

# 38. Self-contained packaging

Self-contained HTML is a packaging target.

Do not structure the runtime around Base64 assets.

The packaging layer may convert canonical assets into:

- embedded blobs;
- Base64;
- compressed serialized content;
- data URLs;
- another reliable offline representation.

At runtime reconstruct normal:

```text
Blob
ArrayBuffer
```

objects.

Measure and document size overhead.

---

# 39. Hybrid packaging

Generate:

```text
CUSTOMER_JOB.zip
│
├── OPEN_LOGO_CONFIGURATOR.html
└── CUSTOMER_JOB.logo-project
```

Application code must be fully bundled.

No CDN.

No network.

No remote fonts.

No external assets.

Support project loading via:

```text
Choose Project
```

and drag/drop.

Do not require silent loading of a neighbouring `.logo-project` through
`file://`. The reliable hybrid workflow uses Choose Project or drag/drop.
For automatic initial loading, embed the issued project into the self-contained
HTML (Mode A). Both modes save the same editable `.logo-project` return format.

---

# 40. Offline compatibility

Critical acceptance test:

```text
generate package
↓
disconnect Internet
↓
unzip
↓
double-click HTML
↓
load project
↓
configure multiple logos
↓
export production result
```

No special browser flags.

No local server.

No runtime dependency installation.

---

# 41. Persistence

Do not make browser persistence essential.

Explicit export must always preserve the job.

Saving downloads an updated project; it must not depend on permission to overwrite
the original file. Reopening that saved project must restore assets, placements,
measurements, instructions, validation context and the applicable confirmation.
Saving a draft must remain available before confirmation. Changes after
confirmation require a new confirmation for submission.

Optional autosave may come later.

Abstract storage so Tauri can later use filesystem APIs.

---

# 42. Provenance

Each master product asset should record where its model came from.

Example:

```text
source:
    tripo-api
```

or:

```text
source:
    realityscan
```

or:

```text
source:
    manually-imported
```

Track:

- generation/import date;
- source images if appropriate;
- tool/provider;
- model version;
- calibration version;
- operator;
- product/variant mapping.

This will matter when models are regenerated later.

---

# 43. Prototype milestones

## Phase 1 — Odoo discovery

Produce:

```text
docs/odoo-discovery.md
```

Include product-category analysis and multiple-logo examples.

## Phase 2 — Domain model

Include project revisions, customer pre-approval, internal review and a
deterministic candidate operational specification. Missing historical job
coordinates are an output gap the tool is designed to fill; do not require Odoo
to already contain those coordinates before designing this workflow. Real product
calibration and operational constraints still require validation in their phases.

Produce:

```text
docs/domain-model.md

schemas/
├── product.schema.json
├── project.schema.json
├── logo.schema.json
└── result.schema.json
```

## Phase 3 — Architecture

Produce:

```text
docs/architecture.md
docs/decisions.md
```

## Phase 4 — 3D asset prototype

Use FlexiTog website images.

Try Tripo API.

Import resulting GLB.

Also prove that an arbitrary external GLB can enter the same pipeline.

## Phase 5 — Product calibration

Implement:

- anchor creation;
- physical measurements;
- surface regions;
- safe polygons;
- exclusion zones;
- model/physical mapping.

## Phase 6 — Logo placement

Implement:

- multiple logos;
- multiple regions;
- mm-based position;
- width/height;
- rotation;
- validation.

## Phase 7 — Variant transfer

Implement at least:

- absolute;
- normalized/proportional;
- variant override.

## Phase 8 — Hybrid project package

Implement:

```text
HTML + .logo-project
```

and verify true offline use.

Verify the full round trip: issue, load, place/resize, review measurements,
confirm, save, reopen and import internally with the same physical data and
confirmation revision. Verify editing invalidates current confirmation and
internal review can return a revised project for another customer confirmation.

## Phase 9 — Self-contained HTML

Generate equivalent single-file output.

## Phase 10 — Production export

Implement schema derived from Odoo discovery.

Generate the operation PDF from the same project revision, including product
renders, placement diagrams, measurements, instructions and approval status.
Verify agreement between the PDF, project and structured production output.

## Phase 11 — Internal Builder

Create customer-project packaging interface.

Include returned-project import/review, operation-PDF preview/export and
ticket/BoM handoff preparation.

---

# 44. Required investigation questions

Resolve through Odoo wherever possible.

## Products

1. What product categories does Logo Station actually process?
2. Which categories are most common?
3. How are categories represented in Odoo?
4. What variant structures are common?
5. How are plain and finished products related?
6. How are finished SKUs created or reused?

## Logos

7. Are logos inventory products?
8. How are logo SKUs structured?
9. Can one finished product contain multiple logo components?
10. How common is this?
11. Can the same logo appear multiple times?
12. Where are artwork files stored?
13. Are dimensions structured anywhere?

## Placement

14. Where is placement currently documented?
15. Is it structured or free text?
16. What standard placement names already exist?
17. Which product categories share placement conventions?
18. How are variants handled?
19. Which measurements do production workers actually use?
20. Are there safe areas / forbidden areas already documented anywhere?

## Production

21. What does a Logo Station operator actually see?
22. Which data points are necessary before production can begin?
23. Which BoM fields drive the work?
24. Which fields could eventually be populated from configurator output?
25. What information currently requires manual interpretation?

---

# 45. Architecture principles to preserve

## Principle 1

Production data is physical and structured.

```text
mm
```

not pixels.

## Principle 2

3D geometry is primarily visualization.

Do not assume an AI-generated mesh is dimensionally exact.

## Principle 3

Products are defined through generalized decoratable surface regions.

Do not build category-specific placement logic.

## Principle 4

Multiple logos are normal.

Use:

```text
placements[]
```

## Principle 5

Product variants may require different calibration.

Do not assume one geometry or placement mapping fits all sizes.

## Principle 6

3D-model generation is replaceable.

Tripo API is one provider, not a permanent architectural dependency.

## Principle 7

External GLB import must always remain available.

## Principle 8

Packaging is independent from project semantics.

Self-contained HTML and HTML + project package use the same canonical project.

## Principle 9

Browser-specific operations are adapters.

Core logic must remain portable to Tauri.

## Principle 10

Odoo evidence takes priority over assumptions.

---

# 46. Testing requirements

Automated tests should cover at least:

- schema validation;
- project serialization;
- package compression/decompression;
- multiple-logo configurations;
- multiple placement regions;
- safe polygon validation;
- exclusion-zone validation;
- mm → surface mapping;
- variant transfer;
- unsupported project versions;
- invalid model/product references;
- malformed project packages.

Manual/integration tests:

- offline execution;
- Chrome;
- Edge;
- `file://`;
- imported GLB;
- Tripo-generated GLB;
- one logo;
- multiple logos;
- multiple product types;
- multiple variants;
- curved placement region;
- self-contained HTML;
- hybrid ZIP;
- production export.

---

# 47. Documentation

Maintain:

```text
docs/
├── odoo-discovery.md
├── architecture.md
├── domain-model.md
├── asset-pipeline.md
├── calibration.md
├── decisions.md
└── prototype-findings.md
```

For important decisions, record:

```text
Decision
Reason
Evidence
Alternatives
Consequences
```

Do not silently encode assumptions into code.

---

# 48. Expected repository structure

At minimum:

```text
README.md

docs/
├── odoo-discovery.md
├── architecture.md
├── domain-model.md
├── asset-pipeline.md
├── calibration.md
├── decisions.md
└── prototype-findings.md

schemas/
├── product.schema.json
├── logo.schema.json
├── project.schema.json
└── result.schema.json

src/
├── core/
├── viewer/
├── assets/
├── packaging/
├── platform/
├── ui/
└── shared/

examples/
├── products/
├── projects/
├── hybrid-package/
└── self-contained/

tests/
```

---

# 49. Definition of success for the first serious prototype

The prototype succeeds when:

1. Real Logo Station workflows have been reconstructed from Odoo.

2. Common product categories have been identified from actual FlexiTog data.

3. At least several materially different product types can fit the generalized product schema.

4. A product can obtain a 3D model either through Tripo API or external GLB import.

5. The model can be calibrated using semantic anchors and known real dimensions.

6. Decoratable regions can be defined independently of product type.

7. Safe areas and exclusion zones can be defined in physical coordinates.

8. One product can contain multiple independent logo placements.

9. Placements are stored in millimetres rather than pixels or raw Three.js transforms.

10. Placements can be mapped onto the 3D surface.

11. Variant-transfer rules can reuse a placement across related sizes/models where appropriate.

12. The customer can receive a ZIP, unzip it and use the configurator entirely offline.

13. The same canonical project can be exported as:

```text
self-contained HTML
```

or:

```text
HTML + .logo-project
```

14. The customer can export a deterministic structured production result.

15. The resulting production data corresponds to information Logo Station actually needs, based on Odoo evidence.

16. Browser/platform code is sufficiently isolated that moving the frontend into Tauri later would not require redesigning the domain model, calibration engine, placement engine, 3D viewer, project formats, or production-output formats.

---

# 50. Final instruction to Codex

Do not begin by hardcoding Plover-specific behavior.

Use Plover as an initial prototype asset if useful, but design from the beginning for products such as:

```text
T-shirts
polo shirts
sweatshirts
gilets
trousers
salopettes
coveralls
hi-visibility garments
caps
and other future product types
```

Likewise, do not assume one logo per product.

Inspect real BoMs and Logo Station jobs first.

The central abstraction should remain:

```text
Product
    ↓
Variant
    ↓
3D surface

Product
    ↓
Semantic anchors
    ↓
Placement regions
    ↓
Physical coordinates in mm
    ↓
0..N logo placements
    ↓
Structured production specification
```

Everything else — Tripo, RealityScan, Three.js, HTML packaging, Tauri, GLB — should remain replaceable infrastructure around that production model.
