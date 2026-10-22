// Shared station-assembly logic for the Logo Station build scripts.
//
// Build-only helper (never imported by shipped UI code). This module is the
// SINGLE implementation of the station assembly: brand-mark inlining,
// inline-IIFE bundling from UI templates, and the embedded customer editor
// marker. Both scripts below consume it:
//   scripts/build-station.mjs          -> production dist/station/ entry
//   scripts/build-package-preview.mjs  -> dev-only dist/dev/ pages
// Same inputs, same bytes: neither generator reimplements this construction.
//
// The production station ships NO example catalogue: no
// __logoBuilderCatalogue marker, no examples/ product/logo/asset bytes.
// Dev/test outputs keep working from examples/ via explicit imports in
// scripts/build-package-preview.mjs (unchanged semantics).
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

export function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Tracked exact original FlexiTog brand mark (red on white), inlined as a
// data URL into the station header and customer editor brand-mark imgs. No
// network, no customer artwork. Deterministic: same bytes every build.
export async function loadStationBrand() {
  const brandMarkBytes = await readFile('src/ui/shared/brand/flexitog-mark.jpg');
  const stationBrandStyles = await readFile('src/ui/shared/brand/station.css', 'utf8');
  return {
    brandMarkDataUrl: `data:image/jpeg;base64,${brandMarkBytes.toString('base64')}`,
    stationBrandStyles,
  };
}

function withBrandMark(templateHtml, brand) {
  const marker = '<img data-customer-hook="brand-mark" alt="FlexiTog">';
  if (templateHtml.split(marker).length !== 2) {
    throw new Error('Customer editor template must contain one unadorned brand-mark img');
  }
  return templateHtml.replace(
    marker,
    () => `<img data-customer-hook="brand-mark" alt="FlexiTog" src="${brand.brandMarkDataUrl}">`,
  );
}

export async function buildInlineHtmlFromTemplate(entryPoint, template, label, brand) {
  // Station brand replacements apply to the station shell template (the
  // internal builder); other embedded templates simply lack these markers.
  // The agreed station brand-mark data-URL pattern is enforced exactly-once
  // for the station shell itself.
  const stylesMarker = '<!-- STATION_BRAND_STYLES -->';
  const brandMarker = '<img data-station-brand alt="FlexiTog">';
  if (label === 'internal builder') {
    if (template.split(stylesMarker).length !== 2) {
      throw new Error(`${label} template must contain one STATION_BRAND_STYLES marker`);
    }
    if (template.split(brandMarker).length !== 2) {
      throw new Error(`${label} template must contain one unadorned station brand-mark img`);
    }
  }
  template = template
    .replace(stylesMarker, () => brand.stationBrandStyles)
    .replace(
      brandMarker,
      () => `<img data-station-brand alt="FlexiTog" src="${brand.brandMarkDataUrl}">`,
    );
  const bundle = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    minify: true,
    legalComments: 'inline',
  });
  const marker = '<!-- APP_SCRIPT -->';
  if (template.split(marker).length !== 2) {
    throw new Error(`${label} template must contain one APP_SCRIPT marker`);
  }
  const script = bundle.outputFiles[0]?.text;
  if (script === undefined) throw new Error(`${label} bundle produced no output`);
  const inlineScript = script.replace(/<\/script/gi, '<\\/script');
  return new TextEncoder().encode(template.replace(marker, () => inlineScript));
}

export async function buildInlineHtml(entryPoint, templatePath, label, brand) {
  let template = await readFile(templatePath, 'utf8');
  if (templatePath.endsWith('src/ui/customer-editor/template.html')) {
    template = withBrandMark(template, brand);
  }
  return buildInlineHtmlFromTemplate(entryPoint, template, label, brand);
}

// The full station document: internal-builder shell + embedded customer
// editor. Inline IIFE,
// file://-safe: no fetch/import of sibling JSON/modules, no CDN/network.
// (The standalone return reviewer is a dev-only page built separately in
// build-package-preview.mjs; it is NOT embedded in the station.)
// No example catalogue is embedded: the station starts empty and works only
// with real uploaded files or explicitly opened project packages.
export async function buildStationHtmlBytes(root, brand) {
  const customerHtmlBytes = await buildInlineHtml(
    'src/ui/customer-editor/main.ts',
    'src/ui/customer-editor/template.html',
    'customer editor',
    brand,
  );
  const builderTemplateRaw = await readFile('src/ui/internal-builder/template.html', 'utf8');
  const editorMarker = '<!-- CUSTOMER_EDITOR_HTML -->';
  if (builderTemplateRaw.split(editorMarker).length !== 2) {
    throw new Error('Internal builder template must contain one CUSTOMER_EDITOR_HTML marker');
  }
  const embeddedEditor = `<script id="__logoCustomerEditorHtml" type="text/plain">${Buffer.from(customerHtmlBytes).toString('base64')}</script>`;
  void root;
  const builderTemplate = builderTemplateRaw
    .replace(editorMarker, () => embeddedEditor);
  const builderHtml = new TextDecoder().decode(
    await buildInlineHtmlFromTemplate(
      'src/ui/internal-builder/main.ts',
      builderTemplate,
      'internal builder',
      brand,
    ),
  );
  return {
    stationHtmlBytes: new TextEncoder().encode(builderHtml),
    customerHtmlBytes,
  };
}
