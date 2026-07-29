import { existsSync, readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  RobotBuilder,
  ThreeUsdRobotLoader,
  serializeUsda,
  toBytes,
  writeUsdz,
} from "../src/index.js";

const ARM = readFileSync(new URL("../test-assets/two_link_arm.usda", import.meta.url), "utf8");
const ARM_BYTES = new TextEncoder().encode(ARM);

/** A fresh ArrayBuffer holding exactly `bytes` (no shared-pool offset leakage). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function armUsdz(): Uint8Array {
  const builder = new RobotBuilder({ name: "zip_bot" });
  builder.addLink({ name: "base" });
  builder.addLink({ name: "arm", frame: new THREE.Matrix4().makeTranslation(0.2, 0, 0.5) });
  builder.addFixedJoint({ name: "root_joint", child: "base" });
  builder.addRevoluteJoint({
    name: "j1",
    parent: "base",
    child: "arm",
    frame: new THREE.Matrix4().makeTranslation(0, 0, 0.5),
    axis: "Z",
    lower: -Math.PI,
    upper: Math.PI,
  });
  return writeUsdz({ "robot.usda": serializeUsda(builder.toUsda()) });
}

describe("toBytes", () => {
  it("honors a view's byteOffset / byteLength", async () => {
    const backing = new Uint8Array(16).fill(0xee);
    backing.set([1, 2, 3, 4], 6);
    expect(await toBytes(new DataView(backing.buffer, 6, 4))).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("accepts ArrayBuffer and Blob", async () => {
    expect(await toBytes(new Uint8Array([5, 6, 7]).buffer as ArrayBuffer)).toEqual(
      new Uint8Array([5, 6, 7]),
    );
    expect(await toBytes(new Blob([new Uint8Array([9, 8])]))).toEqual(new Uint8Array([9, 8]));
  });
});

describe("ThreeUsdRobotLoader.parse — in-memory sources", () => {
  it("accepts USDA text as an ArrayBuffer", async () => {
    const fromText = await new ThreeUsdRobotLoader().parse(ARM);
    const fromBuffer = await new ThreeUsdRobotLoader().parse(toArrayBuffer(ARM_BYTES));
    expect(fromBuffer.getJointNames().length).toBeGreaterThan(0);
    expect(fromBuffer.getJointNames()).toEqual(fromText.getJointNames());
  });

  it("accepts a typed-array view at a nonzero offset", async () => {
    // '#' padding around the payload — a naive `new Uint8Array(view.buffer)` would see it.
    const padded = new Uint8Array(ARM_BYTES.length + 11).fill(0x23);
    padded.set(ARM_BYTES, 7);
    const view = new Uint8Array(padded.buffer, 7, ARM_BYTES.length);
    const robot = await new ThreeUsdRobotLoader().parse(view);
    expect(robot.getJointNames().length).toBeGreaterThan(0);
  });

  it("accepts a Blob, as from drag & drop", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(new Blob([ARM]));
    expect(robot.getJointNames().length).toBeGreaterThan(0);
  });

  it("sniffs a usdz package from an ArrayBuffer and from a Blob", async () => {
    const usdz = armUsdz();
    for (const data of [toArrayBuffer(usdz), new Blob([toArrayBuffer(usdz)])]) {
      const robot = await new ThreeUsdRobotLoader().parse(data);
      expect(robot.getJointNames()).toEqual(["j1"]);
      robot.setJointValue("j1", 0.5);
      expect(robot.getJointValue("j1")).toBeCloseTo(0.5);
    }
  });

  it("parseUsdz accepts a Blob", async () => {
    const robot = await new ThreeUsdRobotLoader().parseUsdz(new Blob([toArrayBuffer(armUsdz())]));
    expect(robot.getJointNames()).toEqual(["j1"]);
  });

  it("parseRobotDescription extracts the IR from usdz bytes", async () => {
    const desc = await new ThreeUsdRobotLoader().parseRobotDescription(armUsdz());
    expect(Object.keys(desc.joints)).toContain("j1");
    expect(Object.keys(desc.links).sort()).toEqual(["arm", "base"]);
  });
});

// Real binary crate — the large asset is not committed, so skip when absent.
const TOROBO = new URL("../data/torobo2_standard_planar_move.usd", import.meta.url);

describe.skipIf(!existsSync(TOROBO))("parse — crate sniffing (data/torobo2)", () => {
  it("sniffs a binary crate from an ArrayBuffer", async () => {
    const bytes = new Uint8Array(readFileSync(TOROBO));
    const robot = await new ThreeUsdRobotLoader().parse(toArrayBuffer(bytes));
    expect(robot.getJointNames().length).toBeGreaterThan(10);
  });
});
