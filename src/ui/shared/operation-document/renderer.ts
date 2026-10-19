/**
 * Operation-document DOM renderer and styles.
 *
 * Escapes untrusted text via textContent / createTextNode. No innerHTML with
 * dynamic strings.
 */

import type {
  ArtworkPreview,
  OperationArtworkAsset,
  OperationConfiguration,
  OperationDocument,
  OperationIdentity,
  OperationPlacement,
  OperationReferenceView,
  PlacementDiagram,
  Point2d,
} from "../../../core/operation-document/types.js";
import { readRasterHeader } from "../../../assets/raster-header.js";
import {
  artworkPreviewReason,
  artworkRenderFailureReason,
  bytesToDataUrl,
  referencePreviewReason,
  type OperationDocumentAssetLookup,
} from "./assets.js";

export type { OperationDocumentAssetLookup };

function setText(element: HTMLElement, text: string): void {
  element.textContent = text;
}

/**
 * Header-valid bytes can still fail native decoding (truncated or corrupt
 * payload behind a valid header). Every rendered raster <img> carries an
 * error listener that swaps the figure for explicit placeholder text, so a
 * corrupt payload never renders a broken image and never throws.
 */
function watchImageDecode(
  document: Document,
  figure: HTMLElement,
  image: HTMLImageElement,
  uri: string,
): void {
  image.addEventListener("error", () => {
    figure.replaceChildren();
    figure.append(createTextElement(document, "p", artworkRenderFailureReason("decode-failed", uri), "opdoc-artwork-placeholder"));
  });
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

function createTextElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = createElement(document, tag, className);
  setText(element, text);
  return element;
}

function appendDefinition(
  document: Document,
  parent: HTMLElement,
  term: string,
  details: string,
): void {
  const dt = createTextElement(document, "dt", term);
  const dd = createTextElement(document, "dd", details);
  const pair = createElement(document, "div", "opdoc-field");
  pair.append(dt, dd);
  parent.append(pair);
}

function renderIdentity(document: Document, identity: OperationIdentity): HTMLElement {
  const section = createElement(document, "section", "opdoc-identity");
  const heading = createTextElement(document, "h2", "Operation document");
  section.append(heading);

  const grid = createElement(document, "dl", "opdoc-identity-grid");
  appendDefinition(document, grid, "Project", identity.projectId);
  appendDefinition(document, grid, "Revision", String(identity.revision));
  appendDigest(document, grid, identity);
  appendDefinition(document, grid, "Schema", identity.schemaVersion);
  if (identity.generatedAt !== undefined) {
    appendDefinition(document, grid, "Generated at", identity.generatedAt);
  }
  appendDefinition(document, grid, "Review status", identity.reviewStatus);
  appendDefinition(document, grid, "Calibration status", identity.calibrationStatus);
  if (identity.customerConfirmation !== undefined) {
    appendDefinition(document, grid, "Local customer confirmation", identity.customerConfirmation);
  }
  if (identity.internalReview !== undefined) {
    appendDefinition(document, grid, "Local internal review", identity.internalReview);
  }
  section.append(grid);
  return section;
}

/**
 * Digest row: truncated digest shown prominently; the full digest is present
 * as text inside a disclosure (screen) and as a print-only span so printed
 * PDFs always carry the exact value even when the disclosure is closed.
 */
function appendDigest(document: Document, grid: HTMLElement, identity: OperationIdentity): void {
  const pair = createElement(document, "div", "opdoc-field");
  pair.append(createTextElement(document, "dt", "Digest"));
  const dd = createElement(document, "dd");
  dd.append(createTextElement(document, "span", `${identity.shortDigest}\u2026`));
  const printOnly = createTextElement(document, "span", identity.digest, "opdoc-digest-print");
  printOnly.setAttribute("data-opdoc-digest", "full");
  dd.append(printOnly);
  const details = createElement(document, "details", "opdoc-digest-screen");
  details.append(createTextElement(document, "summary", "Full digest"));
  details.append(createTextElement(document, "p", identity.digest));
  dd.append(details);
  pair.append(dd);
  grid.append(pair);
}

function renderLimitations(document: Document, limitations: string[]): HTMLElement {
  const section = createElement(document, "section", "opdoc-limitations");
  const heading = createTextElement(document, "h3", "Limitations");
  section.append(heading);
  const list = createElement(document, "ul");
  for (const limitation of limitations) {
    list.append(createTextElement(document, "li", limitation));
  }
  section.append(list);
  return section;
}

function pointsToSvgPath(points: Point2d[]): string {
  if (points.length === 0) return "";
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ") + " Z";
}

function renderDiagram(document: Document, diagram: PlacementDiagram): SVGElement {
  const { viewBox } = diagram;
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", `${viewBox.minX} ${-viewBox.minY - viewBox.height} ${viewBox.width} ${viewBox.height}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("class", "opdoc-diagram");

  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Planar footprint: positive X right, positive Y up; clockwise rotation facing the region. Not to scale.");
  const physical = document.createElementNS(svgNs, "g");
  physical.setAttribute("transform", "scale(1 -1)");
  svg.append(physical);

  if (diagram.safePolygon.length > 0) {
    const safe = document.createElementNS(svgNs, "path") as SVGPathElement;
    safe.setAttribute("d", pointsToSvgPath(diagram.safePolygon));
    safe.setAttribute("class", "opdoc-safe");
    physical.append(safe);
  }

  for (const exclusion of diagram.exclusions) {
    if (exclusion.polygon.length === 0) continue;
    const path = document.createElementNS(svgNs, "path") as SVGPathElement;
    path.setAttribute("d", pointsToSvgPath(exclusion.polygon));
    path.setAttribute("class", "opdoc-exclusion");
    physical.append(path);


  }

  if (diagram.footprint.length > 0) {
    const footprint = document.createElementNS(svgNs, "path") as SVGPathElement;
    footprint.setAttribute("d", pointsToSvgPath(diagram.footprint));
    footprint.setAttribute("class", "opdoc-footprint");
    physical.append(footprint);

    const centre = diagram.footprint.reduce(
      (acc, point) => ({ x: acc.x + point.x / diagram.footprint.length, y: acc.y + point.y / diagram.footprint.length }),
      { x: 0, y: 0 },
    );
    const centreDot = document.createElementNS(svgNs, "circle") as SVGCircleElement;
    centreDot.setAttribute("cx", String(centre.x));
    centreDot.setAttribute("cy", String(centre.y));
    centreDot.setAttribute("r", "1.5");
    centreDot.setAttribute("class", "opdoc-centre");
    physical.append(centreDot);
  }

  const axes = diagram.axes;
  const xAxis = document.createElementNS(svgNs, "line") as SVGLineElement;
  xAxis.setAttribute("x1", String(axes.originX));
  xAxis.setAttribute("y1", String(axes.originY));
  xAxis.setAttribute("x2", String(axes.xEndX));
  xAxis.setAttribute("y2", String(axes.xEndY));
  xAxis.setAttribute("class", "opdoc-axis");
  physical.append(xAxis);

  const yAxis = document.createElementNS(svgNs, "line") as SVGLineElement;
  yAxis.setAttribute("x1", String(axes.originX));
  yAxis.setAttribute("y1", String(axes.originY));
  yAxis.setAttribute("x2", String(axes.yEndX));
  yAxis.setAttribute("y2", String(axes.yEndY));
  yAxis.setAttribute("class", "opdoc-axis");
  physical.append(yAxis);

  const labelSize = Math.max(viewBox.width, viewBox.height) * 0.035;
  for (const [label, x, y] of [["+X", axes.xEndX, -axes.xEndY], ["+Y", axes.yEndX, -axes.yEndY]] as const) {
    const text = document.createElementNS(svgNs, "text");
    text.setAttribute("x", String(x + labelSize / 2));
    text.setAttribute("y", String(y - labelSize / 2));
    text.setAttribute("font-size", String(labelSize));
    text.textContent = label;
    svg.append(text);
  }
  const centre = diagram.footprint.reduce((acc, point) => ({ x: acc.x + point.x / 4, y: acc.y + point.y / 4 }), { x: 0, y: 0 });
  const offsets = document.createElementNS(svgNs, "path");
  offsets.setAttribute("d", `M 0 0 L ${centre.x} 0 L ${centre.x} ${centre.y}`);
  offsets.setAttribute("class", "opdoc-offsets");
  physical.append(offsets);

  return svg;
}

function renderPlacement(
  document: Document,
  placement: OperationPlacement,
  lookup: OperationDocumentAssetLookup | undefined,
): HTMLElement {
  const article = createElement(document, "article", "opdoc-placement");
  const heading = createTextElement(document, "h4", `${placement.displayIndex}. Placement ${placement.id ?? placement.displayIndex}`);
  article.append(heading);
  article.append(createTextElement(document, "p", "Status: candidate-pending-review", "opdoc-status"));

  const grid = createElement(document, "dl", "opdoc-placement-grid");
  appendDefinition(document, grid, "Configuration", placement.configurationId);
  appendDefinition(document, grid, "Product / variant", `${placement.productId} / ${placement.variantId}`);
  appendDefinition(document, grid, "Logo", placement.logoId);
  appendDefinition(document, grid, "Region", placement.regionId);
  appendDefinition(document, grid, "Region name", placement.regionName ?? "not supplied");
  appendDefinition(document, grid, "Method", placement.method);
  appendDefinition(document, grid, "Centre X", `${placement.pos.xMm} mm`);
  appendDefinition(document, grid, "Centre Y", `${placement.pos.yMm} mm`);
  appendDefinition(document, grid, "Width", `${placement.widthMm} mm`);
  appendDefinition(document, grid, "Height", `${placement.heightMm} mm`);
  appendDefinition(document, grid, "Clockwise rotation", `${placement.rotationDeg}°`);
  appendDefinition(document, grid, "Frame ID", placement.frame.frameId);
  appendDefinition(document, grid, "Rotation convention", placement.frame.rotationConvention);
  appendDefinition(document, grid, "Frame origin", placement.frame.originDescription);
  appendDefinition(document, grid, "X-positive axis", placement.frame.axes.xPositive);
  appendDefinition(document, grid, "Y-positive axis", placement.frame.axes.yPositive);
  appendDefinition(document, grid, "Reference point", placement.frame.referencePoint);
  appendDefinition(document, grid, "Calibration", `${placement.calibration.calibrationId} · ${placement.calibration.version}`);
  article.append(grid);
  if (placement.instructions !== undefined) {
    const instructions = createElement(document, "section", "opdoc-instructions");
    instructions.append(createTextElement(document, "h5", "Placement instructions"));
    instructions.append(createTextElement(document, "p", placement.instructions));
    article.append(instructions);
  }

  const diagramHeading = createTextElement(document, "h5", "Positioning diagram");
  article.append(diagramHeading);
  if (!placement.diagram.safeSupplied) {
    article.append(createTextElement(
      document,
      "p",
      "Safe-area polygon not supplied for this region; the footprint is shown without safe bounds.",
      "opdoc-warning",
    ));
  }
  article.append(renderDiagram(document, placement.diagram));
  const caption = createTextElement(document, "p", "Illustrative, not to scale — logo footprint only. Green: safe region; red: exclusions; blue: footprint. Dashed lines: X/Y offsets from the frame origin to the bbox centre. +X right, +Y up; directions are named above.");
  caption.className = "opdoc-caption";
  article.append(caption);

  const artworkHeading = createTextElement(document, "h5", `Artwork — logo ${placement.artwork.logoId}`);
  article.append(artworkHeading);
  if (placement.artwork.assets.length === 0) {
    article.append(createTextElement(document, "p", "No artwork assets recorded."));
  } else {
    const list = createElement(document, "ul", "opdoc-asset-list");
    for (const [assetIndex, asset] of placement.artwork.assets.entries()) {
      const item = createElement(document, "li", "opdoc-asset");
      const assetHeading = createTextElement(document, "h6", `Asset ${assetIndex + 1} · ${asset.role}`);
      item.append(assetHeading);
      const assetGrid = createElement(document, "dl");
      appendDefinition(document, assetGrid, "URI", asset.uri);
      appendDefinition(document, assetGrid, "Declared media type", asset.mediaType);
      appendDefinition(document, assetGrid, "SHA-256", asset.sha256Hex ?? "not supplied");
      if (asset.description !== undefined) appendDefinition(document, assetGrid, "Description", asset.description);
      item.append(assetGrid);
      item.append(renderArtworkPreview(document, asset, placement.artwork.logoId, lookup));
      list.append(item);
    }
    article.append(list);
  }

  return article;
}

/**
 * Bounded package-artwork preview. Only header-validated raster originals
 * render, as inert `<img>` elements with `data:` URLs built from package
 * bytes (never fetched, never remote). Every other case renders explicit
 * placeholder text — never a broken image.
 */
function renderArtworkPreview(
  document: Document,
  asset: OperationArtworkAsset,
  logoId: string,
  lookup: OperationDocumentAssetLookup | undefined,
): HTMLElement {
  const preview: ArtworkPreview = asset.preview;
  if (preview.status !== "inline-raster") {
    return createTextElement(document, "p", artworkPreviewReason(preview.status, asset.uri), "opdoc-artwork-placeholder");
  }
  const bytes = lookup?.getBytes(asset.uri);
  if (!bytes || bytes.length === 0) {
    return createTextElement(document, "p", artworkRenderFailureReason("bytes-absent", asset.uri), "opdoc-artwork-placeholder");
  }
  const header = readRasterHeader(bytes);
  if (header === null || header.mediaType !== preview.mediaType) {
    return createTextElement(document, "p", artworkRenderFailureReason("encode-failed", asset.uri), "opdoc-artwork-placeholder");
  }
  const url = bytesToDataUrl(bytes, header.mediaType);
  if (url === null) {
    return createTextElement(document, "p", artworkRenderFailureReason("encode-failed", asset.uri), "opdoc-artwork-placeholder");
  }
  const figure = createElement(document, "figure", "opdoc-artwork-figure");
  const image = createElement(document, "img", "opdoc-artwork-img");
  image.setAttribute("src", url);
  image.setAttribute("alt", `Customer-supplied artwork preview for logo ${logoId} (illustrative, not a colour proof)`);
  image.setAttribute("width", String(header.width));
  image.setAttribute("height", String(header.height));
  watchImageDecode(document, figure, image, asset.uri);
  figure.append(image);
  const caption = createElement(document, "figcaption", "opdoc-caption");
  setText(caption, "Illustrative customer-supplied artwork preview \u2014 never a production colour proof.");
  figure.append(caption);
  return figure;
}

/**
 * Illustrative product reference views for one configuration. Reference
 * images are visual aids only; missing references render explicit text and
 * missing sides are never invented.
 */
function renderReferenceViews(
  document: Document,
  configuration: OperationConfiguration,
  lookup: OperationDocumentAssetLookup | undefined,
): HTMLElement {
  const section = createElement(document, "section", "opdoc-reference-section");
  section.append(createTextElement(document, "h4", "Product reference (illustrative)"));
  if (configuration.referenceNote !== null) {
    section.append(createTextElement(document, "p", configuration.referenceNote, "opdoc-reference-note"));
  }
  if (configuration.referenceViews.length === 0) {
    if (configuration.referenceNote === null) {
      section.append(createTextElement(
        document,
        "p",
        "Product reference not supplied for this configuration in the package.",
        "opdoc-reference-missing",
      ));
    }
  } else {
    for (const view of configuration.referenceViews) {
      section.append(renderReferenceView(document, view, lookup));
    }
    section.append(createTextElement(
      document,
      "p",
      "Illustrative product reference only; the dimensioned positioning diagram is the source of truth.",
      "opdoc-caption",
    ));
  }
  return section;
}

function renderReferenceView(
  document: Document,
  view: OperationReferenceView,
  lookup: OperationDocumentAssetLookup | undefined,
): HTMLElement {
  const figure = createElement(document, "figure", "opdoc-reference");
  const side = view.view ?? "single view";
  const bytes = view.preview.status === "inline-raster" ? lookup?.getBytes(view.imagePath) : undefined;
  const header = bytes && bytes.length > 0 ? readRasterHeader(bytes) : null;
  const url = header !== null && header.mediaType === view.preview.mediaType
    ? bytesToDataUrl(bytes!, header.mediaType)
    : null;
  if (url === null) {
    const reason = view.preview.status === "inline-raster"
      ? artworkRenderFailureReason(bytes ? "encode-failed" : "bytes-absent", view.imagePath)
      : referencePreviewReason(view.imagePath);
    figure.append(createTextElement(document, "p", reason, "opdoc-artwork-placeholder"));
  } else {
    const image = createElement(document, "img", "opdoc-reference-img");
    image.setAttribute("src", url);
    image.setAttribute("alt", `Illustrative product reference (${side}): ${view.label ?? view.imagePath}`);
    image.setAttribute("width", String(header!.width));
    image.setAttribute("height", String(header!.height));
    watchImageDecode(document, figure, image, view.imagePath);
    figure.append(image);
  }
  const caption = createElement(document, "figcaption", "opdoc-caption");
  setText(caption, `${view.label ?? view.imagePath} \u2014 ${side}; illustrative only, not a placement proof.`);
  figure.append(caption);
  return figure;
}

function renderConfiguration(
  document: Document,
  configuration: OperationConfiguration,
  lookup: OperationDocumentAssetLookup | undefined,
): HTMLElement {
  const section = createElement(document, "section", "opdoc-configuration");
  const heading = createTextElement(
    document,
    "h3",
    `${configuration.productName ?? configuration.productId} / ${configuration.variantName ?? configuration.variantId}`,
  );
  section.append(heading);
  section.append(createTextElement(document, "p", "Status: candidate-pending-review", "opdoc-status"));

  const meta = createElement(document, "dl", "opdoc-config-meta");
  appendDefinition(document, meta, "Configuration ID", configuration.id);
  appendDefinition(document, meta, "Product ID", configuration.productId);
  appendDefinition(document, meta, "Variant ID", configuration.variantId);
  appendDefinition(document, meta, "Placements", String(configuration.placements.length));
  section.append(meta);

  section.append(renderReferenceViews(document, configuration, lookup));

  if (configuration.placements.length === 0) {
    section.append(createTextElement(
      document,
      "p",
      "0 placements \u2014 no logos are configured here; no earlier artwork is reused.",
    ));
  } else {
    for (const placement of configuration.placements) {
      section.append(renderPlacement(document, placement, lookup));
    }
  }

  return section;
}

export function renderOperationDocument(
  doc: OperationDocument,
  document: Document,
  assets?: OperationDocumentAssetLookup,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const wrapper = createElement(document, "div", "lt-operation-document");
  wrapper.append(renderIdentity(document, doc.identity));
  wrapper.append(renderLimitations(document, doc.limitations));

  if (doc.projectInstructions !== undefined) {
    const instructions = createElement(document, "section", "opdoc-instructions");
    instructions.append(createTextElement(document, "h3", "Project instructions"));
    instructions.append(createTextElement(document, "p", doc.projectInstructions));
    wrapper.append(instructions);
  }

  const configurationsSection = createElement(document, "section", "opdoc-configurations");
  if (doc.configurations.length === 0) {
    configurationsSection.append(createTextElement(document, "p", "No configurations recorded in this candidate."));
  }
  for (const configuration of doc.configurations) {
    configurationsSection.append(renderConfiguration(document, configuration, assets));
  }
  wrapper.append(configurationsSection);

  fragment.append(wrapper);
  return fragment;
}

export function operationDocumentStyles(identity: OperationIdentity): string {
  const identityText = `${identity.projectId} | Revision ${identity.revision} | candidate-pending-review`;
  // Hex-escape every code point so identity cannot terminate a CSS string.
  const cssText = Array.from(identityText, (character) => "\\" + character.codePointAt(0)!.toString(16) + " ").join("");
  return `
    .lt-operation-document {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 11pt;
      line-height: 1.45;
      color: #1b2c39;
      background: #fff;
    }
    .lt-operation-document h2, .lt-operation-document h3, .lt-operation-document h4 {
      margin: 0 0 0.5rem;
      page-break-after: avoid;
    }
    .lt-operation-document h2 { font-size: 16pt; border-bottom: 1.5pt solid #1b2c39; padding-bottom: 0.25rem; }
    .lt-operation-document h3 { font-size: 13pt; margin-top: 1rem; }
    .lt-operation-document h4 { font-size: 11pt; margin-top: 0.8rem; }
    .lt-operation-document h5, .lt-operation-document h6 { font-size: 10pt; margin: 0.6rem 0 0.3rem; break-after: avoid; }
    .opdoc-identity-grid, .opdoc-placement-grid, .opdoc-config-meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 0.25rem 1rem;
      align-items: start;
    }
    .opdoc-field { min-width: 0; break-inside: avoid; }
    .lt-operation-document { overflow-wrap: anywhere; }
    .lt-operation-document dl { margin: 0; }
    .lt-operation-document dt { font-weight: 700; font-size: 9pt; color: #52616d; }
    .lt-operation-document dd { margin: 0 0 0.4rem; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; white-space: pre-wrap; }
    .opdoc-limitations ul { margin: 0.25rem 0; padding-left: 1.25rem; }
    .opdoc-limitations li { margin-bottom: 0.2rem; }
    .opdoc-placement { margin: 0.75rem 0; padding: 0.6rem; border: 1pt solid #cbd4da; border-radius: 4pt; break-inside: auto; }
    .opdoc-diagram { width: 100%; max-width: 420px; height: 220px; display: block; break-inside: avoid; margin: 0.5rem 0; border: 0.5pt solid #cbd4da; }
    .opdoc-safe { fill: #e8f5e9; stroke: #2e7d32; stroke-width: 0.8; fill-opacity: 0.35; }
    .opdoc-exclusion { fill: #ffebee; stroke: #c62828; stroke-width: 0.8; fill-opacity: 0.45; }
    .opdoc-exclusion-label { font-size: 7pt; fill: #c62828; text-anchor: middle; dominant-baseline: middle; }
    .opdoc-footprint { fill: #e3f2fd; stroke: #1565c0; stroke-width: 1.2; fill-opacity: 0.55; }
    .opdoc-centre { fill: #1565c0; }
    .opdoc-offsets { fill: none; stroke: #52616d; stroke-width: 0.7; stroke-dasharray: 3 2; }
    .opdoc-axis { stroke: #37474f; stroke-width: 1; }
    .opdoc-axis-label { font-size: 7pt; fill: #37474f; }
    .opdoc-caption { font-size: 8pt; color: #52616d; font-style: italic; margin: 0.25rem 0 0; }
    .opdoc-asset-list { list-style: none; padding: 0; margin: 0; }
    .opdoc-asset { margin: 0.4rem 0; padding: 0.4rem; background: #f7f9fa; border-radius: 3pt; }
    .opdoc-artwork-figure { margin: 0.5rem 0; }
    .opdoc-artwork-img { display: block; max-width: 100%; max-height: 240px; object-fit: contain; margin: 0.4rem 0; border: 0.5pt solid #cbd4da; background: #fff; break-inside: avoid; }
    .opdoc-artwork-placeholder, .opdoc-reference-missing, .opdoc-reference-note, .opdoc-warning {
      font-size: 9pt; color: #5d4037; background: #fff8e1; border: 0.5pt solid #e0c36a;
      border-radius: 3pt; padding: 0.35rem 0.5rem; overflow-wrap: anywhere;
    }
    .opdoc-reference { margin: 0.5rem 0; break-inside: avoid; }
    .opdoc-reference img { display: block; max-width: 100%; max-height: 300px; object-fit: contain; border: 0.5pt solid #cbd4da; background: #fff; }
    .opdoc-reference figcaption { font-size: 8pt; color: #52616d; font-style: italic; margin-top: 0.25rem; overflow-wrap: anywhere; }
    .opdoc-status { font-weight: 700; font-size: 9pt; color: #1b2c39; margin: 0.25rem 0; }
    .opdoc-digest-screen { font-size: 9pt; margin-top: 0.25rem; }
    .opdoc-digest-screen summary { cursor: pointer; }
    .opdoc-digest-screen p { overflow-wrap: anywhere; }
    .opdoc-digest-print { display: none; }
    @media print {
      .opdoc-digest-screen { display: none; }
      .opdoc-digest-print { display: inline; overflow-wrap: anywhere; }
    }
    .opdoc-instructions p { white-space: pre-wrap; overflow-wrap: anywhere; }
    @page {
      size: A4; margin: 22mm 14mm 18mm;
      @bottom-left { content: "${cssText}"; font: 8pt sans-serif; }
      @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8pt sans-serif; }
    }
    @media print {
      body, .lt-operation-document { background: transparent; }
      .opdoc-placement { break-inside: auto; }
      .opdoc-field { break-inside: auto; }
      .opdoc-placement-grid, .opdoc-identity-grid, .opdoc-config-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .opdoc-field { margin-bottom: 2mm; }
      .opdoc-field dt { break-after: avoid; }
      .opdoc-field dd { orphans: 3; widows: 3; }
      .opdoc-configuration { break-before: page; }
      .opdoc-diagram { max-width: 100%; }
      .lt-operation-document h2 { page-break-after: avoid; }
    }
  `;
}
