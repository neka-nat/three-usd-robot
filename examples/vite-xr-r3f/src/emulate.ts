/**
 * Headset emulation for desktop development and headless checks (IWER —
 * Meta's Immersive Web Emulation Runtime), installed before the XR store is
 * created. `@react-three/xr` can inject IWER itself on localhost, but it
 * does not force the install over headless Chromium's device-less
 * `navigator.xr`, and the device object is needed for scripted input — so
 * the viewer owns the emulator and tells the store not to emulate.
 */

import type { XRDevice } from "iwer";
import * as THREE from "three";

export type Emulator = XRDevice;

export async function installEmulator(): Promise<Emulator> {
  const { XRDevice, metaQuest3 } = await import("iwer");
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true });
  device.stereoEnabled = true;
  device.position.set(0, 1.6, 0);
  device.controllers.left?.position.set(-0.25, 1.25, -0.35);
  device.controllers.right?.position.set(0.25, 1.25, -0.35);
  return device;
}

const DEFAULT_HAND_POSITION = {
  left: new THREE.Vector3(-0.25, 1.25, -0.35),
  right: new THREE.Vector3(0.25, 1.25, -0.35),
};

/** Point an emulated controller's ray at a world-space target. Emulator poses are origin-local. */
export function aimEmulatedController(
  device: Emulator,
  origin: THREE.Object3D,
  hand: "left" | "right",
  target: THREE.Vector3,
  from?: THREE.Vector3,
): void {
  const controller = device.controllers[hand];
  if (!controller) return;
  const start = from ?? DEFAULT_HAND_POSITION[hand];
  controller.position.set(start.x, start.y, start.z);
  origin.updateWorldMatrix(true, false);
  const local = origin.worldToLocal(target.clone());
  const dir = local.sub(start).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
  controller.quaternion.set(q.x, q.y, q.z, q.w);
}

/** Move an emulated controller to a world-space point, keeping its orientation. */
export function placeEmulatedController(
  device: Emulator,
  origin: THREE.Object3D,
  hand: "left" | "right",
  point: THREE.Vector3,
): void {
  const controller = device.controllers[hand];
  if (!controller) return;
  origin.updateWorldMatrix(true, false);
  const local = origin.worldToLocal(point.clone());
  controller.position.set(local.x, local.y, local.z);
}

/** Hold or let go of an emulated controller button (`trigger` | `squeeze`). */
export function setEmulatedButton(
  device: Emulator,
  hand: "left" | "right",
  button: "trigger" | "squeeze",
  pressed: boolean,
): void {
  device.controllers[hand]?.updateButtonValue(button, pressed ? 1 : 0);
}
