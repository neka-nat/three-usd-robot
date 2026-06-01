import * as THREE from "three";
import type { JointObject } from "../three/JointObject.js";

/**
 * Visualizes a joint's range of motion: an arc swept between the lower and
 * upper limits (revolute/continuous) or a line segment between them
 * (prismatic). A limitless revolute joint draws a full circle. Add it to the
 * joint's motion node's parent frame (or the joint node) to anchor it.
 */
export class JointLimitHelper extends THREE.Line {
  readonly isJointLimitHelper = true;

  constructor(joint: JointObject, radius = 0.15, color: THREE.ColorRepresentation = 0x00aaff) {
    super(buildLimitGeometry(joint, radius), new THREE.LineBasicMaterial({ color }));
    this.name = `${joint.jointName}:limit`;
  }
}

function buildLimitGeometry(joint: JointObject, radius: number): THREE.BufferGeometry {
  const axis = joint.axis.clone().normalize();

  if (joint.jointType === "prismatic") {
    const lo = joint.lower ?? -radius;
    const hi = joint.upper ?? radius;
    return new THREE.BufferGeometry().setFromPoints([
      axis.clone().multiplyScalar(lo),
      axis.clone().multiplyScalar(hi),
    ]);
  }

  // Revolute / continuous: sweep an arc in the plane perpendicular to the axis.
  const lo = joint.lower ?? 0;
  const hi = joint.upper ?? Math.PI * 2;
  const { u, v } = perpendicularBasis(axis);
  const segments = 48;
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = lo + ((hi - lo) * i) / segments;
    points.push(
      u
        .clone()
        .multiplyScalar(Math.cos(t) * radius)
        .addScaledVector(v, Math.sin(t) * radius),
    );
  }
  return new THREE.BufferGeometry().setFromPoints(points);
}

function perpendicularBasis(axis: THREE.Vector3): { u: THREE.Vector3; v: THREE.Vector3 } {
  const ref = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(axis, ref).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u).normalize();
  return { u, v };
}
