/**
 * Binds `UsdGeom.Mesh` prims to Three.js geometry and attaches them under the
 * robot's link objects.
 *
 * Triangulates polygons with a simple fan, uses authored per-vertex normals
 * when present (else computes smooth normals), and reads `primvars:st` UVs and
 * `primvars:displayColor`. Geometry is left in stage units; the global
 * `metersPerUnit` scale is applied at the root in M9.
 */

import * as THREE from "three";
import { type Mat4, identity4, multiply } from "../kinematics/transforms.js";
import type { Vec2, Vec3 } from "../parser/ast.js";
import type { RobotDescription } from "../robot/RobotDescription.js";
import { type MaterialSubset, getMaterialSubsets, isNonVisualPurpose } from "../schemas/usdGeom.js";
import { COLLISION_API } from "../schemas/usdPhysics.js";
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";
import { computeLocalTransform, computeWorldTransform } from "../usd/xformOps.js";
import { type ResolvedTexture, resolveBoundMaterial } from "./MaterialBinding.js";
import type { TextureProvider } from "./TextureBinding.js";
import type { ThreeUsdRobot } from "./ThreeUsdRobot.js";

export type MeshKind = "visual" | "collision";

const DEFAULT_COLOR = 0x9a9a9a;

export type BindMeshesOptions = {
  loadVisuals?: boolean;
  loadCollisions?: boolean;
  /** Resolves diffuse texture asset paths to `THREE.Texture` (M-tex). */
  textureProvider?: TextureProvider;
};

/**
 * Build a `BufferGeometry` from a Mesh prim, or `null` if it has no points.
 *
 * When the mesh carries `materialBind` face subsets, the triangles are ordered
 * subset by subset and a geometry group is added for each — so the mesh can be
 * drawn with one material per subset (see {@link buildMeshMaterials}). Group
 * order matches {@link getMaterialSubsets}, with any unassigned faces last.
 */
export function buildMeshGeometry(meshPrim: Prim): THREE.BufferGeometry | null {
  const points = meshPrim.GetAttribute("points").Get();
  if (!isVec3Array(points) || points.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(flat3(points), 3));

  const counts = meshPrim.GetAttribute("faceVertexCounts").Get();
  const indices = meshPrim.GetAttribute("faceVertexIndices").Get();
  if (isNumberArray(counts) && isNumberArray(indices)) {
    const subsets = getMaterialSubsets(meshPrim);
    if (subsets.length > 0) {
      geometry.setIndex(triangulateBySubset(geometry, counts, indices, subsets));
    } else {
      geometry.setIndex(triangulate(counts, indices));
    }
  } else if (isNumberArray(indices)) {
    geometry.setIndex(indices.slice());
  }

  const normals = meshPrim.GetAttribute("normals").Get();
  if (isVec3Array(normals) && normals.length === points.length) {
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(flat3(normals), 3));
  } else {
    geometry.computeVertexNormals();
  }

  const st = meshPrim.GetAttribute("primvars:st").Get();
  if (isVec2Array(st) && st.length === points.length) {
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(flat2(st), 2));
  }

  return geometry;
}

/**
 * Build a material for a Mesh prim. Color priority: bound `UsdShade` material
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
): THREE.Material {
  const color = new THREE.Color(DEFAULT_COLOR);
  let opacity = 1;

  const bound = stage ? resolveBoundMaterial(stage, bindingPrim ?? meshPrim) : undefined;
  if (bound?.color) {
    color.setRGB(bound.color[0], bound.color[1], bound.color[2]);
  } else {
    const displayColor = meshPrim.GetAttribute("primvars:displayColor").Get();
    if (isVec3Array(displayColor) && displayColor[0]) {
      const [r, g, b] = displayColor[0];
      color.setRGB(r, g, b);
    }
  }
  if (bound?.opacity !== undefined) opacity = bound.opacity;

  // Resolve a channel's `THREE.Texture`, forwarding its wrap modes and
  // `UsdTransform2d` (the `UsdUVTexture.inputs:scale`/`bias` are folded into the
  // material factors below, not the sampler).
  const tex = (rt: ResolvedTexture | undefined, cs: "srgb" | "linear") =>
    rt && textures
      ? textures(rt.path, {
          colorSpace: cs,
          ...(rt.wrapS ? { wrapS: rt.wrapS } : {}),
          ...(rt.wrapT ? { wrapT: rt.wrapT } : {}),
          ...(rt.transform ? { transform: rt.transform } : {}),
        })
      : null;

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
  const material = new THREE.MeshStandardMaterial({
    color,
    metalness,
    roughness,
    emissive,
    transparent,
    opacity,
    ...(alphaTest > 0 ? { alphaTest } : {}),
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    ...(map ? { map } : {}),
    ...(alphaMap ? { alphaMap } : {}),
    ...(normalMap ? { normalMap } : {}),
    ...(roughnessMap ? { roughnessMap } : {}),
    ...(metalnessMap ? { metalnessMap } : {}),
    ...(aoMap ? { aoMap } : {}),
    ...(emissiveMap ? { emissiveMap } : {}),
  });
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
  const textures = options.textureProvider;

  for (const [key, link] of Object.entries(desc.links)) {
    const linkObj = robot3d.getLinkObject(key);
    const linkPrim = stage.GetPrimAtPath(link.primPath);
    if (!linkObj || !linkPrim) continue;

    // A mesh may be both visual and collision; attach it once, as visual.
    const visualSet = new Set(link.visualPrims);

    if (loadVisuals) {
      for (const meshPath of link.visualPrims) {
        attachMesh(stage, linkPrim, meshPath, linkObj, "visual", textures);
      }
    }
    if (loadCollisions) {
      for (const meshPath of link.collisionPrims ?? []) {
        if (loadVisuals && visualSet.has(meshPath)) continue;
        attachMesh(stage, linkPrim, meshPath, linkObj, "collision", textures);
      }
    }
  }
}

/**
 * Attach the Mesh prims that belong to no link — the static scenery of a cell
 * that also contains robots. They are placed by their authored stage transform
 * under the robot root, so the loader's up-axis and unit normalization applies
 * to them too. Collision-only and guide/proxy prims are skipped.
 */
export function bindSceneMeshes(
  stage: Stage,
  robot3d: ThreeUsdRobot,
  desc: RobotDescription,
  options: { textureProvider?: TextureProvider } = {},
): number {
  const owned = new Set<string>();
  for (const link of Object.values(desc.links)) {
    for (const path of link.visualPrims) owned.add(path);
    for (const path of link.collisionPrims ?? []) owned.add(path);
    owned.add(link.primPath);
  }

  let attached = 0;
  for (const prim of stage.Traverse()) {
    if (prim.GetTypeName() !== "Mesh" || owned.has(prim.GetPath())) continue;
    if (prim.HasAPI(COLLISION_API) || isNonVisualPurpose(prim)) continue;
    // Skip meshes under a link (already bound relative to their link).
    if ([...owned].some((path) => prim.GetPath().startsWith(`${path}/`))) continue;

    const geometry = buildMeshGeometry(prim);
    if (!geometry) continue;
    const mesh = new THREE.Mesh(geometry, buildMeshMaterial(prim, stage, options.textureProvider));
    mesh.name = prim.GetName();
    mesh.userData.kind = "scene";
    mesh.userData.primPath = prim.GetPath();
    mesh.matrixAutoUpdate = false;
    mesh.matrix.fromArray(computeWorldTransform(prim));
    mesh.matrixWorldNeedsUpdate = true;
    robot3d.add(mesh);
    attached++;
  }
  return attached;
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
): THREE.Material | THREE.Material[] {
  const subsets = stage ? getMaterialSubsets(meshPrim) : [];
  if (subsets.length === 0) return buildMeshMaterial(meshPrim, stage, textures);
  return [
    ...subsets.map((s) => buildMeshMaterial(meshPrim, stage, textures, s.prim)),
    buildMeshMaterial(meshPrim, stage, textures),
  ];
}

function attachMesh(
  stage: Stage,
  linkPrim: Prim,
  meshPath: string,
  parent: THREE.Object3D,
  kind: MeshKind,
  textures: TextureProvider | undefined,
): void {
  const meshPrim = stage.GetPrimAtPath(meshPath);
  if (!meshPrim) return;
  const geometry = buildMeshGeometry(meshPrim);
  if (!geometry) return;

  const mesh = new THREE.Mesh(geometry, buildMeshMaterials(meshPrim, stage, textures));
  mesh.name = meshPrim.GetName();
  mesh.userData.kind = kind;
  mesh.userData.primPath = meshPath;
  // Collision meshes are loaded hidden; reveal via `robot.showCollision = true`.
  if (kind === "collision") mesh.visible = false;
  mesh.matrixAutoUpdate = false;
  mesh.matrix.fromArray(relativeTransform(linkPrim, meshPrim));
  mesh.matrixWorldNeedsUpdate = true;
  parent.add(mesh);
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
