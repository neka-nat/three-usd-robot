/**
 * Input-agnostic link picking: which link does a hit object belong to, and
 * which link does a ray hit first. Every mesh the loader binds carries
 * `userData.primPath` / `userData.kind`, and links are {@link LinkObject}s in
 * the hierarchy, so resolving a hit is a walk up the parent chain — the same
 * code serves a mouse raycast and an XR controller ray.
 */

import type * as THREE from "three";
import type { LinkObject } from "../three/LinkObject.js";
import type { ThreeUsdRobot } from "../three/ThreeUsdRobot.js";
import type { LinkMeshKind } from "./appearance.js";

/** What the hit object is, per the loader's `userData.kind` tag. */
export type LinkHitKind = "visual" | "collision" | "ghost" | "light" | "camera" | "unknown";

/** The link an object belongs to. `link.primPath` works with every robot accessor. */
export type LinkHit = {
  robot: ThreeUsdRobot;
  link: LinkObject;
  /** The object actually hit (a mesh, light or camera under the link). */
  object: THREE.Object3D;
  /** The hit object's own prim path (falls back to the link's). */
  primPath: string;
  kind: LinkHitKind;
};

/** A {@link LinkHit} with the ray intersection it came from. */
export type LinkPick = LinkHit & { point: THREE.Vector3; distance: number };

const KINDS: ReadonlySet<string> = new Set(["visual", "collision", "ghost", "light", "camera"]);

/**
 * Walk up from `object` to the nearest link inside `robot`. Returns `null`
 * for objects outside the robot and for static scenery bound with
 * `loadSceneGeometry` — it belongs to no link. A ghost robot's meshes resolve
 * against the ghost (`kind: "ghost"`), not against the source robot.
 */
export function resolveLink(robot: ThreeUsdRobot, object: THREE.Object3D): LinkHit | null {
  let link: LinkObject | null = null;
  let inside = false;
  for (let cur: THREE.Object3D | null = object; cur; cur = cur.parent) {
    if (cur === robot) {
      inside = true;
      break;
    }
    if (!link && (cur as Partial<LinkObject>).isLinkObject) link = cur as LinkObject;
  }
  if (!inside || !link) return null;
  const data = object.userData as { primPath?: unknown; kind?: unknown };
  const primPath = typeof data.primPath === "string" ? data.primPath : link.primPath;
  const kind =
    typeof data.kind === "string" && KINDS.has(data.kind) ? (data.kind as LinkHitKind) : "unknown";
  return { robot, link, object, primPath, kind };
}

export type PickLinkOptions = {
  /** Mesh kinds that count (default `["visual"]`; `"all"` accepts both). */
  kinds?: LinkMeshKind[];
  /**
   * Skip meshes hidden by themselves or an ancestor (default `true`) — hidden
   * collision meshes still raycast.
   */
  visibleOnly?: boolean;
  /**
   * Whether the robots' static scenery (`loadSceneGeometry`, `kind: "scene"`)
   * blocks the ray (default `true`): a link behind a wall is not picked.
   */
  occludeScenery?: boolean;
  /** Further objects that block the ray (a floor, fixtures outside the stage, …). */
  occluders?: THREE.Object3D[];
};

/**
 * The nearest link along the ray, across one or several robots. Meshes of
 * other kinds are transparent to the ray; scenery and `occluders` block it.
 */
export function pickLink(
  targets: ThreeUsdRobot | ThreeUsdRobot[],
  raycaster: THREE.Raycaster,
  options: PickLinkOptions = {},
): LinkPick | null {
  const robots = Array.isArray(targets) ? targets : [targets];
  if (robots.length === 0) return null;
  const kinds = new Set<string>(options.kinds ?? ["visual"]);
  const visibleOnly = options.visibleOnly ?? true;
  const occludeScenery = options.occludeScenery ?? true;
  const occluders = options.occluders ?? [];

  for (const hit of raycaster.intersectObjects([...robots, ...occluders], true)) {
    const object = hit.object;
    if (!(object as THREE.Mesh).isMesh) continue;
    const robot = robots.find((r) => isDescendant(object, r));
    if (robot) {
      const resolved = resolveLink(robot, object);
      if (resolved) {
        if (!kinds.has("all") && !kinds.has(resolved.kind)) continue;
        if (visibleOnly && !isShown(object, robot)) continue;
        return { ...resolved, point: hit.point, distance: hit.distance };
      }
      if (occludeScenery && object.userData.kind === "scene" && isShown(object, robot)) return null;
      continue;
    }
    const blocker = occluders.find((o) => isDescendant(object, o));
    if (blocker && isShown(object, blocker)) return null;
  }
  return null;
}

function isDescendant(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let cur: THREE.Object3D | null = object; cur; cur = cur.parent)
    if (cur === root) return true;
  return false;
}

/** Whether the object and all ancestors up to (and including) `root` are visible. */
function isShown(object: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let cur: THREE.Object3D | null = object; cur; cur = cur.parent) {
    if (!cur.visible) return false;
    if (cur === root) break;
  }
  return true;
}
