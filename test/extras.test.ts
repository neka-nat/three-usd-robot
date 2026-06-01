import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type GuiController, type GuiLike, createJointSliderPanel } from "../src/extras.js";
import { ThreeUsdRobotLoader } from "../src/index.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");

/** A minimal in-memory lil-gui stand-in that records controllers. */
class MockGui implements GuiLike {
  readonly entries: { key: string; min?: number; max?: number; onChange?: (v: number) => void }[] =
    [];

  add(_target: Record<string, number>, key: string, min?: number, max?: number): GuiController {
    const entry: (typeof this.entries)[number] = { key };
    if (min !== undefined) entry.min = min;
    if (max !== undefined) entry.max = max;
    this.entries.push(entry);
    const controller: GuiController = {
      name: () => controller,
      onChange: (cb) => {
        entry.onChange = cb;
        return controller;
      },
      updateDisplay: () => controller,
    };
    return controller;
  }
}

describe("createJointSliderPanel", () => {
  it("adds one slider per articulated joint, using authored limits", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    const gui = new MockGui();
    const panel = createJointSliderPanel(robot, gui);

    expect(gui.entries.map((e) => e.key)).toEqual(["joint1", "joint2"]); // no fixed root_joint
    expect(panel.controllers).toHaveLength(2);

    // joint1 (revolute) uses ±90° limits.
    const j1 = gui.entries.find((e) => e.key === "joint1")!;
    expect(j1.min).toBeCloseTo(-Math.PI / 2, 12);
    expect(j1.max).toBeCloseTo(Math.PI / 2, 12);
  });

  it("drives the robot when a slider changes", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    const gui = new MockGui();
    createJointSliderPanel(robot, gui);

    const j1 = gui.entries.find((e) => e.key === "joint1")!;
    j1.onChange?.(0.5);
    expect(robot.getJointValue("joint1")).toBeCloseTo(0.5, 12);
  });

  it("update() reads joint values back into the sliders", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(ARM);
    const panel = createJointSliderPanel(robot, new MockGui());
    robot.setJointValue("joint2", 0.3);
    expect(() => panel.update()).not.toThrow();
  });
});
