/**
 * A target-pose handle for a tool link: the thing a user drags (with a mouse
 * gizmo or an XR controller) to say "put the tool here". Its whole job is to
 * turn that intent into `change` events carrying a {@link LinkPose} — it
 * never solves IK or writes joint values; the application feeds the pose to
 * its own solver and drives the robot, exactly as it would from any other UI.
 *
 * While nobody holds it the handle follows the robot's live tool link, so an
 * unreachable target visibly snaps back to where the arm really is once
 * released. Grabbing with a `source` object keeps the handle's offset to that
 * object (an XR grip space, a hand); grabbing without one declares that
 * something else moves the handle's own transform (a `TransformControls`).
 * Constraints — axis locks, translation axes, position / angle snapping — are
 * expressed in the robot's frame and applied relative to the pose at grab
 * start; an exponential filter damps hand jitter.
 */

import * as THREE from "three";
import type { LinkPose } from "../three/ThreeUsdRobot.js";
import type { ThreeUsdRobot } from "../three/ThreeUsdRobot.js";

/**
 * Frame of the poses in events and accessors. `"world"` is the scene world;
 * `"robot"` is the robot object's placement with its uniform scale removed —
 * metres, relative to the robot base, in the scene's up convention.
 */
export type HandleSpace = "world" | "robot";

export type TcpConstraints = {
  /** Keep the position where it was at grab start. */
  lockPosition?: boolean;
  /** Keep the orientation where it was at grab start. */
  lockRotation?: boolean;
  /** Robot-frame axes the handle may translate along (default: all). */
  translateAxes?: ("x" | "y" | "z")[];
  /** Snap the robot-frame position to this grid (metres). */
  positionSnap?: number;
  /** Snap the rotation since grab start to multiples of this angle (radians). */
  angleSnap?: number;
};

export type TcpTargetStatus = {
  /** Whether the application's solver reaches the target (colours the gizmo red when `false`). */
  reachable?: boolean;
  /** Whether the target pose collides (colours the gizmo orange). */
  colliding?: boolean;
};

export type TcpTargetHandleOptions = {
  /**
   * What to show at the target: default a small sphere with RGB axes;
   * `null` for no gizmo (an application-drawn one, or nothing).
   */
  gizmo?: THREE.Object3D | null;
  /** Axis length of the default gizmo (metres, default `0.08`). */
  size?: number;
  /** Track the robot's live link while not grabbed (default `true`). */
  follow?: boolean;
  constraints?: TcpConstraints;
  /** Exponential smoothing of grabbed motion, `0` (none, default) … `<1`. */
  smoothing?: number;
  /** Frame of the poses in events (default `"world"`). */
  space?: HandleSpace;
  /**
   * Run {@link TcpTargetHandle.update} from `updateMatrixWorld`, i.e. on every
   * render (default `true`). Switch off to call `update()` yourself at a
   * chosen point of your frame.
   */
  autoUpdate?: boolean;
};

export type TcpTargetPhase = "grabstart" | "move" | "grabend" | "set";

export type TcpTargetEvent = {
  phase: TcpTargetPhase;
  /** Prim path of the tool link. */
  link: string;
  pose: LinkPose;
  space: HandleSpace;
};

export type TcpTargetHandleEventMap = {
  grabstart: TcpTargetEvent;
  /** The target pose changed: `phase` is `"move"` while grabbed, `"set"` from {@link TcpTargetHandle.setPose}. */
  change: TcpTargetEvent;
  grabend: TcpTargetEvent;
};

const DEFAULT_COLOR = 0x4da3ff;
const UNREACHABLE_COLOR = 0xff4444;
const COLLIDING_COLOR = 0xff8800;
const POSITION_EPSILON = 1e-6;
const ANGLE_EPSILON = 1e-6;

export class TcpTargetHandle extends THREE.Object3D<
  THREE.Object3DEventMap & TcpTargetHandleEventMap
> {
  readonly isTcpTargetHandle = true;
  readonly robot: ThreeUsdRobot;
  /** Prim path of the tool link (any link key is accepted by the constructor). */
  readonly link: string;
  /** Frame of the poses in events. */
  readonly space: HandleSpace;
  /** Track the robot's live link while not grabbed. Cleared by {@link setPose}. */
  follow: boolean;
  constraints: TcpConstraints;
  smoothing: number;
  autoUpdate: boolean;
  /** The gizmo shown at the target (the default one unless you passed your own). */
  readonly gizmo: THREE.Object3D | null;

  private readonly ownsGizmo: boolean;
  private _status: TcpTargetStatus = {};
  private _grabbed = false;
  private source: THREE.Object3D | null = null;
  private readonly offset = new THREE.Matrix4();
  private readonly grabStart = new THREE.Matrix4();
  private readonly lastWorld = new THREE.Matrix4();
  private hasLast = false;

  constructor(robot: ThreeUsdRobot, link: string, options: TcpTargetHandleOptions = {}) {
    super();
    const target = robot.getLinkObject(link);
    if (!target) throw new Error(`unknown link "${link}"`);
    this.robot = robot;
    this.link = target.primPath;
    this.name = `${target.linkName}:tcpTarget`;
    this.space = options.space ?? "world";
    this.follow = options.follow ?? true;
    this.constraints = options.constraints ?? {};
    this.smoothing = options.smoothing ?? 0;
    this.autoUpdate = options.autoUpdate ?? true;
    this.ownsGizmo = options.gizmo === undefined;
    this.gizmo =
      options.gizmo === undefined ? createDefaultGizmo(options.size ?? 0.08) : options.gizmo;
    if (this.gizmo) this.add(this.gizmo);
  }

  get grabbed(): boolean {
    return this._grabbed;
  }

  get status(): Readonly<TcpTargetStatus> {
    return this._status;
  }

  /**
   * Start a grab. With `source`, the handle keeps its current offset to that
   * object and follows it (an XR grip, a hand joint). Without, the handle's
   * own `position` / `quaternion` are driven by someone else (a
   * `TransformControls`) and only read here.
   */
  grab(source?: THREE.Object3D): void {
    this.updateWorldMatrix(true, false);
    this.grabStart.copy(this.matrixWorld);
    this.lastWorld.copy(this.matrixWorld);
    this.hasLast = true;
    if (source) {
      source.updateWorldMatrix(true, false);
      this.offset.copy(source.matrixWorld).invert().multiply(this.matrixWorld);
    }
    this.source = source ?? null;
    this._grabbed = true;
    this.dispatchEvent({ type: "grabstart", ...this.describe("grabstart") });
  }

  /** End the grab — the commit point for a taught pose. With `follow`, the handle snaps back to the live link next update. */
  release(): void {
    if (!this._grabbed) return;
    this._grabbed = false;
    this.source = null;
    this.dispatchEvent({ type: "grabend", ...this.describe("grabend") });
  }

  /** Place the handle programmatically (clears `follow`) and report it as a `"set"` change. */
  setPose(pose: LinkPose, space: HandleSpace = this.space): void {
    const world = poseToMatrix(pose);
    if (space === "robot") world.premultiply(this.robotFrame());
    this.follow = false;
    this.applyWorld(world);
    this.dispatchEvent({ type: "change", ...this.describe("set") });
  }

  /** The current target pose. */
  getPose(space: HandleSpace = this.space): LinkPose {
    this.updateWorldMatrix(true, false);
    const m = this.matrixWorld.clone();
    if (space === "robot") m.premultiply(this.robotFrame().invert());
    return matrixToPose(m);
  }

  /** Reflect the application's verdict on the target (colours the default gizmo). */
  setStatus(status: TcpTargetStatus): void {
    this._status = { ...this._status, ...status };
    this.userData.status = this._status;
    if (!this.ownsGizmo || !this.gizmo) return;
    const color = this._status.colliding
      ? COLLIDING_COLOR
      : this._status.reachable === false
        ? UNREACHABLE_COLOR
        : DEFAULT_COLOR;
    const sphere = this.gizmo.getObjectByName("sphere") as THREE.Mesh | undefined;
    (sphere?.material as THREE.MeshBasicMaterial | undefined)?.color.set(color);
  }

  /**
   * Advance one step: follow the link or the grab source, apply constraints
   * and smoothing, and emit `change` when the target moved. Runs on every
   * render unless `autoUpdate` is off.
   */
  update(): void {
    if (this._grabbed) {
      let world: THREE.Matrix4;
      if (this.source) {
        this.source.updateWorldMatrix(true, false);
        world = this.source.matrixWorld.clone().multiply(this.offset);
      } else {
        this.updateWorldMatrix(true, false);
        world = this.matrixWorld.clone();
      }
      world = this.constrain(world);
      if (this.smoothing > 0 && this.hasLast) world = this.smooth(world);
      const moved = this.applyWorld(world);
      if (moved) this.dispatchEvent({ type: "change", ...this.describe("move") });
    } else if (this.follow) {
      this.applyWorld(rigid(this.robot.getLinkWorldMatrix(this.link)));
    }
  }

  override updateMatrixWorld(force?: boolean): void {
    if (this.autoUpdate) this.update();
    super.updateMatrixWorld(force);
  }

  /** Release, drop the default gizmo's GPU resources and detach from the scene. */
  override dispose(): void {
    this.release();
    if (this.ownsGizmo && this.gizmo) {
      this.gizmo.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const material = mesh.material as THREE.Material | undefined;
        material?.dispose();
      });
    }
    this.removeFromParent();
    super.dispose?.(); // r186+ fires the `dispose` event; older releases have no base method
  }

  // -- internals -------------------------------------------------------------

  /** The robot's rigid placement (scale stripped): the `"robot"` frame. */
  private robotFrame(): THREE.Matrix4 {
    this.robot.updateWorldMatrix(true, false);
    return rigid(this.robot.matrixWorld);
  }

  /**
   * Write a world matrix into the local transform. Returns whether the target
   * moved since the last applied pose — compared against that pose, not the
   * current transform, since a gizmo-driven handle already carries the new
   * transform when `update()` reads it.
   */
  private applyWorld(world: THREE.Matrix4): boolean {
    const changed = !this.hasLast || differs(world, this.lastWorld);
    const local = world.clone();
    if (this.parent) {
      this.parent.updateWorldMatrix(true, false);
      local.premultiply(this.parent.matrixWorld.clone().invert());
    }
    local.decompose(this.position, this.quaternion, new THREE.Vector3());
    this.updateWorldMatrix(false, false);
    this.lastWorld.copy(world);
    this.hasLast = true;
    return changed;
  }

  private constrain(world: THREE.Matrix4): THREE.Matrix4 {
    const c = this.constraints;
    if (
      !c.lockPosition &&
      !c.lockRotation &&
      !c.translateAxes &&
      !(c.positionSnap && c.positionSnap > 0) &&
      !(c.angleSnap && c.angleSnap > 0)
    ) {
      return world;
    }
    const frame = this.robotFrame();
    const inverse = frame.clone().invert();
    const start = this.grabStart.clone().premultiply(inverse);
    const current = world.clone().premultiply(inverse);
    const startPosition = new THREE.Vector3();
    const startRotation = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    start.decompose(startPosition, startRotation, new THREE.Vector3());
    current.decompose(position, rotation, new THREE.Vector3());

    if (c.lockPosition) {
      position.copy(startPosition);
    } else {
      if (c.translateAxes) {
        const delta = position.clone().sub(startPosition);
        for (const axis of ["x", "y", "z"] as const) {
          if (!c.translateAxes.includes(axis)) delta[axis] = 0;
        }
        position.copy(startPosition).add(delta);
      }
      if (c.positionSnap && c.positionSnap > 0) {
        const s = c.positionSnap;
        position.set(
          Math.round(position.x / s) * s,
          Math.round(position.y / s) * s,
          Math.round(position.z / s) * s,
        );
      }
    }

    if (c.lockRotation) {
      rotation.copy(startRotation);
    } else if (c.angleSnap && c.angleSnap > 0) {
      const delta = startRotation.clone().invert().multiply(rotation).normalize();
      if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
      const axis = new THREE.Vector3(delta.x, delta.y, delta.z);
      const sin = axis.length();
      const angle = 2 * Math.atan2(sin, delta.w);
      const snapped = Math.round(angle / c.angleSnap) * c.angleSnap;
      if (sin > 1e-9) {
        rotation
          .copy(startRotation)
          .multiply(new THREE.Quaternion().setFromAxisAngle(axis.divideScalar(sin), snapped));
      } else {
        rotation.copy(startRotation);
      }
    }

    return new THREE.Matrix4()
      .compose(position, rotation, new THREE.Vector3(1, 1, 1))
      .premultiply(frame);
  }

  private smooth(world: THREE.Matrix4): THREE.Matrix4 {
    const t = 1 - THREE.MathUtils.clamp(this.smoothing, 0, 0.999);
    const fromPosition = new THREE.Vector3();
    const fromRotation = new THREE.Quaternion();
    const toPosition = new THREE.Vector3();
    const toRotation = new THREE.Quaternion();
    this.lastWorld.decompose(fromPosition, fromRotation, new THREE.Vector3());
    world.decompose(toPosition, toRotation, new THREE.Vector3());
    return new THREE.Matrix4().compose(
      fromPosition.lerp(toPosition, t),
      fromRotation.slerp(toRotation, t),
      new THREE.Vector3(1, 1, 1),
    );
  }

  private describe(phase: TcpTargetPhase): Omit<TcpTargetEvent, never> {
    return { phase, link: this.link, pose: this.getPose(this.space), space: this.space };
  }
}

/** Whether two rigid matrices differ beyond the position / angle epsilons. */
function differs(a: THREE.Matrix4, b: THREE.Matrix4): boolean {
  const pa = new THREE.Vector3();
  const qa = new THREE.Quaternion();
  const pb = new THREE.Vector3();
  const qb = new THREE.Quaternion();
  a.decompose(pa, qa, new THREE.Vector3());
  b.decompose(pb, qb, new THREE.Vector3());
  return pa.distanceTo(pb) > POSITION_EPSILON || qa.angleTo(qb) > ANGLE_EPSILON;
}

/** The rigid part of a matrix: translation and rotation, unit scale. */
function rigid(m: THREE.Matrix4): THREE.Matrix4 {
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  m.decompose(position, rotation, new THREE.Vector3());
  return new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1));
}

function poseToMatrix(pose: LinkPose): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...pose.position),
    new THREE.Quaternion(...pose.quaternion),
    new THREE.Vector3(1, 1, 1),
  );
}

function matrixToPose(m: THREE.Matrix4): LinkPose {
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  m.decompose(position, rotation, new THREE.Vector3());
  return {
    position: [position.x, position.y, position.z],
    quaternion: [rotation.x, rotation.y, rotation.z, rotation.w],
  };
}

/** A small sphere with RGB axes, drawn on top of the scene. */
function createDefaultGizmo(size: number): THREE.Object3D {
  const gizmo = new THREE.Group();
  gizmo.name = "tcpTargetGizmo";
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(size * 0.18, 20, 14),
    new THREE.MeshBasicMaterial({
      color: DEFAULT_COLOR,
      depthTest: false,
      transparent: true,
      opacity: 0.9,
    }),
  );
  sphere.name = "sphere";
  sphere.renderOrder = 10;
  gizmo.add(sphere);
  const axes: [THREE.Vector3, number][] = [
    [new THREE.Vector3(1, 0, 0), 0xff4040],
    [new THREE.Vector3(0, 1, 0), 0x40ff40],
    [new THREE.Vector3(0, 0, 1), 0x4080ff],
  ];
  for (const [direction, color] of axes) {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      direction.multiplyScalar(size),
    ]);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, depthTest: false }));
    line.renderOrder = 10;
    gizmo.add(line);
  }
  return gizmo;
}
