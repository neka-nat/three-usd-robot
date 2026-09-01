import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  ThreeUsdRobotLoader,
  createMemoryResolver,
  createTextureProvider,
  writeUsdz,
} from "../src/index.js";
import { applyUsdEnvironment } from "../src/rendering.js";

/** Minimal Radiance .hdr: 2×1 flat (non-RLE) RGBE — grays of 1.0 and 2.0. */
function tinyHdr(): Uint8Array {
  const header = new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n");
  const pixels = new Uint8Array([128, 128, 128, 129, 128, 128, 128, 130]);
  const out = new Uint8Array(header.length + pixels.length);
  out.set(header);
  out.set(pixels, header.length);
  return out;
}

function domeStage(domeBody: string, type = "DomeLight"): string {
  return `#usda 1.0
(
    defaultPrim = "Room"
    metersPerUnit = 1.0
    upAxis = "Z"
)

def Xform "Room"
{
    def ${type} "sky"
    {
${domeBody}
    }
}
`;
}

const HDR_DOME = domeStage(`        float inputs:intensity = 1000
        asset inputs:texture:file = @sky.hdr@`);

async function loadWithHdr(scale?: number) {
  const resolver = createMemoryResolver({ "/scene/sky.hdr": tinyHdr() });
  const loader = new ThreeUsdRobotLoader({
    assetResolver: resolver,
    loadSceneGeometry: false,
    ...(scale !== undefined ? { lightIntensityScale: scale } : {}),
  });
  return loader.parse(HDR_DOME, "/scene/main.usda");
}

describe("applyUsdEnvironment (M26)", () => {
  it("decodes an .hdr dome into an equirect environment with the loader's intensity scale", async () => {
    const robot = await loadWithHdr(0.001);
    const scene = new THREE.Scene();

    const env = await applyUsdEnvironment(robot, scene);
    expect(env).not.toBeNull();
    expect(scene.environment).toBe(env!.texture);
    expect(scene.background).toBeNull(); // opt-in

    const texture = env!.texture as THREE.DataTexture;
    expect(texture.image.width).toBe(2);
    expect(texture.image.height).toBe(1);
    expect(texture.type).toBe(THREE.HalfFloatType);
    expect(texture.mapping).toBe(THREE.EquirectangularReflectionMapping);
    expect(texture.flipY).toBe(true);
    expect(texture.colorSpace).toBe(THREE.LinearSRGBColorSpace);
    // RGBE decodes with the (mantissa + 0.5) convention — compare loosely.
    expect(
      THREE.DataUtils.fromHalfFloat((texture.image.data as unknown as Uint16Array)[0]!),
    ).toBeCloseTo(1, 2);

    // 1000 × loader lightIntensityScale 0.001.
    expect(scene.environmentIntensity).toBeCloseTo(1, 6);
    expect(env!.intensity).toBeCloseTo(1, 6);

    // Z-up stage + identity dome: root conversion and pole correction cancel.
    expect(scene.environmentRotation.x).toBeCloseTo(0, 6);
    expect(scene.environmentRotation.y).toBeCloseTo(0, 6);
    expect(scene.environmentRotation.z).toBeCloseTo(0, 6);
  });

  it("sets the background too when asked", async () => {
    const robot = await loadWithHdr();
    const scene = new THREE.Scene();
    const env = await applyUsdEnvironment(robot, scene, {
      background: true,
      intensityScale: 0.001,
    });
    expect(scene.background).toBe(env!.texture);
    expect(scene.backgroundIntensity).toBeCloseTo(1, 6);
    expect(scene.environmentIntensity).toBeCloseTo(1, 6); // option overrides the loader default (1)
  });

  it("loads a dome texture packed inside a .usdz", async () => {
    const usdz = writeUsdz({ "root.usda": HDR_DOME, "sky.hdr": tinyHdr() });
    const robot = await new ThreeUsdRobotLoader({ loadSceneGeometry: false }).parseUsdz(usdz);
    expect(robot.domeLights[0]?.textureFile).toBe("sky.hdr");

    const scene = new THREE.Scene();
    const env = await applyUsdEnvironment(robot, scene);
    expect((env!.texture as THREE.DataTexture).image.width).toBe(2);
  });

  it("spins the environment with the dome's authored rotation", async () => {
    const rotated = domeStage(`        asset inputs:texture:file = @sky.hdr@
        double3 xformOp:rotateXYZ = (0, 0, 90)
        uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]`);
    const resolver = createMemoryResolver({ "/scene/sky.hdr": tinyHdr() });
    const robot = await new ThreeUsdRobotLoader({
      assetResolver: resolver,
      loadSceneGeometry: false,
    }).parse(rotated, "/scene/main.usda");

    const scene = new THREE.Scene();
    await applyUsdEnvironment(robot, scene);
    // Stage-up yaw becomes a pure three-world Y (up) rotation.
    expect(scene.environmentRotation.x).toBeCloseTo(0, 6);
    expect(scene.environmentRotation.y).toBeCloseTo(Math.PI / 2, 6);
    expect(scene.environmentRotation.z).toBeCloseTo(0, 6);
  });

  it("honors DomeLight_1 poleAxis over the stage up-axis heuristic", async () => {
    const stage = domeStage(
      `        asset inputs:texture:file = @sky.hdr@
        uniform token inputs:poleAxis = "Y"`,
      "DomeLight_1",
    );
    const resolver = createMemoryResolver({ "/scene/sky.hdr": tinyHdr() });
    const robot = await new ThreeUsdRobotLoader({
      assetResolver: resolver,
      loadSceneGeometry: false,
    }).parse(stage, "/scene/main.usda");

    const scene = new THREE.Scene();
    await applyUsdEnvironment(robot, scene);
    // Only the Z-up → Y-up root conversion remains.
    expect(scene.environmentRotation.x).toBeCloseTo(-Math.PI / 2, 6);
  });

  it("falls back to the dome color when the texture cannot be fetched", async () => {
    const broken = domeStage(`        color3f inputs:color = (1, 0.5, 0.25)
        float inputs:intensity = 2
        asset inputs:texture:file = @missing.hdr@`);
    const robot = await new ThreeUsdRobotLoader({
      assetResolver: createMemoryResolver({}),
      loadSceneGeometry: false,
    }).parse(broken, "/scene/main.usda");

    const warnings: string[] = [];
    const scene = new THREE.Scene();
    const env = await applyUsdEnvironment(robot, scene, { onWarn: (m) => warnings.push(m) });

    expect(warnings.some((m) => m.includes("missing.hdr"))).toBe(true);
    const texture = env!.texture as THREE.DataTexture;
    expect(texture.image.width).toBe(1);
    const data = texture.image.data as unknown as Float32Array;
    expect(data[0]).toBeCloseTo(1, 6);
    expect(data[1]).toBeCloseTo(0.5, 6);
    expect(data[2]).toBeCloseTo(0.25, 6);
    expect(scene.environmentIntensity).toBeCloseTo(2, 6);
  });

  it("uses a uniform color environment for textureless domes", async () => {
    const flat = domeStage(`        color3f inputs:color = (0.2, 0.4, 0.8)
        float inputs:intensity = 3`);
    const robot = await new ThreeUsdRobotLoader({ loadSceneGeometry: false }).parse(flat);

    const scene = new THREE.Scene();
    const env = await applyUsdEnvironment(robot, scene);
    const data = (env!.texture as THREE.DataTexture).image.data as unknown as Float32Array;
    expect(data[2]).toBeCloseTo(0.8, 6);
    expect(scene.environmentIntensity).toBeCloseTo(3, 6);
  });

  it("returns null and leaves the scene alone when there is no dome", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(`#usda 1.0
(
    defaultPrim = "W"
)

def Xform "W"
{
}
`);
    const scene = new THREE.Scene();
    expect(await applyUsdEnvironment(robot, scene)).toBeNull();
    expect(scene.environment).toBeNull();
  });
});

describe("UDIM fallback (M26)", () => {
  it("resolves <UDIM> paths to tile 1001 with a one-time warning", () => {
    const base = createMemoryResolver({ "/t/body.1001.png": new Uint8Array([137]) });
    const seen: string[] = [];
    const resolver = {
      ...base,
      resolve(assetPath: string, baseUrl: string) {
        seen.push(assetPath);
        return base.resolve(assetPath, baseUrl);
      },
    };
    const warnings: string[] = [];
    const provider = createTextureProvider(resolver, "/t/main.usda", (m) => warnings.push(m));

    expect(provider("body.<UDIM>.png")).not.toBeNull();
    expect(seen).toEqual(["body.1001.png"]);
    provider("other.<udim>.png"); // case-insensitive, but only one diagnostic
    expect(warnings.filter((m) => m.includes("UDIM"))).toHaveLength(1);
  });
});
