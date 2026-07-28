/**
 * Geometry access for the robot exporter (M13).
 *
 * `exportRobotUsda` is geometry-agnostic: a {@link RobotGeometryProvider}
 * supplies each link's meshes as plain data. {@link stageGeometryProvider}
 * reads them back off a loaded {@link Stage} for round-trip export; the
 * Three.js authoring side (M14) supplies one backed by `BufferGeometry`.
 */

import { type Mat4, identity4, multiply } from "../kinematics/transforms.js";
import type { Vec2, Vec3 } from "../parser/ast.js";
import type { LinkDescription } from "../robot/RobotDescription.js";
import { getMaterialSubsets } from "../schemas/usdGeom.js";
import { resolveBoundMaterial } from "../three/MaterialBinding.js";
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";
import { computeLocalTransform } from "../usd/xformOps.js";

/** Texture channels a `UsdPreviewSurface` network can reference (M15). */
export type TextureChannel =
  | "color"
  | "opacity"
  | "normal"
  | "roughness"
  | "metalness"
  | "occlusion"
  | "emissive";

/**
 * PBR parameters for a mesh, written as a `UsdPreviewSurface` material (M14).
 * `textures` holds per-channel image **asset paths** (M15) — emitted as a
 * `UsdUVTexture` + `UsdPrimvarReader_float2` network; sampler details
 * (wrap/scale/bias/transform) are not carried. Bundle the image bytes
 * themselves with `writeUsdz` under the same paths.
 */
export type ExportMaterial = {
  /** Material identity: meshes sharing a name share one Material prim. */
  name: string;
  diffuseColor?: Vec3;
  metallic?: number;
  roughness?: number;
  /** Sub-unit opacity renders as a translucent blend. */
  opacity?: number;
  emissiveColor?: Vec3;
  /** Per-channel texture asset paths. */
  textures?: Partial<Record<TextureChannel, string>>;
};

/** `UsdPhysicsMaterialAPI` parameters, bound via `material:binding:physics` (M16). */
export type ExportPhysicsMaterial = {
  /** Identity: meshes sharing a name share one physics-material prim. */
  name: string;
  staticFriction?: number;
  dynamicFriction?: number;
  restitution?: number;
  density?: number;
};

/** `physics:approximation` tokens of `UsdPhysicsMeshCollisionAPI`. */
export type CollisionApproximation =
  | "none"
  | "convexHull"
  | "convexDecomposition"
  | "boundingSphere"
  | "boundingCube"
  | "meshSimplification";

/** One mesh of a link, as plain exportable data (stage units, link-relative). */
export type ExportMesh = {
  /** Prim-name hint; the exporter sanitizes and uniquifies it. */
  name: string;
  kind: "visual" | "collision";
  points: Vec3[];
  /** Authored polygon topology (not re-triangulated). */
  faceVertexCounts: number[];
  faceVertexIndices: number[];
  /** Per-vertex normals (only written when one per point). */
  normals?: Vec3[];
  /** `primvars:st` UVs, vertex interpolation (one per point). */
  st?: Vec2[];
  displayColor?: Vec3;
  doubleSided?: boolean;
  /** Transform relative to the link frame (column-major); identity when omitted. */
  transform?: Mat4;
  /** Bound material constants, if any. */
  material?: ExportMaterial;
  /** Collision approximation token (collision meshes only, M16). */
  collisionApproximation?: CollisionApproximation;
  /** Bound physics material (collision meshes only, M16). */
  physicsMaterial?: ExportPhysicsMaterial;
};

/** Supplies the meshes of a link for export. */
export type RobotGeometryProvider = (linkKey: string, link: LinkDescription) => ExportMesh[];

/** Provider that reads each link's visual/collision Mesh prims from a stage. */
export function stageGeometryProvider(stage: Stage): RobotGeometryProvider {
  return (_linkKey, link) => {
    const linkPrim = stage.GetPrimAtPath(link.primPath);
    if (!linkPrim) return [];

    // Meshes that are both visual and collision export once, as visual.
    const visualSet = new Set(link.visualPrims);
    const out: ExportMesh[] = [];
    for (const path of link.visualPrims) {
      out.push(...readMeshes(stage, linkPrim, path, "visual"));
    }
    for (const path of link.collisionPrims ?? []) {
      if (visualSet.has(path)) continue;
      out.push(...readMeshes(stage, linkPrim, path, "collision"));
    }
    return out;
  };
}

/**
 * Read a Mesh prim as exportable data. A mesh painted by `materialBind` face
 * subsets becomes one {@link ExportMesh} per subset (points re-indexed to the
 * faces each one covers), so the export keeps its materials instead of
 * collapsing to a single colour.
 */
function readMeshes(
  stage: Stage,
  linkPrim: Prim,
  meshPath: string,
  kind: "visual" | "collision",
): ExportMesh[] {
  const prim = stage.GetPrimAtPath(meshPath);
  if (!prim) return [];

  const points = prim.GetAttribute("points").Get();
  if (!isVec3Array(points) || points.length === 0) return [];

  const countsValue = prim.GetAttribute("faceVertexCounts").Get();
  const indicesValue = prim.GetAttribute("faceVertexIndices").Get();
  const counts = isNumberArray(countsValue) ? countsValue : [];
  const indices = isNumberArray(indicesValue) ? indicesValue : [];
  const normalsValue = prim.GetAttribute("normals").Get();
  const stValue = prim.GetAttribute("primvars:st").Get();
  const displayColor = prim.GetAttribute("primvars:displayColor").Get();
  const normals =
    isVec3Array(normalsValue) && normalsValue.length === points.length ? normalsValue : undefined;
  const st = isVec2Array(stValue) && stValue.length === points.length ? stValue : undefined;

  // Attributes shared by every piece of this mesh.
  const transform = relativeTransform(linkPrim, prim);
  const common = {
    kind,
    ...(isVec3Array(displayColor) && displayColor[0] ? { displayColor: displayColor[0] } : {}),
    ...(prim.GetAttribute("doubleSided").Get() === true ? { doubleSided: true } : {}),
    ...(isIdentity(transform) ? {} : { transform }),
  } satisfies Partial<ExportMesh>;

  const withPhysics = (mesh: ExportMesh): ExportMesh => {
    if (kind !== "collision") return mesh;
    const approximation = prim.GetAttribute("physics:approximation").Get();
    if (typeof approximation === "string" && APPROXIMATIONS.has(approximation)) {
      mesh.collisionApproximation = approximation as CollisionApproximation;
    }
    const physicsMaterial = readBoundPhysicsMaterial(stage, prim);
    if (physicsMaterial) mesh.physicsMaterial = physicsMaterial;
    return mesh;
  };

  const subsets = getMaterialSubsets(prim);
  if (subsets.length === 0) {
    const material = readBoundMaterial(stage, prim);
    return [
      withPhysics({
        ...common,
        name: prim.GetName(),
        points: points.slice(),
        faceVertexCounts: counts.slice(),
        faceVertexIndices: indices.slice(),
        ...(normals ? { normals: normals.slice() } : {}),
        ...(st ? { st: st.slice() } : {}),
        ...(material ? { material } : {}),
      }),
    ];
  }

  const faceStart: number[] = [];
  let offset = 0;
  for (const count of counts) {
    faceStart.push(offset);
    offset += count;
  }

  /** Re-index the given faces onto their own point list. */
  const piece = (faces: number[], name: string, material?: ExportMaterial): ExportMesh | null => {
    const remap = new Map<number, number>();
    const outPoints: Vec3[] = [];
    const outNormals: Vec3[] = [];
    const outSt: Vec2[] = [];
    const outCounts: number[] = [];
    const outIndices: number[] = [];

    for (const face of faces) {
      const start = faceStart[face];
      const count = counts[face];
      if (start === undefined || count === undefined) continue;
      outCounts.push(count);
      for (let k = 0; k < count; k++) {
        const vertex = indices[start + k];
        if (vertex === undefined || !points[vertex]) continue;
        let mapped = remap.get(vertex);
        if (mapped === undefined) {
          mapped = outPoints.length;
          remap.set(vertex, mapped);
          outPoints.push(points[vertex]!);
          if (normals) outNormals.push(normals[vertex]!);
          if (st) outSt.push(st[vertex]!);
        }
        outIndices.push(mapped);
      }
    }
    if (outPoints.length === 0) return null;

    return withPhysics({
      ...common,
      name,
      points: outPoints,
      faceVertexCounts: outCounts,
      faceVertexIndices: outIndices,
      ...(normals ? { normals: outNormals } : {}),
      ...(st ? { st: outSt } : {}),
      ...(material ? { material } : {}),
    });
  };

  const out: ExportMesh[] = [];
  const claimed = new Set<number>();
  subsets.forEach((subset, index) => {
    const faces = subset.faces.filter((f) => f >= 0 && f < counts.length && !claimed.has(f));
    for (const f of faces) claimed.add(f);
    const material = readBoundMaterial(stage, subset.prim);
    const mesh = piece(faces, `${prim.GetName()}_${material?.name ?? index}`, material);
    if (mesh) out.push(mesh);
  });

  const leftover = counts.map((_, f) => f).filter((f) => !claimed.has(f));
  if (leftover.length > 0) {
    const material = readBoundMaterial(stage, prim);
    const mesh = piece(leftover, prim.GetName(), material);
    if (mesh) out.push(mesh);
  }
  return out;
}

const APPROXIMATIONS: ReadonlySet<string> = new Set([
  "none",
  "convexHull",
  "convexDecomposition",
  "boundingSphere",
  "boundingCube",
  "meshSimplification",
]);

/** `UsdPhysicsMaterialAPI` parameters bound via `material:binding:physics`. */
function readBoundPhysicsMaterial(stage: Stage, prim: Prim): ExportPhysicsMaterial | undefined {
  const target = firstBindingTarget(prim, "material:binding:physics");
  if (!target) return undefined;
  const materialPrim = stage.GetPrimAtPath(target);
  if (!materialPrim) return undefined;

  const out: ExportPhysicsMaterial = {
    name: target.split("/").filter(Boolean).pop() ?? "PhysicsMaterial",
  };
  const read = (attr: string): number | undefined => {
    const v = materialPrim.GetAttribute(attr).Get();
    return typeof v === "number" ? v : undefined;
  };
  const staticFriction = read("physics:staticFriction");
  if (staticFriction !== undefined) out.staticFriction = staticFriction;
  const dynamicFriction = read("physics:dynamicFriction");
  if (dynamicFriction !== undefined) out.dynamicFriction = dynamicFriction;
  const restitution = read("physics:restitution");
  if (restitution !== undefined) out.restitution = restitution;
  const density = read("physics:density");
  if (density !== undefined) out.density = density;
  return Object.keys(out).length > 1 ? out : undefined;
}

/** First target of `relName` on the prim or an ancestor. */
function firstBindingTarget(prim: Prim, relName: string): string | undefined {
  let p: Prim | null = prim;
  while (p) {
    const targets = p.GetRelationship(relName).GetTargets();
    if (targets.length > 0) return targets[0];
    p = p.GetParent();
  }
  return undefined;
}

/** PBR constants + texture asset paths of the bound material. */
function readBoundMaterial(stage: Stage, prim: Prim): ExportMaterial | undefined {
  const bound = resolveBoundMaterial(stage, prim);
  if (!bound) return undefined;
  const material: ExportMaterial = { name: boundMaterialName(prim) ?? "Material" };
  if (bound.color) material.diffuseColor = bound.color;
  if (bound.metalness !== undefined) material.metallic = bound.metalness;
  if (bound.roughness !== undefined) material.roughness = bound.roughness;
  if (bound.opacity !== undefined) material.opacity = bound.opacity;
  if (bound.emissiveColor) material.emissiveColor = bound.emissiveColor;

  const textures: Partial<Record<TextureChannel, string>> = {};
  if (bound.colorTexture) textures.color = bound.colorTexture.path;
  if (bound.opacityTexture) textures.opacity = bound.opacityTexture.path;
  if (bound.normalTexture) textures.normal = bound.normalTexture.path;
  if (bound.roughnessTexture) textures.roughness = bound.roughnessTexture.path;
  if (bound.metalnessTexture) textures.metalness = bound.metalnessTexture.path;
  if (bound.occlusionTexture) textures.occlusion = bound.occlusionTexture.path;
  if (bound.emissiveTexture) textures.emissive = bound.emissiveTexture.path;
  if (Object.keys(textures).length > 0) material.textures = textures;

  return Object.keys(material).length > 1 ? material : undefined;
}

/** Leaf name of the first `material:binding` target on the prim or an ancestor. */
function boundMaterialName(prim: Prim): string | undefined {
  let p: Prim | null = prim;
  while (p) {
    const targets = p.GetRelationship("material:binding").GetTargets();
    if (targets.length > 0) return targets[0]!.split("/").filter(Boolean).pop();
    p = p.GetParent();
  }
  return undefined;
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
  chain.reverse();

  let m = identity4();
  for (const prim of chain) {
    m = multiply(m, computeLocalTransform(prim).matrix);
  }
  return m;
}

function isIdentity(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) {
    if (m[i] !== (i % 5 === 0 ? 1 : 0)) return false;
  }
  return true;
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
