import { describe, expect, it } from "vitest";
import {
  type JointDescription,
  type RobotDescription,
  Stage,
  buildKinematicTree,
  extractRobotDescription,
  identity4,
} from "../src/core.js";

function joint(
  name: string,
  parent: string,
  child: string,
  type: JointDescription["type"] = "fixed",
): JointDescription {
  return {
    name,
    primPath: `/${name}`,
    type,
    parent,
    child,
    axis: "Z",
    jointFrame0: identity4(),
    jointFrame1: identity4(),
  };
}

function robot(
  linkKeys: string[],
  joints: JointDescription[],
  extra: Partial<RobotDescription> = {},
): RobotDescription {
  return {
    name: "r",
    rootLink: "",
    links: Object.fromEntries(
      linkKeys.map((l) => [l, { name: l, primPath: `/${l}`, visualPrims: [] }]),
    ),
    joints: Object.fromEntries(joints.map((j) => [j.name, j])),
    upAxis: "Y",
    metersPerUnit: 1,
    ...extra,
  };
}

describe("buildKinematicTree — serial chain", () => {
  const tree = buildKinematicTree(
    robot(
      ["base", "l1", "l2"],
      [
        joint("root", "", "base"),
        joint("j1", "base", "l1", "revolute"),
        joint("j2", "l1", "l2", "prismatic"),
      ],
    ),
  );

  it("roots at the world-fixed base and orders parents before children", () => {
    expect(tree.root).toBe("base");
    expect(tree.rootJoint).toBe("root");
    expect(tree.order).toEqual(["base", "l1", "l2"]);
    expect(tree.loopJoints).toEqual([]);
    expect(tree.isolatedLinks).toEqual([]);
  });

  it("links each node to its parent joint and depth", () => {
    expect(tree.nodes.l1?.parent).toBe("base");
    expect(tree.nodes.l1?.jointToParent).toBe("j1");
    expect(tree.nodes.l2?.depth).toBe(2);
    expect(tree.nodes.base?.children).toEqual([{ joint: "j1", child: "l1" }]);
  });
});

describe("buildKinematicTree — branching", () => {
  it("gives a node multiple children (sorted by joint key)", () => {
    const tree = buildKinematicTree(
      robot(
        ["base", "a", "b"],
        [joint("root", "", "base"), joint("jb", "base", "b"), joint("ja", "base", "a")],
      ),
    );
    expect(tree.root).toBe("base");
    expect(tree.nodes.base?.children).toEqual([
      { joint: "ja", child: "a" },
      { joint: "jb", child: "b" },
    ]);
    expect(tree.order).toEqual(["base", "a", "b"]);
  });
});

describe("buildKinematicTree — closed loop", () => {
  it("breaks the loop and records the dropped joint", () => {
    // base->a->b and base->c->b : b has two parents, so one edge is a loop.
    const tree = buildKinematicTree(
      robot(
        ["base", "a", "b", "c"],
        [
          joint("j1", "base", "a"),
          joint("j2", "a", "b"),
          joint("j3", "base", "c"),
          joint("j4", "c", "b"),
        ],
      ),
    );
    expect(tree.root).toBe("base");
    expect(tree.loopJoints).toEqual(["j4"]);
    expect(tree.isolatedLinks).toEqual([]);
    // b stays in the tree via its first-visited parent.
    expect(tree.nodes.b?.parent).toBe("a");
    expect(tree.nodes.b?.jointToParent).toBe("j2");
    expect(tree.warnings.some((w) => w.includes("closed loop"))).toBe(true);
  });
});

describe("buildKinematicTree — root selection", () => {
  it("uses an in-degree-0 link for a floating base (no world joint)", () => {
    const tree = buildKinematicTree(
      robot(["l0", "l1", "l2"], [joint("j1", "l0", "l1"), joint("j2", "l1", "l2")]),
    );
    expect(tree.root).toBe("l0");
    expect(tree.rootJoint).toBeNull();
  });

  it("prefers an articulation-root link over the sorted-first candidate", () => {
    const tree = buildKinematicTree(robot(["a", "b"], [], { articulationRoots: ["b"] }));
    expect(tree.root).toBe("b");
    expect(tree.warnings.some((w) => w.includes("multiple root candidates"))).toBe(true);
  });

  it("flags links unreachable from the root as isolated", () => {
    const tree = buildKinematicTree(
      robot(["base", "l1", "orphan"], [joint("root", "", "base"), joint("j1", "base", "l1")]),
    );
    expect(tree.root).toBe("base");
    expect(tree.isolatedLinks).toEqual(["orphan"]);
    expect(tree.warnings.some((w) => w.includes("not reachable"))).toBe(true);
  });
});

describe("buildKinematicTree — integration with the extractor", () => {
  it("matches the extractor's authoritative root/loops on the two-link arm", () => {
    const usda = `#usda 1.0
def Xform "W"
{
    def Xform "base" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def Xform "l1" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def PhysicsFixedJoint "root" { rel physics:body1 = </W/base> }
    def PhysicsRevoluteJoint "j1"
    {
        rel physics:body0 = </W/base>
        rel physics:body1 = </W/l1>
    }
}`;
    const r = extractRobotDescription(Stage.OpenFromString(usda));
    expect(r.rootLink).toBe("base");
    expect(r.loopJoints).toBeUndefined();

    const tree = buildKinematicTree(r);
    expect(tree.root).toBe("base");
    expect(tree.order).toEqual(["base", "l1"]);
  });

  it("propagates loop detection into the IR", () => {
    const usda = `#usda 1.0
def Xform "W"
{
    def Xform "base" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def Xform "a" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def Xform "b" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def PhysicsFixedJoint "j1" { rel physics:body0 = </W/base>  rel physics:body1 = </W/a> }
    def PhysicsFixedJoint "j2" { rel physics:body0 = </W/a>  rel physics:body1 = </W/b> }
    def PhysicsFixedJoint "j3" { rel physics:body0 = </W/base>  rel physics:body1 = </W/b> }
}`;
    // base reaches b directly via j3 before a's j2, so j2 is the dropped edge.
    const r = extractRobotDescription(Stage.OpenFromString(usda));
    expect(r.loopJoints).toEqual(["j2"]);
    expect(r.warnings?.some((w) => w.includes("closed loop"))).toBe(true);
  });
});
