/**
 * Teaching, stage 2 — a demo-grade inverse kinematics solver so the arm
 * follows the TCP target handle while it is held.
 *
 * Damped least squares on the geometric Jacobian of the articulated chain
 * from the robot root to the tool link, in world space:
 *
 *     Δq = Jᵀ (J Jᵀ + λ² I)⁻¹ e
 *
 * `e` is the position error (metres) and, when the chain has six or more
 * degrees of freedom, the orientation error (a rotation vector) scaled by a
 * weak weight — position first, orientation as far as the arm allows. A few
 * iterations per frame are enough to track a hand; each iteration recomputes
 * the chain's world matrices only (not the meshes). Joint limits come from
 * the robot (`setJointValue` clamps); a joint pinned at its limit while the
 * step pushes it further is dropped from the Jacobian for that iteration so
 * the others take over. A weak null-space pull towards the middle of each
 * joint's range keeps a redundant arm (the Franka's 7th axis) from drifting;
 * on a pinned joint that pull is the only motion left, so the joint creeps
 * back inside its range — which is also what walks the arm out of the
 * straight-arm singularity the Franka's all-zero pose starts in (elbow at its
 * limit, no first-order way to shorten the arm).
 *
 * This is an example, not a library feature: a real application brings its
 * own solver and feeds it the handle's poses the same way (`getPose("world")`).
 */

import * as THREE from "three";
import type { JointObject, KinematicNode, LinkPose, ThreeUsdRobot } from "three-usd-robot";

export type DemoIkOptions = {
  /** Iterations per `solve` (default `10`). */
  iterations?: number;
  /** Damping λ of the least-squares step (default `0.05`). */
  damping?: number;
  /**
   * Weight of the orientation rows against the position rows (default `0.3`).
   * `0` tracks position only; orientation is skipped anyway on a chain with
   * fewer than six degrees of freedom.
   */
  orientationWeight?: number;
  /** Largest joint step per iteration, radians or metres (default `0.25`). */
  maxStep?: number;
  /** Position error that counts as reached, metres (default `0.003`). */
  positionTolerance?: number;
  /** Orientation error that counts as reached, radians (default `0.05`). */
  orientationTolerance?: number;
  /** Null-space pull towards the middle of each joint's range, per iteration (default `0.02`; `0` = off). */
  centering?: number;
  /**
   * How far every limited joint leans towards the middle of its range when
   * an iteration makes no progress on a folding move (default `0.05`; `0` =
   * off) — the way out of a straight-arm singularity.
   */
  escape?: number;
};

export type DemoIkResult = {
  /** Both errors within tolerance (orientation only if tracked). */
  converged: boolean;
  /** Distance between the tool link and the target after the solve (metres). */
  positionError: number;
  /** Angle between the tool link and the target after the solve (radians; `0` when orientation is not tracked). */
  orientationError: number;
  /** Iterations actually run. */
  iterations: number;
};

type ChainJoint = {
  joint: JointObject;
  /** The joint's fixed frame in the parent link: anchor and axis live here. */
  frame0: THREE.Object3D;
  prismatic: boolean;
  lower: number | undefined;
  upper: number | undefined;
};

const POSITION_STEP = 0.1; // metres of target pull per iteration (keeps the linearization honest)
const ORIENTATION_STEP = 0.5; // radians

export class DemoIk {
  readonly robot: ThreeUsdRobot;
  /** Prim path of the tool link. */
  readonly toolLink: string;
  /** Joint prim paths, base first. */
  readonly jointPaths: string[];
  /** Whether the orientation rows are part of the solve. */
  readonly tracksOrientation: boolean;

  private readonly tool: THREE.Object3D;
  /** The tool's ancestors inside the robot, root side first (the FK chain). */
  private readonly path: THREE.Object3D[];
  private readonly chain: ChainJoint[];
  private readonly options: Required<DemoIkOptions>;
  private _last: DemoIkResult | null = null;

  constructor(robot: ThreeUsdRobot, toolLink: string, options: DemoIkOptions = {}) {
    const tool = robot.getLinkObject(toolLink);
    if (!tool) throw new Error(`unknown tool link "${toolLink}"`);
    this.robot = robot;
    this.tool = tool;
    this.toolLink = tool.primPath;
    this.options = {
      iterations: options.iterations ?? 10,
      damping: options.damping ?? 0.05,
      orientationWeight: options.orientationWeight ?? 0.3,
      maxStep: options.maxStep ?? 0.25,
      positionTolerance: options.positionTolerance ?? 0.003,
      orientationTolerance: options.orientationTolerance ?? 0.05,
      centering: options.centering ?? 0.02,
      escape: options.escape ?? 0.05,
    };
    this.chain = buildChain(robot, tool.linkName);
    this.jointPaths = this.chain.map((c) => c.joint.primPath);
    const path: THREE.Object3D[] = [];
    for (let o: THREE.Object3D | null = tool; o && o !== robot; o = o.parent) path.push(o);
    this.path = path.reverse();
    this.tracksOrientation = this.options.orientationWeight > 0 && this.chain.length >= 6;
  }

  /** Number of joints the solver drives. */
  get dof(): number {
    return this.chain.length;
  }

  /** The most recent result, if any. */
  get last(): DemoIkResult | null {
    return this._last;
  }

  /** Current joint values by prim path (for undoing a solve). */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.chain.map((c) => [c.joint.primPath, c.joint.value]));
  }

  /**
   * Move the joints so the tool link approaches `target` (world space) and
   * report how close it got. Writes through `robot.setJointValue`, so limits
   * and mimic followers behave as everywhere else.
   */
  solve(target: THREE.Matrix4 | LinkPose, iterations = this.options.iterations): DemoIkResult {
    const targetPosition = new THREE.Vector3();
    const targetRotation = new THREE.Quaternion();
    if (target instanceof THREE.Matrix4) {
      target.decompose(targetPosition, targetRotation, new THREE.Vector3());
    } else {
      targetPosition.set(...target.position);
      targetRotation.set(...target.quaternion);
    }

    const n = this.chain.length;
    const rows = this.tracksOrientation ? 6 : 3;
    const { damping, maxStep, positionTolerance, orientationTolerance, orientationWeight } =
      this.options;

    const toolPosition = new THREE.Vector3();
    const toolRotation = new THREE.Quaternion();
    const error = new Array<number>(rows).fill(0);
    const errorRotation = new THREE.Quaternion();
    const errorAxis = new THREE.Vector3();
    const anchor = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const lever = new THREE.Vector3();
    const linear = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const jacobian: number[][] = Array.from({ length: rows }, () => new Array<number>(n).fill(0));
    const centering = new Array<number>(n).fill(0);

    let positionError = 0;
    let orientationError = 0;
    let best = Number.POSITIVE_INFINITY;
    let done = 0;
    let converged = false;

    const measure = (): void => {
      this.refreshChain();
      this.tool.matrixWorld.decompose(toolPosition, toolRotation, scale);
      positionError = toolPosition.distanceTo(targetPosition);
      orientationError = this.tracksOrientation ? toolRotation.angleTo(targetRotation) : 0;
      converged =
        positionError <= positionTolerance &&
        (!this.tracksOrientation || orientationError <= orientationTolerance);
    };

    if (n === 0) {
      measure();
      this._last = { converged, positionError, orientationError, iterations: 0 };
      return this._last;
    }

    for (let iteration = 0; iteration < iterations; iteration++) {
      measure();
      if (converged) break;
      done++;

      // Error vector, pulled towards the target by at most one step.
      const delta = targetPosition.clone().sub(toolPosition);
      if (delta.length() > POSITION_STEP) delta.setLength(POSITION_STEP);

      // No progress since the last iteration while the target asks the arm to
      // fold (error pointing back towards its first joint): a straight arm
      // cannot shorten to first order, so lean every limited joint a little
      // towards the middle of its range and try again from there.
      const stalled = positionError >= best - 1e-6;
      best = Math.min(best, positionError);
      if (stalled && this.options.escape > 0) {
        anchor.setFromMatrixPosition(this.chain[0]!.frame0.matrixWorld);
        const folding = delta.dot(lever.copy(toolPosition).sub(anchor)) < 0;
        if (folding) {
          for (const c of this.chain) {
            if (c.lower === undefined || c.upper === undefined) continue;
            const mid = (c.lower + c.upper) / 2;
            this.robot.setJointValue(c.joint.primPath, c.joint.value + this.options.escape * (mid - c.joint.value));
          }
          continue;
        }
      }

      error[0] = delta.x;
      error[1] = delta.y;
      error[2] = delta.z;
      if (this.tracksOrientation) {
        errorRotation.copy(targetRotation).multiply(toolRotation.clone().invert()).normalize();
        if (errorRotation.w < 0) {
          errorRotation.set(-errorRotation.x, -errorRotation.y, -errorRotation.z, -errorRotation.w);
        }
        errorAxis.set(errorRotation.x, errorRotation.y, errorRotation.z);
        const sin = errorAxis.length();
        let angle = 2 * Math.atan2(sin, errorRotation.w);
        if (sin > 1e-9) errorAxis.divideScalar(sin);
        else errorAxis.set(0, 0, 0);
        if (angle > ORIENTATION_STEP) angle = ORIENTATION_STEP;
        errorAxis.multiplyScalar(angle * orientationWeight);
        error[3] = errorAxis.x;
        error[4] = errorAxis.y;
        error[5] = errorAxis.z;
      }

      // Geometric Jacobian in world space. The chain's world matrices are
      // current: `measure()` refreshed the tool's ancestors.
      for (let i = 0; i < n; i++) {
        const c = this.chain[i]!;
        anchor.setFromMatrixPosition(c.frame0.matrixWorld);
        axis.copy(c.joint.axis).transformDirection(c.frame0.matrixWorld);
        if (c.prismatic) {
          // The joint slides in its own (stage-unit) frame: scale to metres.
          linear.copy(axis).multiplyScalar(scale.setFromMatrixScale(c.frame0.matrixWorld).x);
          axis.set(0, 0, 0); // no rotation
        } else {
          lever.copy(toolPosition).sub(anchor);
          linear.crossVectors(axis, lever);
        }
        jacobian[0]![i] = linear.x;
        jacobian[1]![i] = linear.y;
        jacobian[2]![i] = linear.z;
        if (this.tracksOrientation) {
          jacobian[3]![i] = axis.x * orientationWeight;
          jacobian[4]![i] = axis.y * orientationWeight;
          jacobian[5]![i] = axis.z * orientationWeight;
        }
        // Null-space goal: the middle of the range, for joints that have one.
        const mid = c.lower !== undefined && c.upper !== undefined ? (c.lower + c.upper) / 2 : null;
        centering[i] = mid === null ? 0 : this.options.centering * (mid - c.joint.value);
      }

      const step = limitedStep(this.chain, jacobian, error, damping, centering);
      for (let i = 0; i < n; i++) {
        const c = this.chain[i]!;
        const dq = THREE.MathUtils.clamp(step[i]!, -maxStep, maxStep);
        this.robot.setJointValue(c.joint.primPath, c.joint.value + dq);
      }
    }
    if (done === iterations) measure(); // the final step has not been measured yet

    this._last = { converged, positionError, orientationError, iterations: done };
    return this._last;
  }

  /**
   * Recompute the world matrices along the FK chain only — the meshes wait for
   * the render. Done by hand: since r186 `updateWorldMatrix(true, false)`
   * skips ancestors whose own transform did not change, so a joint turned
   * higher up would leave the links below it stale.
   */
  private refreshChain(): void {
    this.robot.updateWorldMatrix(true, false);
    for (const o of this.path) {
      if (o.matrixAutoUpdate) o.updateMatrix();
      if (o.parent) o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix);
    }
  }
}

/** Articulated, drivable joints from the root down to `linkKey`. */
function buildChain(robot: ThreeUsdRobot, linkKey: string): ChainJoint[] {
  const chain: ChainJoint[] = [];
  let node: KinematicNode | undefined = robot.tree.nodes[linkKey];
  while (node) {
    const jointKey = node.jointToParent;
    const joint = jointKey ? robot.getJointObject(jointKey) : undefined;
    if (joint?.articulated && jointKey && !robot.isMimicFollower(jointKey) && joint.parent) {
      chain.push({
        joint,
        frame0: joint.parent,
        prismatic: joint.jointType === "prismatic",
        lower: joint.lower,
        upper: joint.upper,
      });
    }
    node = node.parent ? robot.tree.nodes[node.parent] : undefined;
  }
  return chain.reverse();
}

/**
 * A damped least-squares step that respects the joint limits: a joint the step
 * would drive past its limit is frozen at the limit (keeping only the travel
 * it has left), the error that travel covers is taken out, and the others are
 * solved again for the rest — up to once per joint. Without this a clamped
 * joint leaves the other joints' steps inconsistent, and the arm oscillates
 * against the limit. Frozen joints keep their centering term, which is now
 * unprojected: the only motion left to them is back inside their range.
 */
function limitedStep(
  chain: ChainJoint[],
  jacobian: number[][],
  error: number[],
  damping: number,
  centering: number[],
): number[] {
  const n = chain.length;
  const working = jacobian.map((row) => row.slice());
  const residual = error.slice();
  const goal = centering.slice();
  const frozen = new Array<number | null>(n).fill(null);
  let step = dampedStep(working, residual, damping, goal);
  for (let pass = 0; pass < n; pass++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (frozen[i] !== null) continue;
      const c = chain[i]!;
      const q = c.joint.value;
      const wanted = step[i]!;
      const allowed =
        wanted > 0 && c.upper !== undefined
          ? Math.min(wanted, Math.max(0, c.upper - q))
          : wanted < 0 && c.lower !== undefined
            ? Math.max(wanted, Math.min(0, c.lower - q))
            : wanted;
      if (Math.abs(allowed - wanted) <= 1e-9) continue;
      // Freeze at the limit: consume the error its remaining travel covers,
      // drop the column, keep the (now unprojected) centering pull.
      for (let r = 0; r < residual.length; r++) {
        residual[r]! -= jacobian[r]![i]! * allowed;
        working[r]![i] = 0;
      }
      frozen[i] = allowed + goal[i]!;
      changed = true;
    }
    if (!changed) break;
    step = dampedStep(working, residual, damping, goal);
  }
  return step.map((v, i) => frozen[i] ?? v);
}

/**
 * One damped least-squares step with a null-space term:
 * `Δq = J⁺ e + (I − J⁺ J) c`, `J⁺ = Jᵀ (J Jᵀ + λ² I)⁻¹`.
 */
function dampedStep(jacobian: number[][], error: number[], damping: number, centering: number[]): number[] {
  const m = jacobian.length;
  const n = jacobian[0]?.length ?? 0;
  // A = J Jᵀ + λ² I
  const a: number[][] = Array.from({ length: m }, (_, r) =>
    Array.from({ length: m }, (_, c) => {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += jacobian[r]![k]! * jacobian[c]![k]!;
      return sum + (r === c ? damping * damping : 0);
    }),
  );
  // Right-hand sides: the error, and J·c for the null-space projection.
  const jc = new Array<number>(m).fill(0);
  for (let r = 0; r < m; r++) {
    for (let k = 0; k < n; k++) jc[r]! += jacobian[r]![k]! * centering[k]!;
  }
  const y = solveLinear(a, [error.slice(), jc]);
  const ye = y[0]!;
  const yc = y[1]!;
  const step = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k++) {
    let primary = 0;
    let projected = 0;
    for (let r = 0; r < m; r++) {
      primary += jacobian[r]![k]! * ye[r]!;
      projected += jacobian[r]![k]! * yc[r]!;
    }
    step[k] = primary + (centering[k]! - projected);
  }
  return step;
}

/** Gaussian elimination with partial pivoting for several right-hand sides. */
function solveLinear(a: number[][], rhs: number[][]): number[][] {
  const m = a.length;
  const matrix = a.map((row) => row.slice());
  const b = rhs.map((v) => v.slice());
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(matrix[r]![col]!) > Math.abs(matrix[pivot]![col]!)) pivot = r;
    }
    if (pivot !== col) {
      [matrix[col], matrix[pivot]] = [matrix[pivot]!, matrix[col]!];
      for (const v of b) [v[col], v[pivot]] = [v[pivot]!, v[col]!];
    }
    const diag = matrix[col]![col]!;
    if (Math.abs(diag) < 1e-12) continue; // damping keeps A positive definite; guard anyway
    for (let r = col + 1; r < m; r++) {
      const f = matrix[r]![col]! / diag;
      if (f === 0) continue;
      for (let c = col; c < m; c++) matrix[r]![c]! -= f * matrix[col]![c]!;
      for (const v of b) v[r]! -= f * v[col]!;
    }
  }
  return b.map((v) => {
    const x = new Array<number>(m).fill(0);
    for (let r = m - 1; r >= 0; r--) {
      let sum = v[r]!;
      for (let c = r + 1; c < m; c++) sum -= matrix[r]![c]! * x[c]!;
      const diag = matrix[r]![r]!;
      x[r] = Math.abs(diag) < 1e-12 ? 0 : sum / diag;
    }
    return x;
  });
}
