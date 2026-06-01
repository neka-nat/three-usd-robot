/**
 * `three-usd-robot/extras`
 *
 * Heavier convenience utilities kept out of the main bundle. Currently a
 * `lil-gui` joint slider panel — but this module does **not** depend on
 * `lil-gui`: the caller passes in a GUI instance (typed structurally), so no UI
 * library leaks into the bundle.
 */

import type { ThreeUsdRobot } from "./three/ThreeUsdRobot.js";

/** Minimal structural view of a `lil-gui` controller (only what we use). */
export interface GuiController {
  name(name: string): GuiController;
  onChange(callback: (value: number) => void): GuiController;
  updateDisplay?(): GuiController;
}

/** Minimal structural view of a `lil-gui` GUI / folder. */
export interface GuiLike {
  add(
    target: Record<string, number>,
    key: string,
    min?: number,
    max?: number,
    step?: number,
  ): GuiController;
}

export type JointSliderPanelOptions = {
  /** Half-range used when a revolute joint has no limits (radians, default π). */
  defaultAngularRange?: number;
  /** Half-range used when a prismatic joint has no limits (default `1`). */
  defaultLinearRange?: number;
  /** Slider step (default `0.01`). */
  step?: number;
};

export type JointSliderPanel = {
  controllers: GuiController[];
  /** Re-read joint values from the robot into the sliders. */
  update(): void;
};

/**
 * Add one slider per articulated joint to a `lil-gui` GUI (or folder). Moving a
 * slider drives the robot and refreshes its kinematics.
 *
 * @example
 * ```ts
 * import GUI from "lil-gui";
 * import { createJointSliderPanel } from "three-usd-robot/extras";
 * createJointSliderPanel(robot, new GUI());
 * ```
 */
export function createJointSliderPanel(
  robot: ThreeUsdRobot,
  gui: GuiLike,
  options: JointSliderPanelOptions = {},
): JointSliderPanel {
  const angular = options.defaultAngularRange ?? Math.PI;
  const linear = options.defaultLinearRange ?? 1;
  const step = options.step ?? 0.01;

  const state: Record<string, number> = {};
  const controllers: GuiController[] = [];

  for (const name of robot.getJointNames()) {
    const joint = robot.getJointObject(name);
    if (!joint?.articulated) continue;

    const fallback = joint.jointType === "prismatic" ? linear : angular;
    const lo = joint.lower ?? -fallback;
    const hi = joint.upper ?? fallback;

    state[name] = joint.value;
    const controller = gui
      .add(state, name, lo, hi, step)
      .name(name)
      .onChange((value) => {
        robot.setJointValue(name, value);
        robot.updateKinematics();
      });
    controllers.push(controller);
  }

  return {
    controllers,
    update() {
      for (const name of Object.keys(state)) {
        const value = robot.getJointValue(name);
        if (value !== undefined) state[name] = value;
      }
      for (const c of controllers) c.updateDisplay?.();
    },
  };
}
