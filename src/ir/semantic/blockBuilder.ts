/**
 * Block Builder — Stage 2 of the Semantic IR pipeline
 * 
 * Builds the block definition library and resolves INSERT instances.
 * 
 * In DWG, a BLOCK_HEADER is like a "template":
 *   - It has a name (e.g. "Door_900mm")
 *   - It contains a list of entity handles that belong to it
 *   - It has a base point (the "handle" of the stamp)
 * 
 * An INSERT entity places that block in the drawing:
 *   - It has an ins_pt (where to place it)
 *   - It has rotation, scale_x/y/z
 *   - These form an affine matrix (but we DON'T bake coordinates into it)
 * 
 * KEY DESIGN RULE:
 *   The SAME block definition can be inserted 1000 times at 1000 different
 *   positions. The block's geometry stays as-is in its local coordinate system.
 *   Each INSERT carries a transform matrix that says WHERE to paint it.
 *   We NEVER pre-multiply the matrix into the block vertices.
 */

import type { LdDocument, LdObject } from './libredwg-types.js';
import type {
  BlockDefinition,
  BlockInstance,
  BaseEntity,
  AffineMatrix2D,
  Entity,
  SymbolTables,
} from './schema.js';
import { handleKey, handleAbsref, resolveColor, resolveLineWeight } from './symbolBuilder.js';
import { buildEntities } from './entityBuilder.js';

// ─────────────────────────────────────────────────────────────────────────────
// Affine matrix construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a 2D affine matrix from LibreDWG INSERT parameters.
 * 
 * The matrix represents: translate(ins_pt) × rotate(rotation) × scale(sx, sy)
 * 
 * Note: This is a 2D matrix — we use it for 2D drawings.
 * For 3D drawings with non-trivial extrusion normals, the matrix
 * needs to be 3D (handled in Phase 2 Render IR stage).
 * 
 * Matrix layout (column-major, 2D homogeneous):
 *   | a  c  tx |   =   | sx*cos(θ)  -sy*sin(θ)  tx |
 *   | b  d  ty |       | sx*sin(θ)   sy*cos(θ)  ty |
 *   | 0  0   1 |       |         0           0    1 |
 */
export function buildAffineMatrix(
  tx: number,
  ty: number,
  rotationRad: number,
  sx: number,
  sy: number
): AffineMatrix2D {
  const cos = Math.cos(rotationRad);
  const sin = Math.sin(rotationRad);

  const a = sx * cos;
  const b = sx * sin;
  const c = -sy * sin;
  const d = sy * cos;

  const det = a * d - b * c;
  const hasMirror = det < 0;
  const hasNonUniformScale = Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-9;

  return { a, b, c, d, tx, ty, hasMirror, hasNonUniformScale };
}

// ─────────────────────────────────────────────────────────────────────────────
// Block Definition Builder
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockBuildResult {
  blockDefinitions: Map<string, BlockDefinition>;
  blockHandleToId: Map<number, string>;  // BLOCK_HEADER absref → BlockDefinition.id
  warnings: string[];
}

/**
 * Build all block definitions from BLOCK_HEADER objects.
 * 
 * Each BLOCK_HEADER has:
 *   - name: e.g. "*Model_Space", "*Paper_Space", "Door_900mm"
 *   - base_pt: the origin of the block's local coordinate system
 *   - entities: list of handle references to the entities inside this block
 */
export function buildBlockDefinitions(
  doc: LdDocument,
  handleIndex: Map<number, LdObject>,
  symbols: SymbolTables
): BlockBuildResult {
  const blockDefinitions = new Map<string, BlockDefinition>();
  const blockHandleToId = new Map<number, string>();
  const warnings: string[] = [];

  // Collect all BLOCK_HEADER objects
  const blockHeaders = doc.OBJECTS.filter(o => o.object === 'BLOCK_HEADER');

  for (const header of blockHeaders) {
    const name = header.name ?? 'unnamed';
    const absref = handleAbsref(header.handle);
    const id = `block_${handleKey(header.handle)}`;

    // Skip *Model_Space and *Paper_Space from reusable block definitions library
    if (name === '*Model_Space' || name === '*Paper_Space' || name.startsWith('*Paper_Space')) {
      blockHandleToId.set(absref, id);
      continue;
    }

    // Collect entities that belong to this block
    const blockEntities = new Set<number>();
    if (header.entities) {
      for (const h of header.entities) {
        const ref = handleAbsref(h);
        if (ref > 0) blockEntities.add(ref);
      }
    }

    const entityResult = buildEntities(
      doc.OBJECTS,
      handleIndex,
      symbols,
      {
        ownerAbsref: absref,
        allowedHandles: blockEntities.size > 0 ? blockEntities : undefined,
      }
    );

    if (entityResult.warnings.length > 0) {
      warnings.push(...entityResult.warnings.map(w => `[Block ${name}] ${w}`));
    }

    // Determine XREF status from flags
    const isXref = (header.is_xref_resolved !== undefined) && 
                   (header.xref !== undefined) && 
                   handleAbsref(header.xref) !== 0;

    const isDynamic = false; // Simplified for Phase 1

    const blockDef: BlockDefinition = {
      id,
      name,
      basePoint: (() => {
        const bp = header.base_pt;
        return bp ? { x: bp[0], y: bp[1], z: bp[2] } : { x: 0, y: 0, z: 0 };
      })(),
      entities: entityResult.entities,
      attributeDefinitions: [], // ATTDEF handling in Phase 3
      isDynamic,
      isXref,
      xrefOriginalPath: isXref ? (header.name ?? undefined) : undefined,
      sourceHandle: handleKey(header.handle),
    };

    blockDefinitions.set(id, blockDef);
    blockHandleToId.set(absref, id);
  }

  return { blockDefinitions, blockHandleToId, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// INSERT Instance Builder
// ─────────────────────────────────────────────────────────────────────────────

export interface InstanceFilter {
  ownerAbsref?: number | undefined;
  entmode?: number | undefined;
  allowedHandles?: Set<number> | undefined;
  isModelSpace?: boolean | undefined;
}

/**
 * Build BlockInstance nodes from all INSERT entities.
 * 
 * An INSERT is a lightweight "reference stamp":
 *   - block_header handle → points to which BlockDefinition to use
 *   - ins_pt → where to place it
 *   - rotation → in radians
 *   - scale → [sx, sy, sz] (default is [1,1,1])
 * 
 * We build the affine matrix but DO NOT bake any geometry.
 */
export function buildBlockInstances(
  objects: LdObject[],
  handleIndex: Map<number, LdObject>,
  blockHandleToId: Map<number, string>,
  filter?: InstanceFilter | number
): { instances: BlockInstance[]; warnings: string[] } {
  const resolvedFilter: InstanceFilter = typeof filter === 'number'
    ? { ownerAbsref: filter }
    : (filter ?? {});

  const instances: BlockInstance[] = [];
  const warnings: string[] = [];

  for (const obj of objects) {
    if (obj.entity !== 'INSERT') continue;

    const absref = handleAbsref(obj.handle);

    // Apply filters
    if (resolvedFilter.isModelSpace) {
      const matches = (obj.entmode === 2) ||
        (resolvedFilter.allowedHandles?.has(absref) ?? false) ||
        (resolvedFilter.ownerAbsref !== undefined && handleAbsref(obj.ownerhandle) === resolvedFilter.ownerAbsref);
      if (!matches) continue;
    } else {
      if (resolvedFilter.allowedHandles && !resolvedFilter.allowedHandles.has(absref)) {
        const ownerRef = handleAbsref(obj.ownerhandle);
        if (resolvedFilter.ownerAbsref === undefined || ownerRef !== resolvedFilter.ownerAbsref) {
          continue;
        }
      } else if (resolvedFilter.ownerAbsref !== undefined) {
        if (handleAbsref(obj.ownerhandle) !== resolvedFilter.ownerAbsref) continue;
      }
      if (resolvedFilter.entmode !== undefined && obj.entmode !== resolvedFilter.entmode) {
        continue;
      }
    }

    const blockHeaderRef = handleAbsref(obj.block_header);
    const blockDefId = blockHandleToId.get(blockHeaderRef);
    const blockName = blockHeaderRef 
      ? handleIndex.get(blockHeaderRef)?.name ?? 'unknown'
      : 'unknown';

    if (!blockDefId) {
      warnings.push(
        `INSERT at handle ${handleKey(obj.handle)} references unknown block header 0x${blockHeaderRef.toString(16).toUpperCase()}`
      );
    }

    // Extract insertion parameters
    const ins = obj.ins_pt ?? [0, 0, 0];
    const tx = ins[0];
    const ty = ins[1];
    const tz = ins[2] ?? 0;
    const rotRad = obj.rotation ?? 0;
    
    // Scale: LibreDWG can store as separate fields or as array
    const scaleArr = obj.scale as [number, number, number] | undefined;
    const sx = scaleArr?.[0] ?? 1;
    const sy = scaleArr?.[1] ?? 1;
    const sz = scaleArr?.[2] ?? 1;

    const transform = buildAffineMatrix(tx, ty, rotRad, sx, sy);

    // MINSERT array spec (grid of copies)
    const arraySpec = obj.numcols !== undefined || obj.numrows !== undefined
      ? {
          rowCount: (obj.numrows as number) ?? 1,
          columnCount: (obj.numcols as number) ?? 1,
          rowSpacing: (obj.row_spacing as number) ?? 0,
          columnSpacing: (obj.col_spacing as number) ?? 0,
        }
      : undefined;

    const instance: BlockInstance = {
      id: `insert_${handleKey(obj.handle)}`,
      sourceHandle: handleKey(obj.handle),
      layerName: (() => {
        if (!obj.layer) return '0';
        const layerObj = handleIndex.get(handleAbsref(obj.layer));
        return layerObj?.name ?? '0';
      })(),
      visual: {
        color: resolveColor(obj.color),
        lineWeight: resolveLineWeight(obj.linewt),
        linetype: { kind: 'byLayer' },
        transparency: -1,
        plotable: obj.plotstyle_flags !== 1,
      },
      coordinateFrame: {
        extrusionNormal: obj.extrusion 
          ? { x: obj.extrusion[0], y: obj.extrusion[1], z: obj.extrusion[2] }
          : { x: 0, y: 0, z: 1 },
        isStandardXY: !obj.extrusion || 
          (Math.abs(obj.extrusion[0]) < 1e-9 && Math.abs(obj.extrusion[1]) < 1e-9),
      },
      kind: 'blockInstance',
      blockDefinitionId: blockDefId ?? `unresolved_${blockHeaderRef.toString(16)}`,
      blockName,
      insertionPoint: { x: tx, y: ty, z: tz },
      rotation: (rotRad * 180) / Math.PI,
      scale: { x: sx, y: sy, z: sz },
      transform,
      attributes: [], // ATTRIB handling in Phase 3
      arraySpec,
    };

    instances.push(instance);
  }

  return { instances, warnings };
}
