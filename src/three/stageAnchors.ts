/**
 * Shared placement machinery for binding non-gprim stage prims (lights M25,
 * cameras M27) into an already-built {@link ThreeUsdRobot} hierarchy: find the
 * deepest ancestor that owns a Three.js object — a link frame, a mirrored
 * scenery group, a gprim — and accumulate the local transform chain from it.
 */

import type * as THREE from "three";
import { type Mat4, identity4, multiply } from "../kinematics/transforms.js";
import type { Prim } from "../usd/Prim.js";
import { computeLocalTransform, computeWorldTransform } from "../usd/xformOps.js";
import type { ThreeUsdRobot } from "./ThreeUsdRobot.js";

/**
 * Index `primPath → object` over everything already bound: scenery groups and
 * gprims register through `userData.primPath`, links by their own prim path.
 */
export function collectAnchors(robot3d: ThreeUsdRobot): Map<string, THREE.Object3D> {
  const anchors = new Map<string, THREE.Object3D>();
  robot3d.traverse((object) => {
    const path = (object.userData as { primPath?: unknown }).primPath;
    if (typeof path === "string" && !anchors.has(path)) anchors.set(path, object);
  });
  for (const [path, link] of robot3d.getLinkObjectsByPath()) anchors.set(path, link);
  return anchors;
}

/** The deepest ancestor prim that already has a Three.js object to anchor to. */
export function findAnchor(
  prim: Prim,
  anchors: Map<string, THREE.Object3D>,
): { object: THREE.Object3D; prim: Prim } | null {
  for (let p = prim.GetParent(); p && !p.IsPseudoRoot(); p = p.GetParent()) {
    const object = anchors.get(p.GetPath());
    if (object) return { object, prim: p };
  }
  return null;
}

/**
 * Accumulated local transform from `anchorPrim` (exclusive) down to `prim`
 * (inclusive); from the stage root when `anchorPrim` is `null`.
 */
export function transformFrom(anchorPrim: Prim | null, prim: Prim): Mat4 {
  const stop = anchorPrim?.GetPath();
  const chain: Prim[] = [];
  for (
    let p: Prim | null = prim;
    p && !p.IsPseudoRoot() && p.GetPath() !== stop;
    p = p.GetParent()
  ) {
    chain.push(p);
  }
  chain.reverse();
  let m = identity4();
  for (const link of chain) m = multiply(m, computeLocalTransform(link).matrix);
  return m;
}

/** Uniform-ish world scale at `prim`: root normalization × the prim chain's scale. */
export function worldScaleOf(prim: Prim, rootScale: number): number {
  const m = computeWorldTransform(prim);
  const sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  return rootScale * ((sx + sy + sz) / 3);
}

/**
 * Place `object` under the anchor's Three.js object (or the robot root) by
 * its accumulated USD local transform — the shared attach step of the light
 * and camera binders.
 */
export function attachAtPrim(
  object: THREE.Object3D,
  prim: Prim,
  anchors: Map<string, THREE.Object3D>,
  robot3d: ThreeUsdRobot,
): void {
  const anchor = findAnchor(prim, anchors);
  object.matrixAutoUpdate = false;
  object.matrix.fromArray(transformFrom(anchor?.prim ?? null, prim));
  object.matrixWorldNeedsUpdate = true;
  (anchor?.object ?? robot3d).add(object);
}
