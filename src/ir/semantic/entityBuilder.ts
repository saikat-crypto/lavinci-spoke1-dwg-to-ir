/**
 * Entity Builder — Stage 3 of the Semantic IR pipeline
 * 
 * Converts raw LibreDWG entity objects into typed IR Entity nodes.
 * 
 * Covered entity types:
 *   LINE, ARC, CIRCLE, LWPOLYLINE, POINT, TEXT, MTEXT
 *   DIMENSION_* (preserved as opaque with key fields)
 *   Unknown / Proxy entities → ProxyEntity nodes
 * 
 * KEY DESIGN RULES:
 *   ✅ Coordinates stay in LOCAL entity space (no OCS→WCS baking)
 *   ✅ Colors stay symbolic (ByLayer/ByBlock/ACI)
 *   ✅ Layer resolved by name from symbol tables, NOT by handle lookup yet
 *   ✅ Unknown entities become ProxyEntity nodes — NOTHING is dropped
 */

import type { LdObject, LdHandle } from './libredwg-types.js';
import type {
  Entity,
  GeometricEntity,
  TextEntity,
  MTextEntity,
  ProxyEntity,
  BaseEntity,
  VisualProperties,
  CoordinateFrame,
  CadColor,
  LineWeight,
  LinetypeRef,
  GeoLine,
  GeoCircle,
  GeoArc,
  GeoPolyline2D,
  GeoPolyline3D,
  Point3D,
  Vector3D,
  BoundingBox2D,
  XData,
} from './schema.js';
import type { SymbolTables } from './schema.js';
import { resolveColor, resolveLineWeight, handleKey, handleAbsref } from './symbolBuilder.js';

// ─────────────────────────────────────────────────────────────────────────────
// Coordinate helpers
// ─────────────────────────────────────────────────────────────────────────────

function toPoint3D(arr: [number, number, number] | undefined): Point3D {
  if (!arr) return { x: 0, y: 0, z: 0 };
  return { x: arr[0], y: arr[1], z: arr[2] };
}

function toVector3D(arr: [number, number, number] | undefined): Vector3D {
  if (!arr) return { x: 0, y: 0, z: 1 };
  return { x: arr[0], y: arr[1], z: arr[2] };
}

function coordinateFrame(obj: LdObject): CoordinateFrame {
  const ext = obj.extrusion;
  const x = ext?.[0] ?? 0;
  const y = ext?.[1] ?? 0;
  const z = ext?.[2] ?? 1;
  return {
    extrusionNormal: { x, y, z },
    isStandardXY: Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 && z > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entity-level property resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert ltype_flags to a LinetypeRef.
 * 0=BYLAYER, 1=BYBLOCK, 2=CONTINUOUS, 3=explicit (handled via ltype handle)
 */
function resolveLinetypeRef(obj: LdObject, handleIndex: Map<number, LdObject>): LinetypeRef {
  const flags = obj.ltype_flags ?? 0;
  if (flags === 0) return { kind: 'byLayer' };
  if (flags === 1) return { kind: 'byBlock' };
  if (flags === 2) return { kind: 'named', name: 'Continuous' };
  // flags === 3: explicit ltype handle on the entity (less common)
  // We'd need the entity's own ltype handle field — fall back to byLayer
  return { kind: 'byLayer' };
}

/** Resolve the layer name from the entity's layer handle */
function resolveLayerName(
  obj: LdObject,
  handleIndex: Map<number, LdObject>
): string {
  if (!obj.layer) return '0';
  const layerObj = handleIndex.get(handleAbsref(obj.layer));
  return layerObj?.name ?? '0';
}

/** Build the VisualProperties for any entity */
function buildVisualProps(
  obj: LdObject,
  handleIndex: Map<number, LdObject>
): VisualProperties {
  return {
    color: resolveColor(obj.color),
    lineWeight: resolveLineWeight(obj.linewt),
    linetype: resolveLinetypeRef(obj, handleIndex),
    transparency: -1, // Default: byLayer (no explicit transparency)
    plotable: obj.plotstyle_flags !== 1, // flag=1 means no-plot
  };
}

/** Build the BaseEntity common fields */
function buildBase(
  obj: LdObject,
  handleIndex: Map<number, LdObject>,
  idPrefix: string
): BaseEntity {
  return {
    id: `${idPrefix}_${handleKey(obj.handle)}`,
    sourceHandle: handleKey(obj.handle),
    layerName: resolveLayerName(obj, handleIndex),
    visual: buildVisualProps(obj, handleIndex),
    coordinateFrame: coordinateFrame(obj),
    xdata: parseXData(obj),
  };
}

/** Extract XDATA (extended entity data) from the LibreDWG eed array */
function parseXData(obj: LdObject): XData[] | undefined {
  const eed = obj.eed as Array<{ size?: number; handle?: LdHandle; code: number; value: unknown }> | undefined;
  if (!eed || eed.length === 0) return undefined;

  const groups = new Map<string, XData>();
  let currentAppId = 'UNKNOWN';

  for (const entry of eed) {
    if (entry.handle) {
      // First entry of an XDATA group has a handle (the APPID handle)
      // We can't resolve the name without the handle index, so use hex
      currentAppId = handleKey(entry.handle);
      if (!groups.has(currentAppId)) {
        groups.set(currentAppId, { applicationId: currentAppId, data: [] });
      }
    }
    if (!groups.has(currentAppId)) {
      groups.set(currentAppId, { applicationId: currentAppId, data: [] });
    }
    const group = groups.get(currentAppId)!;
    
    // code 0 = string, 10-39 = real, 60-79 = integer, 330-369 = handle
    const val = entry.value;
    if (entry.code === 0 && typeof val === 'string') {
      group.data.push({ type: 'string', value: val });
    } else if (typeof val === 'number' && entry.code >= 10 && entry.code < 60) {
      group.data.push({ type: 'real', value: val });
    } else if (typeof val === 'number') {
      group.data.push({ type: 'integer', value: val });
    }
  }

  return groups.size > 0 ? Array.from(groups.values()) : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geometry builders
// ─────────────────────────────────────────────────────────────────────────────

function buildLine(obj: LdObject, handleIndex: Map<number, LdObject>): GeometricEntity {
  const geo: GeoLine = {
    kind: 'line',
    start: toPoint3D(obj.start),
    end: toPoint3D(obj.end),
  };
  return {
    ...buildBase(obj, handleIndex, 'line'),
    kind: 'geometric',
    geometry: geo,
  };
}

function buildCircle(obj: LdObject, handleIndex: Map<number, LdObject>): GeometricEntity {
  const geo: GeoCircle = {
    kind: 'circle',
    center: toPoint3D(obj.center),
    radius: obj.radius ?? 1,
  };
  return {
    ...buildBase(obj, handleIndex, 'circle'),
    kind: 'geometric',
    geometry: geo,
  };
}

function buildArc(obj: LdObject, handleIndex: Map<number, LdObject>): GeometricEntity {
  const geo: GeoArc = {
    kind: 'arc',
    center: toPoint3D(obj.center),
    radius: obj.radius ?? 1,
    // LibreDWG stores angles in radians; convert to degrees for readability
    startAngleDeg: (obj.start_angle ?? 0) * (180 / Math.PI),
    endAngleDeg: (obj.end_angle ?? 0) * (180 / Math.PI),
  };
  return {
    ...buildBase(obj, handleIndex, 'arc'),
    kind: 'geometric',
    geometry: geo,
  };
}

function buildLwPolyline(obj: LdObject, handleIndex: Map<number, LdObject>): GeometricEntity {
  const points = obj.points ?? [];
  const bulges = obj.bulges ?? [];
  const widths = obj.widths ?? [];
  const flag = obj.flag ?? 0;
  const isClosed = (flag & 1) !== 0;

  const geo: GeoPolyline2D = {
    kind: 'polyline2d',
    vertices: points.map((pt, i) => ({
      point: { x: pt[0], y: pt[1] },
      bulge: bulges[i] ?? 0,
      startWidth: widths[i]?.[0] ?? 0,
      endWidth: widths[i]?.[1] ?? 0,
    })),
    isClosed,
    globalWidth: obj.width ?? 0,
    elevation: obj.elevation ?? 0,
  };

  return {
    ...buildBase(obj, handleIndex, 'lwpoly'),
    kind: 'geometric',
    geometry: geo,
  };
}

function buildPoint(obj: LdObject, handleIndex: Map<number, LdObject>): GeometricEntity {
  const pt = toPoint3D(obj.point);
  const geo: GeoLine = {
    kind: 'line',
    start: pt,
    end: pt, // Same point = degenerate "dot"
  };
  return {
    ...buildBase(obj, handleIndex, 'point'),
    kind: 'geometric',
    geometry: geo,
  };
}

function buildSolid(obj: LdObject, handleIndex: Map<number, LdObject>): GeometricEntity {
  const c1 = obj.corner1 ?? [0, 0];
  const c2 = obj.corner2 ?? [0, 0];
  const c3 = obj.corner3 ?? [0, 0];
  const c4 = obj.corner4 ?? c3;

  // AutoCAD SOLID vertex loop order: 1, 2, 4, 3 (note 3 and 4 are swapped in AutoCAD representation)
  const isTri = Math.abs(c3[0] - c4[0]) < 1e-9 && Math.abs(c3[1] - c4[1]) < 1e-9;
  const pts = isTri
    ? [{ x: c1[0], y: c1[1] }, { x: c2[0], y: c2[1] }, { x: c3[0], y: c3[1] }]
    : [{ x: c1[0], y: c1[1] }, { x: c2[0], y: c2[1] }, { x: c4[0], y: c4[1] }, { x: c3[0], y: c3[1] }];

  const geo: GeoPolyline2D = {
    kind: 'polyline2d',
    vertices: pts.map(p => ({ point: p, bulge: 0, startWidth: 0, endWidth: 0 })),
    isClosed: true,
    globalWidth: 0,
    elevation: obj.elevation ?? 0,
  };

  return {
    ...buildBase(obj, handleIndex, 'solid'),
    kind: 'geometric',
    geometry: geo,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Text builders
// ─────────────────────────────────────────────────────────────────────────────

const MTEXT_ATTACHMENT: Record<number, TextEntity['horizontalAlign']> = {
  1: 'left', 2: 'center', 3: 'right',
  4: 'left', 5: 'center', 6: 'right',
  7: 'left', 8: 'center', 9: 'right',
};
const MTEXT_V_ATTACHMENT: Record<number, TextEntity['verticalAlign']> = {
  1: 'top', 2: 'top', 3: 'top',
  4: 'middle', 5: 'middle', 6: 'middle',
  7: 'bottom', 8: 'bottom', 9: 'bottom',
};

function buildText(obj: LdObject, handleIndex: Map<number, LdObject>): TextEntity {
  const styleObj = obj.style ? handleIndex.get(handleAbsref(obj.style)) : undefined;
  return {
    ...buildBase(obj, handleIndex, 'text'),
    kind: 'text',
    text: obj.text_value ?? '',
    position: toPoint3D(obj.ins_pt),
    height: obj.height ?? 2.5,
    rotation: ((obj.rotation ?? 0) * 180) / Math.PI,
    widthFactor: 1.0,
    obliqueAngle: 0,
    styleName: styleObj?.name ?? 'Standard',
    horizontalAlign: 'left',
    verticalAlign: 'baseline',
  };
}

function buildMText(obj: LdObject, handleIndex: Map<number, LdObject>): MTextEntity {
  const styleObj = obj.style ? handleIndex.get(handleAbsref(obj.style)) : undefined;
  const attachment = obj.attachment ?? 1;

  // Strip MTEXT format codes for plain text (basic implementation)
  const rawText = obj.text ?? '';
  const plainText = rawText
    .replace(/\\[A-Za-z][^;]*;/g, '') // Remove format codes like \H0.75x;
    .replace(/\\[{}\\]/g, '')          // Remove escaped braces
    .replace(/[{}]/g, '')              // Remove grouping braces
    .trim();

  return {
    ...buildBase(obj, handleIndex, 'mtext'),
    kind: 'mtext',
    plainText,
    rawFormatString: rawText,
    insertionPoint: toPoint3D(obj.ins_pt),
    referenceWidth: obj.rect_width ?? 0,
    height: obj.text_height ?? 2.5,
    attachmentPoint: (() => {
      const pts: MTextEntity['attachmentPoint'][] = [
        'topLeft','topCenter','topRight',
        'middleLeft','middleCenter','middleRight',
        'bottomLeft','bottomCenter','bottomRight',
      ];
      return pts[(attachment - 1) % 9] ?? 'topLeft';
    })(),
    rotation: 0,
    styleName: styleObj?.name ?? 'Standard',
    hasBackgroundMask: (obj.bg_fill_flag ?? 0) !== 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Proxy / Unknown entity builder
// ─────────────────────────────────────────────────────────────────────────────

function buildProxy(obj: LdObject, handleIndex: Map<number, LdObject>): ProxyEntity {
  return {
    ...buildBase(obj, handleIndex, 'proxy'),
    kind: 'proxy',
    originalClassName: obj._subclass ?? obj.object ?? obj.entity ?? 'UNKNOWN',
    dxfName: obj.entity ?? obj.object ?? 'UNKNOWN_ENT',
    opaquePayloadRef: `proxy_${handleKey(obj.handle)}`, // Placeholder — real impl stores to S3
    proxyGraphics: [], // In Phase 2 we'll extract proxy_data graphics here
    proxyBounds: undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DIMENSION handler (opaque passthrough for now)
// ─────────────────────────────────────────────────────────────────────────────

function buildDimension(obj: LdObject, handleIndex: Map<number, LdObject>): ProxyEntity {
  // Dimensions are semantically complex (DIMSTYLE + associations + geometry).
  // For Phase 1 we preserve them as ProxyEntity with key measured data.
  // Phase 3 will decompose them into full IR dimension nodes.
  return {
    ...buildBase(obj, handleIndex, 'dim'),
    kind: 'proxy',
    originalClassName: obj._subclass ?? obj.entity ?? 'DIMENSION',
    dxfName: obj.entity ?? 'DIMENSION',
    opaquePayloadRef: `dim_${handleKey(obj.handle)}`,
    proxyGraphics: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entity dispatch
// ─────────────────────────────────────────────────────────────────────────────

export interface EntityBuildResult {
  entities: Entity[];
  warnings: string[];
  stats: {
    byType: Record<string, number>;
    proxyCount: number;
    unknownCount: number;
  };
}

/**
 * Convert all graphical entities from the OBJECTS array into IR Entity nodes.
 * Only processes objects that have the `entity` field (graphical entities).
 * Non-graphical objects (LAYER, LTYPE, etc.) are skipped here.
 */
export interface EntityFilter {
  ownerAbsref?: number | undefined;
  entmode?: number | undefined;
  allowedHandles?: Set<number> | undefined;
  isModelSpace?: boolean | undefined;
}

export function buildEntities(
  objects: LdObject[],
  handleIndex: Map<number, LdObject>,
  symbols: SymbolTables,
  filter?: EntityFilter | number
): EntityBuildResult {
  const resolvedFilter: EntityFilter = typeof filter === 'number' 
    ? { ownerAbsref: filter } 
    : (filter ?? {});

  const entities: Entity[] = [];
  const warnings: string[] = [];
  const byType: Record<string, number> = {};
  let proxyCount = 0;
  let unknownCount = 0;

  for (const obj of objects) {
    // Only graphical entities have the `entity` field
    if (!obj.entity) continue;

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
        const ownerRef = handleAbsref(obj.ownerhandle);
        if (ownerRef !== resolvedFilter.ownerAbsref) continue;
      }
      if (resolvedFilter.entmode !== undefined && obj.entmode !== resolvedFilter.entmode) {
        continue;
      }
    }

    // Skip BLOCK and ENDBLK — structural markers, not drawable entities
    const entityType = obj.entity;
    if (entityType === 'BLOCK' || entityType === 'ENDBLK') continue;

    byType[entityType] = (byType[entityType] ?? 0) + 1;

    try {
      let entity: Entity;

      switch (entityType) {
        case 'LINE':
          entity = buildLine(obj, handleIndex);
          break;
        case 'CIRCLE':
          entity = buildCircle(obj, handleIndex);
          break;
        case 'ARC':
          entity = buildArc(obj, handleIndex);
          break;
        case 'LWPOLYLINE':
          entity = buildLwPolyline(obj, handleIndex);
          break;
        case 'POINT':
          entity = buildPoint(obj, handleIndex);
          break;
        case 'SOLID':
          entity = buildSolid(obj, handleIndex);
          break;
        case 'TEXT':
          entity = buildText(obj, handleIndex);
          break;
        case 'MTEXT':
          entity = buildMText(obj, handleIndex);
          break;
        case 'DIMENSION_LINEAR':
        case 'DIMENSION_ALIGNED':
        case 'DIMENSION_ANG2LN':
        case 'DIMENSION_ANG3PT':
        case 'DIMENSION_RADIUS':
        case 'DIMENSION_DIAMETER':
        case 'DIMENSION_ORDINATE':
          entity = buildDimension(obj, handleIndex);
          proxyCount++;
          break;
        default:
          // Unknown entity type — preserve as ProxyEntity
          entity = buildProxy(obj, handleIndex);
          unknownCount++;
          warnings.push(`Unhandled entity type "${entityType}" at handle ${handleKey(obj.handle)} — preserved as ProxyEntity`);
      }

      entities.push(entity);
    } catch (err: any) {
      warnings.push(`Failed to convert entity type "${entityType}" at handle ${handleKey(obj.handle)}: ${err.message}`);
    }
  }

  return { entities, warnings, stats: { byType, proxyCount, unknownCount } };
}
