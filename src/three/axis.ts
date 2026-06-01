import * as THREE from "three";
import type { Axis } from "../robot/RobotDescription.js";

/** Unit vector for a USD joint axis token. Returns a fresh vector each call. */
export function axisVector(axis: Axis): THREE.Vector3 {
  switch (axis) {
    case "X":
      return new THREE.Vector3(1, 0, 0);
    case "Y":
      return new THREE.Vector3(0, 1, 0);
    case "Z":
      return new THREE.Vector3(0, 0, 1);
  }
}
