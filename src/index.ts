/**
 * v4-dwg-to-ir: High-performance CAD DWG to Semantic Intermediate Representation (IR) Compiler
 * 
 * Part of the La Vinci CAD processing ecosystem (v4).
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { convertDwgToJson } from './extractors/dwg-to-json/dwgParser.js';
import { convertToSemanticIR, type ConversionResult } from './ir/semantic/semanticConverter.js';
import type { LdDocument } from './ir/semantic/libredwg-types.js';

export * from './ir/semantic/schema.js';
export { convertDwgToJson } from './extractors/dwg-to-json/dwgParser.js';
export { convertToSemanticIR } from './ir/semantic/semanticConverter.js';

export interface ConvertOptions {
  /** Optional custom path or binary name for LibreDWG dwgread */
  dwgreadPath?: string;
}

/**
 * High-level programmatic API: Converts a DWG file directly into the Semantic CAD IR.
 * 
 * @param filePath - Absolute or relative path to the DWG/DWT file
 * @param options - Optional configuration options
 * @returns A promise resolving to the SemanticCadIR document, duration, and audit warnings
 */
export async function convertDwgToSemanticIR(
  filePath: string,
  options?: ConvertOptions
): Promise<ConversionResult> {
  const resolvedPath = path.resolve(filePath);

  // 1. Read binary and compute SHA-256 for deterministic provenance
  const fileBytes = await fs.readFile(resolvedPath);
  const hash = crypto.createHash('sha256').update(fileBytes).digest('hex');

  // 2. Decode binary DWG using LibreDWG
  const rawResult = await convertDwgToJson(resolvedPath);

  // 3. Normalize into canonical Semantic CAD IR
  return convertToSemanticIR(
    rawResult.json as LdDocument,
    resolvedPath,
    hash
  );
}
