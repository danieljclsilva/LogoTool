/**
 * Operation-document DOM renderer and styles.
 *
 * Escapes untrusted text via textContent / createTextNode. No innerHTML with
 * dynamic strings.
 */

import type {
  OperationConfiguration,
  OperationDocument,
  OperationIdentity,
  OperationPlacement,
  PlacementDiagram,
  Point2d,
} from "../../../core/operation-document/types.js";

function setText(element: HTMLElement, text: string): void {
  element.textContent = text;
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
  appendDefinition(document, grid, "Digest", identity.digest);
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

function renderPlacement(document: Document, placement: OperationPlacement): HTMLElement {
  const article = createElement(document, "article", "opdoc-placement");
  const heading = createTextElement(document, "h4", `${placement.displayIndex}. Placement ${placement.id ?? placement.displayIndex}`);
  article.append(heading);

  const grid = createElement(document, "dl", "opdoc-placement-grid");
  appendDefinition(document, grid, "Configuration", placement.configurationId);
  appendDefinition(document, grid, "Product / variant", `${placement.productId} / ${placement.variantId}`);
  appendDefinition(document, grid, "Logo", placement.logoId);
  appendDefinition(document, grid, "Region", placement.regionId);
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
      appendDefinition(document, assetGrid, "Media type", asset.mediaType);
      if (asset.sha256Hex !== undefined) appendDefinition(document, assetGrid, "SHA-256", asset.sha256Hex);
      if (asset.description !== undefined) appendDefinition(document, assetGrid, "Description", asset.description);
      item.append(assetGrid);
      list.append(item);
    }
    article.append(list);
  }

  return article;
}

function renderConfiguration(document: Document, configuration: OperationConfiguration): HTMLElement {
  const section = createElement(document, "section", "opdoc-configuration");
  const heading = createTextElement(
    document,
    "h3",
    `${configuration.productName ?? configuration.productId} / ${configuration.variantName ?? configuration.variantId}`,
  );
  section.append(heading);

  const meta = createElement(document, "dl", "opdoc-config-meta");
  appendDefinition(document, meta, "Configuration ID", configuration.id);
  appendDefinition(document, meta, "Product ID", configuration.productId);
  appendDefinition(document, meta, "Variant ID", configuration.variantId);
  appendDefinition(document, meta, "Placements", String(configuration.placements.length));
  section.append(meta);

  if (configuration.placements.length === 0) {
    section.append(createTextElement(document, "p", "0 placements."));
  } else {
    for (const placement of configuration.placements) {
      section.append(renderPlacement(document, placement));
    }
  }

  return section;
}

export function renderOperationDocument(doc: OperationDocument, document: Document): DocumentFragment {
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
  if (doc.configurations.length === 0) configurationsSection.append(createTextElement(document, "p", "No configurations."));
  for (const configuration of doc.configurations) {
    configurationsSection.append(renderConfiguration(document, configuration));
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
