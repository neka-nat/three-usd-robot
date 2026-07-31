import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { type LinkPose, type ThreeUsdRobot, ThreeUsdRobotLoader } from "../src/index.js";

// Z-up, meters. FK: base=(0,0,0), link1=(0,0,1), link2=(q2·cos q1, q2·sin q1, 2).
const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");
const LINKS = ["base_link", "link1", "link2"];

// Floating base (no world joint): base authored at (2,0,0), tip 1 above it.
const FLOATING = `#usda 1.0
(
    defaultPrim = "W"
    metersPerUnit = 1.0
    upAxis = "Z"
)
def Xform "W" ( prepend apiSchemas = ["PhysicsArticulationRootAPI"] )
{
    def Xform "base" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] )
    {
        float3 xformOp:translate = (2, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
    def Xform "tip" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] )
    {
        float3 xformOp:translate = (2, 0, 1)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
    def PhysicsRevoluteJoint "j"
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </W/base>
        rel physics:body1 = </W/tip>
        point3f physics:localPos0 = (0, 0, 1)
    }
}`;

// a at the origin, b at (+1,0,0) via j1, c at (-1,0,0) via j2; j3 closes b→c.
const LOOP = `#usda 1.0
(
    defaultPrim = "W"
    metersPerUnit = 1.0
    upAxis = "Z"
)
def Xform "W" ( prepend apiSchemas = ["PhysicsArticulationRootAPI"] )
{
    def Xform "a" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def Xform "b" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def Xform "c" ( prepend apiSchemas = ["PhysicsRigidBodyAPI"] ) {}
    def PhysicsFixedJoint "root_joint" { rel physics:body1 = </W/a> }
    def PhysicsRevoluteJoint "j1"
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </W/a>
        rel physics:body1 = </W/b>
        point3f physics:localPos0 = (1, 0, 0)
    }
    def PhysicsRevoluteJoint "j2"
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </W/a>
        rel physics:body1 = </W/c>
        point3f physics:localPos0 = (-1, 0, 0)
    }
    def PhysicsRevoluteJoint "j3"
    {
        uniform token physics:axis = "Z"
        rel physics:body0 = </W/b>
        rel physics:body1 = </W/c>
    }
}`;

type LoaderOptions = ConstructorParameters<typeof ThreeUsdRobotLoader>[0];

const load = (options: LoaderOptions = {}, text = ARM) =>
  new ThreeUsdRobotLoader(options).parse(text);

/** Current world pose of each link, decomposed into a `LinkPose` batch. */
function worldPoses(robot: ThreeUsdRobot, links = LINKS): Record<string, LinkPose> {
  const poses: Record<string, LinkPose> = {};
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  for (const link of links) {
    robot.getLinkWorldMatrix(link).decompose(p, q, s);
    poses[link] = { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] };
  }
  return poses;
}

const snapshotWorlds = (robot: ThreeUsdRobot, links = LINKS) =>
  new Map(links.map((l) => [l, [...robot.getLinkWorldMatrix(l).elements]]));

function expectWorldsMatch(
  robot: ThreeUsdRobot,
  snapshot: Map<string, number[]>,
  digits = 9,
): void {
  for (const [link, want] of snapshot) {
    const got = robot.getLinkWorldMatrix(link).elements;
    for (let i = 0; i < 16; i++) expect(got[i]).toBeCloseTo(want[i]!, digits);
  }
}

describe("setLinkTransforms — mode contract", () => {
  it("acceptance 1: setLinkTransforms → setJointValues(q) ≡ setJointValues(q) alone", async () => {
    const a = await load({ worldUp: "Z" });
    const b = await load({ worldUp: "Z" });
    const q0 = { joint1: 0.3, joint2: 0.2 };
    a.setJointValues(q0);
    b.setJointValues(q0);

    a.setLinkTransforms({
      base_link: { position: [5, -1, 2], quaternion: [0.5, 0.5, 0.5, 0.5] },
      link2: { position: [0, 9, 0], quaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
    });
    expect(a.displayMode).toBe("baked");

    const q1 = { joint1: -0.4, joint2: 0.45 };
    a.setJointValues(q1);
    b.setJointValues(q1);
    expect(a.displayMode).toBe("fk");
    expectWorldsMatch(a, snapshotWorlds(b), 12);
  });

  it("setJointValues({}) restores the fk display without changing joint values", async () => {
    const robot = await load({ worldUp: "Z" });
    robot.setJointValues({ joint1: 0.5, joint2: 0.1 });
    const fk = snapshotWorlds(robot);

    robot.setLinkTransforms({ link1: { position: [3, 3, 3], quaternion: [0, 0, 0, 1] } });
    expect(robot.getLinkWorldPosition("link1").x).toBeCloseTo(3, 10);
    expect(robot.getJointValue("joint1")).toBeCloseTo(0.5, 12); // untouched while baked

    robot.setJointValues({});
    expect(robot.displayMode).toBe("fk");
    expectWorldsMatch(robot, fk, 12);
    expect(robot.getJointValue("joint1")).toBeCloseTo(0.5, 12);
  });

  it("setTime is an fk drive and leaves baked mode", async () => {
    const robot = await load({ worldUp: "Z" });
    const fk = snapshotWorlds(robot);
    robot.setLinkTransforms({ link2: { position: [1, 1, 1], quaternion: [0, 0, 0, 1] } });
    robot.setTime(0); // no animated joints, still an fk transition
    expect(robot.displayMode).toBe("fk");
    expectWorldsMatch(robot, fk, 12);
  });

  it("restores a floating-base root and holds unlisted links", async () => {
    const robot = await load({ worldUp: "Z" }, FLOATING);
    expect(robot.getLinkWorldPosition("base").toArray()).toEqual([2, 0, 0]);

    robot.setLinkTransforms({ base: { position: [5, 5, 5], quaternion: [0, 0, 0, 1] } });
    expect(
      robot
        .getLinkWorldPosition("base")
        .toArray()
        .map((v) => +v.toFixed(9)),
    ).toEqual([5, 5, 5]);
    // tip was not in the batch → it keeps its world pose (does not follow base).
    expect(
      robot
        .getLinkWorldPosition("tip")
        .toArray()
        .map((v) => +v.toFixed(9)),
    ).toEqual([2, 0, 1]);

    robot.setJointValues({});
    expect(
      robot
        .getLinkWorldPosition("base")
        .toArray()
        .map((v) => +v.toFixed(9)),
    ).toEqual([2, 0, 0]);
  });
});

describe("setLinkTransforms — round trip (acceptance 2 & 3)", () => {
  for (const worldUp of ["Y", "Z"] as const) {
    it(`worldUp "${worldUp}": FK poses replay verbatim, residuals ≈ 0, projection ≈ q`, async () => {
      const robot = await load({ worldUp });
      robot.setJointValues({ joint1: 0.7, joint2: 0.3 });
      const fk = snapshotWorlds(robot);
      const poses = worldPoses(robot);

      expect(robot.setLinkTransforms(poses)).toBe(3);
      expect(robot.displayMode).toBe("baked");
      expectWorldsMatch(robot, fk, 8);

      const residuals = robot.validateLinkTransforms(poses);
      expect(Object.keys(residuals).sort()).toEqual([
        "/World/joint1",
        "/World/joint2",
        "/World/root_joint",
      ]);
      for (const r of Object.values(residuals)) {
        expect(r.anchorError).toBeCloseTo(0, 6);
        expect(r.axisError).toBeCloseTo(0, 6);
        expect(r.limitExceeded).toBe(false);
      }
      expect(residuals["/World/joint1"]!.q).toBeCloseTo(0.7, 6);
      expect(residuals["/World/joint2"]!.q).toBeCloseTo(0.3, 6);

      const { values } = robot.jointValuesFromLinkTransforms(poses);
      expect(values["/World/joint1"]).toBeCloseTo(0.7, 6);
      expect(values["/World/joint2"]).toBeCloseTo(0.3, 6);
      expect(values["/World/root_joint"]).toBeUndefined(); // fixed: residual only
    });
  }

  it("survives a unit-scaled, user-placed robot (similarity world transform)", async () => {
    const robot = await load({ worldUp: "Y", unitScale: 2 });
    robot.position.set(1, 2, 3);
    robot.rotateY(0.5);
    robot.setJointValues({ joint1: -0.6, joint2: 0.25 });
    const fk = snapshotWorlds(robot);
    const poses = worldPoses(robot);

    robot.setLinkTransforms(poses);
    expectWorldsMatch(robot, fk, 8);
    for (const r of Object.values(robot.validateLinkTransforms(poses))) {
      expect(r.anchorError).toBeCloseTo(0, 6);
      expect(r.axisError).toBeCloseTo(0, 6);
    }
  });

  it('space: "stage" bypasses the scene-world conversion', async () => {
    const q = { joint1: 0.4, joint2: 0.2 };
    // worldUp "keep" on a Z-up meter stage: scene world ≡ stage space.
    const ref = await load({ worldUp: "keep" });
    ref.setJointValues(q);
    const stagePoses = worldPoses(ref);

    const robot = await load({ worldUp: "Y" });
    robot.setLinkTransforms(stagePoses, { space: "stage" });

    const want = await load({ worldUp: "Y" });
    want.setJointValues(q);
    expectWorldsMatch(robot, snapshotWorlds(want), 8);
  });

  it("accepts full prim paths as pose keys", async () => {
    const robot = await load({ worldUp: "Z" });
    expect(
      robot.setLinkTransforms({
        "/World/link1": { position: [0, 0, 4], quaternion: [0, 0, 0, 1] },
      }),
    ).toBe(1);
    expect(robot.getLinkWorldPosition("link1").z).toBeCloseTo(4, 10);
  });
});

describe("setLinkTransforms — partial batches hold world poses (acceptance 4)", () => {
  it("moving only the base leaves unlisted descendants where they are", async () => {
    const robot = await load({ worldUp: "Z" });
    robot.setJointValues({ joint1: 0.5, joint2: 0.2 });
    const fk = snapshotWorlds(robot);

    robot.setLinkTransforms({ base_link: { position: [1, 0, 0], quaternion: [0, 0, 0, 1] } });
    expect(robot.getLinkWorldPosition("base_link").x).toBeCloseTo(1, 10);
    expectWorldsMatch(robot, new Map([...fk].filter(([l]) => l !== "base_link")), 9);

    // The hold persists across later batches too.
    robot.setLinkTransforms({ link1: { position: [0, 1, 1], quaternion: [0, 0, 0, 1] } });
    expect(robot.getLinkWorldPosition("base_link").x).toBeCloseTo(1, 10);
    expect(robot.getLinkWorldPosition("link1").y).toBeCloseTo(1, 10);
  });
});

describe("validateLinkTransforms / jointValuesFromLinkTransforms — diagnostics", () => {
  it("a moved base violates the world-fixed root joint", async () => {
    const robot = await load({ worldUp: "Z" });
    const poses = worldPoses(robot);
    poses.base_link!.position[0] += 0.1;
    const residuals = robot.validateLinkTransforms(poses);
    expect(residuals["/World/root_joint"]!.anchorError).toBeCloseTo(0.1, 9);
  });

  it("scale-mismatched poses show as a constant anchor offset on every joint", async () => {
    const robot = await load({ worldUp: "Z" });
    const poses = worldPoses(robot); // rest: link1 (0,0,1), link2 (0,0,2)
    for (const pose of Object.values(poses)) {
      pose.position = pose.position.map((v) => v * 2) as LinkPose["position"];
    }
    const residuals = robot.validateLinkTransforms(poses);
    expect(residuals["/World/joint1"]!.anchorError).toBeCloseTo(1, 9);
    expect(residuals["/World/joint2"]!.anchorError).toBeCloseTo(1, 9);
  });

  it("an off-axis rotation shows up as axisError, not q", async () => {
    const robot = await load({ worldUp: "Z" });
    const poses = worldPoses(robot, ["link1"]);
    const rx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.2);
    poses.link1!.quaternion = [rx.x, rx.y, rx.z, rx.w]; // joint1 axis is Z
    const residuals = robot.validateLinkTransforms(poses);
    expect(residuals["/World/joint1"]!.axisError).toBeCloseTo(0.2, 9);
    expect(residuals["/World/joint1"]!.anchorError).toBeCloseTo(0, 9);
    expect(residuals["/World/joint1"]!.q).toBeCloseTo(0, 9);
    // The held child now disagrees with its rotated parent — deviation propagates.
    expect(residuals["/World/joint2"]!.anchorError).toBeGreaterThan(0.05);
  });

  it("reports closure error on loop joints dropped from the fk tree", async () => {
    const robot = await load({ worldUp: "Z" }, LOOP);
    expect(robot.getKinematicTree().loopJoints).toEqual(["j3"]);
    const residuals = robot.validateLinkTransforms({});
    expect(residuals["/W/j3"]!.anchorError).toBeCloseTo(2, 9); // b (+1,0,0) vs c (−1,0,0)
    expect(residuals["/W/j1"]!.anchorError).toBeCloseTo(0, 9);
  });

  it("limitExceeded reports faithfully; clampLimits only clamps values", async () => {
    const robot = await load({ worldUp: "Z", clampJointLimits: false });
    robot.setJointValues({ joint1: 2.0, joint2: 0 }); // upper limit is π/2
    const poses = worldPoses(robot);

    const faithful = robot.jointValuesFromLinkTransforms(poses);
    expect(faithful.values["/World/joint1"]).toBeCloseTo(2.0, 6);
    expect(faithful.residuals["/World/joint1"]!.limitExceeded).toBe(true);
    expect(faithful.residuals["/World/joint2"]!.limitExceeded).toBe(false); // exactly at lower 0

    const clamped = robot.jointValuesFromLinkTransforms(poses, { clampLimits: true });
    expect(clamped.values["/World/joint1"]).toBeCloseTo(Math.PI / 2, 9);
    expect(clamped.residuals["/World/joint1"]!.q).toBeCloseTo(2.0, 6); // unclamped diagnosis
  });

  it("previous picks the nearest 2πk branch (prim path or short key)", async () => {
    const robot = await load({ worldUp: "Z", clampJointLimits: false });
    robot.setJointValues({ joint1: 3.0 });
    const poses = worldPoses(robot);

    const plain = robot.jointValuesFromLinkTransforms(poses);
    expect(plain.values["/World/joint1"]).toBeCloseTo(3.0, 6);

    const up = robot.jointValuesFromLinkTransforms(poses, {
      previous: { "/World/joint1": 3.0 + 2 * Math.PI },
    });
    expect(up.values["/World/joint1"]).toBeCloseTo(3.0 + 2 * Math.PI, 6);

    const down = robot.jointValuesFromLinkTransforms(poses, {
      previous: { joint1: 3.0 - 2 * Math.PI },
    });
    expect(down.values["/World/joint1"]).toBeCloseTo(3.0 - 2 * Math.PI, 6);
  });
});

describe("setLinkTransforms — warnings", () => {
  it("warns once per unknown pose key and skips it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const robot = await load({ worldUp: "Z" });
      const pose: LinkPose = { position: [0, 0, 1], quaternion: [0, 0, 0, 1] };
      expect(robot.setLinkTransforms({ nope: pose, link1: pose })).toBe(1);
      robot.setLinkTransforms({ nope: pose });
      const unknown = warn.mock.calls.filter((c) => String(c[0]).includes('unknown link "nope"'));
      expect(unknown).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("debugBakedTransforms warns once per baked session past tolerance", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const robot = await load({ worldUp: "Z", debugBakedTransforms: true });
      const deviating = worldPoses(robot);
      deviating.base_link!.position[0] += 0.005; // 5 mm against the world-fixed root

      const deviationWarns = () =>
        warn.mock.calls.filter((c) => String(c[0]).includes("deviate")).length;

      robot.setLinkTransforms(deviating);
      expect(deviationWarns()).toBe(1);
      robot.setLinkTransforms(deviating); // same session: stays quiet
      expect(deviationWarns()).toBe(1);

      robot.setJointValues({}); // fk re-entry re-arms the warning
      robot.setLinkTransforms(deviating);
      expect(deviationWarns()).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
});
