/**
 * Test Runner CLI for the Semantic CAD IR Pipeline
 * 
 * Usage:
 *   npx tsx src/ir/semantic/testRunner.ts <path-to-dwg-file> [--save-json]
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { convertDwgToJson } from '../../extractors/dwg-to-json/dwgParser.js';
import { convertToSemanticIR } from './semanticConverter.js';
import type { LdDocument } from './libredwg-types.js';

async function main() {
  const args = process.argv.slice(2);
  const dwgFile = args.find(a => !a.startsWith('--'));
  const saveJson = args.includes('--save-json');

  if (!dwgFile) {
    console.error('Usage: npx tsx src/ir/semantic/testRunner.ts <path-to-dwg-file> [--save-json]');
    process.exit(1);
  }

  const resolvedPath = path.resolve(dwgFile);
  console.log(`\n===============================================================`);
  console.log(`🚀 LA VINCI — SEMANTIC CAD IR COMPILER TEST RUNNER`);
  console.log(`===============================================================`);
  console.log(`Input DWG: ${resolvedPath}`);

  // 1. Compute SHA-256 hash of original binary
  const fileBytes = await fs.readFile(resolvedPath);
  const hash = crypto.createHash('sha256').update(fileBytes).digest('hex');
  console.log(`DWG SHA-256: ${hash}`);
  console.log(`DWG File Size: ${(fileBytes.length / 1024).toFixed(2)} KB`);

  // 2. Stage 0: Decode DWG to LibreDWG raw JSON
  console.log(`\n[Stage 0] Decoding DWG with LibreDWG 0.13.3...`);
  const extractStart = Date.now();
  const rawResult = await convertDwgToJson(resolvedPath);
  const extractDuration = Date.now() - extractStart;
  console.log(`  ✓ Decoded in ${extractDuration} ms`);
  console.log(`  ✓ Raw Objects Count: ${rawResult.json.OBJECTS?.length ?? 0}`);

  // 3. Stages 1-4: Normalize to Semantic CAD IR
  console.log(`\n[Stages 1-4] Normalizing to Semantic CAD IR...`);
  const semanticStart = Date.now();
  const result = await convertToSemanticIR(
    rawResult.json as LdDocument,
    resolvedPath,
    hash
  );
  const semanticDuration = Date.now() - semanticStart;
  const ir = result.ir;

  console.log(`  ✓ Semantic normalization completed in ${semanticDuration} ms`);
  console.log(`  ✓ Total Pipeline Time: ${extractDuration + semanticDuration} ms`);

  // 4. Print Semantic CAD IR Summary
  console.log(`\n---------------------------------------------------------------`);
  console.log(`📊 SEMANTIC CAD IR SUMMARY`);
  console.log(`---------------------------------------------------------------`);
  console.log(`IR Schema Version : ${ir.irVersion}`);
  console.log(`Source DWG Version: ${ir.source.dwgVersion}`);
  console.log(`Units Code        : ${ir.meta.insunits} (${ir.meta.linearUnitsLabel})`);

  if (ir.meta.modelExtents) {
    const b = ir.meta.modelExtents;
    console.log(`Model Extents     : X[${b.minX.toFixed(2)}, ${b.maxX.toFixed(2)}] Y[${b.minY.toFixed(2)}, ${b.maxY.toFixed(2)}]`);
  } else {
    console.log(`Model Extents     : (not specified in header)`);
  }

  // Symbol tables
  console.log(`\n📁 SYMBOL TABLES:`);
  console.log(`  Layers (${ir.symbols.layers.size}):`);
  for (const [name, l] of ir.symbols.layers) {
    const flags = [
      l.isOff ? 'OFF' : null,
      l.isFrozen ? 'FROZEN' : null,
      l.isLocked ? 'LOCKED' : null,
      l.isNoPlot ? 'NO-PLOT' : null,
    ].filter(Boolean).join(', ');
    const flagStr = flags ? ` [${flags}]` : '';
    console.log(`    - "${name}" (Color: ${JSON.stringify(l.color)}, Lineweight: ${JSON.stringify(l.lineWeight)})${flagStr}`);
  }

  console.log(`  Linetypes   : ${ir.symbols.linetypes.size} entries`);
  console.log(`  Text Styles : ${ir.symbols.textStyles.size} entries`);
  for (const [name, st] of ir.symbols.textStyles) {
    console.log(`    - "${name}" (Font: ${st.fontName}, SHX: ${st.isSHX}, Resolution: ${st.fontResolution.mode})`);
  }

  // Block definitions
  console.log(`\n📦 BLOCK DEFINITIONS (${ir.blockDefinitions.size}):`);
  for (const [id, block] of ir.blockDefinitions) {
    if (block.entities.length > 0 || !block.name.startsWith('*')) {
      console.log(`    - "${block.name}" (${block.entities.length} sub-entities, basePoint: [${block.basePoint.x}, ${block.basePoint.y}, ${block.basePoint.z}])`);
    }
  }

  // Model space breakdown
  console.log(`\n🎨 MODEL SPACE:`);
  console.log(`  Total Root Entities: ${ir.modelSpace.entities.length}`);

  const entityTypeCounts: Record<string, number> = {};
  for (const ent of ir.modelSpace.entities) {
    let t = ent.kind as string;
    if (ent.kind === 'geometric') {
      t = (ent as any).geometry.kind;
    }
    entityTypeCounts[t] = (entityTypeCounts[t] ?? 0) + 1;
  }
  for (const [t, count] of Object.entries(entityTypeCounts)) {
    console.log(`    - ${t.padEnd(14)}: ${count}`);
  }

  // Audit and Dispositions
  console.log(`\n🔍 AUDIT & COVERAGE:`);
  console.log(`  Semantic Mappings   : ${ir.audit.fieldDispositions.semanticMappings}`);
  console.log(`  Proxy / Fallbacks   : ${ir.audit.fieldDispositions.opaquePreserved}`);
  console.log(`  Unaccounted Entities: ${ir.audit.fieldDispositions.unaccounted}`);
  console.log(`  Warnings Count      : ${ir.audit.warnings.length}`);
  if (ir.audit.warnings.length > 0) {
    console.log(`  Sample Warnings (first 3):`);
    ir.audit.warnings.slice(0, 3).forEach(w => console.log(`    ⚠️  [${w.code}] ${w.message}`));
  }

  // Optionally save JSON output
  if (saveJson) {
    const outFilename = `${path.basename(dwgFile, path.extname(dwgFile))}_semantic_ir.json`;
    const outPath = path.join(process.cwd(), outFilename);
    
    // Custom serializer to handle Map serialization
    const replacer = (_key: string, value: any) => {
      if (value instanceof Map) {
        return Object.fromEntries(value.entries());
      }
      return value;
    };
    
    await fs.writeFile(outPath, JSON.stringify(ir, replacer, 2), 'utf8');
    console.log(`\n💾 Saved Semantic CAD IR to: ${outPath}`);
  }

  console.log(`===============================================================\n`);
}

main().catch(err => {
  console.error('\n❌ Fatal error in test runner:', err);
  process.exit(1);
});
