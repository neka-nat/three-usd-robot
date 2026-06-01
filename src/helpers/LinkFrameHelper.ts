import * as THREE from "three";

/** A small RGB axes gizmo for a link's local frame. Add it to a `LinkObject`. */
export class LinkFrameHelper extends THREE.AxesHelper {
  readonly isLinkFrameHelper = true;

  constructor(size = 0.2) {
    super(size);
    this.name = "linkFrame";
  }
}
