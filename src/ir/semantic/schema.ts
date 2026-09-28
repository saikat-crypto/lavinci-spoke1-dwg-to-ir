/**
 * ============================================================
 * LA VINCI — SEMANTIC CAD INTERMEDIATE REPRESENTATION (IR)
 * ============================================================
 *
 * This file defines the TypeScript schema for Layer 2 of our 3-layer
 * compiler pipeline:
 *
 *   Layer 1: Source Preservation  (raw LibreDWG JSON, handles intact)
 *   Layer 2: Semantic CAD IR      ← YOU ARE HERE
 *   Layer 3: Render IR            (evaluated, context-specific, paintable)
 *
 * DESIGN RULES FOR THIS SCHEMA:
 *
 *  ✅ Coordinates stay in LOCAL entity space. Never baked into World space.
 *  ✅ Colors stay as symbolic references (ByLayer, ByBlock). Never pre-resolved.
 *  ✅ Block definitions are stored ONCE. Instances reference them by ID.
 *  ✅ NURBS / splines stay as exact analytic curves. No Bézier conversion yet.
 *  ✅ Proxy/unknown entities are preserved verbatim. Nothing is silently dropped.
 *  ✅ Every entity knows its source handle (for traceability back to raw DWG).
 *
 *  ❌ Do NOT put resolved RGB colors here.
 *  ❌ Do NOT put world-space baked coordinates here.
 *  ❌ Do NOT put flattened/expanded hatch lines here.
 *  ❌ Do NOT put tessellated NURBS curves here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: PRIMITIVE BUILDING BLOCKS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A 2D point. All numbers are IEEE-754 float64 (full precision).
 * Civil/geospatial drawings can have coordinates like 5,420,192.482 —
 * we must never downcast to float32 until GPU output.
 */
export interface Point2D {
  x: number;
  y: number;
}

/**
 * A 3D point (all DWG coordinates are ultimately 3D).
 */
export interface Point3D {
  x: number;
  y: number;
  z: number;
}

/**
 * A 3D unit vector. Used for extrusion normals (OCS definition).
 * The most common normal for a "flat 2D drawing" is (0, 0, 1).
 * If this deviates from (0,0,1), entities live in a tilted plane.
 */
export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

/**
 * A 2D affine transformation matrix stored in column-major order.
 * Represents any combination of translation, rotation, and scaling.
 *
 * | a  c  tx |
 * | b  d  ty |
 * | 0  0   1 |
 *
 * Composing transforms: child_world = parent_matrix × child_matrix
 *
 * IMPORTANT: We store the matrix here but NEVER pre-multiply it into
 * vertex coordinates. The matrix travels with the instance and is
 * composed lazily at render time.
 */
export interface AffineMatrix2D {
  a: number; c: number; tx: number;
  b: number; d: number; ty: number;
  /** True if this matrix has negative determinant (a*d - b*c < 0).
   *  Negative determinant = mirroring. Affects: polygon winding,
   *  text orientation, hatch direction. Must be handled specially. */
  hasMirror: boolean;
  /** True if scaleX !== scaleY. Circles become ellipses under this. */
  hasNonUniformScale: boolean;
}

/**
 * AutoCAD coordinate system note for an entity.
 * Needed for Pass 2 (OCS→WCS). The IR preserves this info but does
 * NOT bake it — the Render IR does the actual transform composition.
 */
export interface CoordinateFrame {
  /** The extrusion normal vector defining the entity's local plane.
   *  Most entities have (0,0,1). Non-(0,0,1) means the entity lives
   *  in a tilted 3D plane and needs the Arbitrary Axis Algorithm. */
  extrusionNormal: Vector3D;
  /** True when extrusionNormal is exactly (0,0,1) — the common case. */
  isStandardXY: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: COLOR & VISUAL PROPERTY REFERENCES (Symbolic — NOT resolved)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AutoCAD Color — stored as the original symbolic reference.
 *
 * WHY NOT RGBA? Because "ByLayer" has no single RGB answer.
 * A door block's line might be Red when placed on layer "Walls-Red"
 * and Gray when placed on layer "Walls-Existing". It has TWO colors
 * depending on which INSERT places it. Resolution happens in Render IR.
 */
export type CadColor =
  | { kind: 'byLayer' }          // Inherit from parent layer
  | { kind: 'byBlock' }          // Inherit from parent INSERT occurrence
  | { kind: 'aci'; index: number } // AutoCAD Color Index 1–255
  | { kind: 'trueColor'; r: number; g: number; b: number } // 24-bit explicit

/**
 * Line weight — stored symbolically.
 * -3 = byLayer, -2 = byBlock, -1 = default, 0–211 = actual weights in 1/100 mm
 */
export type LineWeight =
  | { kind: 'byLayer' }
  | { kind: 'byBlock' }
  | { kind: 'default' }
  | { kind: 'mm100'; value: number } // e.g. 25 means 0.25mm

/**
 * Linetype reference — symbolic ID into the linetype symbol table.
 * Examples: "CONTINUOUS", "DASHED", "CENTER", "BYLAYER"
 */
export type LinetypeRef =
  | { kind: 'byLayer' }
  | { kind: 'byBlock' }
  | { kind: 'named'; name: string } // e.g. "DASHED"

/**
 * The complete visual property bundle every entity carries.
 * All values are symbolic references — nothing is resolved to RGB yet.
 */
export interface VisualProperties {
  color: CadColor;
  lineWeight: LineWeight;
  linetype: LinetypeRef;
  /** 0 = fully opaque, 90 = 90% transparent. -1 = byLayer */
  transparency: number | 'byLayer' | 'byBlock';
  /** Whether to include this entity when printing/plotting */
  plotable: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: SYMBOL TABLES (The Drawing's "Dictionary")
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A layer entry in the layer table.
 * Think of layers as named "transparent sheets" stacked on top of each other.
 */
export interface LayerEntry {
  name: string;                  // e.g. "Walls", "Dimensions", "0"
  color: CadColor;               // Layer's default color
  lineWeight: LineWeight;        // Layer's default line weight
  linetype: LinetypeRef;         // Layer's default linetype
  isOff: boolean;                // Layer switched off (entities still exist)
  isFrozen: boolean;             // Layer frozen globally
  isLocked: boolean;             // Layer locked (can't edit entities on it)
  isNoPlot: boolean;             // Layer excluded from printing
  /** Source handle from original DWG — for traceability */
  sourceHandle: string;
}

/**
 * A linetype definition — describes the dash/gap pattern.
 * "GAS---GAS---" or "CENTER _ _ _ _" are linetype patterns.
 */
export interface LinetypeEntry {
  name: string;                  // e.g. "DASHED", "CENTER"
  description: string;           // Human-readable description
  /** The raw pattern elements from DWG.
   *  Positive = dash length, Negative = gap length, Zero = dot */
  patternElements: number[];
  /** Scale factor applied globally to all linetypes */
  globalScale: number;
  /** Whether pattern contains embedded text or SHX shapes */
  hasEmbeddedShapes: boolean;
  /** Raw embedded shape/text data if present */
  embeddedShapeData?: unknown;
  sourceHandle: string;
}

/**
 * A text style entry — describes how text is rendered.
 * In AutoCAD, text styles are like named CSS font + size presets.
 */
export interface TextStyleEntry {
  name: string;                  // e.g. "Standard", "ROMANS"
  fontName: string;              // e.g. "Arial", "romans.shx", "simplex.shx"
  isSHX: boolean;                // Is this an SHX vector font (not a TTF)?
  bigFontName?: string | undefined; // Secondary font for Asian character sets
  height: number;                // 0 = variable height; >0 = fixed height
  widthFactor: number;           // Horizontal scaling (1.0 = normal)
  obliqueAngle: number;          // Slant angle in radians (0 = upright)
  isBold: boolean;
  isItalic: boolean;
  /** How we resolved this font in our environment */
  fontResolution:
    | { mode: 'exact';      resourceHash: string }
    | { mode: 'substitute'; requestedName: string; resolvedTTF: string }
    | { mode: 'missing';    requestedName: string };
  sourceHandle: string;
}

/**
 * All the drawing-wide symbol tables bundled together.
 * Think of this as the "master dictionary" the drawing keeps for
 * looking up what each layer, linetype, and text style means.
 */
export interface SymbolTables {
  layers: Map<string, LayerEntry>;       // Key = layer name
  linetypes: Map<string, LinetypeEntry>; // Key = linetype name
  textStyles: Map<string, TextStyleEntry>; // Key = style name
  /** Drawing units: 1=inches, 4=mm, 6=meters, etc. */
  insunits: number;
  /** Linear units string for humans: "mm", "m", "ft" */
  linearUnitsLabel: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: GEOMETRY TYPES (Exact, Analytic — No Approximation)
// ─────────────────────────────────────────────────────────────────────────────

/** A straight line segment from point A to point B. */
export interface GeoLine {
  kind: 'line';
  start: Point3D;
  end: Point3D;
}

/** A circle defined by center and radius. */
export interface GeoCircle {
  kind: 'circle';
  center: Point3D;
  radius: number;
}

/**
 * A circular arc.
 * NOTE: If this arc is inside a block with non-uniform scale,
 * it becomes an ellipse at render time. That detection happens
 * in the Render IR, not here.
 */
export interface GeoArc {
  kind: 'arc';
  center: Point3D;
  radius: number;
  startAngleDeg: number; // 0° = positive X axis, counterclockwise
  endAngleDeg: number;
}

/**
 * An ellipse.
 * Defined by center, major axis endpoint (from center), and the ratio
 * of minor to major axis length. Start/end angle are parametric.
 */
export interface GeoEllipse {
  kind: 'ellipse';
  center: Point3D;
  /** Vector from center to the end of the major axis */
  majorAxisEndpoint: Vector3D;
  /** Ratio: minorAxisLength / majorAxisLength (0 < r ≤ 1.0) */
  minorToMajorRatio: number;
  startAngleDeg: number;
  endAngleDeg: number;
}

/**
 * A 2D lightweight polyline — the most common entity in floor plans.
 * Can contain both straight segments and curved segments (via "bulge").
 *
 * BULGE: A bulge value describes the curvature of a segment.
 *   bulge = 0    → straight line
 *   bulge = 1    → semicircle
 *   bulge = tan(angle / 4) for any arc
 *
 * We keep bulge as-is (exact). The Render IR converts it to arc geometry.
 * EXCEPTION: A non-uniform scale transform would turn the arc into an
 * ellipse — we flag that here so the Render IR knows.
 */
export interface GeoPolyline2D {
  kind: 'polyline2d';
  vertices: {
    point: Point2D;
    bulge: number;         // 0 = straight to next vertex
    startWidth: number;    // 0 = use global width
    endWidth: number;
  }[];
  isClosed: boolean;
  globalWidth: number;
  elevation: number;       // Z height for this flat polyline
}

/**
 * A 3D polyline — sequence of 3D points connected by straight segments.
 */
export interface GeoPolyline3D {
  kind: 'polyline3d';
  vertices: Point3D[];
  isClosed: boolean;
}

/**
 * A NURBS Spline — stored exactly as the DWG defines it.
 * NEVER converted to Béziers here. The Render IR does that
 * approximation at whatever tolerance the output format needs.
 *
 * NURBS = Non-Uniform Rational B-Spline:
 *  - degree: polynomial degree (usually 3 = cubic)
 *  - knots: parameter values that control how control points affect the curve
 *  - controlPoints: the "magnetic" points that pull the curve
 *  - weights: how strongly each control point pulls (=1 for non-rational)
 *  - rational: if true, weights are meaningful (enables exact conics)
 */
export interface GeoSpline {
  kind: 'spline';
  degree: number;
  knots: number[];
  controlPoints: Point3D[];
  weights: number[];
  isRational: boolean;
  isClosed: boolean;
  isPeriodic: boolean;
  /** Fit points if originally defined by fitting through points */
  fitPoints?: Point3D[];
}

/**
 * An infinite construction line through a point along a direction.
 * We keep it as-is. The Render IR clips it to the viewport/output region.
 * DO NOT clip to $EXTMIN/$EXTMAX here — that would change semantics.
 */
export interface GeoXLine {
  kind: 'xline';
  throughPoint: Point3D;
  direction: Vector3D;
}

/**
 * A ray — half-infinite line from an origin in a direction.
 */
export interface GeoRay {
  kind: 'ray';
  origin: Point3D;
  direction: Vector3D;
}

/** Union of all supported geometry types */
export type Geometry =
  | GeoLine
  | GeoCircle
  | GeoArc
  | GeoEllipse
  | GeoPolyline2D
  | GeoPolyline3D
  | GeoSpline
  | GeoXLine
  | GeoRay;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5: ENTITIES (The "Things" in a Drawing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every entity in the IR shares these common fields.
 */
export interface BaseEntity {
  /** Unique ID in our IR (stable within this document) */
  id: string;
  /** Original hexadecimal handle from the DWG file (for traceability) */
  sourceHandle: string;
  /** The layer this entity belongs to */
  layerName: string;
  /** Visual properties (symbolic — nothing resolved to RGB yet) */
  visual: VisualProperties;
  /** The local coordinate frame for this entity */
  coordinateFrame: CoordinateFrame;
  /** Extension data attached by third-party plugins (preserved verbatim) */
  xdata?: XData[] | undefined;
  /** Whether this entity is part of a group */
  groupIds?: string[];
}

/**
 * A geometric drawing entity (line, polyline, circle, arc, spline...)
 */
export interface GeometricEntity extends BaseEntity {
  kind: 'geometric';
  geometry: Geometry;
}

/**
 * A single-line text entity.
 */
export interface TextEntity extends BaseEntity {
  kind: 'text';
  text: string;             // The plain text content (control codes stripped)
  position: Point3D;        // The insertion point
  height: number;           // Text height in drawing units
  rotation: number;         // Rotation angle in degrees
  widthFactor: number;
  obliqueAngle: number;
  styleName: string;        // References a TextStyleEntry by name
  horizontalAlign: 'left' | 'center' | 'right' | 'aligned' | 'fit' | 'middle';
  verticalAlign: 'baseline' | 'bottom' | 'middle' | 'top';
}

/**
 * A multi-line text entity (MTEXT).
 * MTEXT is much richer than TEXT — it supports inline formatting,
 * multiple fonts, bullets, columns, and background masks.
 */
export interface MTextEntity extends BaseEntity {
  kind: 'mtext';
  /** Plain text content — control codes like \H0.5x; stripped */
  plainText: string;
  /** Raw MTEXT format string — preserved for full fidelity */
  rawFormatString: string;
  insertionPoint: Point3D;
  /** Width of the text box (0 = unlimited width) */
  referenceWidth: number;
  height: number;
  /** Attachment point: where insertionPoint anchors on the text box */
  attachmentPoint:
    | 'topLeft' | 'topCenter' | 'topRight'
    | 'middleLeft' | 'middleCenter' | 'middleRight'
    | 'bottomLeft' | 'bottomCenter' | 'bottomRight';
  rotation: number;
  styleName: string;
  /** Does this text have a background mask (opaque background box)? */
  hasBackgroundMask: boolean;
  backgroundMaskColor?: CadColor;
}

/**
 * A block reference (INSERT entity in DWG terms).
 *
 * Real-world analogy: a rubber stamp.
 *   - The stamp design = BlockDefinition (defined once)
 *   - Each impression on paper = BlockInstance (placed many times)
 *
 * The transform matrix tells us: where to put it, how big, what rotation.
 * We store the matrix but DO NOT pre-multiply it into any geometry.
 */
export interface BlockInstance extends BaseEntity {
  kind: 'blockInstance';
  /** Reference to the block definition's ID */
  blockDefinitionId: string;
  /** The block's name (human-readable, e.g. "Door_900mm") */
  blockName: string;
  /** Insertion point in the parent space */
  insertionPoint: Point3D;
  /** Rotation angle in degrees */
  rotation: number;
  /** X, Y, Z scale factors. Non-uniform (x≠y) means circles become ellipses. */
  scale: { x: number; y: number; z: number };
  /**
   * Precomputed affine matrix from insertion point + rotation + scale.
   * Stored for convenience. DO NOT bake vertex coordinates using this.
   */
  transform: AffineMatrix2D;
  /** Attribute values attached to this instance (tag=value pairs) */
  attributes: BlockAttribute[];
  /** Is this a MINSERT (grid array of instances)? */
  arraySpec?: {
    rowCount: number;
    columnCount: number;
    rowSpacing: number;
    columnSpacing: number;
  } | undefined;
}

/**
 * An attribute value on a specific block instance.
 * Example: Block "TitleBlock" has an attribute TAG="DrawingNo" VALUE="A-001"
 */
export interface BlockAttribute {
  tag: string;           // The attribute tag (like a variable name)
  value: string;         // The attribute value (like a variable value)
  isVisible: boolean;
  position: Point3D;
  height: number;
  rotation: number;
  styleName: string;
}

/**
 * A proxy/unknown entity — something our system (or LibreDWG) cannot
 * fully decode.
 *
 * WHY PRESERVE IT? Because it might be a Civil 3D pipe, an Architecture
 * wall, or a custom plant from a third-party plugin. We must not delete
 * the user's engineering data just because we don't understand it.
 *
 * The `proxyGraphics` field contains simplified wireframe geometry that
 * AutoCAD baked into the DWG for exactly this situation — so standard
 * viewers can still display *something*.
 */
export interface ProxyEntity extends BaseEntity {
  kind: 'proxy';
  /** The AutoCAD class name of this object e.g. "AcDbCivilAlignment" */
  originalClassName: string;
  /** DXF entity name e.g. "ACAD_PROXY_ENTITY" */
  dxfName: string;
  /** Content hash of raw bytes → stored in OpaquePayloadStore (not here) */
  opaquePayloadRef: string;
  /** Simplified geometry AutoCAD baked for standard viewers */
  proxyGraphics: Geometry[];
  /** Bounding box of the proxy graphics */
  proxyBounds?: BoundingBox2D | undefined;
}

/** Union of all entity types */
export type Entity =
  | GeometricEntity
  | TextEntity
  | MTextEntity
  | BlockInstance
  | ProxyEntity;

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6: BLOCK DEFINITIONS (The "Stamps" / Templates)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A block definition — the "master template" drawn once.
 * Every INSERT (BlockInstance) points back to one of these.
 *
 * Analogy: A block definition is the original architect's stamp design.
 * Block instances are the individual impressions on the drawing.
 */
export interface BlockDefinition {
  id: string;
  name: string;                   // e.g. "Door_900mm", "Toilet", "*Model_Space"
  /** Base point — the "handle" or "origin" of the stamp */
  basePoint: Point3D;
  /** All entities that make up this block's geometry */
  entities: Entity[];
  /** Attribute definitions (tags with default values and prompts) */
  attributeDefinitions: AttributeDefinition[];
  /** Is this a dynamic block (has parametric stretch/flip/rotate actions)? */
  isDynamic: boolean;
  /**
   * For dynamic blocks: the anonymous realized block.
   * e.g. block "Door" was stretched → AutoCAD created "*U14" with
   * the actual current geometry. We preserve both.
   */
  dynamicRealizationBlockId?: string;
  /** Is this an external reference (XREF) block? */
  isXref: boolean;
  /** Original file path if XREF (stored as metadata, NOT used for filesystem access) */
  xrefOriginalPath?: string | undefined;
  /** Resolved XREF document ID (after our sandboxed resolution) */
  xrefResolvedDocumentId?: string;
  sourceHandle: string;
}

/**
 * An attribute definition inside a block definition.
 * This is the "template" for an attribute (tag name, prompt, default value).
 */
export interface AttributeDefinition {
  tag: string;                    // Attribute identifier e.g. "ROOM_NO"
  prompt: string;                 // What to ask the user e.g. "Enter room number:"
  defaultValue: string;           // Default value if user doesn't type one
  isVisible: boolean;
  isConstant: boolean;            // If true, value cannot be changed per instance
  position: Point3D;
  height: number;
  rotation: number;
  styleName: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7: SPACES & LAYOUTS (Where Entities Live)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A 2D axis-aligned bounding box.
 */
export interface BoundingBox2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * A VIEWPORT entity on a paper sheet.
 *
 * A viewport is like a "window cut into the paper" that looks into
 * the model space at a specific zoom level, rotation, and position.
 *
 * Each viewport can have different:
 *   - Layer freeze states (some layers visible here, hidden there)
 *   - Annotation scale (text that auto-sizes per viewport scale)
 *   - Clipping boundary (can be non-rectangular!)
 */
export interface ViewportNode {
  id: string;
  sourceHandle: string;
  /** Where on the paper sheet this viewport is positioned */
  paperSpaceCenter: Point2D;
  paperSpaceWidth: number;
  paperSpaceHeight: number;
  /** Camera in model space: where is the viewport looking? */
  viewCenter: Point2D;
  viewHeight: number;            // How much model space is visible vertically
  /** Effective scale = paperSpaceHeight / viewHeight */
  scale: number;
  /** Rotation of the view (twist) in degrees */
  twistAngle: number;
  /** Layer names frozen ONLY in this viewport (not globally) */
  frozenLayerNames: string[];
  /** Annotation scale for annotative objects in this viewport */
  annotationScale: number;
  /**
   * Clipping boundary — can be a non-rectangular polygon!
   * null means the viewport uses its rectangular paper boundary.
   */
  clipBoundary: GeoPolyline2D | null;
  isActive: boolean;
  isOn: boolean;
}

/**
 * ModelSpace — the infinite drawing canvas.
 * This is where all engineering geometry lives.
 * Coordinates are real-world units (e.g. millimeters or meters).
 */
export interface ModelSpace {
  /** All entities directly in model space */
  entities: Entity[];
  /** Draw order: entity IDs in paint order (first = bottom, last = top).
   *  Derived from SORTENTSTABLE. */
  drawOrder: string[];
  /** The tight bounding box of all geometry (used for viewBox calculation) */
  bounds: BoundingBox2D | null;
}

/**
 * A paper space layout — like a physical printout sheet (A1, A3, etc.)
 * A drawing can have multiple layouts: "Floor Plan", "Electrical", "Roof Plan"
 */
export interface LayoutSpace {
  name: string;               // e.g. "Floor Plan A1"
  sourceHandle: string;
  /** Paper size in millimeters */
  paperWidth: number;
  paperHeight: number;
  /** Margin widths */
  margins: { top: number; right: number; bottom: number; left: number };
  /** "Viewport windows" cut into this paper sheet, each looking into model space */
  viewports: ViewportNode[];
  /** Title block and other entities drawn directly on this paper sheet */
  paperEntities: Entity[];
  /** Draw order for paper space entities */
  drawOrder: string[];
  /** Plot settings (paper orientation, scale, etc.) */
  plotSettings: PlotSettings;
}

/**
 * Plot settings attached to a layout.
 * These control how the drawing is printed.
 */
export interface PlotSettings {
  plotterName: string;           // e.g. "DWG To PDF.pc3"
  paperSize: string;             // e.g. "ISO A1 (841.00 x 594.00 MM)"
  orientation: 'portrait' | 'landscape';
  /** Name of the plot style table file (.ctb or .stb) */
  plotStyleName: string;
  plotStyleType: 'ctb' | 'stb' | 'none';
  scale: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8: EXTENDED DATA (Semantic Metadata from Plugins)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * XDATA — extended entity data attached to entities by third-party plugins.
 *
 * Example: AutoCAD MEP attaches pipe specs to a LINE entity:
 *   APPID: "MEP_PIPE"
 *   Data: { diameter: 150, material: "PVC", pressure: "16 Bar" }
 *
 * We preserve this verbatim. A future BIM/GIS spoke can decode it.
 */
export interface XData {
  applicationId: string;         // The plugin's registered ID e.g. "MEP_PIPE"
  data: XDataValue[];
}

export type XDataValue =
  | { type: 'string';  value: string }
  | { type: 'real';    value: number }
  | { type: 'integer'; value: number }
  | { type: 'handle';  value: string }   // Reference to another entity
  | { type: 'point3d'; value: Point3D }
  | { type: 'binary';  value: string };  // Hex-encoded binary

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9: THE COMPLETE SEMANTIC CAD IR DOCUMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Geographic / geospatial data when a drawing has real-world coordinates.
 * Common in civil engineering, surveying, and urban planning drawings.
 */
export interface GeoData {
  /** Design reference point in the drawing (the "origin" in real-world terms) */
  designPoint: Point3D;
  /** Corresponding real-world longitude/latitude */
  referencePoint: { longitude: number; latitude: number };
  /** Coordinate Reference System identifier e.g. "EPSG:32644" (UTM Zone 44N) */
  crsId: string;
  /** Human-readable CRS description */
  crsDescription: string;
  /** Direction of true north (angle in degrees from Y-axis) */
  northDirection: number;
}

/**
 * The root document — the complete Semantic CAD IR.
 *
 * This is what gets persisted to S3/disk as our intermediate artifact.
 * All downstream compilers (SVG, PDF, WebGL, DXF) read from this.
 */
export interface SemanticCadIR {
  /** IR schema version — allows future migration without breaking parsers */
  irVersion: '1.0.0';

  /** ───── Provenance ─────────────────────────────────────────────────── */
  source: {
    originalFilename: string;
    /** SHA-256 hash of the original DWG binary — for caching & identity */
    contentHash: string;
    /** AutoCAD DWG version string e.g. "AC1032" (R2018) */
    dwgVersion: string;
    /** LibreDWG version used for extraction e.g. "0.13.3" */
    extractorVersion: string;
    /** Exact LibreDWG git commit hash + configure flags (not just version!) */
    extractorCommit: string;
    extractedAt: string;         // ISO-8601 timestamp
  };

  /** ───── Drawing Metadata ──────────────────────────────────────────── */
  meta: {
    /** Drawing units code (1=inches, 4=mm, 6=meters, etc.) */
    insunits: number;
    linearUnitsLabel: string;
    angularUnitsLabel: string;
    /** Drawing extents in drawing units */
    modelExtents: BoundingBox2D | null;
    /** If this is a geospatially referenced drawing */
    geodata: GeoData | null;
    /** Drawing-level header variables worth preserving */
    headerVars: Record<string, unknown>;
  };

  /** ───── Symbol Tables ─────────────────────────────────────────────── */
  symbols: SymbolTables;

  /** ───── Block Library ────────────────────────────────────────────── */
  /** Every block definition in the drawing, keyed by ID */
  blockDefinitions: Map<string, BlockDefinition>;

  /** ───── Drawing Spaces ────────────────────────────────────────────── */
  modelSpace: ModelSpace;
  layouts: LayoutSpace[];

  /** ───── Coverage & Quality Audit ─────────────────────────────────── */
  audit: {
    /**
     * Field disposition ledger.
     * For every field LibreDWG decodes, we record what happened to it.
     * This replaces the broken "UNKNOWN_ENT == 0" metric.
     */
    fieldDispositions: {
      totalDecodedFields: number;
      semanticMappings: number;      // Fields we fully understand and model
      opaquePreserved: number;       // Fields we preserve but don't decode
      intentionallyIgnored: number;  // Fields we know are irrelevant
      unaccounted: number;           // Fields we haven't handled — MUST BE 0
    };
    /** Entity class coverage breakdown */
    entityClassAudit: {
      stable: string[];              // Classes fully decoded
      unstable: string[];            // Classes partially decoded
      proxyEntities: number;         // Proxy entity count (rendered via proxy graphics)
      unknownEntities: number;       // Truly unrecognized — should be 0
    };
    /** Warnings generated during semantic IR construction */
    warnings: IRWarning[];
  };

  /** ───── Dependency Manifest ───────────────────────────────────────── */
  dependencies: {
    /** XREFs and external assets this drawing depends on */
    external: ExternalDependency[];
  };
}

/**
 * An external dependency (XREF, raster image, PDF underlay, etc.)
 */
export interface ExternalDependency {
  kind: 'xref' | 'image' | 'pdfUnderlay' | 'dwfUnderlay' | 'dgnUnderlay' | 'pointCloud';
  /** Original path as it appeared inside the DWG (untrusted) */
  originalPath: string;
  /** Our resolved S3 key (set after sandboxed resolution; null if not found) */
  resolvedS3Key: string | null;
  /** Content hash of the resolved asset */
  contentHash: string | null;
  status: 'resolved' | 'missing' | 'sandboxBlocked';
}

/**
 * A structured warning produced during IR construction.
 */
export interface IRWarning {
  severity: 'info' | 'warning' | 'error';
  code: string;                  // e.g. "NON_STANDARD_EXTRUSION", "PROXY_ENTITY"
  message: string;
  entityHandle?: string | undefined; // Which entity triggered this warning
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10: WHAT LIVES OUTSIDE THE SEMANTIC IR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The OpaquePayloadStore — for things we cannot decode but must not lose.
 *
 * Stored separately (e.g. in S3) and referenced by content hash.
 * NOT loaded into memory as part of the working Semantic IR.
 *
 * Examples of opaque payloads:
 *   - ACIS/SAT 3D solid geometry blobs
 *   - Civil 3D proprietary binary data
 *   - Unknown custom application data
 *   - OLE2 embedded documents (Excel sheets, Word docs)
 */
export interface OpaquePayloadEntry {
  contentHash: string;           // SHA-256 of the raw bytes
  sourceEntityHandle: string;    // Which entity this came from
  payloadType: string;           // e.g. "ACIS_SAT", "OLE2", "PROXY_BINARY"
  byteSize: number;
  /** Where this blob is actually stored */
  storageUri: string;            // e.g. "s3://lavinci-jobs/opaque/abc123.bin"
}

/**
 * Things that are explicitly NOT part of the Semantic CAD IR:
 *
 *   ❌ UNDO/REDO history buffers (AutoCAD internal, meaningless outside)
 *   ❌ Object reactor linked lists (internal graph pointers, no semantic value)
 *   ❌ Thumbnail preview images (redundant — we generate SVG previews)
 *   ❌ Raw binary DWG section checksums and page maps (LibreDWG internals)
 *   ❌ Evaluated/computed fields that are just cached re-derivations of
 *      other fields (e.g. auto-computed dimension measurement text when
 *      the measurement can be re-derived from geometry)
 *
 * All of the above have dispositions recorded in `audit.fieldDispositions`
 * as `intentionallyIgnored`, so the field ledger still balances to zero.
 */

export type { SemanticCadIR as default };
