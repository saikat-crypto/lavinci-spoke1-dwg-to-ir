/**
 * LibreDWG Raw JSON Types
 * 
 * These types describe the exact shape of what LibreDWG 0.13.3 outputs
 * when run with: dwgread <file> -O JSON -o output.json
 * 
 * Field names were verified directly by inspecting real DWG output.
 * Handles are always: [code, size, absref, absref]
 * Arrays of 3 numbers = [x, y, z] coordinates.
 */

// A LibreDWG handle reference: [code, size, val, absref]
export type LdHandle = [number, number, number, number];

// Color as stored in LibreDWG JSON
export interface LdColor {
  index?: number;     // ACI index: 0=BYBLOCK, 256=BYLAYER, 1-255=explicit
  rgb?: string;       // Hex: "c0000007" or "FF0000"; 'c' prefix = flag byte
  flag?: number;
}

// A raw entity/object from the OBJECTS array
export interface LdObject {
  object?: string;         // Non-entity objects: "LAYER", "LTYPE", "STYLE", "BLOCK_HEADER" etc
  entity?: string;         // Graphical entities: "LINE", "ARC", "CIRCLE", "LWPOLYLINE", etc
  index: number;
  type: number;
  handle: LdHandle;
  ownerhandle?: LdHandle;
  reactors?: LdHandle[];
  xdicobjhandle?: LdHandle;
  _subclass?: string;

  // Common entity fields
  layer?: LdHandle;        // Handle ref to LAYER object
  color?: LdColor;
  ltype_flags?: number;    // 0=BYLAYER, 1=BYBLOCK, 2=CONTINUOUS, 3=entity-specific
  ltype_scale?: number;
  linewt?: number;         // Line weight code: 29=default, 30=byLayer, 31=byBlock
  plotstyle_flags?: number;
  invisible?: number;
  entmode?: number;        // 0=in block, 1=in paper space, 2=in model space
  extrusion?: [number, number, number]; // OCS extrusion normal vector

  // BLOCK_HEADER specific
  name?: string;
  base_pt?: [number, number, number];
  entities?: LdHandle[];
  endblk_entity?: LdHandle;
  layout?: LdHandle;
  is_xref_resolved?: number;
  xref?: LdHandle;

  // LAYER specific
  flag0?: number;          // Bitfield: bit 0=frozen, bit 2=locked, bit 4=off, etc
  linewt_as_layer?: number;
  plotstyle?: LdHandle;
  material?: LdHandle;
  ltype?: LdHandle;        // LAYER's linetype handle

  // LTYPE (linetype) specific
  description?: string;
  pattern_len?: number;
  alignment?: number;
  numdashes?: number;
  dashes?: Array<{ length: number; complex_shapecode?: number; text?: string }>;

  // STYLE (text style) specific
  is_shape?: number;
  is_vertical?: number;
  text_size?: number;
  width_factor?: number;
  oblique_angle?: number;
  generation?: number;
  last_height?: number;
  font_file?: string;
  bigfont_file?: string;
  eed?: Array<{ size?: number; handle?: LdHandle; code: number; value: unknown }>;

  // LINE entity
  z_is_zero?: number;
  start?: [number, number, number];
  end?: [number, number, number];
  thickness?: number;

  // CIRCLE entity
  center?: [number, number, number];
  radius?: number;

  // ARC entity (inherits center, radius from CIRCLE)
  start_angle?: number;    // Radians
  end_angle?: number;      // Radians

  // LWPOLYLINE entity
  flag?: number;           // Bit 0=closed, bit 9=wide
  points?: Array<[number, number]>;
  bulges?: number[];
  widths?: Array<[number, number]>;  // [startWidth, endWidth] per vertex
  vertexids?: number[];
  elevation?: number;
  width?: number;          // Global width (0 = use per-vertex widths)

  // TEXT entity
  text_value?: string;
  ins_pt?: [number, number, number];
  height?: number;
  rotation?: number;       // Radians
  style?: LdHandle;
  h_just?: number;         // 0=left,1=center,2=right,3=aligned,4=fit,5=middle
  v_just?: number;         // 0=baseline,1=bottom,2=middle,3=top

  // MTEXT entity
  text?: string;           // Raw MTEXT content (may include format codes)
  rect_width?: number;
  rect_height?: number;
  text_height?: number;
  attachment?: number;     // 1-9 attachment point
  x_axis_dir?: [number, number, number];
  flow_dir?: number;
  linespace_style?: number;
  linespace_factor?: number;
  bg_fill_flag?: number;

  // INSERT entity
  ins_pt2?: [number, number, number]; // Sometimes used for insert
  scale?: [number, number, number];   // [scaleX, scaleY, scaleZ]
  block_header?: LdHandle;
  attrib_count?: number;

  // DIMENSION entities
  class_version?: number;
  text_midpt?: [number, number];
  flag1?: number;
  user_text?: string;
  text_rotation?: number;
  act_measurement?: number;
  xline1_pt?: [number, number, number];
  xline2_pt?: [number, number, number];
  def_pt?: [number, number, number];
  dim_rotation?: number;
  dimstyle?: LdHandle;
  block?: LdHandle; // anonymous presentation block

  // ELLIPSE entity
  sm_axis?: [number, number, number];   // Semi-minor axis vector
  major_axis?: [number, number, number]; // Major axis endpoint from center
  axis_ratio?: number;                   // ratio = minor/major
  param1?: number;
  param2?: number;

  // SPLINE entity
  degree?: number;
  knots?: number[];
  ctrl_pts?: Array<{ pt: [number, number, number]; w?: number }>;
  fit_pts?: Array<[number, number, number]>;
  ctrl_tol?: number;
  fit_tol?: number;

  // POINT entity
  point?: [number, number, number];
  x_ang?: number;

  // SOLID / TRACE entity
  corner1?: [number, number] | [number, number, number];
  corner2?: [number, number] | [number, number, number];
  corner3?: [number, number] | [number, number, number];
  corner4?: [number, number] | [number, number, number];

  // Catch-all for unknown fields
  [key: string]: unknown;
}

// Top-level LibreDWG JSON document
export interface LdDocument {
  created_by: string;
  FILEHEADER: {
    version: string;       // e.g. "AC1032" = R2018
    dwg_version: number;
    [key: string]: unknown;
  };
  HEADER: {
    INSUNITS: number;      // Drawing units: 4=mm, 6=meters, 1=inches
    EXTMIN: [number, number, number];
    EXTMAX: [number, number, number];
    LIMMIN: [number, number];
    LIMMAX: [number, number];
    LTSCALE: number;
    TEXTSIZE: number;
    INSBASE: [number, number, number];
    [key: string]: unknown;
  };
  CLASSES?: unknown[];
  OBJECTS: LdObject[];
  THUMBNAILIMAGE?: unknown;
  [key: string]: unknown;
}
