/**
 * Builds a kinematic spanning tree from a {@link RobotDescription}.
 *
 * USD physics joints form a directed graph (parent `body0` → child `body1`,
 * with an empty `body0` meaning "fixed to world"). Three.js needs a tree, so we
 * pick a root, breadth-first walk the real (link→link) edges, and drop any edge
 * that would revisit a link — those are recorded as {@link KinematicTree.loopJoints}
 * (closed chains / parallel mechanisms) rather than silently corrupting the tree.
 */

import type { RobotDescription } from "./RobotDescription.js";

/** Sentinel parent for a world-fixed joint (`body0` empty). */
const WORLD = "";

export type TreeEdge = {
  /** Joint key connecting this node to the child. */
  joint: string;
  /** Child link key. */
  child: string;
};

export type KinematicNode = {
  link: string;
  /** Parent link key, or `null` for the root. */
  parent: string | null;
  /** Joint key to the parent, or `null` for the root. */
  jointToParent: string | null;
  children: TreeEdge[];
  /** Distance from the root (root = 0). */
  depth: number;
};

export type KinematicTree = {
  root: string;
  /** World-fixed joint attaching the root to the world frame, if any. */
  rootJoint: string | null;
  nodes: Record<string, KinematicNode>;
  /** Link keys in breadth-first order (parents before children). */
  order: string[];
  /** Joints dropped from the tree to break closed loops. */
  loopJoints: string[];
  /** Links not reachable from the root. */
  isolatedLinks: string[];
  warnings: string[];
};

export type BuildTreeOptions = {
  onWarn?: (message: string) => void;
};

export function buildKinematicTree(
  robot: RobotDescription,
  options: BuildTreeOptions = {},
): KinematicTree {
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    options.onWarn?.(m);
  };

  const links = new Set(Object.keys(robot.links));

  // Real (link→link) edges, world-fixed attachments, and in-degrees.
  const outgoing = new Map<string, TreeEdge[]>();
  const worldJointByChild = new Map<string, string>();
  const inRealDegree = new Map<string, number>();

  for (const [jointKey, joint] of Object.entries(robot.joints)) {
    if (!links.has(joint.child)) {
      warn(`joint "${jointKey}": child link "${joint.child}" is unknown; skipping edge`);
      continue;
    }
    if (joint.parent === WORLD) {
      if (worldJointByChild.has(joint.child)) {
        warn(`link "${joint.child}" is fixed to world by multiple joints; keeping "${jointKey}"`);
      }
      worldJointByChild.set(joint.child, jointKey);
      continue;
    }
    if (!links.has(joint.parent)) {
      warn(`joint "${jointKey}": parent link "${joint.parent}" is unknown; skipping edge`);
      continue;
    }
    const edges = outgoing.get(joint.parent) ?? [];
    edges.push({ joint: jointKey, child: joint.child });
    outgoing.set(joint.parent, edges);
    inRealDegree.set(joint.child, (inRealDegree.get(joint.child) ?? 0) + 1);
  }

  const root = chooseRoot(links, inRealDegree, worldJointByChild, robot, warn);

  // Breadth-first spanning tree.
  const nodes: Record<string, KinematicNode> = {};
  const order: string[] = [];
  const loopJoints: string[] = [];
  const visited = new Set<string>();

  if (root !== "") {
    nodes[root] = { link: root, parent: null, jointToParent: null, children: [], depth: 0 };
    visited.add(root);
    order.push(root);
    const queue = [root];

    while (queue.length > 0) {
      const cur = queue.shift()!;
      const edges = [...(outgoing.get(cur) ?? [])].sort((a, b) => a.joint.localeCompare(b.joint));
      for (const edge of edges) {
        if (visited.has(edge.child)) {
          loopJoints.push(edge.joint); // revisiting a link closes a loop
          continue;
        }
        visited.add(edge.child);
        nodes[edge.child] = {
          link: edge.child,
          parent: cur,
          jointToParent: edge.joint,
          children: [],
          depth: nodes[cur]!.depth + 1,
        };
        nodes[cur]!.children.push(edge);
        order.push(edge.child);
        queue.push(edge.child);
      }
    }
  }

  const isolatedLinks = [...links].filter((l) => !visited.has(l)).sort();
  if (isolatedLinks.length > 0) {
    warn(
      `${isolatedLinks.length} link(s) not reachable from root "${root}": ${isolatedLinks.join(", ")}`,
    );
  }
  if (loopJoints.length > 0) {
    warn(`closed loop(s) detected; dropped joints from tree: ${loopJoints.sort().join(", ")}`);
  }

  return {
    root,
    rootJoint: worldJointByChild.get(root) ?? null,
    nodes,
    order,
    loopJoints: loopJoints.sort(),
    isolatedLinks,
    warnings,
  };
}

/**
 * Pick the root link. Priority: a link flagged with `PhysicsArticulationRootAPI`,
 * then a world-fixed link, then any link with no real parent. Falls back to the
 * lexicographically-first link if every link has a parent (a full cycle).
 */
function chooseRoot(
  links: Set<string>,
  inRealDegree: Map<string, number>,
  worldJointByChild: Map<string, string>,
  robot: RobotDescription,
  warn: (m: string) => void,
): string {
  if (links.size === 0) return "";

  const candidates = [...links].filter((l) => (inRealDegree.get(l) ?? 0) === 0).sort();

  if (candidates.length === 0) {
    const fallback = [...links].sort()[0]!;
    warn(`no root candidate (every link has a parent — likely a full cycle); using "${fallback}"`);
    return fallback;
  }

  const articulation = (robot.articulationRoots ?? []).filter((a) => candidates.includes(a));
  const worldFixed = candidates.filter((c) => worldJointByChild.has(c));
  const chosen = articulation[0] ?? worldFixed[0] ?? candidates[0]!;

  if (candidates.length > 1) {
    warn(`multiple root candidates (${candidates.join(", ")}); using "${chosen}"`);
  }
  return chosen;
}
