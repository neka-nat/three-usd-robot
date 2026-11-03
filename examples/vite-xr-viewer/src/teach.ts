/**
 * Teaching, stage 1 — no IK needed:
 *
 * - **Grab a link to turn its joint.** The first articulated joint above the
 *   grabbed link follows the hand like a lever: a revolute joint turns by the
 *   angle the hand sweeps around the joint axis, a prismatic one slides by the
 *   hand's travel along it. No wrist rotation needed — you move your hand, the
 *   arm turns about the joint you hold.
 * - **Waypoints.** Each recorded pose leaves a translucent ghost (onion skin)
 *   and a point on the tool path.
 * - **Playback.** The waypoints are baked into the robot description as a
 *   time-sampled trajectory, so `setTime` plays it and `exportThreeUsdRobot`
 *   writes it out as USD `timeSamples` — what you see is what you export.
 */

import * as THREE from "three";
import {
  exportThreeUsdRobot,
  type KinematicNode,
  type ThreeUsdRobot,
  serializeUsda,
} from "three-usd-robot";
import { createGhostRobot, getLinkMeshes } from "three-usd-robot/helpers";

type SampleChannel = { times: number[]; values: number[] };

export type Waypoint = {
  /** Commandable joint values, keyed by joint prim path. */
  joints: Record<string, number>;
  /** Tool-link position at the time of recording (world). */
  tcp: THREE.Vector3;
  ghost: ThreeUsdRobot;
};

export type TeachOptions = {
  scene: THREE.Scene;
  robot: ThreeUsdRobot;
  /** The link whose position draws the path (prim path or key). */
  toolLink: string;
  /** Time codes per second of the baked trajectory (default `24`). */
  timeCodesPerSecond?: number;
  /** Joint speed the playback aims for (rad/s or m/s, default `0.6`). */
  speed?: number;
  /** Called whenever the session's observable state changes. */
  onChange?: () => void;
};

const TIMES_EPSILON = 1e-9;
/** Lever arm below which a hand position no longer defines an angle (m). */
const MIN_LEVER = 0.03;

export class TeachSession {
  readonly robot: ThreeUsdRobot;
  readonly scene: THREE.Scene;
  readonly toolLink: string;
  readonly waypoints: Waypoint[] = [];

  private readonly tps: number;
  private readonly speed: number;
  private readonly onChange: (() => void) | undefined;
  private readonly path: THREE.Line;
  /** Joint prim path → description key (the IR's `joints` record is keyed by key). */
  private readonly keyByPath = new Map<string, string>();
  private readonly originalSamples = new Map<string, SampleChannel | undefined>();
  private readonly originalTps: number | undefined;

  private grab: {
    /** The articulated joint's child link (highlighted while turning). */
    linkPath: string;
    jointPath: string;
    prismatic: boolean;
    source: THREE.Object3D;
    /** Joint anchor and axis in world space, fixed for the grab. */
    anchor: THREE.Vector3;
    axis: THREE.Vector3;
    /** Hand at grab start: position, and its lever vector around the axis. */
    hand0: THREE.Vector3;
    lever0: THREE.Vector3;
    q0: number;
    /** Last sweep angle, for unwrapping past ±π. */
    lastSweep: number;
  } | null = null;
  private _limitExceeded = false;
  private _playing = false;
  private playTime = 0;
  private baked = false;

  constructor(options: TeachOptions) {
    this.robot = options.robot;
    this.scene = options.scene;
    this.tps = options.timeCodesPerSecond ?? 24;
    this.speed = options.speed ?? 0.6;
    this.onChange = options.onChange;
    const tool = this.robot.getLinkObject(options.toolLink);
    if (!tool) throw new Error(`unknown tool link "${options.toolLink}"`);
    this.toolLink = tool.primPath;
    for (const [key, joint] of Object.entries(this.robot.robot.joints)) {
      this.keyByPath.set(joint.primPath, key);
      this.originalSamples.set(key, joint.valueSamples);
    }
    this.originalTps = this.robot.robot.timeCodesPerSecond;
    this.path = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffc400 }),
    );
    this.path.name = "teachPath";
    this.path.frustumCulled = false;
    this.scene.add(this.path);
  }

  /** Prim path of the link being turned, if any. */
  get grabbedLink(): string | null {
    return this.grab?.linkPath ?? null;
  }

  /** Whether the current grab pushes the joint against its limit. */
  get limitExceeded(): boolean {
    return this._limitExceeded;
  }

  get playing(): boolean {
    return this._playing;
  }

  /** Whether teaching currently owns the robot's joints (grabbing, or waypoints exist). */
  get active(): boolean {
    return this.grab !== null || this.waypoints.length > 0;
  }

  // -- grab a link -----------------------------------------------------------

  /**
   * Grab the link nearest to `source` (within `reach`, world units): from then
   * on the first articulated joint above it follows the hand. Returns whether
   * a link was taken.
   */
  tryGrabLink(source: THREE.Object3D, reach: number): boolean {
    // Nearest first; a link with no articulated joint above it (the base, a
    // fixed plate) is skipped in favour of the next one within reach.
    for (const target of this.linksByDistance(source, reach)) {
      // Climb to the first articulated joint; a fixed mount turns the joint above it.
      let node: KinematicNode | undefined = this.robot.tree.nodes[target];
      while (node) {
        const jointKey = node.jointToParent;
        const joint = jointKey ? this.robot.getJointObject(jointKey) : undefined;
        if (joint?.articulated) {
          const link = this.robot.getLinkObject(node.link);
          const frame = joint.parent; // the joint's fixed frame: anchor + axis live here
          if (!link || !frame) break;
          this.robot.updateMatrixWorld(true);
          source.updateWorldMatrix(true, false);
          const anchor = new THREE.Vector3().setFromMatrixPosition(frame.matrixWorld);
          const axis = joint.axis.clone().transformDirection(frame.matrixWorld);
          const hand0 = new THREE.Vector3().setFromMatrixPosition(source.matrixWorld);
          const lever0 = hand0.clone().sub(anchor).projectOnPlane(axis);
          this.stop();
          this.grab = {
            linkPath: link.primPath,
            jointPath: joint.primPath,
            prismatic: joint.jointType === "prismatic",
            source,
            anchor,
            axis,
            hand0,
            lever0,
            q0: joint.value,
            lastSweep: 0,
          };
          this._limitExceeded = false;
          this.onChange?.();
          return true;
        }
        node = node.parent ? this.robot.tree.nodes[node.parent] : undefined;
      }
    }
    return false;
  }

  releaseLink(): void {
    if (!this.grab) return;
    this.grab = null;
    this._limitExceeded = false;
    this.onChange?.();
  }

  /** Link keys whose visual meshes lie within `reach` of the source, nearest first. */
  private linksByDistance(source: THREE.Object3D, reach: number): string[] {
    source.updateWorldMatrix(true, false);
    const at = new THREE.Vector3().setFromMatrixPosition(source.matrixWorld);
    this.robot.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const candidates: { key: string; distance: number }[] = [];
    for (const key of this.robot.getLinkNames()) {
      let nearest = Number.POSITIVE_INFINITY;
      for (const mesh of getLinkMeshes(this.robot, key, "visual")) {
        box.setFromObject(mesh);
        if (!box.isEmpty()) nearest = Math.min(nearest, box.distanceToPoint(at));
      }
      if (nearest <= reach) candidates.push({ key, distance: nearest });
    }
    return candidates.sort((a, b) => a.distance - b.distance).map((c) => c.key);
  }

  // -- waypoints -------------------------------------------------------------

  /** Record the current pose: a ghost stays behind, the tool path grows. */
  record(): Waypoint {
    this.stop();
    const joints: Record<string, number> = {};
    for (const [path, joint] of this.robot.getJointObjectsByPath()) {
      if (joint.articulated && !this.robot.isMimicFollower(path)) joints[path] = joint.value;
    }
    const ghost = createGhostRobot(this.robot, { color: 0x66aaff, opacity: 0.22 });
    ghost.name = `teachGhost${this.waypoints.length}`;
    (this.robot.parent ?? this.scene).add(ghost);
    const waypoint = { joints, tcp: this.robot.getLinkWorldPosition(this.toolLink), ghost };
    this.waypoints.push(waypoint);
    this.baked = false;
    this.redrawPath();
    this.onChange?.();
    return waypoint;
  }

  /** Drop the last waypoint. */
  undo(): void {
    const last = this.waypoints.pop();
    if (!last) return;
    this.stop();
    disposeGhost(last.ghost);
    this.baked = false;
    this.redrawPath();
    this.onChange?.();
  }

  /** Drop every waypoint and restore the asset's own animation, if it had one. */
  clear(): void {
    this.stop();
    for (const waypoint of this.waypoints) disposeGhost(waypoint.ghost);
    this.waypoints.length = 0;
    this.restoreSamples();
    this.redrawPath();
    this.onChange?.();
  }

  private redrawPath(): void {
    this.path.geometry.dispose();
    const points = this.waypoints.map((w) => w.tcp);
    if (points.length > 1) points.push(points[0]!); // the playback loops back to the start
    this.path.geometry = new THREE.BufferGeometry().setFromPoints(points);
    this.path.visible = points.length > 1;
  }

  // -- playback & export -----------------------------------------------------

  /** Start playing the taught trajectory (needs two waypoints), or pause it. */
  togglePlay(): boolean {
    if (this._playing) {
      this.stop();
      return false;
    }
    const range = this.bake();
    if (!range) return false;
    this.playTime = range.start;
    this._playing = true;
    this.onChange?.();
    return true;
  }

  stop(): void {
    if (!this._playing) return;
    this._playing = false;
    this.onChange?.();
  }

  /** Advance the lever grab or the playback by `delta` seconds. */
  update(delta: number): void {
    if (this.grab) {
      const grab = this.grab;
      grab.source.updateWorldMatrix(true, false);
      const hand = new THREE.Vector3().setFromMatrixPosition(grab.source.matrixWorld);
      let q: number;
      if (grab.prismatic) {
        q = grab.q0 + hand.clone().sub(grab.hand0).dot(grab.axis);
      } else {
        const lever = hand.sub(grab.anchor).projectOnPlane(grab.axis);
        // Too close to the axis the angle is noise: hold the last value.
        if (lever.length() < MIN_LEVER || grab.lever0.length() < MIN_LEVER) return;
        const sweep = Math.atan2(
          new THREE.Vector3().crossVectors(grab.lever0, lever).dot(grab.axis),
          grab.lever0.dot(lever),
        );
        // Unwrap: stay within π of the previous sweep so a full turn accumulates.
        let unwrapped = sweep;
        while (unwrapped - grab.lastSweep > Math.PI) unwrapped -= 2 * Math.PI;
        while (unwrapped - grab.lastSweep < -Math.PI) unwrapped += 2 * Math.PI;
        grab.lastSweep = unwrapped;
        q = grab.q0 + unwrapped;
      }
      this.robot.setJointValue(grab.jointPath, q); // clamps to the authored limits
      const applied = this.robot.getJointValue(grab.jointPath) ?? q;
      const exceeded = Math.abs(applied - q) > 1e-6;
      if (exceeded !== this._limitExceeded) {
        this._limitExceeded = exceeded;
        this.onChange?.();
      }
      return;
    }
    if (this._playing) {
      const range = this.robot.getTimeRange();
      if (!range) return;
      this.playTime += delta * this.tps;
      if (this.playTime > range.end) this.playTime = range.start;
      this.robot.setTime(this.playTime);
    }
  }

  /**
   * Bake the waypoints into the robot description as time samples (closing
   * the loop back to the first pose) and return the resulting time range.
   */
  bake(): { start: number; end: number } | null {
    if (this.waypoints.length < 2) return null;
    if (this.baked) return this.robot.getTimeRange();
    const sequence = [...this.waypoints, this.waypoints[0]!];
    const times = [0];
    for (let i = 1; i < sequence.length; i++) {
      let maxDelta = 0;
      for (const [path, value] of Object.entries(sequence[i]!.joints)) {
        maxDelta = Math.max(maxDelta, Math.abs(value - (sequence[i - 1]!.joints[path] ?? value)));
      }
      const seconds = THREE.MathUtils.clamp(maxDelta / this.speed, 0.5, 4);
      times.push(times[i - 1]! + Math.max(seconds * this.tps, TIMES_EPSILON));
    }
    for (const path of Object.keys(this.waypoints[0]!.joints)) {
      const key = this.keyByPath.get(path);
      const joint = key ? this.robot.robot.joints[key] : undefined;
      if (!joint) continue;
      joint.valueSamples = { times: [...times], values: sequence.map((w) => w.joints[path] ?? 0) };
    }
    this.robot.robot.timeCodesPerSecond = this.tps;
    this.baked = true;
    return this.robot.getTimeRange();
  }

  /** The robot with the taught trajectory as USDA text (`timeSamples` on the joint drives). */
  exportUsda(): string {
    this.bake();
    return serializeUsda(exportThreeUsdRobot(this.robot));
  }

  private restoreSamples(): void {
    for (const [key, samples] of this.originalSamples) {
      const joint = this.robot.robot.joints[key];
      if (joint) joint.valueSamples = samples;
    }
    this.robot.robot.timeCodesPerSecond = this.originalTps;
    this.baked = false;
  }

  dispose(): void {
    this.releaseLink();
    this.clear();
    this.path.geometry.dispose();
    (this.path.material as THREE.Material).dispose();
    this.path.removeFromParent();
  }
}

/** Ghosts share the source's geometry; only their one material is theirs. */
function disposeGhost(ghost: ThreeUsdRobot): void {
  let material: THREE.Material | undefined;
  ghost.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !material) material = mesh.material as THREE.Material;
  });
  material?.dispose();
  ghost.removeFromParent();
}

