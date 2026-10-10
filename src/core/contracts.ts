/**
 * Runtime structural contracts: the checked-in provisional JSON Schemas
 * compiled with Ajv 2020-12 (actual draft 2020-12 validation, strict mode).
 *
 * The schemas are imported as JSON modules (checked in under `schemas/`),
 * so no filesystem or network access is needed at runtime — this works in
 * browsers as well as Node. `validate.ts` runs these structural checks first
 * and keeps its semantic checks (duplicate ids, dangling refs, calibration
 * resolution, method/variant applicability) on top.
 *
 * Pure apart from the Ajv import; no DOM / React / Three.js / Node APIs.
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import logoSchema from "../../schemas/logo.schema.json" with { type: "json" };
import productSchema from "../../schemas/product.schema.json" with { type: "json" };
import projectSchema from "../../schemas/project.schema.json" with { type: "json" };
import resultSchema from "../../schemas/result.schema.json" with { type: "json" };
import type { ValidationError } from "./types.js";

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(productSchema);
ajv.addSchema(logoSchema);

const validateProductSchema = ajv.compile(productSchema);
const validateLogoSchema = ajv.compile(logoSchema);
const validateProjectSchema = ajv.compile(projectSchema);
const validateResultSchema = ajv.compile(resultSchema);

function toErrors(
  keywordErrors: ErrorObject[] | null | undefined,
  what: string,
): ValidationError[] {
  return (keywordErrors ?? []).map((entry) => ({
    code: "schema-reject",
    path: entry.instancePath.length > 0 ? entry.instancePath.slice(1) : what,
    message: `${what} rejected by provisional schema (${entry.keyword}${entry.params !== undefined && Object.keys(entry.params).length > 0 ? `: ${JSON.stringify(entry.params)}` : ""}): ${entry.message ?? "invalid"}`,
  }));
}

/** Structural validation of a product definition (never throws). */
export function checkProductContract(value: unknown): ValidationError[] {
  const ok = validateProductSchema(value);
  return ok ? [] : toErrors(validateProductSchema.errors, "product");
}

/** Structural validation of a logo definition (never throws). */
export function checkLogoContract(value: unknown): ValidationError[] {
  const ok = validateLogoSchema(value);
  return ok ? [] : toErrors(validateLogoSchema.errors, "logo");
}

/** Structural validation of a full project document (never throws). */
export function checkProjectContract(value: unknown): ValidationError[] {
  const ok = validateProjectSchema(value);
  return ok ? [] : toErrors(validateProjectSchema.errors, "project");
}

/** Structural validation of a candidate export (never throws). */
export function checkResultContract(value: unknown): ValidationError[] {
  const ok = validateResultSchema(value);
  return ok ? [] : toErrors(validateResultSchema.errors, "result");
}
