/**
 * XR origin rig. The camera and the XR controller spaces hang off one Group;
 * three composes the group's `matrixWorld` into the XR camera and controller
 * poses (`WebXRManager.updateCamera`), so moving / rotating / scaling the
 * group moves the player.
 *
 * Coordinate contract (see docs/xr.md): the WebXR reference space is Y-up
 * with the floor at y = 0 (`local-floor`). A Z-up application world is
 * handled by rotating this origin by +90° about X — content is never
 * rotated, so controller `matrixWorld`s land directly in application-world
 * coordinates and nothing between the scene graph and XR needs converting.
 */

import * as THREE from "three";
import { onXrInput } from "./events.js";

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

export type XrOriginPlacementOptions = {
  /** Up axis of the application world (default `"Y"`). */
  worldUp?: XrWorldUp;
  /** Where the player's feet go (world). */
  standAt: THREE.Vector3;
  /** What the player faces (world); omitted keeps `yaw`. */
  lookAt?: THREE.Vector3;
  /**
   * The head's pose in the XR reference space (the XR camera's local
   * `position` / `quaternion`): the feet are placed under it and the heading
   * accounts for where the head currently looks. Omitted = at the origin, looking −Z.
   */
  head?: { position: THREE.Vector3; quaternion: THREE.Quaternion };
  /** Yaw to keep when `lookAt` is omitted (radians, default `0`). */
  yaw?: number;
  /** Origin scale (default `1`). */
  playerScale?: number;
  /** For a `"local"` reference space: how far the floor is below the origin (m). */
  floorOffset?: number;
};

/**
 * The origin transform that stands the player at `standAt` facing `lookAt` —
 * the math behind {@link XrOriginRig.recenter}, for origins owned elsewhere
 * (an `@react-three/xr` `<XROrigin>`, say):
 *
 * ```tsx
 * const { position, quaternion } = xrOriginPlacement({ worldUp: "Z", standAt, lookAt, head: xrCamera });
 * <XROrigin position={position} quaternion={quaternion} />
 * ```
 */
export function xrOriginPlacement(options: XrOriginPlacementOptions): {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  yaw: number;
} {
  const base = xrOriginQuaternion(options.worldUp ?? "Y");
  const scale = options.playerScale ?? 1;
  const headPosition = options.head?.position ?? new THREE.Vector3();
  const headQuaternion = options.head?.quaternion ?? new THREE.Quaternion();
  let yaw = options.yaw ?? 0;
  if (options.lookAt) {
    const dir = options.lookAt.clone().sub(options.standAt).applyQuaternion(base.clone().invert());
    dir.y = 0;
    if (dir.lengthSq() > 1e-12) {
      const f = LOCAL_FORWARD.clone().applyQuaternion(headQuaternion);
      yaw = Math.atan2(-dir.x, -dir.z) - Math.atan2(-f.x, -f.z);
    }
  }
  const quaternion = base.clone().multiply(new THREE.Quaternion().setFromAxisAngle(LOCAL_Y, yaw));
  const headFloorOffset = new THREE.Vector3(headPosition.x, 0, headPosition.z)
    .multiplyScalar(scale)
    .applyQuaternion(quaternion);
  const position = options.standAt
    .clone()
    .sub(headFloorOffset)
    .addScaledVector(LOCAL_Y.clone().applyQuaternion(base), (options.floorOffset ?? 0) * scale);
  return { position, quaternion, yaw };
}

export class XrOriginRig extends THREE.Group {
  readonly isXrOriginRig = true;
  readonly camera: THREE.Camera;
  readonly worldUp: XrWorldUp;
  /** Target-ray spaces, by renderer slot (slots are not handedness — see {@link controller}). */
  readonly controllers: THREE.XRTargetRaySpace[] = [];
  readonly grips: THREE.XRGripSpace[] = [];
  readonly hands: THREE.XRHandSpace[] = [];
  readonly floorOffset: number;

  private readonly baseQuaternion: THREE.Quaternion;
  private readonly handednessByObject = new Map<THREE.Object3D, XRHandedness>();
  private readonly subscriptions: (() => void)[] = [];
  private _yaw = 0;
  private _playerScale = 1;

  constructor(
    renderer: { xr: XrManagerLike },
    camera: THREE.Camera,
    options: XrOriginRigOptions = {},
  ) {
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
      const hand = options.hands ? renderer.xr.getHand(i) : null;
      this.add(controller, grip);
      this.controllers.push(controller);
      this.grips.push(grip);
      if (hand) {
        this.add(hand);
        this.hands.push(hand);
      }
      // Slots are assigned in input-source order, which differs between
      // runtimes; handedness arrives with the `connected` event.
      const spaces = hand ? [controller, grip, hand] : [controller, grip];
      const track = (handedness: XRHandedness | undefined) => {
        for (const space of spaces) {
          if (handedness) this.handednessByObject.set(space, handedness);
          else this.handednessByObject.delete(space);
        }
      };
      this.subscriptions.push(
        onXrInput(controller, "connected", (event) => track(event.data?.handedness)),
        onXrInput(controller, "disconnected", () => track(undefined)),
      );
    }
  }

  /** Handedness of a controller / grip / hand space, once its input source connected. */
  handednessOf(space: THREE.Object3D): XRHandedness | undefined {
    return this.handednessByObject.get(space);
  }

  /** The target-ray space of the given hand, if connected. */
  controller(hand: XRHandedness): THREE.XRTargetRaySpace | undefined {
    return this.controllers.find((c) => this.handednessByObject.get(c) === hand);
  }

  /** The grip space of the given hand, if connected. */
  grip(hand: XRHandedness): THREE.XRGripSpace | undefined {
    return this.grips.find((g) => this.handednessByObject.get(g) === hand);
  }

  /** The hand space of the given hand, if claimed (`hands: true`) and connected. */
  hand(hand: XRHandedness): THREE.XRHandSpace | undefined {
    return this.hands.find((h) => this.handednessByObject.get(h) === hand);
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

  /**
   * 1 = life size. Larger values shrink the world (tabletop view) while
   * every measurement stays in model units. Objects parented to the rig scale
   * with the player; keep labels as plain geometry (three's sprites size
   * themselves from world scale and come out `playerScale` times too large).
   */
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
    this.place(standAt, lookAt);
  }

  /** Move the player's feet to `standAt` (world), keeping the heading. */
  teleport(standAt: THREE.Vector3): void {
    this.place(standAt);
  }

  private place(standAt: THREE.Vector3, lookAt?: THREE.Vector3): void {
    const placement = xrOriginPlacement({
      worldUp: this.worldUp,
      standAt,
      ...(lookAt ? { lookAt } : {}),
      head: { position: this.camera.position, quaternion: this.camera.quaternion },
      yaw: this._yaw,
      playerScale: this._playerScale,
      floorOffset: this.floorOffset,
    });
    this._yaw = placement.yaw;
    this.quaternion.copy(placement.quaternion);
    this.position.copy(placement.position);
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

  /** Drop the input-source subscriptions and leave the scene (the controller spaces stay with the renderer). */
  override dispose(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.length = 0;
    this.handednessByObject.clear();
    this.removeFromParent();
    super.dispose?.(); // r186+ fires the `dispose` event; older releases have no base method
  }
}
