/**
 * Per-link appearance helpers: highlight (tint), material replacement, and
 * translucent "ghost" clones for pose previews.
 *
 * Material overrides are reversible — the original materials are kept aside on
 * first override and put back exactly by {@link restoreLinkMaterials} /
 * {@link restoreAllLinkMaterials}. Links are addressed like everywhere else:
 * by key or by full prim path.
 */

import * as THREE from "three";
import { ThreeUsdRobot } from "../three/ThreeUsdRobot.js";

/** Which meshes of a link an operation affects. */
export type LinkMeshKind = "visual" | "collision" | "all";

/** Originals saved on first override (per mesh; first save wins until restore). */
const savedMaterials = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();

/** Marks materials created by {@link highlightLink}, so restore can dispose them. */
const HIGHLIGHT_FLAG = "__threeUsdRobotHighlight";

/**
 * The meshes belonging to exactly this link — not those of child links, which
 * live under their own `LinkObject` deeper in the kinematic chain. Helpers and
 * joint-frame groups are excluded.
 */
export function getLinkMeshes(
  robot: ThreeUsdRobot,
  link: string,
  kind: LinkMeshKind = "all",
): THREE.Mesh[] {
  const obj = robot.getLinkObject(link);
  if (!obj) return [];
  const out: THREE.Mesh[] = [];
  for (const child of obj.children) {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) continue;
    const k = (mesh.userData as { kind?: string }).kind;
    if (k !== "visual" && k !== "collision") continue;
    if (kind !== "all" && k !== kind) continue;
    out.push(mesh);
  }
  return out;
}

export type HighlightLinkOptions = {
  /** Highlight color (default red `0xff4444`). */
  color?: THREE.ColorRepresentation;
  /** Emissive strength of the tint (default `0.8`). */
  emissiveIntensity?: number;
  /** Force translucency while highlighted (e.g. `0.5`); default keeps the material's own. */
  opacity?: number;
  /** Which meshes of the link to affect (default `"visual"`). */
  kind?: LinkMeshKind;
};

/**
 * Tint a link's meshes (emissive red by default) while keeping their maps and
 * base colors — e.g. to flag a colliding link. Repeated calls re-tint from the
 * *original* materials, so highlights don't stack; restore with
 * {@link restoreLinkMaterials}. Returns `false` when the link has no matching
 * meshes.
 */
export function highlightLink(
  robot: ThreeUsdRobot,
  link: string,
  options: HighlightLinkOptions = {},
): boolean {
  const meshes = getLinkMeshes(robot, link, options.kind ?? "visual");
  if (meshes.length === 0) return false;

  const color = new THREE.Color(options.color ?? 0xff4444);
  for (const mesh of meshes) {
    if (!savedMaterials.has(mesh)) savedMaterials.set(mesh, mesh.material);
    const base = savedMaterials.get(mesh)!;
    disposeHighlightClones(mesh.material);
    mesh.material = Array.isArray(base)
      ? base.map((m) => tintClone(m, color, options))
      : tintClone(base, color, options);
  }
  return true;
}

function tintClone(
  base: THREE.Material,
  color: THREE.Color,
  options: HighlightLinkOptions,
): THREE.Material {
  const m = base.clone();
  m.userData[HIGHLIGHT_FLAG] = true;
  const std = m as THREE.MeshStandardMaterial;
  if (std.isMeshStandardMaterial) {
    std.emissive.copy(color);
    std.emissiveIntensity = options.emissiveIntensity ?? 0.8;
  } else if ("color" in m) {
    (m as THREE.MeshBasicMaterial).color.copy(color);
  }
  if (options.opacity !== undefined) {
    m.transparent = options.opacity < 1;
    m.opacity = options.opacity;
  }
  return m;
}

/**
 * Replace a link's mesh materials with `material` (one shared instance). The
 * caller keeps ownership — it is never disposed here. Restore the originals
 * with {@link restoreLinkMaterials}. Returns `false` when the link has no
 * matching meshes.
 */
export function setLinkMaterial(
  robot: ThreeUsdRobot,
  link: string,
  material: THREE.Material,
  kind: LinkMeshKind = "visual",
): boolean {
  const meshes = getLinkMeshes(robot, link, kind);
  if (meshes.length === 0) return false;
  for (const mesh of meshes) {
    if (!savedMaterials.has(mesh)) savedMaterials.set(mesh, mesh.material);
    disposeHighlightClones(mesh.material);
    mesh.material = material;
  }
  return true;
}

/** Put back a link's original materials (no-op for untouched meshes). */
export function restoreLinkMaterials(robot: ThreeUsdRobot, link: string): void {
  for (const mesh of getLinkMeshes(robot, link, "all")) {
    const original = savedMaterials.get(mesh);
    if (original === undefined) continue;
    disposeHighlightClones(mesh.material);
    mesh.material = original;
    savedMaterials.delete(mesh);
  }
}

/** Put back the original materials of every link of the robot. */
export function restoreAllLinkMaterials(robot: ThreeUsdRobot): void {
  for (const name of robot.getLinkNames()) restoreLinkMaterials(robot, name);
}

/** Dispose materials created by {@link highlightLink} (never user-supplied ones). */
function disposeHighlightClones(current: THREE.Material | THREE.Material[]): void {
  for (const m of Array.isArray(current) ? current : [current]) {
    if (m.userData[HIGHLIGHT_FLAG]) m.dispose();
  }
}

export type GhostRobotOptions = {
  /** Ghost tint (default `0x66aaff`). */
  color?: THREE.ColorRepresentation;
  /** Ghost opacity (default `0.35`). */
  opacity?: number;
  /** Complete material override; `color` / `opacity` are ignored when given. */
  material?: THREE.Material;
  /** Which meshes to clone (default `"visual"`). */
  kind?: "visual" | "collision";
  /** Joint overrides applied on top of the source robot's current pose. */
  jointValues?: Record<string, number>;
};

/**
 * Build a translucent clone of the robot for pose previews (target pose,
 * onion-skinning). Geometry is shared with the source; every mesh uses one
 * ghost material and is tagged `userData.kind = "ghost"`, so the source's
 * `showVisual` / `showCollision` toggles never affect it. The clone is a full
 * {@link ThreeUsdRobot} — drive it with `setJointValues` — starting from the
 * source's current joint values (plus `jointValues` overrides) and mirroring
 * its root transform. Add it to the same parent/scene as the source.
 */
export function createGhostRobot(
  robot: ThreeUsdRobot,
  options: GhostRobotOptions = {},
): ThreeUsdRobot {
  const ghost = new ThreeUsdRobot(robot.robot, robot.tree, {
    clampJointLimits: robot.clampJointLimits,
    applyInitialPose: false,
    upAxisConversion: "none",
  });
  ghost.name = `${robot.name}_ghost`;
  // Mirror the source root exactly (stage normalization + any user transform).
  ghost.position.copy(robot.position);
  ghost.quaternion.copy(robot.quaternion);
  ghost.scale.copy(robot.scale);

  const material =
    options.material ??
    new THREE.MeshStandardMaterial({
      color: options.color ?? 0x66aaff,
      transparent: true,
      opacity: options.opacity ?? 0.35,
      depthWrite: false,
      metalness: 0,
      roughness: 1,
    });

  const kind = options.kind ?? "visual";
  for (const key of robot.getLinkNames()) {
    const target = ghost.getLinkObject(key);
    if (!target) continue;
    for (const src of getLinkMeshes(robot, key, kind)) {
      const mesh = new THREE.Mesh(src.geometry, material);
      mesh.name = `${src.name}_ghost`;
      mesh.userData.kind = "ghost";
      mesh.userData.primPath = (src.userData as { primPath?: string }).primPath;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(src.matrix);
      mesh.matrixWorldNeedsUpdate = true;
      target.add(mesh);
    }
  }

  for (const name of robot.getJointNames()) {
    const value = robot.getJointValue(name);
    if (value !== undefined) ghost.setJointValue(name, value);
  }
  if (options.jointValues) ghost.setJointValues(options.jointValues);
  return ghost;
}
