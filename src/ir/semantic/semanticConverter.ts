/**
 * Semantic Converter — Main Orchestrator
 * 
 * Converts raw LibreDWG JSON (LdDocument) into a Semantic CAD IR.
 * 
 * Pipeline:
 *   Stage 0: Parse raw JSON (done by dwgParser.ts)
 *   Stage 1: Build handle index + symbol tables (symbolBuilder)
 *   Stage 2: Build block definitions (blockBuilder)
 *   Stage 3: Build model space entities + block instances (entityBuilder + blockBuilder)
 *   Stage 4: Assemble final SemanticCadIR document
 */

import * as crypto from 'crypto';
import { readFile } from 'fs/promises';
import type { LdDocument } from './libredwg-types.js';
import type {
  SemanticCadIR,
  ModelSpace,
  BoundingBox2D,
  IRWarning,
} from './schema.js';
import { buildSymbolTables, handleAbsref, handleKey } from './symbolBuilder.js';
import { buildBlockDefinitions, buildBlockInstances } from './blockBuilder.js';
import { buildEntities } from './entityBuilder.js';

// ─────────────────────────────────────────────────────────────────────────────
// Drawing version mapping
// ─────────────────────────────────────────────────────────────────────────────

const DWG_VERSION_MAP: Record<string, string> = {
  'AC1006': 'R10', 'AC1009': 'R12', 'AC1012': 'R13',
  'AC1014': 'R14', 'AC1015': '2000', 'AC1018': '2004',
  'AC1021': '2007', 'AC1024': '2010', 'AC1027': '2013',
  'AC1032': '2018',
};

// ─────────────────────────────────────────────────────────────────────────────
// Model extents calculation
// ─────────────────────────────────────────────────────────────────────────────

function extractModelExtents(doc: LdDocument): BoundingBox2D | null {
  const extMin = doc.HEADER.EXTMIN;
  const extMax = doc.HEADER.EXTMAX;
  if (!extMin || !extMax) return null;

  const [minX, minY] = extMin;
  const [maxX, maxY] = extMax;

  // If extents are unset (all zeros or inverted), return null
  if (minX === 0 && minY === 0 && maxX === 0 && maxY === 0) return null;
  if (minX >= maxX || minY >= maxY) return null;

  return { minX, minY, maxX, maxY };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Conversion Function
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversionResult {
  ir: SemanticCadIR;
  durationMs: number;
  warnings: IRWarning[];
}

/**
 * Convert a parsed LibreDWG JSON document into the Semantic CAD IR.
 * 
 * @param doc      The parsed LibreDWG JSON document
 * @param filePath Original DWG file path (for provenance metadata)
 * @param rawDwgHash SHA-256 hash of the original DWG binary (for caching)
 */
export async function convertToSemanticIR(
  doc: LdDocument,
  filePath: string,
  rawDwgHash: string
): Promise<ConversionResult> {
  const start = Date.now();
  const allWarnings: IRWarning[] = [];

  function warn(code: string, message: string, entityHandle?: string): void {
    allWarnings.push({ severity: 'warning', code, message, entityHandle });
  }

  // ── Stage 1: Symbol Tables & Handle Index ─────────────────────────────────
  const { symbols, handleIndex, warnings: symWarnings } = buildSymbolTables(doc);
  symWarnings.forEach(w => warn('SYMBOL_BUILD', w));

  // ── Stage 2: Block Definitions ────────────────────────────────────────────
  const {
    blockDefinitions,
    blockHandleToId,
    warnings: blockWarnings
  } = buildBlockDefinitions(doc, handleIndex, symbols);
  blockWarnings.forEach(w => warn('BLOCK_BUILD', w));

  // ── Stage 3: Identify ModelSpace & PaperSpace blocks ─────────────────────
  // In DWG, *Model_Space and *Paper_Space are special BLOCK_HEADER objects.
  // Model space entities live inside the *Model_Space block.
  const modelSpaceHeader = doc.OBJECTS.find(
    o => o.object === 'BLOCK_HEADER' && o.name === '*Model_Space'
  );
  if (!modelSpaceHeader) {
    warn('NO_MODEL_SPACE', 'No *Model_Space block header found in this drawing');
  }

  const modelSpaceAbsref = modelSpaceHeader 
    ? handleAbsref(modelSpaceHeader.handle) 
    : 0;

  // Collect handles explicitly listed in modelSpaceHeader.entities if present
  const msHandles = new Set<number>();
  if (modelSpaceHeader?.entities) {
    for (const h of modelSpaceHeader.entities) {
      const ref = handleAbsref(h);
      if (ref > 0) msHandles.add(ref);
    }
  }

  // Build entities that belong to model space
  const modelEntityResult = buildEntities(
    doc.OBJECTS,
    handleIndex,
    symbols,
    {
      isModelSpace: true,
      ownerAbsref: modelSpaceAbsref > 0 ? modelSpaceAbsref : undefined,
      allowedHandles: msHandles.size > 0 ? msHandles : undefined,
    }
  );
  modelEntityResult.warnings.forEach(w => warn('ENTITY_BUILD', w));

  // Build INSERT instances in model space
  const modelInsertResult = buildBlockInstances(
    doc.OBJECTS,
    handleIndex,
    blockHandleToId,
    {
      isModelSpace: true,
      ownerAbsref: modelSpaceAbsref > 0 ? modelSpaceAbsref : undefined,
      allowedHandles: msHandles.size > 0 ? msHandles : undefined,
    }
  );
  modelInsertResult.warnings.forEach(w => warn('INSERT_BUILD', w));

  // Combine: model space = primitive entities + block instances
  const modelSpaceEntities = [
    ...modelEntityResult.entities,
    ...modelInsertResult.instances,
  ];

  // ── Stage 4: Assemble the SemanticCadIR ──────────────────────────────────
  const modelSpace: ModelSpace = {
    entities: modelSpaceEntities,
    drawOrder: modelSpaceEntities.map(e => e.id), // Default: creation order
    bounds: extractModelExtents(doc),
  };

  // Collect audit stats
  const allEntityTypes = { ...modelEntityResult.stats.byType };
  const totalSemantic = Object.values(allEntityTypes).reduce((a, b) => a + b, 0);
  const proxyCount = modelEntityResult.stats.proxyCount;
  const unknownCount = modelEntityResult.stats.unknownCount;
  
  // Count all entity types across all blocks too
  let totalDecoded = totalSemantic;
  for (const blockDef of blockDefinitions.values()) {
    totalDecoded += blockDef.entities.length;
  }

  const fileVersion = doc.FILEHEADER?.version ?? 'unknown';
  const createdBy = doc.created_by ?? 'LibreDWG';
  const extractorVersion = createdBy.replace('LibreDWG ', '').trim();

  const ir: SemanticCadIR = {
    irVersion: '1.0.0',

    source: {
      originalFilename: filePath.split(/[\\/]/).pop() ?? filePath,
      contentHash: rawDwgHash,
      dwgVersion: `${fileVersion} (AutoCAD ${DWG_VERSION_MAP[fileVersion] ?? 'unknown'})`,
      extractorVersion,
      extractorCommit: 'libredwg-0.13.3-windows-binary', // Phase 2: read from build manifest
      extractedAt: new Date().toISOString(),
    },

    meta: {
      insunits: doc.HEADER.INSUNITS ?? 0,
      linearUnitsLabel: symbols.linearUnitsLabel,
      angularUnitsLabel: 'deg',
      modelExtents: extractModelExtents(doc),
      geodata: null, // Phase 5: GEODATA extraction
      headerVars: {
        LTSCALE: doc.HEADER.LTSCALE,
        TEXTSIZE: doc.HEADER.TEXTSIZE,
        INSBASE: doc.HEADER.INSBASE,
        EXTMIN: doc.HEADER.EXTMIN,
        EXTMAX: doc.HEADER.EXTMAX,
        DIMSCALE: doc.HEADER.DIMSCALE,
      },
    },

    symbols,
    blockDefinitions,
    modelSpace,
    layouts: [], // Phase 2: paper space layout extraction

    audit: {
      fieldDispositions: {
        totalDecodedFields: doc.OBJECTS.length, // Approximation for Phase 1
        semanticMappings: totalDecoded,
        opaquePreserved: proxyCount,
        intentionallyIgnored: 0, // Will be tracked in Phase 3+
        unaccounted: 0,
      },
      entityClassAudit: {
        stable: Object.keys(allEntityTypes).filter(t => 
          !['DIMENSION_LINEAR','DIMENSION_ALIGNED','DIMENSION_ANG2LN',
            'DIMENSION_ANG3PT','DIMENSION_RADIUS','DIMENSION_DIAMETER'].includes(t)
        ),
        unstable: Object.keys(allEntityTypes).filter(t => t.startsWith('DIMENSION')),
        proxyEntities: proxyCount,
        unknownEntities: unknownCount,
      },
      warnings: allWarnings,
    },

    dependencies: {
      external: [], // Phase 2: XREF discovery
    },
  };

  return {
    ir,
    durationMs: Date.now() - start,
    warnings: allWarnings,
  };
}
