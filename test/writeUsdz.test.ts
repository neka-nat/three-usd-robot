import { strFromU8, strToU8, unzipSync } from "fflate";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  RobotBuilder,
  ThreeUsdRobotLoader,
  openUsdz,
  serializeUsda,
  writeUsdz,
} from "../src/index.js";

const ARM_USDA = () => {
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
  return serializeUsda(builder.toUsda());
};

/** Walk the archive's local file headers, returning entry names + data offsets. */
function walkLocalHeaders(zip: Uint8Array): { name: string; dataStart: number; method: number }[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: { name: string; dataStart: number; method: number }[] = [];
  let offset = 0;
  while (offset + 4 <= zip.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = strFromU8(zip.subarray(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    out.push({ name, dataStart, method });
    offset = dataStart + compressedSize;
  }
  return out;
}

describe("writeUsdz", () => {
  it("stores entries uncompressed with 64-byte-aligned data offsets", () => {
    const usdz = writeUsdz({
      "robot.usda": "#usda 1.0\n",
      "textures/color.png": new Uint8Array([1, 2, 3, 4, 5]),
      "textures/normal.png": new Uint8Array(100).fill(7),
    });
    const headers = walkLocalHeaders(usdz);
    expect(headers).toHaveLength(3);
    for (const h of headers) {
      expect(h.method).toBe(0); // stored
      expect(h.dataStart % 64).toBe(0);
    }
  });

  it("moves the root USD layer to the front regardless of input order", () => {
    const usdz = writeUsdz({
      "textures/color.png": new Uint8Array([9]),
      "model.usda": "#usda 1.0\n",
    });
    const headers = walkLocalHeaders(usdz);
    expect(headers[0]!.name).toBe("model.usda");

    const pkg = openUsdz(usdz);
    expect(pkg.rootEntry).toBe("model.usda");
  });

  it("round-trips entry contents through openUsdz / unzipSync", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]);
    const usdz = writeUsdz({ "robot.usda": "#usda 1.0\n", "tex/a.png": png });

    const entries = unzipSync(usdz);
    expect(strFromU8(entries["robot.usda"]!)).toBe("#usda 1.0\n");
    expect(entries["tex/a.png"]).toEqual(png);

    const pkg = openUsdz(usdz);
    expect(new Uint8Array(await pkg.resolver.fetchBytes("tex/a.png"))).toEqual(png);
  });

  it("rejects a package without a root USD layer", () => {
    expect(() => writeUsdz({ "a.png": new Uint8Array([1]) })).toThrow(/root USD layer/);
  });

  it("loader opens a written package and the robot articulates (acceptance)", async () => {
    const usdz = writeUsdz({ "robot.usda": ARM_USDA() });
    const robot = await new ThreeUsdRobotLoader({ upAxisConversion: "none" }).parseUsdz(usdz);

    robot.setJointValue("j1", Math.PI / 2);
    const p = robot.getLinkWorldPosition("arm");
    expect(p.x).toBeCloseTo(0, 10);
    expect(p.y).toBeCloseTo(0.2, 10);
    expect(p.z).toBeCloseTo(0.5, 10);
  });

  it("handles large unaligned payloads (alignment holds for every entry)", () => {
    const entries: Record<string, Uint8Array | string> = { "r.usda": "#usda 1.0\n" };
    for (let i = 0; i < 7; i++) {
      entries[`f${i}.bin`] = strToU8("x".repeat(13 + i * 41));
    }
    const headers = walkLocalHeaders(writeUsdz(entries));
    expect(headers).toHaveLength(8);
    for (const h of headers) expect(h.dataStart % 64).toBe(0);
  });
});
