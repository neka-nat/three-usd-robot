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

    const collisionSet = new Set(link.collisionPrims ?? []);
    const out: ExportMesh[] = [];
    for (const path of link.visualPrims) {
      if (collisionSet.has(path)) continue;
      const mesh = readMesh(stage, linkPrim, path, "visual");
      if (mesh) out.push(mesh);
    }
    for (const path of link.collisionPrims ?? []) {
      const mesh = readMesh(stage, linkPrim, path, "collision");
      if (mesh) out.push(mesh);
    }
    return out;
  };
}

function readMesh(
  stage: Stage,
  linkPrim: Prim,
  meshPath: string,
  kind: "visual" | "collision",
): ExportMesh | null {
  const prim = stage.GetPrimAtPath(meshPath);
  if (!prim) return null;

  const points = prim.GetAttribute("points").Get();
  if (!isVec3Array(points) || points.length === 0) return null;

  const counts = prim.GetAttribute("faceVertexCounts").Get();
  const indices = prim.GetAttribute("faceVertexIndices").Get();
  const normals = prim.GetAttribute("normals").Get();
  const st = prim.GetAttribute("primvars:st").Get();
  const displayColor = prim.GetAttribute("primvars:displayColor").Get();

  const mesh: ExportMesh = {
    name: prim.GetName(),
    kind,
    points: points.slice(),
    faceVertexCounts: isNumberArray(counts) ? counts.slice() : [],
    faceVertexIndices: isNumberArray(indices) ? indices.slice() : [],
  };
  if (isVec3Array(normals) && normals.length === points.length) mesh.normals = normals.slice();
  if (isVec2Array(st) && st.length === points.length) mesh.st = st.slice();
  if (isVec3Array(displayColor) && displayColor[0]) mesh.displayColor = displayColor[0];
  if (prim.GetAttribute("doubleSided").Get() === true) mesh.doubleSided = true;

  const transform = relativeTransform(linkPrim, prim);
  if (!isIdentity(transform)) mesh.transform = transform;

  const material = readBoundMaterial(stage, prim);
  if (material) mesh.material = material;

  if (kind === "collision") {
    const approximation = prim.GetAttribute("physics:approximation").Get();
    if (typeof approximation === "string" && APPROXIMATIONS.has(approximation)) {
      mesh.collisionApproximation = approximation as CollisionApproximation;
    }
    const physicsMaterial = readBoundPhysicsMaterial(stage, prim);
    if (physicsMaterial) mesh.physicsMaterial = physicsMaterial;
  }
  return mesh;
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
