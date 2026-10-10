/**
 * Self-contained glTF-payload validation (runs before any render attempt).
 *
 * Supported subset (the only inputs `ingestAsset` treats as renderable):
 * - glTF 2.0 JSON chunk parsed from a GLB container;
 * - geometry stored in the embedded BIN chunk (`buffers[i].uri` omitted) or
 *   in allowlisted `data:` URIs with bounded decoded length;
 * - images stored in `bufferView`s (with a known `mimeType`) or in
 *   allowlisted `data:` image URIs with bounded decoded length;
 * - uncompressed, non-instanced meshes: no Draco / meshopt compression, no
 *   GPU instancing, no other `extensionsRequired` entries.
 *
 * Rejected before render with `{ code, path, message }` issues:
 * - external or sibling URIs in `buffers`/`images` (http/https/file/blob/
 *   any URI scheme, absolute paths, `./`/`../` relatives, bare filenames
 *   such as `model.bin` / `texture.png`);
 * - `data:` URIs outside the allowlist, non-base64 payloads, or payloads
 *   whose decoded length exceeds `maxDataUriBytes`;
 * - compression/decoder extensions: `KHR_draco_mesh_compression`,
 *   `KHR_meshopt_compression`, `EXT_meshopt_compression`,
 *   `EXT_mesh_gpu_instancing`; any other `extensionsRequired` entry;
 * - dangling accessor / bufferView / mesh / node (and scene/material/
 *   texture-adjacent) references, malformed accessors, bufferViews that
 *   overrun their buffer, oversized buffers, over-long arrays.
 *
 * Advisory (non-blocking, code ends in `-advisory`): `KHR_mesh_quantization`
 * decodes without an extra decoder library, so it is reported but does not
 * block ingestion; callers decide whether to accept quantized assets.
 *
 * Portable: only shared guards are imported, no Node fs/crypto, no
 * browser/Three.js APIs.
 */

import { isRecord } from "../core/guards.js";

export interface AssetIssue {
  code: string;
  path: string;
  message: string;
}

export interface ValidateSelfContainedOptions {
  maxBytes?: number;
  maxDataUriBytes?: number;
}

export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_DATA_URI_BYTES = 8 * 1024 * 1024;
/** Per-array cap so hostile JSON cannot force unbounded validation work. */
export const MAX_ARRAY_ITEMS = 8192;
/** Upper bound for a single accessor element count. */
const MAX_ACCESSOR_COUNT = 100_000_000;

const UNSUPPORTED_COMPRESSION: Record<string, true> = {
  KHR_draco_mesh_compression: true,
  KHR_meshopt_compression: true,
  EXT_meshopt_compression: true,
};
const NEEDS_DECODER_EXTENSION = "EXT_mesh_gpu_instancing";
const QUANTIZATION_EXTENSION = "KHR_mesh_quantization";
const BUFFER_DATA_PREFIXES = [
  "data:application/octet-stream;base64,",
  "data:application/gltf-buffer;base64,",
];
const IMAGE_DATA_PREFIXES = [
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/webp;base64,",
];
const KNOWN_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const ACCESSOR_TYPES = ["SCALAR", "VEC2", "VEC3", "VEC4", "MAT2", "MAT3", "MAT4"];
const ACCESSOR_COMPONENT_TYPES = [5120, 5121, 5122, 5123, 5125, 5126];

function isRefIndex(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value as number) >= 0
  );
}

function pushRef(
  issues: AssetIssue[],
  code: string,
  path: string,
  value: unknown,
  length: number,
  what: string,
): void {
  if (!isRefIndex(value) || value >= length) {
    issues.push({
      code,
      path,
      message: `${what} index ${String(value)} is out of range (0..${length - 1}).`,
    });
  }
}

function readArray(
  issues: AssetIssue[],
  holder: Record<string, unknown>,
  key: string,
): unknown[] {
  const raw = holder[key];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push({
      code: "asset-bad-array",
      path: key,
      message: `\`${key}\` must be an array.`,
    });
    return [];
  }
  if (raw.length > MAX_ARRAY_ITEMS) {
    issues.push({
      code: "asset-too-many-entries",
      path: key,
      message: `\`${key}\` has ${raw.length} entries; at most ${MAX_ARRAY_ITEMS} are accepted.`,
    });
    return [];
  }
  return raw;
}

/** Decoded byte estimate for a base64 payload, or -1 when malformed. */
function base64ByteEstimate(payload: string): number {
  if (payload.length === 0 || payload.length % 4 !== 0) return -1;
  let padding = 0;
  if (payload.endsWith("==")) padding = 2;
  else if (payload.endsWith("=")) padding = 1;
  const body =
    padding === 0 ? payload : payload.slice(0, payload.length - padding);
  if (!/^[A-Za-z0-9+/]*$/.test(body)) return -1;
  return (payload.length / 4) * 3 - padding;
}

function pushDataUri(
  issues: AssetIssue[],
  path: string,
  uri: string,
  prefixes: string[],
  maxDataUriBytes: number,
  what: string,
): void {
  const prefix = prefixes.find((candidate) => uri.startsWith(candidate));
  if (prefix === undefined) {
    issues.push({
      code: "asset-data-uri-not-allowed",
      path,
      message: `${what} uses a \`data:\` URI outside the allowlist (${prefixes.join(", ")}).`,
    });
    return;
  }
  const estimate = base64ByteEstimate(uri.slice(prefix.length));
  if (estimate < 0) {
    issues.push({
      code: "asset-data-uri-not-allowed",
      path,
      message: `${what} \`data:\` payload is not valid base64.`,
    });
    return;
  }
  if (estimate > maxDataUriBytes) {
    issues.push({
      code: "asset-data-uri-too-large",
      path,
      message: `${what} \`data:\` payload decodes to ~${estimate} bytes; at most ${maxDataUriBytes} are accepted.`,
    });
  }
}

/**
 * Validate that the glTF JSON payload is self-contained and inside the
 * supported subset. Returns blocking errors plus `-advisory` notes; an empty
 * array means the payload is accepted for ingestion.
 */
export function validateSelfContained(
  json: unknown,
  opts?: ValidateSelfContainedOptions,
): AssetIssue[] {
  const issues: AssetIssue[] = [];
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDataUriBytes = opts?.maxDataUriBytes ?? DEFAULT_MAX_DATA_URI_BYTES;
  if (!isRecord(json)) {
    return [
      {
        code: "asset-not-object",
        path: "",
        message: "glTF payload must be a JSON object.",
      },
    ];
  }
  const root: Record<string, unknown> = json;

  const assetValue = root["asset"];
  const version =
    isRecord(assetValue) && typeof assetValue["version"] === "string"
      ? (assetValue["version"] as string)
      : null;
  if (version !== "2.0") {
    issues.push({
      code: "asset-bad-version",
      path: "asset/version",
      message: "glTF `asset.version` must be `\"2.0\"`.",
    });
  }

  const usedRaw = root["extensionsUsed"];
  const requiredRaw = root["extensionsRequired"];
  const extensionsUsed: unknown[] = Array.isArray(usedRaw) ? usedRaw : [];
  const extensionsRequired: unknown[] = Array.isArray(requiredRaw)
    ? requiredRaw
    : [];
  const extensionSeen: Record<string, true> = {};
  for (const entry of [...extensionsUsed, ...extensionsRequired]) {
    if (typeof entry === "string") extensionSeen[entry] = true;
  }
  for (const name of Object.keys(UNSUPPORTED_COMPRESSION)) {
    if (extensionSeen[name] === true) {
      issues.push({
        code: "asset-unsupported-compression",
        path: "extensionsUsed",
        message: `Compression extension \`${name}\` is not in the supported subset.`,
      });
    }
  }
  if (extensionSeen[NEEDS_DECODER_EXTENSION] === true) {
    issues.push({
      code: "asset-needs-decoder",
      path: "extensionsUsed",
      message: `\`${NEEDS_DECODER_EXTENSION}\` needs a decoder outside the supported subset.`,
    });
  }
  if (extensionSeen[QUANTIZATION_EXTENSION] === true) {
    issues.push({
      code: "asset-quantization-advisory",
      path: "extensionsUsed",
      message: `\`${QUANTIZATION_EXTENSION}\` is advisory only: quantized accessors need client-side handling.`,
    });
  }
  for (const entry of extensionsRequired) {
    if (
      typeof entry === "string" &&
      UNSUPPORTED_COMPRESSION[entry] !== true &&
      entry !== NEEDS_DECODER_EXTENSION &&
      entry !== QUANTIZATION_EXTENSION
    ) {
      issues.push({
        code: "asset-unsupported-extension",
        path: "extensionsRequired",
        message: `Required extension \`${entry}\` is outside the supported subset.`,
      });
    }
  }

  const buffers = readArray(issues, root, "buffers");
  const bufferViews = readArray(issues, root, "bufferViews");
  const accessors = readArray(issues, root, "accessors");
  const meshes = readArray(issues, root, "meshes");
  const nodes = readArray(issues, root, "nodes");
  const scenes = readArray(issues, root, "scenes");
  const images = readArray(issues, root, "images");
  const materials = readArray(issues, root, "materials");
  const textures = readArray(issues, root, "textures");
  const skins = readArray(issues, root, "skins");

  const bufferLengths: (number | null)[] = buffers.map((entry, index) => {
    const path = `buffers/${index}`;
    if (!isRecord(entry)) {
      issues.push({
        code: "asset-bad-array",
        path,
        message: "Buffer entry must be an object.",
      });
      return null;
    }
    const byteLength = entry["byteLength"];
    if (
      typeof byteLength !== "number" ||
      !Number.isInteger(byteLength) ||
      byteLength < 0
    ) {
      issues.push({
        code: "asset-bad-array",
        path: `${path}/byteLength`,
        message: "Buffer `byteLength` must be a non-negative integer.",
      });
      return null;
    }
    if (byteLength > maxBytes) {
      issues.push({
        code: "asset-too-large",
        path: `${path}/byteLength`,
        message: `Buffer declares ${byteLength} bytes; at most ${maxBytes} are accepted.`,
      });
    }
    const uri = entry["uri"];
    if (uri === undefined) {
      if (index !== 0) {
        issues.push({
          code: "asset-buffer-missing-uri",
          path,
          message: "Only the first buffer may omit `uri` (embedded BIN chunk).",
        });
      }
    } else if (typeof uri !== "string" || uri.length === 0) {
      issues.push({
        code: "asset-external-uri",
        path: `${path}/uri`,
        message: "Buffer `uri` must be a non-empty string.",
      });
    } else if (uri.startsWith("data:")) {
      pushDataUri(
        issues,
        `${path}/uri`,
        uri,
        BUFFER_DATA_PREFIXES,
        maxDataUriBytes,
        "Buffer",
      );
    } else {
      issues.push({
        code: "asset-external-uri",
        path: `${path}/uri`,
        message: `Buffer \`uri\` "${uri}" is external: only the embedded BIN chunk or allowlisted \`data:\` URIs are accepted.`,
      });
    }
    return byteLength;
  });

  bufferViews.forEach((entry, index) => {
    const path = `bufferViews/${index}`;
    if (!isRecord(entry)) {
      issues.push({
        code: "asset-bad-array",
        path,
        message: "BufferView entry must be an object.",
      });
      return;
    }
    const buffer = entry["buffer"];
    const byteOffset = entry["byteOffset"] ?? 0;
    const byteLength = entry["byteLength"];
    if (!isRefIndex(buffer) || buffer >= buffers.length) {
      issues.push({
        code: "asset-bad-bufferview-ref",
        path: `${path}/buffer`,
        message: `BufferView buffer index ${String(buffer)} is out of range (0..${buffers.length - 1}).`,
      });
      return;
    }
    if (
      typeof byteOffset !== "number" ||
      !Number.isInteger(byteOffset) ||
      byteOffset < 0 ||
      typeof byteLength !== "number" ||
      !Number.isInteger(byteLength) ||
      byteLength < 0
    ) {
      issues.push({
        code: "asset-bad-bufferview",
        path,
        message:
          "BufferView needs integer `byteOffset >= 0` and `byteLength >= 0`.",
      });
      return;
    }
    const declared = bufferLengths[buffer];
    if (declared !== null && declared !== undefined) {
      const end: number = byteOffset + byteLength;
      if (end > declared) {
        issues.push({
          code: "asset-bad-bufferview",
          path,
          message: `BufferView range ${String(byteOffset)}..${end} overruns buffer ${String(buffer)} (${String(declared)} bytes).`,
        });
      }
    }
  });

  accessors.forEach((entry, index) => {
    const path = `accessors/${index}`;
    if (!isRecord(entry)) {
      issues.push({
        code: "asset-bad-array",
        path,
        message: "Accessor entry must be an object.",
      });
      return;
    }
    const bufferView = entry["bufferView"];
    if (bufferView !== undefined) {
      pushRef(
        issues,
        "asset-bad-accessor-ref",
        `${path}/bufferView`,
        bufferView,
        bufferViews.length,
        "Accessor bufferView",
      );
    }
    const sparse = entry["sparse"];
    if (isRecord(sparse)) {
      const indices = sparse["indices"];
      const values = sparse["values"];
      pushRef(
        issues,
        "asset-bad-accessor-ref",
        `${path}/sparse/indices/bufferView`,
        isRecord(indices) ? indices["bufferView"] : undefined,
        bufferViews.length,
        "Sparse indices bufferView",
      );
      pushRef(
        issues,
        "asset-bad-accessor-ref",
        `${path}/sparse/values/bufferView`,
        isRecord(values) ? values["bufferView"] : undefined,
        bufferViews.length,
        "Sparse values bufferView",
      );
    }
    const componentType = entry["componentType"];
    const accessorType = entry["type"];
    const count = entry["count"];
    if (
      typeof componentType !== "number" ||
      !ACCESSOR_COMPONENT_TYPES.includes(componentType)
    ) {
      issues.push({
        code: "asset-bad-accessor",
        path: `${path}/componentType`,
        message:
          "Accessor `componentType` must be one of 5120/5121/5122/5123/5125/5126.",
      });
    }
    if (
      typeof accessorType !== "string" ||
      !ACCESSOR_TYPES.includes(accessorType)
    ) {
      issues.push({
        code: "asset-bad-accessor",
        path: `${path}/type`,
        message:
          "Accessor `type` must be one of SCALAR/VEC2/VEC3/VEC4/MAT2/MAT3/MAT4.",
      });
    }
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count <= 0 ||
      count > MAX_ACCESSOR_COUNT
    ) {
      issues.push({
        code: "asset-bad-accessor",
        path: `${path}/count`,
        message: "Accessor `count` must be a positive integer within bounds.",
      });
    }
  });

  images.forEach((entry, index) => {
    const path = `images/${index}`;
    if (!isRecord(entry)) {
      issues.push({
        code: "asset-bad-array",
        path,
        message: "Image entry must be an object.",
      });
      return;
    }
    const bufferView = entry["bufferView"];
    const uri = entry["uri"];
    if (bufferView !== undefined) {
      pushRef(
        issues,
        "asset-bad-accessor-ref",
        `${path}/bufferView`,
        bufferView,
        bufferViews.length,
        "Image bufferView",
      );
      const mimeType = entry["mimeType"];
      if (
        typeof mimeType !== "string" ||
        !KNOWN_IMAGE_MIME_TYPES.includes(mimeType)
      ) {
        issues.push({
          code: "asset-bad-image",
          path: `${path}/mimeType`,
          message:
            "BufferView images need `mimeType` image/png, image/jpeg, or image/webp.",
        });
      }
    } else if (typeof uri === "string" && uri.startsWith("data:")) {
      pushDataUri(
        issues,
        `${path}/uri`,
        uri,
        IMAGE_DATA_PREFIXES,
        maxDataUriBytes,
        "Image",
      );
    } else if (typeof uri === "string" && uri.length > 0) {
      issues.push({
        code: "asset-external-uri",
        path: `${path}/uri`,
        message: `Image \`uri\` "${uri}" is external: only bufferView storage or allowlisted \`data:\` image URIs are accepted.`,
      });
    } else {
      issues.push({
        code: "asset-image-missing-source",
        path,
        message: "Image needs either `bufferView` or a `data:` `uri`.",
      });
    }
  });

  meshes.forEach((entry, meshIndex) => {
    const path = `meshes/${meshIndex}`;
    if (!isRecord(entry)) {
      issues.push({
        code: "asset-bad-array",
        path,
        message: "Mesh entry must be an object.",
      });
      return;
    }
    const primitivesRaw = entry["primitives"];
    const primitives: unknown[] = Array.isArray(primitivesRaw)
      ? primitivesRaw
      : [];
    if (!Array.isArray(primitivesRaw) || primitives.length === 0) {
      issues.push({
        code: "asset-bad-array",
        path: `${path}/primitives`,
        message: "Mesh needs a non-empty `primitives` array.",
      });
      return;
    }
    primitives.forEach((primitive, primitiveIndex) => {
      const primitivePath = `${path}/primitives/${primitiveIndex}`;
      if (!isRecord(primitive)) {
        issues.push({
          code: "asset-bad-array",
          path: primitivePath,
          message: "Primitive must be an object.",
        });
        return;
      }
      const attributes = primitive["attributes"];
      if (!isRecord(attributes) || Object.keys(attributes).length === 0) {
        issues.push({
          code: "asset-bad-mesh-ref",
          path: `${primitivePath}/attributes`,
          message:
            "Primitive needs a non-empty `attributes` map of accessor indices.",
        });
      } else {
        for (const [name, ref] of Object.entries(attributes)) {
          pushRef(
            issues,
            "asset-bad-mesh-ref",
            `${primitivePath}/attributes/${name}`,
            ref,
            accessors.length,
            `Attribute ${name}`,
          );
        }
      }
      const indices = primitive["indices"];
      if (indices !== undefined) {
        pushRef(
          issues,
          "asset-bad-mesh-ref",
          `${primitivePath}/indices`,
          indices,
          accessors.length,
          "Indices accessor",
        );
      }
      const material = primitive["material"];
      if (material !== undefined) {
        pushRef(
          issues,
          "asset-bad-mesh-ref",
          `${primitivePath}/material`,
          material,
          materials.length,
          "Material",
        );
      }
      const extensions = primitive["extensions"];
      if (isRecord(extensions)) {
        for (const name of Object.keys(UNSUPPORTED_COMPRESSION)) {
          if (name in extensions) {
            issues.push({
              code: "asset-unsupported-compression",
              path: `${primitivePath}/extensions/${name}`,
              message: `Primitive uses compression extension \`${name}\`.`,
            });
          }
        }
      }
    });
  });

  nodes.forEach((entry, index) => {
    const path = `nodes/${index}`;
    if (!isRecord(entry)) {
      issues.push({
        code: "asset-bad-array",
        path,
        message: "Node entry must be an object.",
      });
      return;
    }
    const mesh = entry["mesh"];
    if (mesh !== undefined) {
      pushRef(
        issues,
        "asset-bad-node-ref",
        `${path}/mesh`,
        mesh,
        meshes.length,
        "Node mesh",
      );
    }
    const children = entry["children"];
    if (children !== undefined) {
      if (!Array.isArray(children)) {
        issues.push({
          code: "asset-bad-array",
          path: `${path}/children`,
          message: "Node `children` must be an array.",
        });
      } else {
        children.forEach((child, childIndex) => {
          pushRef(
            issues,
            "asset-bad-node-ref",
            `${path}/children/${childIndex}`,
            child,
            nodes.length,
            "Node child",
          );
        });
      }
    }
    const skin = entry["skin"];
    if (skin !== undefined) {
      pushRef(
        issues,
        "asset-bad-node-ref",
        `${path}/skin`,
        skin,
        skins.length,
        "Node skin",
      );
    }
    const extensions = entry["extensions"];
    if (isRecord(extensions) && NEEDS_DECODER_EXTENSION in extensions) {
      issues.push({
        code: "asset-needs-decoder",
        path: `${path}/extensions/${NEEDS_DECODER_EXTENSION}`,
        message: `Node uses \`${NEEDS_DECODER_EXTENSION}\`.`,
      });
    }
  });

  scenes.forEach((entry, index) => {
    const path = `scenes/${index}`;
    if (!isRecord(entry)) {
      issues.push({
        code: "asset-bad-array",
        path,
        message: "Scene entry must be an object.",
      });
      return;
    }
    const sceneNodes = entry["nodes"];
    if (sceneNodes === undefined) return;
    if (!Array.isArray(sceneNodes)) {
      issues.push({
        code: "asset-bad-array",
        path: `${path}/nodes`,
        message: "Scene `nodes` must be an array.",
      });
      return;
    }
    sceneNodes.forEach((ref, refIndex) => {
      pushRef(
        issues,
        "asset-bad-node-ref",
        `${path}/nodes/${refIndex}`,
        ref,
        nodes.length,
        "Scene node",
      );
    });
  });

  textures.forEach((entry, index) => {
    const path = `textures/${index}`;
    if (!isRecord(entry)) {
      issues.push({
        code: "asset-bad-array",
        path,
        message: "Texture entry must be an object.",
      });
      return;
    }
    const source = entry["source"];
    if (source !== undefined) {
      pushRef(
        issues,
        "asset-bad-accessor-ref",
        `${path}/source`,
        source,
        images.length,
        "Texture image",
      );
    }
  });

  return issues;
}
