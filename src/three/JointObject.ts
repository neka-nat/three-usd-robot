import * as THREE from "three";
import type { Axis, JointDescription, JointType } from "../robot/RobotDescription.js";
import { axisVector } from "./axis.js";

/**
 * The articulated "motion" node of a joint, inserted between the joint's two
 * fixed frames (`jointFrame0` and `inverse(jointFrame1)`). {@link setValue}
 * rotates it about the axis (revolute/continuous) or slides it along the axis
 * (prismatic); fixed joints are inert.
 */
export class JointObject extends THREE.Object3D {
  readonly isJointObject = true;
  readonly jointName: string;
  readonly jointType: JointType;
  readonly axisToken: Axis;
  readonly axis: THREE.Vector3;
  readonly lower: number | undefined;
  readonly upper: number | undefined;

  private _value = 0;

  constructor(joint: JointDescription) {
    super();
    this.name = joint.name;
    this.jointName = joint.name;
    this.jointType = joint.type;
    this.axisToken = joint.axis;
    this.axis = axisVector(joint.axis);
    this.lower = joint.lower;
    this.upper = joint.upper;
  }

  get value(): number {
    return this._value;
  }

  get articulated(): boolean {
    return this.jointType !== "fixed";
  }

  /**
   * Set the joint value (radians for revolute/continuous, length for prismatic).
   * Optionally clamps to authored limits. Returns the value actually applied.
   */
  setValue(value: number, clampToLimits = true): number {
    if (!this.articulated) return this._value; // fixed joint: inert

    let v = value;
    if (clampToLimits) {
      if (this.lower !== undefined && v < this.lower) v = this.lower;
      if (this.upper !== undefined && v > this.upper) v = this.upper;
    }
    this._value = v;

    if (this.jointType === "prismatic") {
      this.position.copy(this.axis).multiplyScalar(v);
      this.quaternion.identity();
    } else {
      this.quaternion.setFromAxisAngle(this.axis, v);
      this.position.set(0, 0, 0);
    }
    return v;
  }
}
