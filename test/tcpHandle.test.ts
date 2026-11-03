import { readFileSync } from "node:fs";
import * as THREE from "three";
import { beforeEach, describe, expect, it } from "vitest";
import { type TcpTargetEvent, TcpTargetHandle } from "../src/helpers.js";
import { type ThreeUsdRobot, ThreeUsdRobotLoader } from "../src/index.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

const TOOL = "link2";
let scene: THREE.Scene;
let robot: ThreeUsdRobot;

beforeEach(async () => {
  // `worldUp: "keep"` leaves the robot frame equal to the world frame.
  robot = await new ThreeUsdRobotLoader({ worldUp: "keep" }).parse(ARM);
  scene = new THREE.Scene();
  scene.add(robot);
});

function worldOf(object: THREE.Object3D): {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
} {
  object.updateWorldMatrix(true, false);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  object.matrixWorld.decompose(position, quaternion, new THREE.Vector3());
  return { position, quaternion };
}

function linkWorld(): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  robot.getLinkWorldMatrix(TOOL).decompose(position, quaternion, new THREE.Vector3());
  return { position, quaternion };
}

function expectVec(actual: THREE.Vector3, expected: THREE.Vector3 | [number, number, number]) {
  const e = Array.isArray(expected) ? new THREE.Vector3(...expected) : expected;
  expect(actual.distanceTo(e)).toBeLessThan(1e-6);
}

function record(handle: TcpTargetHandle): TcpTargetEvent[] {
  const events: TcpTargetEvent[] = [];
  for (const type of ["grabstart", "change", "grabend"] as const) {
    handle.addEventListener(type, (e) => events.push({ ...e }));
  }
  return events;
}

describe("TcpTargetHandle — follow", () => {
  it("sits on the live tool link and tracks joints and the robot placement", () => {
    const handle = new TcpTargetHandle(robot, TOOL);
    scene.add(handle);
    expect(handle.link).toBe("/World/link2");
    handle.update();
    let link = linkWorld();
    expectVec(worldOf(handle).position, link.position);
    expect(worldOf(handle).quaternion.angleTo(link.quaternion)).toBeLessThan(1e-6);

    robot.setJointValue("joint1", 0.7);
    robot.setJointValue("joint2", 0.3);
    robot.position.set(1, 2, 3);
    handle.update();
    link = linkWorld();
    expectVec(worldOf(handle).position, link.position);
    expect(worldOf(handle).quaternion.angleTo(link.quaternion)).toBeLessThan(1e-6);
  });

  it("updates itself from the scene's matrix update, and emits nothing while following", () => {
    const handle = new TcpTargetHandle(robot, TOOL);
    scene.add(handle);
    const events = record(handle);
    robot.setJointValue("joint2", 0.1); // prismatic: moves link2 along x
    scene.updateMatrixWorld(true);
    expectVec(handle.position, linkWorld().position);
    expect(events).toHaveLength(0);

    handle.autoUpdate = false;
    robot.setJointValue("joint2", 0.4);
    scene.updateMatrixWorld(true);
    expect(handle.position.distanceTo(linkWorld().position)).toBeGreaterThan(0.1);
  });

  it("rejects unknown links and accepts link keys as well as prim paths", () => {
    expect(() => new TcpTargetHandle(robot, "nope")).toThrow(/unknown link/);
    expect(new TcpTargetHandle(robot, "/World/link2").link).toBe("/World/link2");
  });
});

describe("TcpTargetHandle — grab", () => {
  it("keeps its offset to the source and reports moves, with a grabstart/change/grabend sequence", () => {
    const handle = new TcpTargetHandle(robot, TOOL);
    scene.add(handle);
    handle.update();
    const events = record(handle);
    const start = worldOf(handle).position.clone();

    const grip = new THREE.Object3D();
    grip.position.set(0.5, 0.5, 0.5);
    grip.rotation.set(0.3, 0.2, 0.1);
    scene.add(grip);
    handle.grab(grip);
    expect(handle.grabbed).toBe(true);
    handle.update();
    expectVec(worldOf(handle).position, start); // nothing moved yet
    expect(events.map((e) => e.phase)).toEqual(["grabstart"]);

    grip.position.add(new THREE.Vector3(0.1, -0.2, 0.3));
    handle.update();
    expectVec(worldOf(handle).position, start.clone().add(new THREE.Vector3(0.1, -0.2, 0.3)));
    expect(events.map((e) => e.phase)).toEqual(["grabstart", "move"]);
    expect(events[1]!.space).toBe("world");
    expect(events[1]!.link).toBe("/World/link2");
    expect(
      new THREE.Vector3(...events[1]!.pose.position).distanceTo(worldOf(handle).position),
    ).toBeLessThan(1e-9);

    // The joints moving underneath do not matter while grabbed.
    robot.setJointValue("joint1", 1.2);
    handle.update();
    expect(events).toHaveLength(2);

    handle.release();
    expect(handle.grabbed).toBe(false);
    expect(events.map((e) => e.phase)).toEqual(["grabstart", "move", "grabend"]);
    handle.update(); // follow resumes: back on the (moved) link
    expectVec(worldOf(handle).position, linkWorld().position);
  });

  it("rotates about the source like a held object", () => {
    const handle = new TcpTargetHandle(robot, TOOL);
    scene.add(handle);
    handle.update();
    const grip = new THREE.Object3D();
    grip.position.copy(worldOf(handle).position).add(new THREE.Vector3(0, 0, 1));
    scene.add(grip);
    handle.grab(grip);
    grip.rotateY(Math.PI / 2);
    handle.update();
    // The handle sat 1 m along −Z from the grip; after a +90° yaw it sits along −X.
    expectVec(worldOf(handle).position, grip.position.clone().add(new THREE.Vector3(-1, 0, 0)));
    expect(worldOf(handle).quaternion.angleTo(grip.quaternion)).toBeLessThan(1e-6);
  });

  it("reads its own transform when grabbed without a source (gizmo-driven)", () => {
    const handle = new TcpTargetHandle(robot, TOOL);
    scene.add(handle);
    handle.update();
    const events = record(handle);
    handle.grab();
    handle.position.x += 0.25;
    handle.update();
    expect(events.map((e) => e.phase)).toEqual(["grabstart", "move"]);
    expect(events[1]!.pose.position[0]).toBeCloseTo(linkWorld().position.x + 0.25, 9);
    handle.update();
    expect(events).toHaveLength(2); // no move, no event
  });
});

describe("TcpTargetHandle — constraints & smoothing", () => {
  function grabbed(options: ConstructorParameters<typeof TcpTargetHandle>[2]) {
    const handle = new TcpTargetHandle(robot, TOOL, options);
    scene.add(handle);
    handle.update();
    const grip = new THREE.Object3D();
    grip.position.copy(worldOf(handle).position);
    scene.add(grip);
    handle.grab(grip);
    return { handle, grip, start: worldOf(handle) };
  }

  it("locks position / rotation", () => {
    const { handle, grip, start } = grabbed({
      constraints: { lockPosition: true, lockRotation: true },
    });
    grip.position.add(new THREE.Vector3(1, 1, 1));
    grip.rotateX(0.5);
    handle.update();
    expectVec(worldOf(handle).position, start.position);
    expect(worldOf(handle).quaternion.angleTo(start.quaternion)).toBeLessThan(1e-6);
  });

  it("restricts translation to the allowed robot axes", () => {
    const { handle, grip, start } = grabbed({ constraints: { translateAxes: ["x"] } });
    grip.position.add(new THREE.Vector3(0.2, 0.3, 0.4));
    handle.update();
    expectVec(worldOf(handle).position, start.position.clone().add(new THREE.Vector3(0.2, 0, 0)));
  });

  it("snaps positions to a grid and rotations to an angle step", () => {
    const { handle, grip, start } = grabbed({
      constraints: { positionSnap: 0.1, angleSnap: Math.PI / 4 },
    });
    grip.position.add(new THREE.Vector3(0.26, 0.04, -0.17));
    grip.rotateZ(THREE.MathUtils.degToRad(50));
    handle.update();
    const p = worldOf(handle).position;
    for (const v of [p.x, p.y, p.z])
      expect(Math.abs(v / 0.1 - Math.round(v / 0.1))).toBeLessThan(1e-6);
    expectVec(p, start.position.clone().add(new THREE.Vector3(0.3, 0, -0.2)));
    const expected = start.quaternion
      .clone()
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4));
    expect(worldOf(handle).quaternion.angleTo(expected)).toBeLessThan(1e-6);
  });

  it("applies constraints in the robot frame", () => {
    robot.position.set(1, 0, 0);
    robot.rotateY(Math.PI / 2); // robot +x is world −z
    const { handle, grip, start } = grabbed({ constraints: { translateAxes: ["x"] } });
    grip.position.add(new THREE.Vector3(0.5, 0.5, -0.5));
    handle.update();
    expectVec(worldOf(handle).position, start.position.clone().add(new THREE.Vector3(0, 0, -0.5)));
  });

  it("damps grabbed motion with the exponential filter", () => {
    const { handle, grip, start } = grabbed({ smoothing: 0.5 });
    grip.position.add(new THREE.Vector3(1, 0, 0));
    handle.update();
    expectVec(worldOf(handle).position, start.position.clone().add(new THREE.Vector3(0.5, 0, 0)));
    handle.update();
    expectVec(worldOf(handle).position, start.position.clone().add(new THREE.Vector3(0.75, 0, 0)));
  });
});

describe("TcpTargetHandle — poses, status, lifecycle", () => {
  it("reports and accepts poses in the robot frame (placement without scale)", () => {
    robot.position.set(1, 0, 0);
    robot.rotateY(Math.PI / 2);
    robot.scale.setScalar(2);
    const handle = new TcpTargetHandle(robot, TOOL, { space: "robot" });
    scene.add(handle);
    handle.setPose({ position: [1, 0, 0], quaternion: [0, 0, 0, 1] }); // 1 m along robot x
    expect(handle.follow).toBe(false);
    expectVec(worldOf(handle).position, [1, 0, -1]);
    const back = handle.getPose("robot");
    expect(back.position[0]).toBeCloseTo(1, 9);
    expect(back.position[2]).toBeCloseTo(0, 9);
    const world = handle.getPose("world");
    expect(world.position[2]).toBeCloseTo(-1, 9);
  });

  it("emits a set change and stays put when following is off", () => {
    const handle = new TcpTargetHandle(robot, TOOL);
    scene.add(handle);
    const events = record(handle);
    handle.setPose({ position: [5, 6, 7], quaternion: [0, 0, 0, 1] });
    expect(events.map((e) => e.phase)).toEqual(["set"]);
    handle.update();
    expectVec(worldOf(handle).position, [5, 6, 7]);
    handle.follow = true;
    handle.update();
    expectVec(worldOf(handle).position, linkWorld().position);
  });

  it("colours the default gizmo by status and keeps a custom gizmo untouched", () => {
    const handle = new TcpTargetHandle(robot, TOOL);
    const sphere = handle.gizmo!.getObjectByName("sphere") as THREE.Mesh;
    const color = () => (sphere.material as THREE.MeshBasicMaterial).color.getHex();
    expect(color()).toBe(0x4da3ff);
    handle.setStatus({ reachable: false });
    expect(color()).toBe(0xff4444);
    handle.setStatus({ colliding: true });
    expect(color()).toBe(0xff8800);
    handle.setStatus({ reachable: true, colliding: false });
    expect(color()).toBe(0x4da3ff);
    expect(handle.status).toEqual({ reachable: true, colliding: false });

    const custom = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x123456 }),
    );
    const own = new TcpTargetHandle(robot, TOOL, { gizmo: custom });
    own.setStatus({ reachable: false });
    expect((custom.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x123456);
    expect(new TcpTargetHandle(robot, TOOL, { gizmo: null }).gizmo).toBeNull();
  });

  it("disposes: releases the grab and leaves the scene", () => {
    const handle = new TcpTargetHandle(robot, TOOL);
    scene.add(handle);
    const events = record(handle);
    handle.grab();
    handle.dispose();
    expect(handle.parent).toBeNull();
    expect(handle.grabbed).toBe(false);
    expect(events.map((e) => e.phase)).toEqual(["grabstart", "grabend"]);
  });
});
