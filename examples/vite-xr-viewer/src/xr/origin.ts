/**
 * XR origin rig — the shape proposed for `three-usd-robot/xr` (xr-design
 * §4.2). The camera and the XR controller spaces hang off one Group; three
 * composes the group's `matrixWorld` into the XR camera and controller poses
 * (`WebXRManager.updateCamera`), so moving / rotating / scaling the group moves
 * the player.
 *
 * Coordinate contract (xr-design §3): the WebXR reference space is Y-up with
 * the floor at y = 0 (`local-floor`). A Z-up application world is handled by
 * rotating this origin by +90° about X — content is never rotated, so
 * controller `matrixWorld`s land directly in application-world coordinates.
 */

import * as THREE from "three";

export type XrWorldUp = "Y" | "Z";

/** Rotation that maps the XR reference space's +Y (up) onto the world's up axis. */
export function xrOriginQuaternion(worldUp: XrWorldUp): THREE.Quaternion {
  const q = new THREE.Quaternion();
  if (worldUp === "Z") q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  return q;
}

export type XrOriginRigOptions = {
  /** Up axis of the application world (default `"Y"`). */
  worldUp?: XrWorldUp;
  /** Controller slots to claim from the renderer (default `2`). */
  controllers?: 0 | 1 | 2;
  /** Also claim the hand spaces (default `false`). */
  hands?: boolean;
  /** Reference space to request (default `"local-floor"`). */
  referenceSpace?: XRReferenceSpaceType;
  /** With a `"local"` reference space the origin sits at head height: the floor is this far below (m). */
  floorOffset?: number;
};

/** The slice of `WebXRManager` the rig needs (so tests can pass a stub). */
export type XrManagerLike = Pick<
  THREE.WebXRManager,
  "getController" | "getControllerGrip" | "getHand" | "setReferenceSpaceType"
>;

const LOCAL_Y = new THREE.Vector3(0, 1, 0);
const LOCAL_FORWARD = new THREE.Vector3(0, 0, -1);

export class XrOriginRig extends THREE.Group {
  readonly camera: THREE.Camera;
  readonly worldUp: XrWorldUp;
  readonly controllers: THREE.XRTargetRaySpace[] = [];
  readonly grips: THREE.XRGripSpace[] = [];
  readonly hands: THREE.XRHandSpace[] = [];
  readonly floorOffset: number;

  private readonly baseQuaternion: THREE.Quaternion;
  private _yaw = 0;
  private _playerScale = 1;

  constructor(renderer: { xr: XrManagerLike }, camera: THREE.Camera, options: XrOriginRigOptions = {}) {
    super();
    this.name = "xrOrigin";
    this.camera = camera;
    this.worldUp = options.worldUp ?? "Y";
    this.floorOffset = options.floorOffset ?? 0;
    this.baseQuaternion = xrOriginQuaternion(this.worldUp);
    this.quaternion.copy(this.baseQuaternion);
    this.add(camera);
    renderer.xr.setReferenceSpaceType(options.referenceSpace ?? "local-floor");
    const count = options.controllers ?? 2;
    for (let i = 0; i < count; i++) {
      const controller = renderer.xr.getController(i);
      const grip = renderer.xr.getControllerGrip(i);
      this.add(controller, grip);
      this.controllers.push(controller);
      this.grips.push(grip);
      if (options.hands) {
        const hand = renderer.xr.getHand(i);
        this.add(hand);
        this.hands.push(hand);
      }
    }
  }

  /** Unit world-up vector. */
  upVector(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(LOCAL_Y).applyQuaternion(this.baseQuaternion);
  }

  /** Yaw of the rig about the world up axis (radians), on top of the up-axis rotation. */
  get yaw(): number {
    return this._yaw;
  }
  set yaw(value: number) {
    this._yaw = value;
    this.quaternion
      .copy(this.baseQuaternion)
      .multiply(new THREE.Quaternion().setFromAxisAngle(LOCAL_Y, value));
  }

  /** 1 = life size. Larger values shrink the world (tabletop view); measurements stay in model units. */
  get playerScale(): number {
    return this._playerScale;
  }
  set playerScale(value: number) {
    this._playerScale = value;
    this.scale.setScalar(value);
  }

  /**
   * World-space offset from the rig's floor origin to the point on the floor
   * under the head. `camera.position` is rig-local — three writes the XR pose
   * into it every frame.
   */
  headFloorOffset(out = new THREE.Vector3()): THREE.Vector3 {
    return out
      .set(this.camera.position.x, 0, this.camera.position.z)
      .multiplyScalar(this._playerScale)
      .applyQuaternion(this.quaternion);
  }

  /** Yaw of the head's forward direction within the rig (radians). */
  headYaw(): number {
    const f = LOCAL_FORWARD.clone().applyQuaternion(this.camera.quaternion);
    return Math.atan2(-f.x, -f.z);
  }

  /**
   * Put the player's feet at `standAt` (world) and, with `lookAt`, turn the
   * rig so the head currently faces that point (yaw only). Call once the XR
   * camera pose is valid — after the first rendered XR frame.
   */
  recenter(standAt: THREE.Vector3, lookAt?: THREE.Vector3): void {
    if (lookAt) {
      // Desired horizontal heading, expressed in the up-neutral (base) frame.
      const dir = lookAt.clone().sub(standAt).applyQuaternion(this.baseQuaternion.clone().invert());
      dir.y = 0;
      if (dir.lengthSq() > 1e-12) this.yaw = Math.atan2(-dir.x, -dir.z) - this.headYaw();
    }
    this.teleport(standAt);
  }

  /** Move the player's feet to `standAt` (world), keeping the heading. */
  teleport(standAt: THREE.Vector3): void {
    this.position
      .copy(standAt)
      .sub(this.headFloorOffset())
      .addScaledVector(this.upVector(), this.floorOffset * this._playerScale);
    this.updateMatrixWorld(true);
  }

  /** Reset to the reference-space origin: identity placement, life size. */
  reset(): void {
    this.position.set(0, 0, 0);
    this.yaw = 0;
    this.playerScale = 1;
    this.updateMatrixWorld(true);
  }

  /** A pose in the XR reference space (e.g. from `XRFrame.getPose`) → application world. */
  toWorld(transform: XRRigidTransform | THREE.Matrix4, out = new THREE.Matrix4()): THREE.Matrix4 {
    const local =
      transform instanceof THREE.Matrix4
        ? transform
        : new THREE.Matrix4().fromArray(transform.matrix);
    return out.multiplyMatrices(this.matrixWorld, local);
  }
}
