import * as THREE from "three";
import type { JointObject } from "../three/JointObject.js";

/**
 * An arrow drawn along a joint's motion axis (the rotation axis for
 * revolute/continuous joints, the slide direction for prismatic). Add it to the
 * joint's motion node so it tracks the joint.
 */
export class JointAxisHelper extends THREE.ArrowHelper {
  readonly isJointAxisHelper = true;

  constructor(joint: JointObject, length = 0.2, color: THREE.ColorRepresentation = 0xffd000) {
    super(joint.axis.clone().normalize(), new THREE.Vector3(0, 0, 0), length, color);
    this.name = `${joint.jointName}:axis`;
  }
}
