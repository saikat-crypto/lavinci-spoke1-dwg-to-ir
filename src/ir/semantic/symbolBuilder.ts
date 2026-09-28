/**
 * Symbol Builder — Stage 1 of the Semantic IR pipeline
 * 
 * Reads the OBJECTS array and builds the drawing's symbol tables:
 *   - Layers (with name, color, linetype, frozen/locked/off flags)
 *   - Linetypes (with pattern description)
 *   - Text styles (with font file, sizes, flags)
 *   - Handle index (O(1) lookup of any object by its numeric absref)
 * 
 * NO geometry is processed here. This is purely the dictionary phase.
 */

import type { LdDocument, LdObject, LdHandle } from './libredwg-types.js';
import type {
  SymbolTables,
  LayerEntry,
  LinetypeEntry,
  TextStyleEntry,
  CadColor,
  LineWeight,
  LinetypeRef,
} from './schema.js';

// ─────────────────────────────────────────────────────────────────────────────
// Handle decoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract the absolute numeric reference from a LibreDWG handle tuple.
 * Handle format: [code, size, val, absref]  — we always want index 3.
 */
export function handleAbsref(h: LdHandle | undefined): number {
  if (!h || !Array.isArray(h)) return 0;
  return h[3] ?? h[2] ?? 0;
}

/** Format a handle as a hex string for use as a Map key */
export function handleKey(h: LdHandle | undefined): string {
  return `0x${handleAbsref(h).toString(16).toUpperCase()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle Index — O(1) lookup of any object by absref
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a flat index: absref → LdObject
 * This replaces the need to scan the full array every time we need to
 * resolve a handle reference (e.g., entity.layer → LayerEntry).
 */
export function buildHandleIndex(objects: LdObject[]): Map<number, LdObject> {
  const index = new Map<number, LdObject>();
  for (const obj of objects) {
    const absref = handleAbsref(obj.handle);
    if (absref > 0) {
      index.set(absref, obj);
    }
  }
  return index;
}

// ─────────────────────────────────────────────────────────────────────────────
// Color resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a LibreDWG color object into our symbolic CadColor type.
 * 
 * LibreDWG color.flag meanings:
 *   flag=1  → index is meaningful (ACI color or BYLAYER/BYBLOCK magic values)
 *   flag=32 → rgb string is 24-bit TrueColor, no index
 * 
 * ACI special values:
 *   0   → BYBLOCK
 *   256 → BYLAYER
 *   257 → ByEntity (rare)
 */
export function resolveColor(ldColor: LdObject['color'] | undefined): CadColor {
  if (!ldColor) return { kind: 'byLayer' }; // Default when missing

  const idx = ldColor.index;
  const flag = ldColor.flag ?? 1;

  // Flag=32 → TrueColor (rgb string without index)
  if (flag === 32 && ldColor.rgb && !ldColor.rgb.startsWith('c')) {
    const hex = ldColor.rgb.replace('#', '');
    if (hex.length === 6) {
      return {
        kind: 'trueColor',
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
  }

  // Index-based (flag=1 or has index)
  if (idx !== undefined) {
    if (idx === 0) return { kind: 'byBlock' };
    if (idx === 256 || idx === 257) return { kind: 'byLayer' };
    if (idx >= 1 && idx <= 255) return { kind: 'aci', index: idx };
  }

  // rgb string with 'c' prefix: format is "cFLAGRRGGBB" (8 hex chars)
  if (ldColor.rgb && ldColor.rgb.length === 8 && ldColor.rgb.startsWith('c')) {
    const r = parseInt(ldColor.rgb.slice(2, 4), 16);
    const g = parseInt(ldColor.rgb.slice(4, 6), 16);
    const b = parseInt(ldColor.rgb.slice(6, 8), 16);
    return { kind: 'trueColor', r, g, b };
  }

  return { kind: 'byLayer' }; // Safe fallback
}

/**
 * Convert LibreDWG linewt code to our LineWeight type.
 * 
 * LibreDWG uses standard DXF lineweight codes (0=5, 1=9, 2=13,...,29=default)
 * Special values: 29=default, 30=BYLAYER, 31=BYBLOCK
 */
export function resolveLineWeight(linewt: number | undefined): LineWeight {
  if (linewt === undefined || linewt === 29) return { kind: 'default' };
  if (linewt === 30) return { kind: 'byLayer' };
  if (linewt === 31) return { kind: 'byBlock' };
  // DXF lineweight index maps to: 0→5, 1→9, 2→13, 3→15, 4→18, 5→20,
  // 6→25, 7→30, 8→35, 9→40, 10→50, 11→53, 12→60, 13→70, 14→80,
  // 15→90, 16→100, 17→106, 18→120, 19→140, 20→158, 21→200, 22→211
  const lwTable = [5,9,13,15,18,20,25,30,35,40,50,53,60,70,80,90,100,106,120,140,158,200,211];
  const mm100 = lwTable[linewt] ?? 25;
  return { kind: 'mm100', value: mm100 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer Table Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse all LAYER objects from the OBJECTS array.
 * 
 * Layer flag0 bitfield (verified from LibreDWG source):
 *   bit 0 (0x01) = frozen
 *   bit 1 (0x02) = frozen in new viewports  
 *   bit 2 (0x04) = locked
 *   bit 4 (0x10) = off (invisible)
 *   bit 6 (0x40) = no-plot
 */
export function buildLayerTable(
  objects: LdObject[],
  handleIndex: Map<number, LdObject>
): Map<string, LayerEntry> {
  const layers = new Map<string, LayerEntry>();

  for (const obj of objects) {
    if (obj.object !== 'LAYER') continue;
    
    const name = obj.name ?? '0';
    const flag0 = obj.flag0 ?? 0;

    // Resolve linetype: LAYER has a `ltype` handle pointing to an LTYPE object
    let ltypeRef: LinetypeRef = { kind: 'byLayer' };
    if (obj.ltype) {
      const ltypeObj = handleIndex.get(handleAbsref(obj.ltype));
      if (ltypeObj?.name) {
        const ltName = ltypeObj.name.toUpperCase();
        if (ltName === 'BYLAYER') ltypeRef = { kind: 'byLayer' };
        else if (ltName === 'BYBLOCK') ltypeRef = { kind: 'byBlock' };
        else ltypeRef = { kind: 'named', name: ltypeObj.name };
      }
    }

    const entry: LayerEntry = {
      name,
      color: resolveColor(obj.color),
      lineWeight: resolveLineWeight(obj.linewt),
      linetype: ltypeRef,
      // In AutoCAD/LibreDWG, layer OFF is stored via negative color index or off: 1
      isOff: (obj.color?.index !== undefined && obj.color.index < 0) || obj.off === 1,
      isFrozen: (flag0 & 0x01) !== 0,
      isLocked: (flag0 & 0x04) !== 0,
      isNoPlot: name.toLowerCase() === 'defpoints' || (obj as any).plot_flag === 0 || (obj as any).plotting_flag === 0,
      sourceHandle: handleKey(obj.handle),
    };

    layers.set(name, entry);
  }

  // Always ensure layer "0" exists (it's the default in all DWG files)
  if (!layers.has('0')) {
    layers.set('0', {
      name: '0',
      color: { kind: 'aci', index: 7 },
      lineWeight: { kind: 'default' },
      linetype: { kind: 'named', name: 'Continuous' },
      isOff: false, isFrozen: false, isLocked: false, isNoPlot: false,
      sourceHandle: '0x0',
    });
  }

  return layers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Linetype Table Builder
// ─────────────────────────────────────────────────────────────────────────────

export function buildLinetypeTable(objects: LdObject[]): Map<string, LinetypeEntry> {
  const ltypes = new Map<string, LinetypeEntry>();

  for (const obj of objects) {
    if (obj.object !== 'LTYPE') continue;

    const name = obj.name ?? 'Continuous';
    const entry: LinetypeEntry = {
      name,
      description: obj.description ?? '',
      patternElements: (obj.dashes ?? []).map(d => d.length),
      globalScale: 1.0, // Applied later from HEADER.LTSCALE
      hasEmbeddedShapes: (obj.dashes ?? []).some(d => d.complex_shapecode || d.text),
      embeddedShapeData: obj.dashes?.some(d => d.complex_shapecode || d.text) 
        ? obj.dashes 
        : undefined,
      sourceHandle: handleKey(obj.handle),
    };

    ltypes.set(name, entry);
  }

  // Ensure standard system linetypes always exist
  for (const reserved of ['Continuous', 'ByLayer', 'ByBlock']) {
    if (!ltypes.has(reserved)) {
      ltypes.set(reserved, {
        name: reserved,
        description: reserved,
        patternElements: [],
        globalScale: 1.0,
        hasEmbeddedShapes: false,
        sourceHandle: '0x0',
      });
    }
  }

  return ltypes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Text Style Table Builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determines if a font file name is an SHX vector font.
 * SHX fonts end with ".shx" and are NOT system fonts.
 * TTF fonts end with ".ttf", ".otf", ".ttc" etc.
 */
function isSHXFont(fontFile: string): boolean {
  return fontFile.toLowerCase().endsWith('.shx');
}

/**
 * Map common SHX font names to TTF substitutes.
 * This is a best-effort mapping for rendering fallback.
 */
const SHX_TO_TTF: Record<string, string> = {
  'simplex.shx': 'Arial',
  'romans.shx': 'Times New Roman',
  'romanc.shx': 'Times New Roman',
  'romand.shx': 'Times New Roman',
  'romant.shx': 'Times New Roman',
  'italic.shx': 'Times New Roman Italic',
  'italict.shx': 'Times New Roman Italic',
  'greekc.shx': 'Symbol',
  'greeks.shx': 'Symbol',
  'symath.shx': 'Symbol',
  'symap.shx': 'Symbol',
  'txt.shx': 'Arial',
  'monotxt.shx': 'Courier New',
  'isocpeur.shx': 'Arial',
};

export function buildTextStyleTable(objects: LdObject[]): Map<string, TextStyleEntry> {
  const styles = new Map<string, TextStyleEntry>();

  for (const obj of objects) {
    if (obj.object !== 'STYLE') continue;

    const name = obj.name ?? 'Standard';
    const fontFile = obj.font_file ?? 'arial.ttf';
    const shx = isSHXFont(fontFile);
    const substituteTTF = shx ? (SHX_TO_TTF[fontFile.toLowerCase()] ?? 'Arial') : null;

    const entry: TextStyleEntry = {
      name,
      fontName: fontFile,
      isSHX: shx,
      bigFontName: obj.bigfont_file || undefined,
      height: obj.text_size ?? 0,
      widthFactor: obj.width_factor ?? 1.0,
      obliqueAngle: obj.oblique_angle ?? 0,
      isBold: false,   // LibreDWG doesn't expose bold directly; stored in eed
      isItalic: false, // Same
      fontResolution: shx
        ? substituteTTF
          ? { mode: 'substitute', requestedName: fontFile, resolvedTTF: substituteTTF }
          : { mode: 'missing', requestedName: fontFile }
        : { mode: 'exact', resourceHash: fontFile }, // TTF: mark as exact (resolved by name)
      sourceHandle: handleKey(obj.handle),
    };

    styles.set(name, entry);
  }

  // Always ensure Standard style exists
  if (!styles.has('Standard')) {
    styles.set('Standard', {
      name: 'Standard',
      fontName: 'arial.ttf',
      isSHX: false,
      height: 0,
      widthFactor: 1.0,
      obliqueAngle: 0,
      isBold: false,
      isItalic: false,
      fontResolution: { mode: 'exact', resourceHash: 'arial.ttf' },
      sourceHandle: '0x0',
    });
  }

  return styles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Units
// ─────────────────────────────────────────────────────────────────────────────

const INSUNITS_LABELS: Record<number, string> = {
  0: 'unitless', 1: 'in', 2: 'ft', 3: 'mi', 4: 'mm',
  5: 'cm', 6: 'm', 7: 'km', 8: 'microin', 9: 'mil',
  10: 'yd', 11: 'angstrom', 12: 'nm', 13: 'micron',
  14: 'dm', 15: 'dam', 16: 'hm', 17: 'gm', 18: 'au',
  19: 'ly', 20: 'parsec',
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

export interface SymbolBuildResult {
  symbols: SymbolTables;
  /** O(1) handle index — used by all subsequent stages */
  handleIndex: Map<number, LdObject>;
  warnings: string[];
}

export function buildSymbolTables(doc: LdDocument): SymbolBuildResult {
  const warnings: string[] = [];
  const handleIndex = buildHandleIndex(doc.OBJECTS);

  const layers = buildLayerTable(doc.OBJECTS, handleIndex);
  const linetypes = buildLinetypeTable(doc.OBJECTS);
  const textStyles = buildTextStyleTable(doc.OBJECTS);

  const insunits = doc.HEADER.INSUNITS ?? 0;
  const linearUnitsLabel = INSUNITS_LABELS[insunits] ?? 'unitless';

  // Apply global LTSCALE to all linetypes
  const ltscale = doc.HEADER.LTSCALE ?? 1.0;
  for (const lt of linetypes.values()) {
    lt.globalScale = ltscale;
  }

  if (layers.size === 0) {
    warnings.push('No LAYER objects found — using default layer "0" only');
  }

  return {
    symbols: {
      layers,
      linetypes,
      textStyles,
      insunits,
      linearUnitsLabel,
    },
    handleIndex,
    warnings,
  };
}
