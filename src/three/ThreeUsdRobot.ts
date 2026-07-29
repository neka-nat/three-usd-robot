import * as THREE from "three";
import { interpolate } from "../kinematics/sampling.js";
import { type Mat4, invert, multiply } from "../kinematics/transforms.js";
import type {
  JointDescription,
  LinkDescription,
  RobotDescription,
} from "../robot/RobotDescription.js";
import type { KinematicTree } from "../robot/buildKinematicTree.js";
import type { Stage } from "../usd/Stage.js";
import { JointObject } from "./JointObject.js";
import { LinkObject } from "./LinkObject.js";

/** Target world up-axis: normalize to Y-up / Z-up, or keep the authored orientation. */
export type WorldUpAxis = "Y" | "Z" | "keep";

export type ThreeUsdRobotOptions = {
  /** Clamp `setJointValue` to authored limits (default `true`). */
  clampJointLimits?: boolean;
  /** Size of the built-in joint-axis / link-frame helpers (stage units, default `0.15`). */
  helperSize?: number;
  /**
   * Target world up-axis. The root is rotated so the stage's authored `upAxis`
   * lands in that convention: `"Y"` for a standard three.js scene, `"Z"` for a
   * robotics-style Z-up world, `"keep"` for no correction. Takes precedence
   * over the deprecated {@link ThreeUsdRobotOptions.upAxisConversion}.
   */
  worldUp?: WorldUpAxis;
  /**
   * Legacy up-axis correction: `"auto"` ≡ `worldUp: "Y"`, `"Y"` / `"none"` ≡
   * `worldUp: "keep"`, and `"Z"` forces the Z-up→Y-up rotation regardless of
   * stage metadata. Default `"none"` (the loader defaults to `"auto"`).
   * @deprecated Use {@link ThreeUsdRobotOptions.worldUp}.
   */
  upAxisConversion?: "auto" | "Y" | "Z" | "none";
  /** Extra uniform scale multiplied with the stage `metersPerUnit` (default `1`). */
  unitScale?: number;
  /** Seed joints from their authored initial value (drive target / joint state). Default `true`. */
  applyInitialPose?: boolean;
};

/**
 * A Three.js `Object3D` that realizes a {@link RobotDescription} as a kinematic
 * hierarchy and drives forward kinematics via {@link setJointValue}.
 *
 * Per joint the hierarchy is
 * `parentLink → jointFrame0 → jointMotion → jointFrame1⁻¹ → childLink`,
 * where only `jointMotion` (a {@link JointObject}) changes with the joint value;
 * world poses then fall out of Three.js's `updateMatrixWorld`.
 *
 * **Naming contract** — a link/joint's key is its prim's leaf name when that
 * is unique across the robot, else its full prim path (deterministic; see the
 * extractor). Every accessor taking a name equally accepts the full prim path,
 * which is stable regardless of collisions; {@link getLinkObjectsByPath} /
 * {@link getJointObjectsByPath} enumerate the path-keyed tables.
 */
export class ThreeUsdRobot extends THREE.Object3D {
  readonly isThreeUsdRobot = true;
  readonly robot: RobotDescription;
  readonly tree: KinematicTree;
  readonly clampJointLimits: boolean;
  /**
   * The composed USD stage this robot was built from — the full prim tree, for
   * inspection tooling (structure panels, attribute browsers). Attached by
   * {@link ThreeUsdRobotLoader}; `undefined` for programmatically-built robots.
   */
  stage?: Stage;

  private readonly linkObjects = new Map<string, LinkObject>();
  private readonly jointObjects = new Map<string, JointObject>();
  private readonly linkKeyByPath = new Map<string, string>();
  private readonly jointKeyByPath = new Map<string, string>();
  private dirty = true;

  private readonly helperSize: number;
  private _showVisual = true;
  private _showCollision = false;
  private _showJointAxes = false;
  private _showLinkFrames = false;
  private jointAxesHelpers: THREE.AxesHelper[] = [];
  private linkFrameHelpers: THREE.AxesHelper[] = [];

  constructor(robot: RobotDescription, tree: KinematicTree, options: ThreeUsdRobotOptions = {}) {
    super();
    this.name = robot.name;
    this.robot = robot;
    this.tree = tree;
    this.clampJointLimits = options.clampJointLimits ?? true;
    this.helperSize = options.helperSize ?? 0.15;

    // Create a node for every link up front; index links and joints by path.
    for (const [key, link] of Object.entries(robot.links)) {
      this.linkObjects.set(key, new LinkObject(link));
      this.linkKeyByPath.set(link.primPath, key);
    }
    for (const [key, joint] of Object.entries(robot.joints)) {
      this.jointKeyByPath.set(joint.primPath, key);
    }

    this.attachRoot();
    this.attachTreeEdges();
    this.attachIsolatedLinks();
    this.applyStageNormalization(robot, options);
    if (options.applyInitialPose ?? true) this.applyInitialPose(robot);
  }

  /** Orient (authored upAxis → target world up) and scale (metersPerUnit × unitScale) the root. */
  private applyStageNormalization(robot: RobotDescription, options: ThreeUsdRobotOptions): void {
    const scale = (robot.metersPerUnit || 1) * (options.unitScale ?? 1);
    if (scale !== 1) this.scale.setScalar(scale);

    const rotateX = (angle: number) =>
      this.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), angle);

    if (options.worldUp) {
      if (options.worldUp === "Y" && robot.upAxis === "Z") rotateX(-Math.PI / 2);
      else if (options.worldUp === "Z" && robot.upAxis === "Y") rotateX(Math.PI / 2);
      return; // matching axis or "keep": leave as authored
    }
    const conv = options.upAxisConversion ?? "none";
    if (conv === "Z" || (conv === "auto" && robot.upAxis === "Z")) rotateX(-Math.PI / 2);
  }

  /** Apply each joint's authored initial value, if any. */
  private applyInitialPose(robot: RobotDescription): void {
    for (const [key, joint] of Object.entries(robot.joints)) {
      if (joint.initialValue === undefined) continue;
      this.jointObjects.get(key)?.setValue(joint.initialValue, this.clampJointLimits);
    }
    this.dirty = true;
  }

  private attachRoot(): void {
    const rootObj = this.linkObjects.get(this.tree.root);
    if (!rootObj) return; // empty robot
    const rootJointKey = this.tree.rootJoint;
    const rootLink = this.robot.links[this.tree.root];
    if (rootJointKey) {
      const j = this.robot.joints[rootJointKey];
      // World-fixed placement: jointFrame0 (in world) · inverse(jointFrame1).
      if (j) setMatrix(rootObj, multiply(j.jointFrame0, invert(j.jointFrame1)));
    } else if (rootLink?.worldTransform) {
      // Floating base: keep the authored stage placement.
      setMatrix(rootObj, rootLink.worldTransform);
    }
    this.add(rootObj);
  }

  private attachTreeEdges(): void {
    for (const linkKey of this.tree.order) {
      const node = this.tree.nodes[linkKey];
      if (!node || node.parent === null || node.jointToParent === null) continue;

      const parentObj = this.linkObjects.get(node.parent);
      const childObj = this.linkObjects.get(linkKey);
      const joint = this.robot.joints[node.jointToParent];
      if (!parentObj || !childObj || !joint) continue;

      this.attachJointChain(parentObj, childObj, node.jointToParent, joint);
    }
  }

  /** Build `parent → frame0 → motion → frame1⁻¹ → child` for one joint. */
  private attachJointChain(
    parent: LinkObject,
    child: LinkObject,
    jointKey: string,
    joint: JointDescription,
  ): void {
    const frame0 = new THREE.Group();
    frame0.name = `${joint.name}:frame0`;
    setMatrix(frame0, joint.jointFrame0);

    const motion = new JointObject(joint);

    const frame1Inv = new THREE.Group();
    frame1Inv.name = `${joint.name}:frame1Inv`;
    setMatrix(frame1Inv, invert(joint.jointFrame1));

    parent.add(frame0);
    frame0.add(motion);
    motion.add(frame1Inv);
    frame1Inv.add(child);

    this.jointObjects.set(jointKey, motion);
  }

  private attachIsolatedLinks(): void {
    for (const key of this.tree.isolatedLinks) {
      const obj = this.linkObjects.get(key);
      if (!obj || obj.parent) continue;
      // Not placeable by any joint chain — keep the authored stage placement
      // (other machines / free bodies on a multi-articulation stage).
      const worldTransform = this.robot.links[key]?.worldTransform;
      if (worldTransform) setMatrix(obj, worldTransform);
      this.add(obj);
    }
  }

  // -- Naming --------------------------------------------------------------

  /** Resolve a link reference — key or full prim path — to the extractor key. */
  private linkKey(ref: string): string {
    if (this.linkObjects.has(ref)) return ref;
    return this.linkKeyByPath.get(ref) ?? ref;
  }

  /** Resolve a joint reference — key or full prim path — to the extractor key. */
  private jointKey(ref: string): string {
    if (this.jointObjects.has(ref)) return ref;
    return this.jointKeyByPath.get(ref) ?? ref;
  }

  // -- Joint control -------------------------------------------------------

  /**
   * Set one joint value, addressed by key or full prim path. Unknown joints
   * are ignored. Returns whether it applied.
   */
  setJointValue(name: string, value: number): boolean {
    const joint = this.jointObjects.get(this.jointKey(name));
    if (!joint) return false;
    joint.setValue(value, this.clampJointLimits);
    this.dirty = true;
    return true;
  }

  /** Set several joint values at once (matrix update is coalesced). */
  setJointValues(values: Record<string, number>): void {
    for (const [name, value] of Object.entries(values)) {
      const joint = this.jointObjects.get(this.jointKey(name));
      if (joint) {
        joint.setValue(value, this.clampJointLimits);
        this.dirty = true;
      }
    }
  }

  getJointValue(name: string): number | undefined {
    return this.jointObjects.get(this.jointKey(name))?.value;
  }

  /** Recompute world matrices. Called lazily by the getters; safe to call directly. */
  updateKinematics(): void {
    this.updateMatrixWorld(true);
    this.dirty = false;
  }

  private ensureUpdated(): void {
    if (this.dirty) this.updateKinematics();
  }

  // -- Queries -------------------------------------------------------------

  /** World matrix of a link, addressed by key or full prim path. */
  getLinkWorldMatrix(name: string): THREE.Matrix4 {
    const obj = this.linkObjects.get(this.linkKey(name));
    if (!obj) throw new Error(`unknown link "${name}"`);
    this.ensureUpdated();
    return obj.matrixWorld.clone();
  }

  getLinkWorldPosition(name: string): THREE.Vector3 {
    return new THREE.Vector3().setFromMatrixPosition(this.getLinkWorldMatrix(name));
  }

  /** Link object by key or full prim path. */
  getLinkObject(name: string): LinkObject | undefined {
    return this.linkObjects.get(this.linkKey(name));
  }

  /** Joint object by key or full prim path. */
  getJointObject(name: string): JointObject | undefined {
    return this.jointObjects.get(this.jointKey(name));
  }

  /**
   * Table of link prim path → {@link LinkObject}. Prim paths are the
   * collision-proof way to pin a link (e.g. to attach tools or gizmos).
   */
  getLinkObjectsByPath(): Map<string, LinkObject> {
    const out = new Map<string, LinkObject>();
    for (const [path, key] of this.linkKeyByPath) {
      const obj = this.linkObjects.get(key);
      if (obj) out.set(path, obj);
    }
    return out;
  }

  /**
   * Table of joint prim path → {@link JointObject}, covering the joints
   * realized in the kinematic tree (loop joints have no motion node).
   */
  getJointObjectsByPath(): Map<string, JointObject> {
    const out = new Map<string, JointObject>();
    for (const [path, key] of this.jointKeyByPath) {
      const obj = this.jointObjects.get(key);
      if (obj) out.set(path, obj);
    }
    return out;
  }

  getJoints(): JointDescription[] {
    return Object.values(this.robot.joints);
  }

  getLinks(): LinkDescription[] {
    return Object.values(this.robot.links);
  }

  /** Names of the articulated (controllable) joints. */
  getJointNames(): string[] {
    return [...this.jointObjects.keys()];
  }

  getLinkNames(): string[] {
    return [...this.linkObjects.keys()];
  }

  getKinematicTree(): KinematicTree {
    return this.tree;
  }

  /** Authored stage up-axis (`"Y"` or `"Z"`) — unaffected by `worldUp` normalization. */
  get upAxis(): "Y" | "Z" {
    return this.robot.upAxis;
  }

  /** Authored stage scale in meters per unit (already applied to the root). */
  get metersPerUnit(): number {
    return this.robot.metersPerUnit;
  }

  // -- Animation playback --------------------------------------------------

  /** Playback rate in time codes per second (from the stage; default 24). */
  getTimeCodesPerSecond(): number {
    return this.robot.timeCodesPerSecond ?? 24;
  }

  /** Whether any joint has a time-sampled trajectory. */
  hasAnimation(): boolean {
    return Object.values(this.robot.joints).some((j) => j.valueSamples !== undefined);
  }

  /**
   * Animation range in time codes: the union of authored joint sample ranges,
   * falling back to the stage `startTimeCode`/`endTimeCode`. `null` if neither.
   */
  getTimeRange(): { start: number; end: number } | null {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const joint of Object.values(this.robot.joints)) {
      const times = joint.valueSamples?.times;
      if (!times || times.length === 0) continue;
      start = Math.min(start, times[0]!);
      end = Math.max(end, times[times.length - 1]!);
    }
    if (start <= end) return { start, end };

    const { startTimeCode, endTimeCode } = this.robot;
    if (startTimeCode !== undefined && endTimeCode !== undefined) {
      return { start: startTimeCode, end: endTimeCode };
    }
    return null;
  }

  /** Sample every animated joint at time code `t` and apply the values. */
  setTime(t: number): void {
    for (const [key, joint] of Object.entries(this.robot.joints)) {
      if (joint.valueSamples) this.setJointValue(key, interpolate(joint.valueSamples, t));
    }
  }

  // -- Display toggles -----------------------------------------------------

  get showVisual(): boolean {
    return this._showVisual;
  }
  set showVisual(v: boolean) {
    this._showVisual = v;
    this.setKindVisibility("visual", v);
  }

  get showCollision(): boolean {
    return this._showCollision;
  }
  set showCollision(v: boolean) {
    this._showCollision = v;
    this.setKindVisibility("collision", v);
  }

  get showJointAxes(): boolean {
    return this._showJointAxes;
  }
  set showJointAxes(v: boolean) {
    this._showJointAxes = v;
    if (v && this.jointAxesHelpers.length === 0) {
      for (const joint of this.jointObjects.values()) {
        const h = new THREE.AxesHelper(this.helperSize);
        h.name = `${joint.jointName}:axes`;
        joint.add(h);
        this.jointAxesHelpers.push(h);
      }
    }
    for (const h of this.jointAxesHelpers) h.visible = v;
  }

  get showLinkFrames(): boolean {
    return this._showLinkFrames;
  }
  set showLinkFrames(v: boolean) {
    this._showLinkFrames = v;
    if (v && this.linkFrameHelpers.length === 0) {
      for (const link of this.linkObjects.values()) {
        const h = new THREE.AxesHelper(this.helperSize);
        h.name = `${link.linkName}:frame`;
        link.add(h);
        this.linkFrameHelpers.push(h);
      }
    }
    for (const h of this.linkFrameHelpers) h.visible = v;
  }

  private setKindVisibility(kind: string, visible: boolean): void {
    this.traverse((o) => {
      if ((o.userData as { kind?: string }).kind === kind) o.visible = visible;
    });
  }
}

/** Assign a fixed local matrix to an object (disables Three.js auto-update). */
function setMatrix(obj: THREE.Object3D, m: Mat4): void {
  obj.matrixAutoUpdate = false;
  obj.matrix.fromArray(m);
  obj.matrixWorldNeedsUpdate = true;
}
