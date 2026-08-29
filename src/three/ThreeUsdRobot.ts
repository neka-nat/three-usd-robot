import * as THREE from "three";
import {
  type JointRelativeDecomposition,
  decomposeJointRelative,
  nearestAngleBranch,
} from "../kinematics/jointResiduals.js";
import { interpolate } from "../kinematics/sampling.js";
import { type Mat4, identity4, invert, multiply, multiplyAll } from "../kinematics/transforms.js";
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
  /**
   * Diagnose {@link ThreeUsdRobot.setLinkTransforms} poses against the joint
   * constraints and `console.warn` once per baked session when one deviates
   * beyond tolerance (default 1 mm anchor / 0.01 rad axis). `true` uses the
   * defaults; pass an object to tune them.
   */
  debugBakedTransforms?: boolean | { anchorTolerance?: number; axisTolerance?: number };
};

/**
 * A rigid world pose for {@link ThreeUsdRobot.setLinkTransforms} —
 * `quaternion` in Three.js `[x, y, z, w]` order (USD authors quatf as
 * `(w, x, y, z)`; reorder when reading recorded USD by hand).
 */
export type LinkPose = {
  position: [number, number, number];
  quaternion: [number, number, number, number];
};

/**
 * Coordinate space of {@link LinkPose} batches. `"world"` (default) is the
 * Three.js scene world *after* `worldUp` / unit normalization — with
 * `worldUp: "Z"` you hand in Z-up poses — including any transform on the
 * robot object itself (which must stay a similarity: uniform scale, no
 * shear). `"stage"` is the authored USD stage space (before up-axis rotation
 * and `metersPerUnit` scaling), as prim world transforms are written in the
 * file.
 */
export type LinkPoseSpace = "world" | "stage";

export type LinkPosesOptions = {
  /** Interpretation of the poses (default `"world"`). */
  space?: LinkPoseSpace;
};

export type JointValuesFromLinkTransformsOptions = LinkPosesOptions & {
  /**
   * Previous joint values (keyed like the returned `values`): each
   * revolute/continuous joint picks the 2πk branch of its projection nearest
   * this, for frame-to-frame continuity past ±π.
   */
  previous?: Record<string, number>;
  /** Clamp `values` to authored limits (default `false` — deviations are reported, not hidden). */
  clampLimits?: boolean;
};

/**
 * Per-joint constraint residual of a link-pose batch, keyed by joint prim
 * path. The ideal parent→child transform of a joint is a pure motion along
 * its DOF; whatever the poses leave over splits into `anchorError` /
 * `axisError` (see {@link ThreeUsdRobot.validateLinkTransforms}).
 */
export type JointResidual = {
  /** Translation residual at the joint anchor, in meters (`metersPerUnit` applied). */
  anchorError: number;
  /** Rotation residual off the joint DOF, in radians. */
  axisError: number;
  /** Projected joint value (SI: radians / stage length units; `0` for fixed joints). */
  q: number;
  /** Whether `q` lies outside the authored limits. */
  limitExceeded: boolean;
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
  /** Mimic edges among realized joints: leader key → followers. */
  private readonly mimicFollowers = new Map<
    string,
    { key: string; multiplier: number; offset: number }[]
  >();
  private readonly mimicLeaderByFollower = new Map<string, string>();
  private warnedMimicDrive = false;
  private dirty = true;

  /** Constructed (fk rest) local matrix of every link, for baked→fk restore. */
  private readonly restLocal = new Map<string, Mat4>();
  private _displayMode: "fk" | "baked" = "fk";
  /** Stage-space link worlds while baked (`null` in fk mode). */
  private bakedStageWorld: Map<string, Mat4> | null = null;
  /** Frozen `frame0 · motion · frame1⁻¹` per tree joint while baked. */
  private bakedChainRel: Map<string, Mat4> | null = null;
  private readonly debugBaked: { anchorTolerance: number; axisTolerance: number } | null;
  private bakedDebugWarned = false;
  private readonly warnedPoseKeys = new Set<string>();
  private warnedNonUniformScale = false;

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
    this.registerMimicFollowers();
    this.applyStageNormalization(robot, options);
    if (options.applyInitialPose ?? true) this.applyInitialPose(robot);
    this.propagateAllMimic();

    for (const [key, obj] of this.linkObjects) this.restLocal.set(key, obj.matrix.toArray());
    const debug = options.debugBakedTransforms;
    this.debugBaked = debug
      ? {
          anchorTolerance: (typeof debug === "object" ? debug.anchorTolerance : undefined) ?? 1e-3,
          axisTolerance: (typeof debug === "object" ? debug.axisTolerance : undefined) ?? 0.01,
        }
      : null;
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

  // -- Mimic joints ---------------------------------------------------------

  /** Index the mimic edges realized in the tree (leader and follower both driven). */
  private registerMimicFollowers(): void {
    for (const [key, joint] of Object.entries(this.robot.joints)) {
      const mimic = joint.mimic;
      if (!mimic || !this.jointObjects.has(key)) continue;
      const leaderKey = this.jointKey(mimic.joint);
      // A leader outside the fk tree (loop joint) cannot drive; leave the
      // follower independently commandable.
      if (!this.jointObjects.has(leaderKey)) continue;
      this.mimicLeaderByFollower.set(key, leaderKey);
      const list = this.mimicFollowers.get(leaderKey) ?? [];
      list.push({ key, multiplier: mimic.multiplier, offset: mimic.offset });
      this.mimicFollowers.set(leaderKey, list);
    }
  }

  /** Drive the followers of `leaderKey` from its current value (recursive, cycle-safe). */
  private propagateMimic(leaderKey: string, visited?: Set<string>): void {
    const followers = this.mimicFollowers.get(leaderKey);
    if (!followers) return;
    const leaderValue = this.jointObjects.get(leaderKey)?.value;
    if (leaderValue === undefined) return;
    const seen = visited ?? new Set([leaderKey]);
    for (const { key, multiplier, offset } of followers) {
      if (seen.has(key)) continue; // cycle — reported by the validator
      seen.add(key);
      this.jointObjects
        .get(key)
        ?.setValue(multiplier * leaderValue + offset, this.clampJointLimits);
      this.propagateMimic(key, seen);
    }
  }

  /** Re-derive every follower from its chain's top-most leader. */
  private propagateAllMimic(): void {
    for (const leaderKey of this.mimicFollowers.keys()) {
      if (!this.mimicLeaderByFollower.has(leaderKey)) this.propagateMimic(leaderKey);
    }
    if (this.mimicFollowers.size > 0) this.dirty = true;
  }

  /** Whether the joint (key or prim path) is a mimic follower, driven by its leader. */
  isMimicFollower(name: string): boolean {
    return this.mimicLeaderByFollower.has(this.jointKey(name));
  }

  /** Keys of the mimic-follower joints (excluded from {@link getJointNames}). */
  getMimicJointNames(): string[] {
    return [...this.mimicLeaderByFollower.keys()];
  }

  private warnMimicDriveOnce(key: string): void {
    if (this.warnedMimicDrive) return;
    this.warnedMimicDrive = true;
    const leader = this.mimicLeaderByFollower.get(key);
    console.warn(
      `three-usd-robot: "${key}" is a mimic follower of "${leader}" — its value derives from the leader; direct sets are ignored (warned once)`,
    );
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
   * are ignored, and so are mimic followers (their value derives from the
   * leader; a warning is logged once). Driving a leader also updates its
   * followers. Returns whether it applied. Always restores `"fk"` display
   * mode first (see {@link setLinkTransforms}).
   */
  setJointValue(name: string, value: number): boolean {
    this.exitBakedMode();
    const key = this.jointKey(name);
    if (this.mimicLeaderByFollower.has(key)) {
      this.warnMimicDriveOnce(key);
      return false;
    }
    const joint = this.jointObjects.get(key);
    if (!joint) return false;
    joint.setValue(value, this.clampJointLimits);
    this.propagateMimic(key);
    this.dirty = true;
    return true;
  }

  /**
   * Set several joint values at once (matrix update is coalesced). Mimic
   * followers in the batch are skipped like in {@link setJointValue}. Always
   * restores `"fk"` display mode first, recomputing every link purely from
   * joint values — even an empty batch returns from baked playback (see
   * {@link setLinkTransforms}).
   */
  setJointValues(values: Record<string, number>): void {
    this.exitBakedMode();
    for (const [name, value] of Object.entries(values)) {
      const key = this.jointKey(name);
      if (this.mimicLeaderByFollower.has(key)) {
        this.warnMimicDriveOnce(key);
        continue;
      }
      const joint = this.jointObjects.get(key);
      if (joint) {
        joint.setValue(value, this.clampJointLimits);
        this.propagateMimic(key);
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

  // -- Baked link transforms (M23) -----------------------------------------

  /**
   * `"fk"` (default): link placements derive from joint values. `"baked"`:
   * {@link setLinkTransforms} wrote link poses directly and the joints no
   * longer constrain the display; any `setJointValue`-family call restores fk.
   */
  get displayMode(): "fk" | "baked" {
    return this._displayMode;
  }

  /**
   * Drive link world poses directly — the display path for baked recordings
   * (Isaac Sim body-transform time samples, maximal-coordinate playback).
   * usdview-like semantics: constraint deviations are shown, never corrected —
   * {@link validateLinkTransforms} measures them,
   * {@link jointValuesFromLinkTransforms} projects onto the joints instead.
   *
   * Enters `"baked"` display mode; joint values stay untouched. Return to fk
   * with {@link setJointValues} (any batch, even `{}`), which recomputes
   * every link purely from joint values.
   *
   * Keys are link keys or full prim paths; unknown keys warn once and are
   * skipped. Unspecified links KEEP their current world pose — a track that
   * omits a link means "it did not move". Poses are rigid, `quaternion` in
   * `[x, y, z, w]` order, interpreted per `opts.space` (default `"world"`:
   * the Three.js scene world after `worldUp` normalization — pair a Z-up
   * meter track with `worldUp: "Z"`). Matrix updates are coalesced into the
   * next render / world query. Returns the number of poses applied.
   */
  setLinkTransforms(poses: Record<string, LinkPose>, opts: LinkPosesOptions = {}): number {
    const targets = this.resolvePoseTargets(poses, opts.space ?? "world");
    if (this._displayMode !== "baked") this.enterBakedMode();
    const current = this.bakedStageWorld ?? new Map<string, Mat4>();
    const rels = this.bakedChainRel ?? new Map<string, Mat4>();

    // Rewrite every link's local matrix parents-first: written links land on
    // their target, held links keep their world pose while ancestors move.
    // The chain nodes in between stay frozen at their fk values; each link's
    // local absorbs the difference, so world matrices come out exact.
    const next = new Map<string, Mat4>();
    for (const key of this.tree.order) {
      const node = this.tree.nodes[key];
      const obj = this.linkObjects.get(key);
      if (!node || !obj) continue;
      const world = targets.get(key) ?? current.get(key);
      if (!world) continue;
      if (node.parent === null || node.jointToParent === null) {
        next.set(key, world); // the root's Object3D parent is the robot itself
        setMatrix(obj, world);
        continue;
      }
      const parentWorld = next.get(node.parent);
      const chainRel = rels.get(node.jointToParent);
      if (!parentWorld || !chainRel) continue;
      next.set(key, world);
      setMatrix(obj, multiply(invert(multiply(parentWorld, chainRel)), world));
    }
    for (const key of this.tree.isolatedLinks) {
      const obj = this.linkObjects.get(key);
      const world = targets.get(key) ?? current.get(key);
      if (!obj || !world) continue;
      next.set(key, world);
      setMatrix(obj, world);
    }

    this.bakedStageWorld = next;
    this.dirty = true;
    this.warnBakedDeviationOnce(next);
    return targets.size;
  }

  /**
   * Measure how far a link-pose batch deviates from the joint constraints,
   * without touching the display. Unspecified links resolve to their current
   * displayed pose, so the report predicts exactly what
   * {@link setLinkTransforms} with the same batch would show.
   *
   * Keyed by joint prim path; covers every joint — fixed joints (`q` = 0
   * check), loop joints dropped from the fk tree (closure error) and the
   * world-fixed root attachment (a moved base against a fixed-base model).
   * Typical signatures: a constant `anchorError` offset on every joint —
   * recording/model mismatch (wrong version or scale); growth over time —
   * maximal-coordinate solver drift; large uniform `axisError` — a
   * coordinate-convention bug (Y/Z-up or quaternion order).
   */
  validateLinkTransforms(
    poses: Record<string, LinkPose>,
    opts: LinkPosesOptions = {},
  ): Record<string, JointResidual> {
    const out: Record<string, JointResidual> = {};
    for (const { joint, rel } of this.decomposeJoints(poses, opts.space ?? "world")) {
      out[joint.primPath] = this.buildResidual(joint, rel.q, rel);
    }
    return out;
  }

  /**
   * Project a link-pose batch onto the joint manifold: the closed-form 1-DOF
   * joint values that best reproduce it, plus the same residuals as
   * {@link validateLinkTransforms}. `values` covers the commandable
   * articulated tree joints (mimic followers excluded — their leaders
   * re-derive them), keyed by joint prim path, and feeds
   * {@link setJointValues} directly — the constraint-respecting playback of
   * the same track:
   *
   * ```ts
   * robot.setJointValues(robot.jointValuesFromLinkTransforms(poses, { previous }).values);
   * ```
   *
   * Residual `q` / `limitExceeded` always report the unclamped projection,
   * also when `clampLimits` clamps `values`.
   */
  jointValuesFromLinkTransforms(
    poses: Record<string, LinkPose>,
    opts: JointValuesFromLinkTransformsOptions = {},
  ): { values: Record<string, number>; residuals: Record<string, JointResidual> } {
    const values: Record<string, number> = {};
    const residuals: Record<string, JointResidual> = {};
    for (const { key, joint, rel } of this.decomposeJoints(poses, opts.space ?? "world")) {
      let q = rel.q;
      if (joint.type === "revolute" || joint.type === "continuous") {
        const previous = opts.previous?.[joint.primPath] ?? opts.previous?.[key];
        if (previous !== undefined) q = nearestAngleBranch(q, previous);
      }
      residuals[joint.primPath] = this.buildResidual(joint, q, rel);
      if (!this.jointObjects.get(key)?.articulated) continue;
      // Followers are not commandable — the constraint re-derives them when
      // the returned values are fed to setJointValues.
      if (this.mimicLeaderByFollower.has(key)) continue;
      if (opts.clampLimits) {
        if (joint.lower !== undefined && q < joint.lower) q = joint.lower;
        if (joint.upper !== undefined && q > joint.upper) q = joint.upper;
      }
      values[joint.primPath] = q;
    }
    return { values, residuals };
  }

  /** Restore the constructed fk link placements (no-op when already `"fk"`). */
  private exitBakedMode(): void {
    if (this._displayMode === "fk") return;
    for (const [key, local] of this.restLocal) {
      const obj = this.linkObjects.get(key);
      if (obj) setMatrix(obj, local);
    }
    this.bakedStageWorld = null;
    this.bakedChainRel = null;
    this.bakedDebugWarned = false;
    this._displayMode = "fk";
    this.dirty = true;
  }

  /** Freeze the fk state a baked session builds on (joints cannot move while baked). */
  private enterBakedMode(): void {
    const rels = this.computeChainRels();
    this.bakedChainRel = rels;
    this.bakedStageWorld = this.computeStageWorlds(rels);
    this._displayMode = "baked";
  }

  /** `frame0 · motion(q) · frame1⁻¹` of every tree joint, from live joint values. */
  private computeChainRels(): Map<string, Mat4> {
    const rels = new Map<string, Mat4>();
    for (const [key, motion] of this.jointObjects) {
      const joint = this.robot.joints[key];
      if (!joint) continue;
      motion.updateMatrix();
      rels.set(
        key,
        multiplyAll([joint.jointFrame0, motion.matrix.toArray(), invert(joint.jointFrame1)]),
      );
    }
    return rels;
  }

  /** Stage-space world transform of every link under the current display state. */
  private computeStageWorlds(rels: Map<string, Mat4>): Map<string, Mat4> {
    const worlds = new Map<string, Mat4>();
    for (const key of this.tree.order) {
      const node = this.tree.nodes[key];
      const obj = this.linkObjects.get(key);
      if (!node || !obj) continue;
      const local = obj.matrix.toArray();
      if (node.parent === null || node.jointToParent === null) {
        worlds.set(key, local);
        continue;
      }
      const parentWorld = worlds.get(node.parent);
      const chainRel = rels.get(node.jointToParent);
      if (!parentWorld || !chainRel) continue;
      worlds.set(key, multiplyAll([parentWorld, chainRel, local]));
    }
    for (const key of this.tree.isolatedLinks) {
      const obj = this.linkObjects.get(key);
      if (obj) worlds.set(key, obj.matrix.toArray());
    }
    return worlds;
  }

  private currentStageWorlds(): Map<string, Mat4> {
    return this.bakedStageWorld ?? this.computeStageWorlds(this.computeChainRels());
  }

  /** Resolve pose keys to link keys and convert each pose to a rigid stage-space matrix. */
  private resolvePoseTargets(
    poses: Record<string, LinkPose>,
    space: LinkPoseSpace,
  ): Map<string, Mat4> {
    const targets = new Map<string, Mat4>();
    const entries = Object.entries(poses);
    if (entries.length === 0) return targets;

    const toStage = space === "world" ? this.sceneToStageConverter() : null;
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const matrix = new THREE.Matrix4();
    for (const [ref, pose] of entries) {
      const key = this.linkKey(ref);
      if (!this.linkObjects.has(key)) {
        this.warnUnknownPoseKey(ref);
        continue;
      }
      position.fromArray(pose.position);
      quaternion.fromArray(pose.quaternion).normalize();
      toStage?.(position, quaternion);
      targets.set(key, matrix.compose(position, quaternion, UNIT_SCALE).toArray());
    }
    return targets;
  }

  /**
   * Scene world → stage space, undoing the robot's own world transform
   * (up-axis rotation, unit scale, any user placement) as a similarity — so
   * link locals stay rigid and the root keeps carrying the scale.
   */
  private sceneToStageConverter(): (position: THREE.Vector3, quaternion: THREE.Quaternion) => void {
    this.updateWorldMatrix(true, false);
    const rootPosition = new THREE.Vector3();
    const rootQuaternion = new THREE.Quaternion();
    const rootScale = new THREE.Vector3();
    this.matrixWorld.decompose(rootPosition, rootQuaternion, rootScale);
    const s = rootScale.x;
    if (
      !this.warnedNonUniformScale &&
      (Math.abs(rootScale.y - s) > 1e-6 * Math.abs(s) ||
        Math.abs(rootScale.z - s) > 1e-6 * Math.abs(s))
    ) {
      this.warnedNonUniformScale = true;
      console.warn(
        `three-usd-robot: non-uniform world scale on "${this.name}"; space:"world" poses are off`,
      );
    }
    const invQuaternion = rootQuaternion.clone().invert();
    const invScale = s !== 0 ? 1 / s : 1;
    return (position, quaternion) => {
      position.sub(rootPosition).applyQuaternion(invQuaternion).multiplyScalar(invScale);
      quaternion.premultiply(invQuaternion);
    };
  }

  /**
   * Decompose every joint's parent→child transform under a pose batch
   * (unspecified links resolve to their current displayed pose, mirroring
   * {@link setLinkTransforms}). Pure — the display is untouched.
   */
  private decomposeJoints(
    poses: Record<string, LinkPose>,
    space: LinkPoseSpace,
  ): { key: string; joint: JointDescription; rel: JointRelativeDecomposition }[] {
    const worlds = new Map(this.currentStageWorlds());
    for (const [key, world] of this.resolvePoseTargets(poses, space)) worlds.set(key, world);

    const out: { key: string; joint: JointDescription; rel: JointRelativeDecomposition }[] = [];
    for (const [key, joint] of Object.entries(this.robot.joints)) {
      const childWorld = worlds.get(joint.child);
      const parentWorld = joint.parent === "" ? IDENTITY4 : worlds.get(joint.parent);
      if (!childWorld || !parentWorld) continue;
      out.push({ key, joint, rel: decomposeJointRelative(joint, parentWorld, childWorld) });
    }
    return out;
  }

  private buildResidual(
    joint: JointDescription,
    q: number,
    rel: JointRelativeDecomposition,
  ): JointResidual {
    return {
      anchorError: rel.anchorError * this.robot.metersPerUnit,
      axisError: rel.axisError,
      q,
      limitExceeded:
        (joint.lower !== undefined && q < joint.lower - LIMIT_EPS) ||
        (joint.upper !== undefined && q > joint.upper + LIMIT_EPS),
    };
  }

  private warnUnknownPoseKey(ref: string): void {
    if (this.warnedPoseKeys.has(ref)) return;
    this.warnedPoseKeys.add(ref);
    console.warn(`three-usd-robot: unknown link "${ref}" in a pose batch; ignoring`);
  }

  /** `debugBakedTransforms`: warn once per baked session when poses break the constraints. */
  private warnBakedDeviationOnce(worlds: Map<string, Mat4>): void {
    if (!this.debugBaked || this.bakedDebugWarned) return;
    const { anchorTolerance, axisTolerance } = this.debugBaked;
    let count = 0;
    let worst: { path: string; anchor: number; axis: number; score: number } | null = null;
    for (const joint of Object.values(this.robot.joints)) {
      const childWorld = worlds.get(joint.child);
      const parentWorld = joint.parent === "" ? IDENTITY4 : worlds.get(joint.parent);
      if (!childWorld || !parentWorld) continue;
      const rel = decomposeJointRelative(joint, parentWorld, childWorld);
      const anchor = rel.anchorError * this.robot.metersPerUnit;
      if (anchor <= anchorTolerance && rel.axisError <= axisTolerance) continue;
      count++;
      const score = anchor / anchorTolerance + rel.axisError / axisTolerance;
      if (!worst || score > worst.score) {
        worst = { path: joint.primPath, anchor, axis: rel.axisError, score };
      }
    }
    if (!worst) return;
    this.bakedDebugWarned = true;
    console.warn(
      `three-usd-robot: baked poses deviate from ${count} joint constraint(s) — worst ` +
        `${worst.path}: anchor ${(worst.anchor * 1e3).toFixed(3)} mm, axis ` +
        `${worst.axis.toFixed(4)} rad (recording/model mismatch? warned once per baked session)`,
    );
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

  /**
   * Names of the commandable joints — articulated tree joints minus mimic
   * followers, whose values derive from their leader
   * (see {@link getMimicJointNames}).
   */
  getJointNames(): string[] {
    return [...this.jointObjects.keys()].filter((key) => !this.mimicLeaderByFollower.has(key));
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

  /**
   * Sample every animated joint at time code `t` and apply the values (an fk
   * drive — leaves baked mode). Samples on mimic followers are ignored; the
   * constraint re-derives them from their leader.
   */
  setTime(t: number): void {
    this.exitBakedMode();
    for (const [key, joint] of Object.entries(this.robot.joints)) {
      if (!joint.valueSamples || this.mimicLeaderByFollower.has(key)) continue;
      this.setJointValue(key, interpolate(joint.valueSamples, t));
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

const UNIT_SCALE = new THREE.Vector3(1, 1, 1);
const IDENTITY4: Mat4 = identity4();
/** Slack for `limitExceeded` so poses exactly at a limit round-trip clean. */
const LIMIT_EPS = 1e-9;

/** Assign a fixed local matrix to an object (disables Three.js auto-update). */
function setMatrix(obj: THREE.Object3D, m: Mat4): void {
  obj.matrixAutoUpdate = false;
  obj.matrix.fromArray(m);
  obj.matrixWorldNeedsUpdate = true;
}
