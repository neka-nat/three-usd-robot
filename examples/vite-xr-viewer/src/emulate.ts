/**
 * Headset emulation for desktop development and headless checks: IWER (Meta's
 * Immersive Web Emulation Runtime) installs a fake `navigator.xr` that drives
 * a stereo view into the page's canvas. Must run before three's `XRButton` is
 * created — the button checks `navigator.xr` once, on creation.
 */

import * as THREE from "three";
import type { XRDevice } from "iwer";
import type { XrOriginRig } from "three-usd-robot/xr";

export type Emulator = XRDevice;

export async function installEmulator(): Promise<Emulator> {
  const { XRDevice, metaQuest3 } = await import("iwer");
  const device = new XRDevice(metaQuest3);
  // Headless Chromium exposes a native `navigator.xr` without any device, which
  // IWER would politely defer to — override it.
  device.installRuntime({ forceInstall: true });
  device.stereoEnabled = true; // render both eyes side by side, as a headset would
  // A plausible standing pose: eyes 1.6 m up, controllers held in front.
  device.position.set(0, 1.6, 0);
  device.controllers.left?.position.set(-0.25, 1.25, -0.35);
  device.controllers.right?.position.set(0.25, 1.25, -0.35);
  return device;
}

/**
 * Point an emulated controller's ray at a world-space target. The emulator's
 * poses live in the XR reference space, i.e. rig-local — so the target is
 * brought into the rig first (xr-design §3).
 */
export function aimEmulatedController(
  device: Emulator,
  rig: XrOriginRig,
  hand: "left" | "right",
  target: THREE.Vector3,
  from?: THREE.Vector3,
): void {
  const controller = device.controllers[hand];
  if (!controller) return;
  const origin = from ?? new THREE.Vector3(hand === "left" ? -0.25 : 0.25, 1.25, -0.35);
  controller.position.set(origin.x, origin.y, origin.z);
  const local = rig.worldToLocal(target.clone());
  const dir = local.sub(origin).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
  controller.quaternion.set(q.x, q.y, q.z, q.w);
}

/** Move an emulated controller to a world-space point, keeping its orientation. */
export function placeEmulatedController(
  device: Emulator,
  rig: XrOriginRig,
  hand: "left" | "right",
  point: THREE.Vector3,
): void {
  const controller = device.controllers[hand];
  if (!controller) return;
  const local = rig.worldToLocal(point.clone());
  controller.position.set(local.x, local.y, local.z);
}

/**
 * Emulated controller buttons (IWER's Touch Plus layout ids). `a-button` /
 * `b-button` name the upper face buttons of either hand — the left hand's
 * are `x-button` / `y-button` in the layout and are translated here.
 */
export type EmulatedButton = "trigger" | "squeeze" | "a-button" | "b-button" | "thumbstick";

/** Hold or let go of an emulated controller button. */
export function setEmulatedButton(
  device: Emulator,
  hand: "left" | "right",
  button: EmulatedButton,
  pressed: boolean,
): void {
  const id =
    hand === "left" && button === "a-button"
      ? "x-button"
      : hand === "left" && button === "b-button"
        ? "y-button"
        : button;
  device.controllers[hand]?.updateButtonValue(id, pressed ? 1 : 0);
}
