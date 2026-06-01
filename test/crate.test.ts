import { existsSync, readFileSync } from "node:fs";
import type * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CrateReader, ThreeUsdRobotLoader } from "../src/index.js";

// Integration test against a real binary USDC robot. The asset is large and not
// committed, so these are skipped when it is absent (e.g. in CI).
const TOROBO = new URL("../data/torobo2_standard_planar_move.usd", import.meta.url);
const present = existsSync(TOROBO);
const bytes = present ? new Uint8Array(readFileSync(TOROBO)) : new Uint8Array();

describe.skipIf(!present)("USDC crate reader (data/torobo2)", () => {
  it("identifies and parses crate structure", () => {
    expect(CrateReader.isCrate(bytes)).toBe(true);
    const c = new CrateReader(bytes);
    expect(c.version[0]).toBe(0);
    expect(c.getTokens().length).toBeGreaterThan(100);
    expect(c.getPaths()).toContain("/torobo2");

    const specTypes = new Set(c.getSpecs().map((s) => s.specType));
    expect(specTypes.has(6)).toBe(true); // SdfSpecTypePrim
    expect(specTypes.has(1)).toBe(true); // SdfSpecTypeAttribute
  });

  it("decodes joint values (axis token, body paths)", () => {
    const c = new CrateReader(bytes);
    const paths = c.getPaths();
    const byPath = new Map(c.getSpecs().map((s) => [paths[s.pathIndex]!, s]));
    const fieldVal = (path: string, name: string) => {
      const sp = byPath.get(path);
      if (!sp) return undefined;
      for (const fi of c.getFieldSet(sp.fieldSetIndex)) {
        const f = c.getFields()[fi]!;
        if (c.getToken(f.nameIndex) === name) return c.getValue(f.rep);
      }
      return undefined;
    };
    const joint = "/torobo2/base_link/base_front_left_wheel_joint";
    expect(fieldVal(`${joint}.physics:axis`, "default")).toBe("X");
    expect(fieldVal(`${joint}.physics:body0`, "targetPaths")).toEqual(["/torobo2/base_link"]);
  });

  it("builds a controllable robot with joints and meshes", async () => {
    const robot = await new ThreeUsdRobotLoader().parseCrate(bytes);
    expect(robot.getKinematicTree().root).toBeTruthy();
    expect(robot.getJointNames().length).toBeGreaterThan(10);

    let meshes = 0;
    robot.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    expect(meshes).toBeGreaterThan(0);
  });
});
