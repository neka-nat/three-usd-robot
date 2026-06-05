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
import type { Prim } from "../usd/Prim.js";
import type { Stage } from "../usd/Stage.js";
import { computeLocalTransform } from "../usd/xformOps.js";
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

/** Build a `BufferGeometry` from a Mesh prim, or `null` if it has no points. */
export function buildMeshGeometry(meshPrim: Prim): THREE.BufferGeometry | null {
  const points = meshPrim.GetAttribute("points").Get();
  if (!isVec3Array(points) || points.length === 0) return null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(flat3(points), 3));

  const counts = meshPrim.GetAttribute("faceVertexCounts").Get();
  const indices = meshPrim.GetAttribute("faceVertexIndices").Get();
  if (isNumberArray(counts) && isNumberArray(indices)) {
    geometry.setIndex(triangulate(counts, indices));
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
): THREE.Material {
  const color = new THREE.Color(DEFAULT_COLOR);
  let opacity = 1;

  const bound = stage ? resolveBoundMaterial(stage, meshPrim) : undefined;
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
  return new THREE.MeshStandardMaterial({
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

    const collisionSet = new Set(link.collisionPrims ?? []);

    if (loadVisuals) {
      for (const meshPath of link.visualPrims) {
        if (collisionSet.has(meshPath)) continue; // collision-only handled below
        attachMesh(stage, linkPrim, meshPath, linkObj, "visual", textures);
      }
    }
    if (loadCollisions) {
      for (const meshPath of link.collisionPrims ?? []) {
        attachMesh(stage, linkPrim, meshPath, linkObj, "collision", textures);
      }
    }
  }
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

  const mesh = new THREE.Mesh(geometry, buildMeshMaterial(meshPrim, stage, textures));
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
