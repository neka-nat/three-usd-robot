/**
 * Binds renderable gprims — `UsdGeom.Mesh` plus the parametric solids (`Cube` /
 * `Sphere` / `Cylinder` / `Capsule` / `Cone`) — to Three.js geometry and
 * attaches them under the robot's link objects.
 *
 * Meshes are triangulated with a simple fan. Primvars (`st` UV sets, `normals`,
 * `displayColor`) resolve with USD interpolation semantics — `:indices`
 * de-referencing, vertex vs faceVarying (de-indexed) layouts, multiple UV
 * channels. Solids tessellate from their schema attributes. Geometry is left
 * in stage units; the global `metersPerUnit` scale is applied at the root in M9.
 */

import * as THREE from "three";
import { type Mat4, identity4, multiply } from "../kinematics/transforms.js";
import type { Vec2, Vec3 } from "../parser/ast.js";
import type { RobotDescription } from "../robot/RobotDescription.js";
import {
  type MaterialSubset,
  getMaterialSubsets,
  isNonVisualPurpose,
  isRenderableGprim,
} from "../schemas/usdGeom.js";
import { COLLISION_API } from "../schemas/usdPhysics.js";
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";
import type { MdlModuleProvider } from "../usd/mdl/parseMdl.js";
import { computeLocalTransform } from "../usd/xformOps.js";
import {
  type ResolveMaterialOptions,
  type ResolvedTexture,
  resolveBoundMaterial,
} from "./MaterialBinding.js";
import type { TextureProvider } from "./TextureBinding.js";
import type { ThreeUsdRobot } from "./ThreeUsdRobot.js";

export type MeshKind = "visual" | "collision";

const DEFAULT_COLOR = 0x9a9a9a;

export type BindMeshesOptions = {
  loadVisuals?: boolean;
  loadCollisions?: boolean;
  /** Resolves diffuse texture asset paths to `THREE.Texture` (M-tex). */
  textureProvider?: TextureProvider;
  /** Render `BasisCurves` with authored `widths` as tube meshes (M18). */
  curveTubes?: boolean;
  /** Receives fidelity diagnostics (channel-packing mismatches, M19). */
  onWarn?: (message: string) => void;
  /** Parsed `.mdl` modules for MDL material family/value resolution (M20). */
  mdl?: MdlModuleProvider;
};

/** Interpolation domain of a resolved primvar (UsdGeom tokens; `varying` ⇒ `vertex`). */
type PrimvarInterpolation = "constant" | "uniform" | "vertex" | "faceVarying";

type ResolvedPrimvar = {
  /** Tuples after `primvars:<name>:indices` de-referencing. */
  values: number[][];
  interpolation: PrimvarInterpolation;
};

/** Element counts of the interpolation domains on a mesh. */
type MeshLens = { points: number; faceVertices: number; faces: number };

/**
 * Read a primvar (or a bare attribute like `normals`): applies the paired
 * `:indices` array, then resolves the interpolation — authored metadata
 * first, else inferred from the value count. Data too short for its domain
 * degrades to constant instead of producing a broken attribute.
 */
function readPrimvar(
  meshPrim: Prim,
  attrName: string,
  isTuple: (v: unknown) => boolean,
  lens: MeshLens,
): ResolvedPrimvar | null {
  const attr = meshPrim.GetAttribute(attrName);
  const raw = attr.Get();
  if (!isTuple(raw) || (raw as number[][]).length === 0) return null;
  const base = raw as number[][];
  let values = base;
  const idx = meshPrim.GetAttribute(`${attrName}:indices`).Get();
  if (isNumberArray(idx)) values = idx.map((i) => base[i] ?? base[0]!);

  const authored = attr.GetMetadata("interpolation");
  let interpolation: PrimvarInterpolation;
  if (authored === "varying")
    interpolation = "vertex"; // ≡ vertex on polygon meshes
  else if (
    authored === "constant" ||
    authored === "uniform" ||
    authored === "vertex" ||
    authored === "faceVarying"
  ) {
    interpolation = authored;
  } else if (values.length === lens.points && lens.points > 0) interpolation = "vertex";
  else if (values.length === lens.faceVertices && lens.faceVertices > 0)
    interpolation = "faceVarying";
  else if (values.length === lens.faces && lens.faces > 0) interpolation = "uniform";
  else interpolation = "constant";

  const needed =
    interpolation === "vertex"
      ? lens.points
      : interpolation === "faceVarying"
        ? lens.faceVertices
        : interpolation === "uniform"
          ? lens.faces
          : 1;
  if (values.length < needed) interpolation = "constant";
  return { values, interpolation };
}

/**
 * UV-set primvar names authored on a mesh — `"st"` first (three's `uv`
 * attribute / channel 0), extras sorted (`uv1`, `uv2`, …). The geometry and
 * material builders both derive the channel mapping from this order.
 */
/** UV-capable primvar value types (pxr spells it `texCoord2f`, assets vary). */
const UV_TYPE_NAMES: ReadonlySet<string> = new Set(["texcoord2f", "float2"]);

function meshUvSetNames(meshPrim: Prim): string[] {
  const sets: string[] = [];
  for (const attr of meshPrim.GetAttributes()) {
    const name = attr.GetName();
    if (!name.startsWith("primvars:") || name.endsWith(":indices")) continue;
    if (!attr.IsArray()) continue;
    if (!UV_TYPE_NAMES.has(attr.GetTypeName().toLowerCase())) continue;
    sets.push(name.slice("primvars:".length));
  }
  sets.sort((a, b) => (a === "st" ? -1 : b === "st" ? 1 : a < b ? -1 : 1));
  return sets;
}

function uvAttrName(index: number): string {
  return index === 0 ? "uv" : `uv${index}`;
}

function meshLens(meshPrim: Prim): MeshLens {
  const points = meshPrim.GetAttribute("points").Get();
  const counts = meshPrim.GetAttribute("faceVertexCounts").Get();
  const indices = meshPrim.GetAttribute("faceVertexIndices").Get();
  const hasTopology = isNumberArray(counts) && isNumberArray(indices);
  return {
    points: isVec3Array(points) ? points.length : 0,
    faceVertices: hasTopology ? (indices as number[]).length : 0,
    faces: hasTopology ? (counts as number[]).length : 0,
  };
}

/** The mesh's `primvars:displayColor`, resolved — shared by geometry & material. */
function displayColorPrimvar(meshPrim: Prim): ResolvedPrimvar | null {
  return readPrimvar(meshPrim, "primvars:displayColor", isVec3Array, meshLens(meshPrim));
}

/**
 * Build a `BufferGeometry` from a Mesh prim, or `null` if it has no points.
 *
 * Primvars resolve with full interpolation semantics (M19): `:indices` arrays
 * are de-referenced, vertex-interpolated `st` sets / `normals` /
 * `displayColor` bind onto the shared vertices, and any faceVarying primvar
 * (or per-face color) switches the mesh to a de-indexed layout where every
 * face corner owns its vertex. Extra UV sets become `uv1`, `uv2`, … in
 * {@link meshUvSetNames} order.
 *
 * When the mesh carries `materialBind` face subsets, the triangles are ordered
 * subset by subset and a geometry group is added for each — so the mesh can be
 * drawn with one material per subset (see {@link buildMeshMaterials}). Group
 * order matches {@link getMaterialSubsets}, with any unassigned faces last.
 */
export function buildMeshGeometry(meshPrim: Prim): THREE.BufferGeometry | null {
  const points = meshPrim.GetAttribute("points").Get();
  if (!isVec3Array(points) || points.length === 0) return null;

  const countsRaw = meshPrim.GetAttribute("faceVertexCounts").Get();
  const indicesRaw = meshPrim.GetAttribute("faceVertexIndices").Get();
  const counts = isNumberArray(countsRaw) ? countsRaw : null;
  const indices = isNumberArray(indicesRaw) ? indicesRaw : null;
  const lens: MeshLens = {
    points: points.length,
    faceVertices: counts && indices ? indices.length : 0,
    faces: counts && indices ? counts.length : 0,
  };

  const uvSets = meshUvSetNames(meshPrim).map((set) =>
    readPrimvar(meshPrim, `primvars:${set}`, isVec2Array, lens),
  );
  const normals =
    readPrimvar(meshPrim, "primvars:normals", isVec3Array, lens) ??
    readPrimvar(meshPrim, "normals", isVec3Array, lens);
  const color = displayColorPrimvar(meshPrim);

  // Face-varying data (or per-face color) cannot live on shared vertices.
  const expand =
    counts !== null &&
    indices !== null &&
    ([...uvSets, normals].some((p) => p?.interpolation === "faceVarying") ||
      color?.interpolation === "faceVarying" ||
      color?.interpolation === "uniform");

  return expand
    ? buildExpandedGeometry(meshPrim, points, counts!, indices!, uvSets, normals, color)
    : buildIndexedGeometry(meshPrim, points, counts, indices, uvSets, normals, color);
}

/** Shared-vertex (indexed) layout: all primvars are per-vertex or absent. */
function buildIndexedGeometry(
  meshPrim: Prim,
  points: Vec3[],
  counts: number[] | null,
  indices: number[] | null,
  uvSets: (ResolvedPrimvar | null)[],
  normals: ResolvedPrimvar | null,
  color: ResolvedPrimvar | null,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(flat3(points), 3));

  if (counts && indices) {
    const subsets = getMaterialSubsets(meshPrim);
    if (subsets.length > 0) {
      geometry.setIndex(triangulateBySubset(geometry, counts, indices, subsets));
    } else {
      geometry.setIndex(triangulate(counts, indices));
    }
  } else if (indices) {
    geometry.setIndex(indices.slice());
  }

  if (normals?.interpolation === "vertex") {
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(flat3(normals.values.slice(0, points.length) as Vec3[]), 3),
    );
  } else {
    geometry.computeVertexNormals();
  }
  for (const [i, uv] of uvSets.entries()) {
    if (uv?.interpolation !== "vertex") continue;
    geometry.setAttribute(
      uvAttrName(i),
      new THREE.Float32BufferAttribute(flat2(uv.values.slice(0, points.length) as Vec2[]), 2),
    );
  }
  if (color?.interpolation === "vertex") {
    geometry.setAttribute(
      "color",
      new THREE.Float32BufferAttribute(flat3(color.values.slice(0, points.length) as Vec3[]), 3),
    );
  }
  return geometry;
}

/**
 * De-indexed layout for faceVarying primvars: triangulate to face-corner
 * "slots", then emit one vertex per corner, sampling each primvar in its own
 * interpolation domain. Subset groups carry over in corner units.
 */
function buildExpandedGeometry(
  meshPrim: Prim,
  points: Vec3[],
  counts: number[],
  indices: number[],
  uvSets: (ResolvedPrimvar | null)[],
  normals: ResolvedPrimvar | null,
  color: ResolvedPrimvar | null,
): THREE.BufferGeometry {
  const { slots, faces, groups } = triangulateToSlots(counts, getMaterialSubsets(meshPrim));

  const sample = (p: ResolvedPrimvar, corner: number): number[] => {
    switch (p.interpolation) {
      case "faceVarying":
        return p.values[slots[corner]!] ?? p.values[0]!;
      case "vertex":
        return p.values[indices[slots[corner]!]!] ?? p.values[0]!;
      case "uniform":
        return p.values[faces[corner]!] ?? p.values[0]!;
      default:
        return p.values[0]!;
    }
  };

  const geometry = new THREE.BufferGeometry();
  const position = new Array<number>(slots.length * 3);
  for (let c = 0; c < slots.length; c++) {
    const v = points[indices[slots[c]!]!] ?? [0, 0, 0];
    position[c * 3] = v[0];
    position[c * 3 + 1] = v[1];
    position[c * 3 + 2] = v[2];
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));

  for (const [i, uv] of uvSets.entries()) {
    if (!uv || uv.interpolation === "constant") continue;
    const out = new Array<number>(slots.length * 2);
    for (let c = 0; c < slots.length; c++) {
      const t = sample(uv, c);
      out[c * 2] = t[0] ?? 0;
      out[c * 2 + 1] = t[1] ?? 0;
    }
    geometry.setAttribute(uvAttrName(i), new THREE.Float32BufferAttribute(out, 2));
  }

  const emitVec3 = (p: ResolvedPrimvar, name: string) => {
    const out = new Array<number>(slots.length * 3);
    for (let c = 0; c < slots.length; c++) {
      const t = sample(p, c);
      out[c * 3] = t[0] ?? 0;
      out[c * 3 + 1] = t[1] ?? 0;
      out[c * 3 + 2] = t[2] ?? 0;
    }
    geometry.setAttribute(name, new THREE.Float32BufferAttribute(out, 3));
  };
  if (normals && normals.interpolation !== "constant") emitVec3(normals, "normal");
  else geometry.computeVertexNormals();
  if (color && color.interpolation !== "constant") emitVec3(color, "color");

  for (const g of groups) geometry.addGroup(g.start, g.count, g.materialIndex);
  return geometry;
}

/**
 * Triangulate faces into corner-slot triples (subset by subset, unassigned
 * faces last — the ordering contract of {@link triangulateBySubset}), keeping
 * the owning face of every corner and the subset group ranges.
 */
function triangulateToSlots(
  faceVertexCounts: number[],
  subsets: MaterialSubset[],
): {
  slots: number[];
  faces: number[];
  groups: { start: number; count: number; materialIndex: number }[];
} {
  const faceStart: number[] = [];
  let offset = 0;
  for (const count of faceVertexCounts) {
    faceStart.push(offset);
    offset += count;
  }

  const slots: number[] = [];
  const faces: number[] = [];
  const emit = (face: number) => {
    const start = faceStart[face]!;
    const count = faceVertexCounts[face]!;
    for (let k = 2; k < count; k++) {
      slots.push(start, start + k - 1, start + k);
      faces.push(face, face, face);
    }
  };

  const groups: { start: number; count: number; materialIndex: number }[] = [];
  if (subsets.length === 0) {
    for (let face = 0; face < faceVertexCounts.length; face++) emit(face);
    return { slots, faces, groups };
  }

  const claimed = new Uint8Array(faceVertexCounts.length);
  for (const [index, subset] of subsets.entries()) {
    const begin = slots.length;
    for (const face of subset.faces) {
      if (face < 0 || face >= faceVertexCounts.length || claimed[face]) continue;
      claimed[face] = 1;
      emit(face);
    }
    if (slots.length > begin) {
      groups.push({ start: begin, count: slots.length - begin, materialIndex: index });
    }
  }
  const begin = slots.length;
  for (let face = 0; face < faceVertexCounts.length; face++) {
    if (!claimed[face]) emit(face);
  }
  if (slots.length > begin) {
    groups.push({ start: begin, count: slots.length - begin, materialIndex: subsets.length });
  }
  return { slots, faces, groups };
}

/**
 * Build geometry for any renderable gprim: `Mesh` via {@link buildMeshGeometry},
 * parametric solids from their schema attributes. Solids follow UsdGeom
 * semantics — sizes in stage units, centered at the origin, `axis` (default
 * `"Z"`) along the spine, and a capsule's `height` spans only its cylindrical
 * section. Returns `null` for unsupported prim types.
 */
export function buildGprimGeometry(prim: Prim): THREE.BufferGeometry | null {
  switch (prim.GetTypeName()) {
    case "Mesh":
      return buildMeshGeometry(prim);
    case "Cube": {
      const size = getNumber(prim, "size") ?? 2;
      return new THREE.BoxGeometry(size, size, size);
    }
    case "Sphere":
      return new THREE.SphereGeometry(getNumber(prim, "radius") ?? 1, 32, 16);
    case "Cylinder": {
      const radius = getNumber(prim, "radius") ?? 1;
      const height = getNumber(prim, "height") ?? 2;
      return orientSpine(new THREE.CylinderGeometry(radius, radius, height, 32), prim);
    }
    case "Capsule": {
      const radius = getNumber(prim, "radius") ?? 0.5;
      const height = getNumber(prim, "height") ?? 1;
      return orientSpine(new THREE.CapsuleGeometry(radius, height, 8, 32), prim);
    }
    case "Cone": {
      const radius = getNumber(prim, "radius") ?? 1;
      const height = getNumber(prim, "height") ?? 2;
      return orientSpine(new THREE.ConeGeometry(radius, height, 32), prim);
    }
    default:
      return null;
  }
}

export type BuildGprimOptions = {
  /** Resolves texture asset paths for mesh materials. */
  textureProvider?: TextureProvider;
  /**
   * Render `BasisCurves` that author `widths` as tube meshes instead of
   * 1-px lines (default `false`).
   */
  curveTubes?: boolean;
  /** Receives fidelity diagnostics (channel-packing mismatches, M19). */
  onWarn?: (message: string) => void;
  /** Parsed `.mdl` modules for MDL material family/value resolution (M20). */
  mdl?: MdlModuleProvider;
};

/**
 * Build a renderable `THREE.Object3D` for any supported gprim (M18):
 * `Mesh` and the parametric solids become a `THREE.Mesh` (via
 * {@link buildGprimGeometry} + {@link buildMeshMaterials}), `Points` a
 * `THREE.Points`, and `BasisCurves` a `THREE.Group` holding one line — or,
 * with {@link BuildGprimOptions.curveTubes}, one tube mesh — per curve.
 * Returns `null` for unsupported prim types and degenerate geometry.
 */
export function buildGprimObject(
  prim: Prim,
  stage?: Stage,
  options: BuildGprimOptions = {},
): THREE.Object3D | null {
  switch (prim.GetTypeName()) {
    case "Points":
      return buildPointsObject(prim, stage, options.mdl);
    case "BasisCurves":
      return buildBasisCurvesObject(prim, stage, options.curveTubes ?? false, options.mdl);
    default: {
      const geometry = buildGprimGeometry(prim);
      if (!geometry) return null;
      return new THREE.Mesh(
        geometry,
        buildMeshMaterials(prim, stage, options.textureProvider, options.onWarn, options.mdl),
      );
    }
  }
}

/**
 * Flat color/opacity for point/curve materials — the same priority as meshes:
 * bound `UsdShade` diffuse → constant `primvars:displayColor` → default gray.
 */
function resolveFlatColor(
  prim: Prim,
  stage?: Stage,
  mdl?: MdlModuleProvider,
): { color: THREE.Color; opacity: number; name?: string } {
  const color = new THREE.Color(DEFAULT_COLOR);
  const bound = stage ? resolveBoundMaterial(stage, prim, mdl ? { mdl } : {}) : undefined;
  if (bound?.color) {
    color.setRGB(bound.color[0], bound.color[1], bound.color[2]);
  } else {
    const displayColor = prim.GetAttribute("primvars:displayColor").Get();
    if (isVec3Array(displayColor) && displayColor[0]) {
      color.setRGB(displayColor[0][0], displayColor[0][1], displayColor[0][2]);
    }
  }
  const result: { color: THREE.Color; opacity: number; name?: string } = {
    color,
    opacity: bound?.opacity ?? 1,
  };
  if (bound?.name) result.name = bound.name;
  return result;
}

/** Mean of an authored `widths` array (USD widths are world-space diameters). */
function meanWidth(prim: Prim): number | undefined {
  const widths = prim.GetAttribute("widths").Get();
  if (!isNumberArray(widths) || widths.length === 0) return undefined;
  return widths.reduce((a, b) => a + b, 0) / widths.length;
}

/**
 * `Points` → `THREE.Points`. Per-point `primvars:displayColor` becomes vertex
 * colors; `widths` (diameters) have no per-point equivalent in
 * `PointsMaterial`, so their mean becomes the world-space point size. Without
 * widths, points draw as fixed 3-px dots.
 */
function buildPointsObject(
  prim: Prim,
  stage?: Stage,
  mdl?: MdlModuleProvider,
): THREE.Points | null {
  const points = prim.GetAttribute("points").Get();
  if (!isVec3Array(points) || points.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(flat3(points), 3));

  const flat = resolveFlatColor(prim, stage, mdl);
  const material = new THREE.PointsMaterial({ color: flat.color });
  if (flat.opacity < 1) {
    material.transparent = true;
    material.opacity = flat.opacity;
  }
  if (flat.name) material.name = flat.name;

  const displayColor = prim.GetAttribute("primvars:displayColor").Get();
  if (isVec3Array(displayColor) && displayColor.length === points.length && points.length > 1) {
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(flat3(displayColor), 3));
    material.vertexColors = true;
    material.color.set(0xffffff); // let the vertex colors drive
  }

  const width = meanWidth(prim);
  if (width !== undefined && width > 0) {
    material.size = width;
    material.sizeAttenuation = true;
  } else {
    material.size = 3;
    material.sizeAttenuation = false;
  }
  return new THREE.Points(geometry, material);
}

/** Polyline samples per cubic curve segment. */
const CURVE_DIVISIONS = 8;

/**
 * Uniform cubic basis matrices, rows weighting `[t³, t², t, 1]` —
 * `p(t) = [t³ t² t 1] · M · [P0 P1 P2 P3]ᵀ` (RenderMan/USD conventions).
 */
const CUBIC_BASES: Record<string, { m: number[][]; vstep: number }> = {
  // biome-ignore format: keep matrix layout readable
  bezier: {
    m: [
      [-1, 3, -3, 1],
      [3, -6, 3, 0],
      [-3, 3, 0, 0],
      [1, 0, 0, 0],
    ],
    vstep: 3,
  },
  // biome-ignore format: keep matrix layout readable
  bspline: {
    m: [
      [-1 / 6, 3 / 6, -3 / 6, 1 / 6],
      [3 / 6, -6 / 6, 3 / 6, 0],
      [-3 / 6, 0, 3 / 6, 0],
      [1 / 6, 4 / 6, 1 / 6, 0],
    ],
    vstep: 1,
  },
  // biome-ignore format: keep matrix layout readable
  catmullRom: {
    m: [
      [-1 / 2, 3 / 2, -3 / 2, 1 / 2],
      [2 / 2, -5 / 2, 4 / 2, -1 / 2],
      [-1 / 2, 0, 1 / 2, 0],
      [0, 2 / 2, 0, 0],
    ],
    vstep: 1,
  },
};

/**
 * Sample one cubic curve into a polyline. Periodic curves wrap their control
 * points and omit the closing sample (the caller closes with a `LineLoop`);
 * nonperiodic curves include both endpoints. Returns `null` when there are
 * too few CVs for a single segment.
 */
function sampleCubicCurve(cvs: Vec3[], basisName: string, periodic: boolean): Vec3[] | null {
  const basis = CUBIC_BASES[basisName] ?? CUBIC_BASES.bezier!;
  const n = cvs.length;
  const nseg = periodic ? Math.floor(n / basis.vstep) : Math.floor((n - 4) / basis.vstep) + 1;
  if (n < 4 || nseg < 1) return null;

  const out: Vec3[] = [];
  for (let s = 0; s < nseg; s++) {
    const i0 = s * basis.vstep;
    const P = [cvs[i0 % n]!, cvs[(i0 + 1) % n]!, cvs[(i0 + 2) % n]!, cvs[(i0 + 3) % n]!];
    // Segments share boundary points: sample [0, 1) per segment, plus the
    // final t=1 endpoint only on the last nonperiodic segment.
    const last = !periodic && s === nseg - 1 ? CURVE_DIVISIONS : CURVE_DIVISIONS - 1;
    for (let k = 0; k <= last; k++) {
      const t = k / CURVE_DIVISIONS;
      const w = [t * t * t, t * t, t, 1];
      const point: Vec3 = [0, 0, 0];
      for (let i = 0; i < 4; i++) {
        let b = 0;
        for (let j = 0; j < 4; j++) b += w[j]! * basis.m[j]![i]!;
        point[0] += b * P[i]![0];
        point[1] += b * P[i]![1];
        point[2] += b * P[i]![2];
      }
      out.push(point);
    }
  }
  return out;
}

/** A piecewise-linear `CurvePath` through `samples`, for tube tessellation. */
function polylinePath(samples: Vec3[], closed: boolean): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  const vecs = samples.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  for (let i = 0; i < vecs.length - 1; i++) path.add(new THREE.LineCurve3(vecs[i]!, vecs[i + 1]!));
  if (closed) path.add(new THREE.LineCurve3(vecs[vecs.length - 1]!, vecs[0]!));
  return path;
}

/**
 * `BasisCurves` → a `THREE.Group` with one object per curve. `type="linear"`
 * connects the CVs directly; `type="cubic"` samples the authored `basis`
 * (`bezier` / `bspline` / `catmullRom`, uniform cubic evaluation) at
 * {@link CURVE_DIVISIONS} points per segment. `wrap="periodic"` closes each
 * curve (`THREE.LineLoop`). With `curveTubes` and authored `widths`, curves
 * tessellate into `TubeGeometry` meshes of radius `mean(widths) / 2` instead.
 */
function buildBasisCurvesObject(
  prim: Prim,
  stage: Stage | undefined,
  curveTubes: boolean,
  mdl?: MdlModuleProvider,
): THREE.Object3D | null {
  const points = prim.GetAttribute("points").Get();
  const counts = prim.GetAttribute("curveVertexCounts").Get();
  if (!isVec3Array(points) || !isNumberArray(counts) || counts.length === 0) return null;

  const curveType = prim.GetAttribute("type").Get() ?? "cubic";
  const basisName = prim.GetAttribute("basis").Get() ?? "bezier";
  const periodic = prim.GetAttribute("wrap").Get() === "periodic";

  const flat = resolveFlatColor(prim, stage, mdl);
  const width = meanWidth(prim);
  const asTubes = curveTubes && width !== undefined && width > 0;

  const material = asTubes
    ? new THREE.MeshStandardMaterial({ color: flat.color, roughness: 0.8, metalness: 0.1 })
    : new THREE.LineBasicMaterial({ color: flat.color });
  if (flat.opacity < 1) {
    material.transparent = true;
    material.opacity = flat.opacity;
  }
  if (flat.name) material.name = flat.name;

  const group = new THREE.Group();
  let offset = 0;
  for (const count of counts) {
    const cvs = points.slice(offset, offset + count);
    offset += count;
    const samples =
      curveType === "linear"
        ? cvs.length >= 2
          ? cvs
          : null
        : sampleCubicCurve(cvs, typeof basisName === "string" ? basisName : "bezier", periodic);
    if (!samples || samples.length < 2) continue;

    if (asTubes) {
      const path = polylinePath(samples, periodic);
      const geometry = new THREE.TubeGeometry(
        path,
        Math.max(samples.length, 2),
        width / 2,
        8,
        periodic,
      );
      group.add(new THREE.Mesh(geometry, material));
    } else {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(flat3(samples), 3));
      group.add(
        periodic ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material),
      );
    }
  }
  return group.children.length > 0 ? group : null;
}

function getNumber(prim: Prim, name: string): number | undefined {
  const v = prim.GetAttribute(name).Get();
  return typeof v === "number" ? v : undefined;
}

/** Rotate a Y-spined three.js primitive onto the prim's `axis` (USD default `Z`). */
function orientSpine(geometry: THREE.BufferGeometry, prim: Prim): THREE.BufferGeometry {
  const axis = prim.GetAttribute("axis").Get();
  if (axis === "Y") return geometry;
  if (axis === "X") return geometry.rotateZ(-Math.PI / 2);
  return geometry.rotateX(Math.PI / 2);
}

/**
 * Build a material for a gprim. Color priority: bound `UsdShade` material
 * (when `stage` is given) → `primvars:displayColor` → default gray. Textures
 * (via `textures`) become the matching `MeshStandardMaterial` maps — diffuse →
 * `map` (sRGB), plus `normalMap` / `roughnessMap` / `metalnessMap` / `aoMap`
 * (linear data) and emissive `emissiveMap`. Metalness / roughness / opacity /
 * emissive constants come from the bound material when present.
 */
export function buildMeshMaterial(
  meshPrim: Prim,
  stage?: Stage,
  textures?: TextureProvider,
  /** Resolve the material binding from here instead (a `GeomSubset`). */
  bindingPrim?: Prim,
  /** Receives fidelity diagnostics (channel-packing mismatches, M19). */
  onWarn?: (message: string) => void,
  /** Parsed `.mdl` modules for MDL material family/value resolution (M20). */
  mdl?: MdlModuleProvider,
): THREE.Material {
  const color = new THREE.Color(DEFAULT_COLOR);
  let opacity = 1;
  let vertexColors = false;

  const resolveOptions: ResolveMaterialOptions = {
    ...(mdl ? { mdl } : {}),
    ...(onWarn ? { onWarn } : {}),
  };
  const bound = stage
    ? resolveBoundMaterial(stage, bindingPrim ?? meshPrim, resolveOptions)
    : undefined;
  if (bound?.color) {
    color.setRGB(bound.color[0], bound.color[1], bound.color[2]);
  } else {
    const displayColor = displayColorPrimvar(meshPrim);
    if (displayColor && displayColor.interpolation !== "constant") {
      // Per-vertex / per-face displayColor → vertex colors; the geometry
      // builder authors the matching `color` attribute.
      vertexColors = true;
      color.setRGB(1, 1, 1);
    } else if (displayColor?.values[0]) {
      const [r, g, b] = displayColor.values[0];
      color.setRGB(r ?? 0, g ?? 0, b ?? 0);
    }
  }
  if (bound?.opacity !== undefined) opacity = bound.opacity;

  // Resolve a channel's `THREE.Texture`, forwarding its wrap modes, UV-set
  // channel, colorspace, and `UsdTransform2d` (the `UsdUVTexture
  // .inputs:scale`/`bias` are folded into the material factors below, not the
  // sampler). `inputs:sourceColorSpace` overrides the per-channel default.
  const uvSetNames = meshUvSetNames(meshPrim);
  const tex = (rt: ResolvedTexture | undefined, cs: "srgb" | "linear") => {
    if (!rt || !textures) return null;
    const channel = rt.uvSet ? Math.max(uvSetNames.indexOf(rt.uvSet), 0) : 0;
    const colorSpace =
      rt.sourceColorSpace === "raw" ? "linear" : rt.sourceColorSpace === "sRGB" ? "srgb" : cs;
    return textures(rt.path, {
      colorSpace,
      ...(rt.wrapS ? { wrapS: rt.wrapS } : {}),
      ...(rt.wrapT ? { wrapT: rt.wrapT } : {}),
      ...(rt.transform ? { transform: rt.transform } : {}),
      ...(channel > 0 ? { channel } : {}),
    });
  };

  // three.js samples fixed channels from packed maps (glTF convention). A
  // network wired to a different single-channel output can't be honoured
  // without repacking — surface it instead of sampling silently wrong data.
  if (onWarn) {
    const packed = [
      [bound?.roughnessTexture, "g", "roughness"],
      [bound?.metalnessTexture, "b", "metalness"],
      [bound?.occlusionTexture, "r", "occlusion"],
    ] as const;
    for (const [rt, expected, label] of packed) {
      const channel = rt?.outputChannel;
      if (channel && channel !== "rgb" && channel !== expected) {
        onWarn(
          `${meshPrim.GetPath()}: ${label} reads outputs:${channel}, but three.js samples the "${expected}" channel of the map — repack the texture to the glTF ORM layout`,
        );
      }
    }
  }

  const map = tex(bound?.colorTexture, "srgb");
  // `inputs:scale` on the diffuse texture tints the map; otherwise pass through.
  if (map) {
    const s = bound?.colorTexture?.scale;
    if (s) color.setRGB(s[0], s[1], s[2]);
    else color.setRGB(1, 1, 1);
  }
  const normalMap = tex(bound?.normalTexture, "linear");
  const roughnessMap = tex(bound?.roughnessTexture, "linear");
  const metalnessMap = tex(bound?.metalnessTexture, "linear");
  const aoMap = tex(bound?.occlusionTexture, "linear");
  const emissiveMap = tex(bound?.emissiveTexture, "srgb");

  // A scalar map's `inputs:scale[0]` (or an authored constant) becomes three's
  // factor; three multiplies factor × map, so default to 1 to pass it through.
  const metalness =
    bound?.metalness ?? bound?.metalnessTexture?.scale?.[0] ?? (metalnessMap ? 1 : 0.1);
  const roughness =
    bound?.roughness ?? bound?.roughnessTexture?.scale?.[0] ?? (roughnessMap ? 1 : 0.8);

  const emissive = new THREE.Color(0x000000);
  if (bound?.emissiveColor) {
    emissive.setRGB(bound.emissiveColor[0], bound.emissiveColor[1], bound.emissiveColor[2]);
  } else if (emissiveMap) {
    emissive.setRGB(1, 1, 1); // let the map drive emission
  }

  // Opacity sourcing: a dedicated opacity texture → `alphaMap`; an opacity input
  // wired to the *same* image as the diffuse map → that map's own alpha channel
  // (no separate map needed). `opacityThreshold > 0` means alpha clip (a binary
  // cutout rendered in the opaque pass); otherwise sub-unit alpha blends.
  const opacityTex = bound?.opacityTexture;
  const sharesColorMap = !!(opacityTex && opacityTex.path === bound?.colorTexture?.path);
  const alphaMap = sharesColorMap ? null : tex(opacityTex, "linear");
  const hasAlphaSource = opacity < 1 || sharesColorMap || !!alphaMap;
  const threshold = bound?.opacityThreshold;
  const alphaTest = threshold !== undefined && threshold > 0 ? threshold : 0;
  // Alpha-clip masks render opaque (depth-written, discarded below the cutoff);
  // only true translucency uses the transparent/blended pass.
  const transparent = alphaTest === 0 && hasAlphaSource;

  const doubleSided = meshPrim.GetAttribute("doubleSided").Get() === true;
  const params: THREE.MeshStandardMaterialParameters = {
    color,
    metalness,
    roughness,
    emissive,
    transparent,
    opacity,
    ...(vertexColors ? { vertexColors: true } : {}),
    ...(alphaTest > 0 ? { alphaTest } : {}),
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    ...(map ? { map } : {}),
    ...(alphaMap ? { alphaMap } : {}),
    ...(normalMap ? { normalMap } : {}),
    ...(roughnessMap ? { roughnessMap } : {}),
    ...(metalnessMap ? { metalnessMap } : {}),
    ...(aoMap ? { aoMap } : {}),
    ...(emissiveMap ? { emissiveMap } : {}),
  };

  // UsdPreviewSurface / Omni-MDL physical inputs promote the material (M19 /
  // M20); plain assets keep getting the cheaper MeshStandardMaterial.
  const physical =
    bound !== undefined &&
    (bound.ior !== undefined ||
      bound.clearcoat !== undefined ||
      bound.clearcoatRoughness !== undefined ||
      bound.specularColor !== undefined ||
      bound.transmission !== undefined ||
      bound.clearcoatNormalTexture !== undefined);
  const material = physical
    ? new THREE.MeshPhysicalMaterial(params)
    : new THREE.MeshStandardMaterial(params);
  if (material instanceof THREE.MeshPhysicalMaterial && bound) {
    if (bound.ior !== undefined) material.ior = bound.ior;
    if (bound.clearcoat !== undefined) material.clearcoat = bound.clearcoat;
    if (bound.clearcoatRoughness !== undefined)
      material.clearcoatRoughness = bound.clearcoatRoughness;
    if (bound.specularColor) {
      material.specularColor.setRGB(
        bound.specularColor[0],
        bound.specularColor[1],
        bound.specularColor[2],
      );
    }
    // OmniGlass (M20): a transmissive dielectric with a refraction volume.
    if (bound.transmission !== undefined) material.transmission = bound.transmission;
    if (bound.thickness !== undefined) material.thickness = bound.thickness;
    const clearcoatNormalMap = tex(bound.clearcoatNormalTexture, "linear");
    if (clearcoatNormalMap) material.clearcoatNormalMap = clearcoatNormalMap;
  }
  if (bound?.emissiveIntensity !== undefined) material.emissiveIntensity = bound.emissiveIntensity;
  // UsdPreviewSurface normal maps author scale (2,2,2,1) / bias (−1,−1,−1,0)
  // to decode [0,1] → [−1,1]; three does that internally, so scale/2 is the
  // residual normalScale (the sign carries DirectX-style green flips).
  if (normalMap && bound?.normalTexture?.scale) {
    material.normalScale.set(bound.normalTexture.scale[0] / 2, bound.normalTexture.scale[1] / 2);
  }
  // Carry the USD material name so re-exports keep it (and dedupe by it).
  if (bound?.name) material.name = bound.name;
  return material;
}

/**
 * Attach visual (and optionally collision) meshes to every link of a built
 * {@link ThreeUsdRobot}. Each mesh is positioned by its transform relative to
 * the owning link prim.
 */
export function bindRobotMeshes(
  stage: Stage,
  robot3d: ThreeUsdRobot,
  desc: RobotDescription,
  options: BindMeshesOptions = {},
): void {
  const loadVisuals = options.loadVisuals ?? true;
  const loadCollisions = options.loadCollisions ?? false;
  const gprimOptions: BuildGprimOptions = {
    ...(options.textureProvider ? { textureProvider: options.textureProvider } : {}),
    ...(options.curveTubes ? { curveTubes: true } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    ...(options.mdl ? { mdl: options.mdl } : {}),
  };

  for (const [key, link] of Object.entries(desc.links)) {
    const linkObj = robot3d.getLinkObject(key);
    const linkPrim = stage.GetPrimAtPath(link.primPath);
    if (!linkObj || !linkPrim) continue;

    // A mesh may be both visual and collision; attach it once, as visual.
    const visualSet = new Set(link.visualPrims);

    if (loadVisuals) {
      for (const meshPath of link.visualPrims) {
        attachGprim(stage, linkPrim, meshPath, linkObj, "visual", gprimOptions);
      }
    }
    if (loadCollisions) {
      for (const meshPath of link.collisionPrims ?? []) {
        if (loadVisuals && visualSet.has(meshPath)) continue;
        attachGprim(stage, linkPrim, meshPath, linkObj, "collision", gprimOptions);
      }
    }
  }
}

/**
 * Attach the gprims that belong to no link — the static scenery of a cell that
 * also contains robots. The authored prim hierarchy is mirrored with
 * `THREE.Group` nodes (each carrying `userData.primPath` and its prim's local
 * transform), so grouped scenery — a pallet and its cartons, a fence and its
 * wires — stays one movable subtree. World placements are unchanged, and the
 * loader's up-axis and unit normalization still applies at the robot root.
 * Collision-only and guide/proxy prims are skipped.
 */
export function bindSceneMeshes(
  stage: Stage,
  robot3d: ThreeUsdRobot,
  desc: RobotDescription,
  options: {
    textureProvider?: TextureProvider;
    curveTubes?: boolean;
    onWarn?: (message: string) => void;
    mdl?: MdlModuleProvider;
  } = {},
): number {
  const owned = new Set<string>();
  for (const link of Object.values(desc.links)) {
    for (const path of link.visualPrims) owned.add(path);
    for (const path of link.collisionPrims ?? []) owned.add(path);
    owned.add(link.primPath);
  }

  // Ancestor prims materialize lazily, so subtrees with nothing renderable
  // produce no empty groups. Meshes register too: gprims can nest.
  const nodes = new Map<string, THREE.Object3D>();
  const containerFor = (prim: Prim): THREE.Object3D => {
    const parent = prim.GetParent();
    if (!parent || parent.IsPseudoRoot()) return robot3d;
    let node = nodes.get(parent.GetPath());
    if (!node) {
      node = new THREE.Group();
      node.name = parent.GetName();
      node.userData.kind = "scene";
      node.userData.primPath = parent.GetPath();
      placeAtLocal(node, parent);
      containerFor(parent).add(node);
      nodes.set(parent.GetPath(), node);
    }
    return node;
  };

  const gprimOptions: BuildGprimOptions = {
    ...(options.textureProvider ? { textureProvider: options.textureProvider } : {}),
    ...(options.curveTubes ? { curveTubes: true } : {}),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    ...(options.mdl ? { mdl: options.mdl } : {}),
  };

  let attached = 0;
  for (const prim of stage.Traverse()) {
    if (!isRenderableGprim(prim) || owned.has(prim.GetPath())) continue;
    if (prim.HasAPI(COLLISION_API) || isNonVisualPurpose(prim)) continue;
    // Skip gprims under a link (already bound relative to their link).
    if ([...owned].some((path) => prim.GetPath().startsWith(`${path}/`))) continue;

    const object = buildGprimObject(prim, stage, gprimOptions);
    if (!object) continue;
    object.name = prim.GetName();
    object.userData.kind = "scene";
    object.userData.primPath = prim.GetPath();
    placeAtLocal(object, prim);
    containerFor(prim).add(object);
    nodes.set(prim.GetPath(), object);
    attached++;
  }
  return attached;
}

/** Fix `object` at its prim's local transform (scenery is static). */
function placeAtLocal(object: THREE.Object3D, prim: Prim): void {
  object.matrixAutoUpdate = false;
  object.matrix.fromArray(computeLocalTransform(prim).matrix);
  object.matrixWorldNeedsUpdate = true;
}

/**
 * Materials for a mesh: one per `materialBind` face subset (matching the
 * geometry groups {@link buildMeshGeometry} adds) plus a trailing fallback for
 * faces no subset claims. A mesh without subsets gets a single material.
 */
export function buildMeshMaterials(
  meshPrim: Prim,
  stage?: Stage,
  textures?: TextureProvider,
  onWarn?: (message: string) => void,
  mdl?: MdlModuleProvider,
): THREE.Material | THREE.Material[] {
  const subsets = stage ? getMaterialSubsets(meshPrim) : [];
  if (subsets.length === 0)
    return buildMeshMaterial(meshPrim, stage, textures, undefined, onWarn, mdl);
  return [
    ...subsets.map((s) => buildMeshMaterial(meshPrim, stage, textures, s.prim, onWarn, mdl)),
    buildMeshMaterial(meshPrim, stage, textures, undefined, onWarn, mdl),
  ];
}

function attachGprim(
  stage: Stage,
  linkPrim: Prim,
  meshPath: string,
  parent: THREE.Object3D,
  kind: MeshKind,
  options: BuildGprimOptions,
): void {
  const meshPrim = stage.GetPrimAtPath(meshPath);
  if (!meshPrim) return;
  const object = buildGprimObject(meshPrim, stage, options);
  if (!object) return;

  object.name = meshPrim.GetName();
  object.userData.kind = kind;
  object.userData.primPath = meshPath;
  // Collision gprims are loaded hidden; reveal via `robot.showCollision = true`.
  if (kind === "collision") object.visible = false;
  object.matrixAutoUpdate = false;
  object.matrix.fromArray(relativeTransform(linkPrim, meshPrim));
  object.matrixWorldNeedsUpdate = true;
  parent.add(object);
}

/** Accumulated local transform from `linkPrim` (exclusive) down to `meshPrim` (inclusive). */
function relativeTransform(linkPrim: Prim, meshPrim: Prim): Mat4 {
  const chain: Prim[] = [];
  let p: Prim | null = meshPrim;
  const stop = linkPrim.GetPath();
  while (p && p.GetPath() !== stop) {
    chain.push(p);
    p = p.GetParent();
  }
  chain.reverse(); // top-most (just under link) → mesh

  let m = identity4();
  for (const prim of chain) {
    m = multiply(m, computeLocalTransform(prim).matrix);
  }
  return m;
}

// --- triangulation & typed-array helpers -----------------------------------

/** Fan-triangulate USD polygon faces into a flat triangle index list. */
function triangulate(faceVertexCounts: number[], faceVertexIndices: number[]): number[] {
  const tris: number[] = [];
  let offset = 0;
  for (const count of faceVertexCounts) {
    for (let k = 2; k < count; k++) {
      tris.push(
        faceVertexIndices[offset]!,
        faceVertexIndices[offset + k - 1]!,
        faceVertexIndices[offset + k]!,
      );
    }
    offset += count;
  }
  return tris;
}

/**
 * Triangulate subset by subset so each subset owns a contiguous run of the
 * index buffer, and register that run as a geometry group.
 */
function triangulateBySubset(
  geometry: THREE.BufferGeometry,
  faceVertexCounts: number[],
  faceVertexIndices: number[],
  subsets: MaterialSubset[],
): number[] {
  const faceStart: number[] = [];
  let offset = 0;
  for (const count of faceVertexCounts) {
    faceStart.push(offset);
    offset += count;
  }

  const tris: number[] = [];
  const emit = (face: number) => {
    const start = faceStart[face]!;
    const count = faceVertexCounts[face]!;
    for (let k = 2; k < count; k++) {
      tris.push(
        faceVertexIndices[start]!,
        faceVertexIndices[start + k - 1]!,
        faceVertexIndices[start + k]!,
      );
    }
  };

  const claimed = new Uint8Array(faceVertexCounts.length);
  subsets.forEach((subset, index) => {
    const begin = tris.length;
    for (const face of subset.faces) {
      if (face < 0 || face >= faceVertexCounts.length || claimed[face]) continue;
      claimed[face] = 1;
      emit(face);
    }
    if (tris.length > begin) geometry.addGroup(begin, tris.length - begin, index);
  });

  const begin = tris.length;
  for (let face = 0; face < faceVertexCounts.length; face++) {
    if (!claimed[face]) emit(face);
  }
  if (tris.length > begin) geometry.addGroup(begin, tris.length - begin, subsets.length);

  return tris;
}

function flat3(v: Vec3[]): number[] {
  const out = new Array<number>(v.length * 3);
  for (let i = 0; i < v.length; i++) {
    out[i * 3] = v[i]![0];
    out[i * 3 + 1] = v[i]![1];
    out[i * 3 + 2] = v[i]![2];
  }
  return out;
}

function flat2(v: Vec2[]): number[] {
  const out = new Array<number>(v.length * 2);
  for (let i = 0; i < v.length; i++) {
    out[i * 2] = v[i]![0];
    out[i * 2 + 1] = v[i]![1];
  }
  return out;
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((n) => typeof n === "number");
}

function isVec3Array(v: unknown): v is Vec3[] {
  return Array.isArray(v) && v.every((e) => Array.isArray(e) && e.length === 3);
}

function isVec2Array(v: unknown): v is Vec2[] {
  return Array.isArray(v) && v.every((e) => Array.isArray(e) && e.length === 2);
}
