import { readFileSync } from "node:fs";
import * as THREE from "three";
import { beforeEach, describe, expect, it } from "vitest";
import { TcpTargetHandle } from "../src/helpers.js";
import { type ThreeUsdRobot, ThreeUsdRobotLoader } from "../src/index.js";
import {
  type LinkPick,
  type XrManagerLike,
  XrOriginRig,
  XrRayPicker,
  bindXrGrab,
  xrOriginPlacement,
  xrOriginQuaternion,
} from "../src/xr.js";

const CELL = readFileSync(new URL("../test-assets/pick_cell.usda", import.meta.url), "utf8");
const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

type Dispatchable = { dispatchEvent(event: { type: string; data?: unknown }): void };
const fire = (object: THREE.Object3D, type: string, data?: unknown) =>
  (object as unknown as Dispatchable).dispatchEvent({ type, data });

/** A `renderer.xr` stand-in: plain groups for the controller spaces. */
function mockXr() {
  const controllers: THREE.Group[] = [];
  const grips: THREE.Group[] = [];
  const hands: THREE.Group[] = [];
  const state = { referenceSpace: "" };
  const slot = (list: THREE.Group[], i: number) => {
    list[i] ??= new THREE.Group();
    return list[i];
  };
  const xr = {
    getController: (i: number) => slot(controllers, i),
    getControllerGrip: (i: number) => slot(grips, i),
    getHand: (i: number) => slot(hands, i),
    setReferenceSpaceType: (type: string) => {
      state.referenceSpace = type;
    },
  } as unknown as XrManagerLike;
  return { xr, controllers, grips, hands, state };
}

function worldPosition(object: THREE.Object3D): THREE.Vector3 {
  return object.getWorldPosition(new THREE.Vector3());
}

const near = (a: THREE.Vector3, b: [number, number, number]) =>
  expect(a.distanceTo(new THREE.Vector3(...b))).toBeLessThan(1e-6);

describe("xrOriginQuaternion", () => {
  it("is the identity for Y-up and turns the reference frame up onto +Z for Z-up", () => {
    expect(xrOriginQuaternion("Y").angleTo(new THREE.Quaternion())).toBe(0);
    const q = xrOriginQuaternion("Z");
    near(new THREE.Vector3(0, 1, 0).applyQuaternion(q), [0, 0, 1]);
    near(new THREE.Vector3(0, 0, -1).applyQuaternion(q), [0, 1, 0]);
  });
});

describe("xrOriginPlacement", () => {
  it("stands the head over the stand point facing the target, for a framework-owned origin", () => {
    const head = {
      position: new THREE.Vector3(0.2, 1.6, 0.1),
      quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2),
    };
    const placement = xrOriginPlacement({
      worldUp: "Z",
      standAt: new THREE.Vector3(3, 4, 0),
      lookAt: new THREE.Vector3(3, 10, 0),
      head,
    });
    const origin = new THREE.Group();
    origin.position.copy(placement.position);
    origin.quaternion.copy(placement.quaternion);
    const camera = new THREE.PerspectiveCamera();
    camera.position.copy(head.position);
    camera.quaternion.copy(head.quaternion);
    origin.add(camera);
    origin.updateMatrixWorld(true);
    near(worldPosition(camera), [3, 4, 1.6]);
    near(camera.getWorldDirection(new THREE.Vector3()), [0, 1, 0]);

    const kept = xrOriginPlacement({ standAt: new THREE.Vector3(1, 0, 1), yaw: 0.5 });
    expect(kept.yaw).toBe(0.5);
    near(kept.position, [1, 0, 1]);
  });
});

describe("XrOriginRig", () => {
  let camera: THREE.PerspectiveCamera;
  beforeEach(() => {
    camera = new THREE.PerspectiveCamera();
  });

  it("claims the controller spaces and the reference space", () => {
    const mock = mockXr();
    const rig = new XrOriginRig({ xr: mock.xr }, camera);
    expect(camera.parent).toBe(rig);
    expect(rig.controllers).toEqual(mock.controllers.slice(0, 2));
    expect(rig.grips).toEqual(mock.grips.slice(0, 2));
    expect(rig.hands).toEqual([]);
    expect(mock.controllers[0]!.parent).toBe(rig);
    expect(mock.state.referenceSpace).toBe("local-floor");

    const withHands = new XrOriginRig({ xr: mockXr().xr }, new THREE.PerspectiveCamera(), {
      controllers: 1,
      hands: true,
      referenceSpace: "local",
    });
    expect(withHands.controllers).toHaveLength(1);
    expect(withHands.hands).toHaveLength(1);
  });

  it("learns handedness from the connected event", () => {
    const mock = mockXr();
    const rig = new XrOriginRig({ xr: mock.xr }, camera);
    expect(rig.controller("left")).toBeUndefined();
    fire(mock.controllers[1]!, "connected", { handedness: "left" });
    fire(mock.controllers[0]!, "connected", { handedness: "right" });
    expect(rig.controller("left")).toBe(mock.controllers[1]);
    expect(rig.grip("left")).toBe(mock.grips[1]);
    expect(rig.handednessOf(mock.grips[0]!)).toBe("right");
    fire(mock.controllers[1]!, "disconnected", {});
    expect(rig.controller("left")).toBeUndefined();
    rig.dispose();
    fire(mock.controllers[0]!, "disconnected", {});
    expect(rig.handednessOf(mock.controllers[0]!)).toBeUndefined();
  });

  it("recenters the player's feet and heading (Y-up)", () => {
    const rig = new XrOriginRig({ xr: mockXr().xr }, camera);
    // The headset stands 0.2 m right / 0.1 m back of the reference origin, looking along local +X.
    camera.position.set(0.2, 1.6, 0.1);
    camera.rotation.y = -Math.PI / 2;
    rig.recenter(new THREE.Vector3(5, 0, 5), new THREE.Vector3(5, 0, 0));
    const head = worldPosition(camera);
    near(head, [5, 1.6, 5]);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    near(forward, [0, 0, -1]);
  });

  it("recenters in a Z-up world: the floor is z = 0, heading is in the xy plane", () => {
    const rig = new XrOriginRig({ xr: mockXr().xr }, camera, { worldUp: "Z" });
    camera.position.set(0, 1.6, 0);
    rig.recenter(new THREE.Vector3(3, 4, 0), new THREE.Vector3(3, 10, 0));
    near(worldPosition(camera), [3, 4, 1.6]);
    near(camera.getWorldDirection(new THREE.Vector3()), [0, 1, 0]);
    near(rig.upVector(), [0, 0, 1]);
  });

  it("teleports keeping the heading, scales the player, resets", () => {
    const rig = new XrOriginRig({ xr: mockXr().xr }, camera);
    camera.position.set(0.3, 1.6, -0.2);
    rig.recenter(new THREE.Vector3(1, 0, 1), new THREE.Vector3(1, 0, -5));
    const yaw = rig.yaw;
    rig.teleport(new THREE.Vector3(-2, 0, 4));
    expect(rig.yaw).toBe(yaw);
    near(worldPosition(camera), [-2, 1.6, 4]);

    rig.playerScale = 4;
    rig.teleport(new THREE.Vector3(0, 0, 0));
    near(worldPosition(camera), [0, 6.4, 0]); // feet stay on the floor at the stand point
    expect(rig.scale.x).toBe(4);

    rig.reset();
    expect(rig.playerScale).toBe(1);
    expect(rig.yaw).toBe(0);
    near(rig.position, [0, 0, 0]);
  });

  it("lifts a 'local' reference space by the floor offset and maps reference poses to world", () => {
    const rig = new XrOriginRig({ xr: mockXr().xr }, camera, {
      referenceSpace: "local",
      floorOffset: 1.5,
    });
    camera.position.set(0, 0, 0); // 'local': the origin is at the head
    rig.teleport(new THREE.Vector3(2, 0, 2));
    near(worldPosition(camera), [2, 1.5, 2]);
    const m = rig.toWorld(new THREE.Matrix4().makeTranslation(1, 0, 0));
    near(new THREE.Vector3().setFromMatrixPosition(m), [3, 1.5, 2]);
  });
});

describe("XrRayPicker", () => {
  let robot: ThreeUsdRobot;
  let scene: THREE.Scene;
  let controller: THREE.Group;
  beforeEach(async () => {
    robot = await new ThreeUsdRobotLoader({ loadSceneGeometry: true }).parse(CELL);
    scene = new THREE.Scene();
    controller = new THREE.Group();
    controller.rotation.x = -Math.PI / 2; // −Z → −Y: pointing down
    scene.add(robot, controller);
    // The picker reads the meshes' world matrices as the last render left them.
    scene.updateMatrixWorld(true);
  });

  it("reports hover changes and turns the select event into a selection", () => {
    const picker = new XrRayPicker(controller, [robot]);
    const hovers: (LinkPick | null)[] = [];
    const selects: LinkPick[] = [];
    picker.addEventListener("hover", ({ hit }) => hovers.push(hit));
    picker.addEventListener("select", ({ hit }) => selects.push(hit));

    controller.position.set(2, 5, 0);
    picker.update();
    picker.update(); // same link: no second event
    expect(hovers.map((h) => h?.link.primPath)).toEqual(["/World/tool"]);
    expect(picker.current?.distance).toBeCloseTo(4.7, 2);

    fire(controller, "select");
    expect(selects.map((s) => s.link.primPath)).toEqual(["/World/tool"]);

    controller.position.set(0, 5, 0);
    picker.update();
    controller.position.set(9, 5, 0);
    picker.update();
    expect(hovers.map((h) => h?.link.primPath ?? null)).toEqual([
      "/World/tool",
      "/World/base",
      null,
    ]);
    fire(controller, "select");
    expect(selects).toHaveLength(1); // nothing under the ray

    picker.dispose();
    controller.position.set(2, 5, 0);
    picker.update();
    fire(controller, "select");
    expect(selects).toHaveLength(1);
  });

  it("takes a target function, a ray length, and the picking options", () => {
    const robots: ThreeUsdRobot[] = [];
    const picker = new XrRayPicker(controller, () => robots, {
      maxDistance: 2,
      selectEvent: "selectstart",
      occludeScenery: false,
    });
    controller.position.set(2, 5, 0);
    picker.update();
    expect(picker.current).toBeNull(); // no robots yet
    robots.push(robot);
    picker.update();
    expect(picker.current).toBeNull(); // 4.7 m away, ray length 2
    picker.maxDistance = 10;
    picker.update();
    expect(picker.current?.link.primPath).toBe("/World/tool");

    const selects: LinkPick[] = [];
    picker.addEventListener("select", ({ hit }) => selects.push(hit));
    fire(controller, "select");
    fire(controller, "selectstart");
    expect(selects).toHaveLength(1);

    // Scenery no longer blocks: through the wall at x = −2 onto the base.
    controller.rotation.set(0, -Math.PI / 2, 0); // −Z → +X
    controller.position.set(-5, 0, 0);
    picker.update();
    expect(picker.current?.link.primPath).toBe("/World/base");
  });
});

describe("bindXrGrab", () => {
  let robot: ThreeUsdRobot;
  let scene: THREE.Scene;
  let handle: TcpTargetHandle;
  let grip: THREE.Group;
  beforeEach(async () => {
    robot = await new ThreeUsdRobotLoader({ worldUp: "keep" }).parse(ARM);
    scene = new THREE.Scene();
    handle = new TcpTargetHandle(robot, "link2");
    grip = new THREE.Group();
    scene.add(robot, handle, grip);
    handle.update();
    grip.position.copy(worldPosition(handle));
  });

  it("grabs on squeeze, follows the grip, releases on squeeze end", () => {
    const phases: string[] = [];
    handle.addEventListener("grabstart", () => phases.push("grabstart"));
    handle.addEventListener("grabend", () => phases.push("grabend"));
    const unbind = bindXrGrab(handle, grip);
    const start = worldPosition(handle);

    fire(grip, "squeezestart");
    expect(handle.grabbed).toBe(true);
    grip.position.x += 0.1;
    handle.update();
    near(worldPosition(handle), [start.x + 0.1, start.y, start.z]);

    fire(grip, "squeezeend");
    expect(handle.grabbed).toBe(false);
    fire(grip, "squeezeend"); // idempotent
    expect(phases).toEqual(["grabstart", "grabend"]);

    unbind();
    fire(grip, "squeezestart");
    expect(handle.grabbed).toBe(false);
  });

  it("honours custom events, the distance gate and the predicate, and releases on unbind", () => {
    const unbindSelect = bindXrGrab(handle, grip, { start: "selectstart", end: "selectend" });
    fire(grip, "squeezestart");
    expect(handle.grabbed).toBe(false);
    fire(grip, "selectstart");
    expect(handle.grabbed).toBe(true);
    fire(grip, "selectend");
    expect(handle.grabbed).toBe(false);
    unbindSelect();

    const unbindNear = bindXrGrab(handle, grip, { maxDistance: 0.05 });
    grip.position.x += 1;
    fire(grip, "squeezestart");
    expect(handle.grabbed).toBe(false); // too far
    grip.position.x -= 1;
    fire(grip, "squeezestart");
    expect(handle.grabbed).toBe(true);
    unbindNear(); // releases the grab in progress
    expect(handle.grabbed).toBe(false);

    let allowed = false;
    const unbindWhen = bindXrGrab(handle, grip, { when: () => allowed });
    fire(grip, "squeezestart");
    expect(handle.grabbed).toBe(false);
    allowed = true;
    fire(grip, "squeezestart");
    expect(handle.grabbed).toBe(true);
    unbindWhen();
  });
});
