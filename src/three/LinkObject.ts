import * as THREE from "three";
import type { LinkDescription } from "../robot/RobotDescription.js";

/**
 * Three.js node for a robot link. Its frame is the USD link prim's frame;
 * visual/collision meshes (M6) attach as children relative to it. Placement
 * relative to the parent is supplied by the joint chain, so a link's own local
 * matrix is identity (except the root, which carries the world-fixed placement).
 */
export class LinkObject extends THREE.Object3D {
  readonly isLinkObject = true;
  readonly linkName: string;
  readonly primPath: string;

  constructor(link: LinkDescription) {
    super();
    this.name = link.name;
    this.linkName = link.name;
    this.primPath = link.primPath;
    // Placement comes from the parent joint chain; keep the local matrix fixed.
    this.matrixAutoUpdate = false;
  }
}
