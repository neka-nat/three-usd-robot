import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  Stage,
  type TextureOptions,
  type TextureProvider,
  ThreeUsdRobotLoader,
  buildMeshMaterial,
  createMemoryResolver,
  createTextureProvider,
  resolveBoundMaterial,
} from "../src/index.js";
import { decodeRadianceHdr, environmentEulerFor, softShadowMapType } from "../src/rendering.js";

// M29: OmniPBR semantics (albedo adjustments, map influences, declaration
// defaults, specular level, DirectX normal maps, ao_to_diffuse), photometric
// emission calibration, texture anisotropy, the UsdLux emitter model, and the
// three r180–r186 compatibility shims.

const stageOf = (usda: string) => Stage.OpenFromString(usda);
const geomOf = (stage: Stage) => stage.GetPrimAtPath("/World/geom")!;

/** One OmniPBR material (authored `inputs`) bound to a triangle. */
function omniPbr(inputs: string, sub = "OmniPBR"): string {
  return `#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            token outputs:mdl:surface.connect = </World/Looks/Mat/Shader.outputs:out>

            def Shader "Shader"
            {
                uniform token info:implementationSource = "sourceAsset"
                uniform asset info:mdl:sourceAsset = @OmniPBR.mdl@
                uniform token info:mdl:sourceAsset:subIdentifier = "${sub}"
${inputs}
                token outputs:out
            }
        }
    }

    def Mesh "geom"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        rel material:binding = </World/Looks/Mat>
    }
}`;
}

/** One UsdPreviewSurface material with constant inputs bound to a triangle. */
function previewSurface(inputs: string): string {
  return `#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            token outputs:surface.connect = </World/Looks/Mat/Surface.outputs:surface>
            def Shader "Surface"
            {
                uniform token info:id = "UsdPreviewSurface"
${inputs}
                token outputs:surface
            }
        }
    }
    def Mesh "geom"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        rel material:binding = </World/Looks/Mat>
    }
}`;
}

function recordingProvider(calls: { path: string; options?: TextureOptions }[]): TextureProvider {
  return (path, options) => {
    calls.push({ path, ...(options ? { options } : {}) });
    return new THREE.Texture();
  };
}

const resolve = (usda: string, warnings: string[] = []) =>
  resolveBoundMaterial(stageOf(usda), geomOf(stageOf(usda)), { onWarn: (m) => warnings.push(m) })!;

const materialOf = (usda: string) => {
  const stage = stageOf(usda);
  const calls: { path: string; options?: TextureOptions }[] = [];
  const material = buildMeshMaterial(
    geomOf(stage),
    stage,
    recordingProvider(calls),
  ) as THREE.MeshStandardMaterial;
  return { material, calls };
};

describe("OmniPBR semantics (M29)", () => {
  it("applies the declaration defaults when nothing is authored", () => {
    const bound = resolve(omniPbr(""));
    expect(bound.color).toEqual([0.2, 0.2, 0.2]);
    expect(bound.roughness).toBe(0.5);
    expect(bound.metalness).toBe(0);
    const { material } = materialOf(omniPbr(""));
    expect(material.roughness).toBe(0.5);
    expect(material.metalness).toBe(0);
    expect(material.color.r).toBeCloseTo(0.2, 6);
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  });

  it("folds albedo desaturation / brightness / add / tint into a constant albedo", () => {
    const bound = resolve(
      omniPbr(`                color3f inputs:diffuse_color_constant = (0.8, 0.2, 0.2)
                float inputs:albedo_desaturation = 0.5
                float inputs:albedo_brightness = 0.5
                float inputs:albedo_add = 0.1
                color3f inputs:diffuse_tint = (1, 1, 0.5)`),
    );
    // luminance = 0.2126·0.8 + 0.7152·0.2 + 0.0722·0.2 = 0.32756
    const lum = 0.32756;
    const r = ((0.8 + (lum - 0.8) * 0.5) * 0.5 + 0.1) * 1;
    const g = ((0.2 + (lum - 0.2) * 0.5) * 0.5 + 0.1) * 1;
    const b = ((0.2 + (lum - 0.2) * 0.5) * 0.5 + 0.1) * 0.5;
    expect(bound.color?.[0]).toBeCloseTo(r, 5);
    expect(bound.color?.[1]).toBeCloseTo(g, 5);
    expect(bound.color?.[2]).toBeCloseTo(b, 5);
    expect(bound.tint).toBeUndefined();
  });

  it("keeps brightness × tint as a multiplier on textured albedo and reports add / desaturation", () => {
    const warnings: string[] = [];
    const usda = omniPbr(`                asset inputs:diffuse_texture = @albedo.png@
                float inputs:albedo_brightness = 0.7
                float inputs:albedo_add = 0.1
                color3f inputs:diffuse_tint = (1, 0.5, 1)`);
    const bound = resolve(usda, warnings);
    expect(bound.tint?.[0]).toBeCloseTo(0.7, 6);
    expect(bound.tint?.[1]).toBeCloseTo(0.35, 6);
    expect(bound.tint?.[2]).toBeCloseTo(0.7, 6);
    expect(warnings.some((w) => w.includes("albedo_add"))).toBe(true);

    const { material } = materialOf(usda);
    expect(material.map).toBeTruthy();
    expect(material.color.r).toBeCloseTo(0.7, 6);
    expect(material.color.g).toBeCloseTo(0.35, 6);
    expect(material.color.b).toBeCloseTo(0.7, 6);
  });

  it("uses a roughness / metallic map only when its influence rounds to 1", () => {
    // Influence 1 with an authored constant: the map wins, factor 1.
    const full = resolve(
      omniPbr(`                asset inputs:reflectionroughness_texture = @rough.png@
                float inputs:reflection_roughness_constant = 0.5
                float inputs:reflection_roughness_texture_influence = 1`),
    );
    expect(full.roughnessTexture?.path).toBe("rough.png");
    expect(full.roughness).toBeUndefined();
    const { material: fullMaterial } = materialOf(
      omniPbr(`                asset inputs:reflectionroughness_texture = @rough.png@
                float inputs:reflection_roughness_constant = 0.5
                float inputs:reflection_roughness_texture_influence = 1`),
    );
    expect(fullMaterial.roughnessMap).toBeTruthy();
    expect(fullMaterial.roughness).toBe(1);

    // No influence authored (OmniPBR default 0): the map is unused, as in Omniverse.
    const warnings: string[] = [];
    const none = resolve(
      omniPbr("                asset inputs:reflectionroughness_texture = @rough.png@"),
      warnings,
    );
    expect(none.roughnessTexture).toBeUndefined();
    expect(none.roughness).toBe(0.5);
    expect(warnings.some((w) => w.includes("reflection_roughness_texture_influence is 0"))).toBe(
      true,
    );

    // Fractional influences are approximated and reported.
    const low: string[] = [];
    const lowBound = resolve(
      omniPbr(`                asset inputs:metallic_texture = @metal.png@
                float inputs:metallic_constant = 0.9
                float inputs:metallic_texture_influence = 0.3`),
      low,
    );
    expect(lowBound.metalnessTexture).toBeUndefined();
    expect(lowBound.metalness).toBe(0.9);
    expect(low.some((w) => w.includes("approximating as 0"))).toBe(true);

    const high: string[] = [];
    const highBound = resolve(
      omniPbr(`                asset inputs:metallic_texture = @metal.png@
                float inputs:metallic_constant = 0.9
                float inputs:metallic_texture_influence = 0.7`),
      high,
    );
    expect(highBound.metalnessTexture?.path).toBe("metal.png");
    expect(highBound.metalness).toBeUndefined();
    expect(high.some((w) => w.includes("approximating as 1"))).toBe(true);
  });

  it("applies the influences to packed ORM maps and ao_to_diffuse to its AO channel", () => {
    const bound = resolve(
      omniPbr(`                asset inputs:ORM_texture = @orm.png@
                bool inputs:enable_ORM_texture = true
                float inputs:reflection_roughness_texture_influence = 1
                float inputs:metallic_texture_influence = 1`),
    );
    expect(bound.roughnessTexture?.outputChannel).toBe("g");
    expect(bound.metalnessTexture?.outputChannel).toBe("b");
    expect(bound.occlusionTexture).toBeUndefined(); // ao_to_diffuse defaults to 0

    const weighted = resolve(
      omniPbr(`                asset inputs:ORM_texture = @orm.png@
                bool inputs:enable_ORM_texture = true
                float inputs:ao_to_diffuse = 0.6`),
    );
    expect(weighted.occlusionTexture?.outputChannel).toBe("r");
    expect(weighted.occlusionStrength).toBeCloseTo(0.6, 6);
    // Influences unauthored → roughness / metalness fall back to the constants.
    expect(weighted.roughnessTexture).toBeUndefined();
    expect(weighted.metalnessTexture).toBeUndefined();
  });

  it("drops the AO map unless ao_to_diffuse is authored, then weights aoMapIntensity", () => {
    const { material: plain } = materialOf(
      omniPbr("                asset inputs:ao_texture = @ao.png@"),
    );
    expect(plain.aoMap).toBeNull();

    const { material: weighted } = materialOf(
      omniPbr(`                asset inputs:ao_texture = @ao.png@
                float inputs:ao_to_diffuse = 0.6`),
    );
    expect(weighted.aoMap).toBeTruthy();
    expect(weighted.aoMapIntensity).toBeCloseTo(0.6, 6);
  });

  it("maps specular_level onto specularIntensity (0.5 ≙ three's default)", () => {
    const matte = resolve(omniPbr("                float inputs:specular_level = 0"));
    expect(matte.specularIntensity).toBe(0);
    const { material } = materialOf(omniPbr("                float inputs:specular_level = 0"));
    expect(material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect((material as THREE.MeshPhysicalMaterial).specularIntensity).toBe(0);

    const stock = resolve(omniPbr("                float inputs:specular_level = 0.5"));
    expect(stock.specularIntensity).toBeUndefined();
    const bright = resolve(omniPbr("                float inputs:specular_level = 1"));
    expect(bright.specularIntensity).toBeCloseTo(2, 6);
  });

  it("flips OmniPBR normal maps' green channel by default (DirectX) and honors bump_factor / flips", () => {
    const stock = resolve(omniPbr("                asset inputs:normalmap_texture = @n.png@"));
    expect(stock.normalScale).toEqual([1, -1]);
    const { material } = materialOf(
      omniPbr("                asset inputs:normalmap_texture = @n.png@"),
    );
    expect(material.normalMap).toBeTruthy();
    expect(material.normalScale.x).toBeCloseTo(1, 9);
    expect(material.normalScale.y).toBeCloseTo(-1, 9);

    const openGl = resolve(
      omniPbr(`                asset inputs:normalmap_texture = @n.png@
                bool inputs:flip_tangent_v = false
                float inputs:bump_factor = 2`),
    );
    expect(openGl.normalScale).toEqual([2, 2]);

    const flippedU = resolve(
      omniPbr(`                asset inputs:normalmap_texture = @n.png@
                bool inputs:flip_tangent_u = true`),
    );
    expect(flippedU.normalScale).toEqual([-1, -1]);

    // Clear-coat normal maps carry their own flags.
    const coat = resolve(
      omniPbr(
        `                asset inputs:clearcoat_normalmap_texture = @coat_n.png@
                float inputs:clearcoat_bump_factor = 0.5`,
        "OmniPBR_ClearCoat",
      ),
    );
    expect(coat.clearcoatNormalScale).toEqual([0.5, -0.5]);
  });

  it("flags Omniverse emission as photometric radiance", () => {
    const bound = resolve(
      omniPbr(`                bool inputs:enable_emission = true
                color3f inputs:emissive_color = (0, 0.1, 1)
                float inputs:emissive_intensity = 29000`),
    );
    expect(bound.emissiveIntensity).toBe(29000);
    expect(bound.emissivePhotometric).toBe(true);
    const { material } = materialOf(
      omniPbr(`                bool inputs:enable_emission = true
                color3f inputs:emissive_color = (0, 0.1, 1)
                float inputs:emissive_intensity = 29000`),
    );
    expect(material.userData.emissivePhotometric).toBe(true);
  });
});

describe("UsdPreviewSurface defaults (M29)", () => {
  it("falls back to the spec's roughness 0.5 / metallic 0 for unauthored constants", () => {
    const bound = resolve(
      previewSurface("                color3f inputs:diffuseColor = (1, 0, 0)"),
    );
    expect(bound.roughness).toBe(0.5);
    expect(bound.metalness).toBe(0);
    expect(bound.emissivePhotometric).toBeUndefined();
  });

  it("gives unbound meshes the same 0.5 / 0 fallback", () => {
    const stage = stageOf(`#usda 1.0
def Xform "World"
{
    def Mesh "geom"
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`);
    const material = buildMeshMaterial(geomOf(stage), stage) as THREE.MeshStandardMaterial;
    expect(material.roughness).toBe(0.5);
    expect(material.metalness).toBe(0);
  });
});

/** A lit stage: one OmniPBR emissive panel, one UsdPreviewSurface emissive, one RectLight. */
function emissiveStage(rectLight: boolean, emissive = 29000): string {
  return `#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = 1.0
    upAxis = "Y"
)
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Led"
        {
            token outputs:mdl:surface.connect = </World/Looks/Led/Shader.outputs:out>
            def Shader "Shader"
            {
                uniform token info:implementationSource = "sourceAsset"
                uniform asset info:mdl:sourceAsset = @OmniPBR.mdl@
                uniform token info:mdl:sourceAsset:subIdentifier = "OmniPBR"
                bool inputs:enable_emission = true
                color3f inputs:emissive_color = (0, 0.1, 1)
                float inputs:emissive_intensity = ${emissive}
                token outputs:out
            }
        }
        def Material "Glow"
        {
            token outputs:surface.connect = </World/Looks/Glow/Surface.outputs:surface>
            def Shader "Surface"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:emissiveColor = (1, 1, 1)
                token outputs:surface
            }
        }
    }
    def Mesh "led"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        rel material:binding = </World/Looks/Led>
    }
    def Mesh "glow"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        rel material:binding = </World/Looks/Glow>
    }
${
  rectLight
    ? `    def RectLight "panel"
    {
        float inputs:width = 2
        float inputs:height = 0.5
        float inputs:intensity = 15000
    }`
    : ""
}
}
`;
}

function materialByMesh(robot: THREE.Object3D, name: string): THREE.MeshStandardMaterial {
  let found: THREE.MeshStandardMaterial | undefined;
  robot.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.name === name) found = mesh.material as THREE.MeshStandardMaterial;
  });
  if (!found) throw new Error(`mesh ${name} not found`);
  return found;
}

describe("photometric emissive calibration (M29)", () => {
  it("scales Omniverse emissive radiance with the stage's light calibration", async () => {
    const robot = await new ThreeUsdRobotLoader({ loadSceneGeometry: true }).parse(
      emissiveStage(true),
    );
    expect(robot.lightIntensityScale).toBe(0.001);
    const led = materialByMesh(robot, "led");
    expect(led.emissiveIntensity).toBeCloseTo(29, 9);
    expect(led.userData.emissiveIntensityScale).toBe(0.001);
    // UsdPreviewSurface emission is a unitless multiplier and stays put.
    expect(materialByMesh(robot, "glow").emissiveIntensity).toBe(1);
  });

  it("counts emissive radiance toward the auto calibration when the stage has no lights", async () => {
    const robot = await new ThreeUsdRobotLoader({ loadSceneGeometry: true }).parse(
      emissiveStage(false, 100000),
    );
    expect(robot.lightIntensityScale).toBe(0.001);
    expect(materialByMesh(robot, "led").emissiveIntensity).toBeCloseTo(100, 9);

    const dim = await new ThreeUsdRobotLoader({ loadSceneGeometry: true }).parse(
      emissiveStage(false, 5),
    );
    expect(dim.lightIntensityScale).toBe(1);
    expect(materialByMesh(dim, "led").emissiveIntensity).toBe(5);
  });
});

describe("texture anisotropy (M29)", () => {
  it("requests 16× anisotropy by default and honors the provider option", () => {
    const resolver = createMemoryResolver({ "/scene/a.png": new Uint8Array([1, 2, 3]) });
    const stock = createTextureProvider(resolver, "/scene/main.usda")("a.png");
    expect(stock?.anisotropy).toBe(16);
    const custom = createTextureProvider(resolver, "/scene/main.usda", undefined, {
      anisotropy: 4,
    })("a.png");
    expect(custom?.anisotropy).toBe(4);
  });

  it("flows through the loader's textureAnisotropy option", async () => {
    const usda = `#usda 1.0
(
    defaultPrim = "World"
)
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            token outputs:surface.connect = </World/Looks/Mat/Surface.outputs:surface>
            def Shader "Surface"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor.connect = </World/Looks/Mat/Tex.outputs:rgb>
                token outputs:surface
            }
            def Shader "Tex"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @wood.png@
                token outputs:rgb
            }
        }
    }
    def Mesh "geom"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        rel material:binding = </World/Looks/Mat>
    }
}`;
    const resolver = createMemoryResolver({ "/scene/wood.png": new Uint8Array([0]) });
    const robot = await new ThreeUsdRobotLoader({
      assetResolver: resolver,
      loadSceneGeometry: true,
      textureAnisotropy: 2,
    }).parse(usda, "/scene/main.usda");
    expect(materialByMesh(robot, "geom").map?.anisotropy).toBe(2);
  });
});

function litStage(lights: string, metersPerUnit = 1): string {
  return `#usda 1.0
(
    defaultPrim = "World"
    metersPerUnit = ${metersPerUnit}
    upAxis = "Y"
)
def Xform "World"
{
    def Mesh "floor"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
${lights}
}
`;
}

const lightByName = (robot: THREE.Object3D, name: string) =>
  (robot as unknown as { lights: THREE.Light[] }).lights.find((l) => l.name === name)!;

describe("UsdLux emitter model (M29)", () => {
  it("converts sphere radiance to candela (π r²) on photometric stages", async () => {
    const robot = await new ThreeUsdRobotLoader().parse(
      litStage(`    def SphereLight "bulb"
    {
        float inputs:radius = 0.5
        float inputs:intensity = 30000
    }`),
    );
    expect(robot.lightEmitterModel).toBe("radiance");
    expect(robot.lightIntensityScale).toBe(0.001);
    expect(lightByName(robot, "bulb").intensity).toBeCloseTo(30000 * 0.001 * Math.PI * 0.25, 6);
  });

  it("scales the radius into world meters and honors normalize / treatAsPoint", async () => {
    // Area-light shadow proxies (M30) would split the rect / disk intensities.
    const robot = await new ThreeUsdRobotLoader({ areaLightShadows: false }).parse(
      litStage(
        `    def SphereLight "small"
    {
        float inputs:radius = 5
        float inputs:intensity = 30000
    }
    def SphereLight "normalized"
    {
        float inputs:radius = 5
        float inputs:intensity = 30000
        bool inputs:normalize = true
    }
    def SphereLight "point"
    {
        float inputs:radius = 5
        float inputs:intensity = 30000
        bool inputs:treatAsPoint = true
    }
    def RectLight "panel"
    {
        float inputs:width = 200
        float inputs:height = 50
        float inputs:intensity = 15000
        bool inputs:normalize = true
    }
    def DiskLight "disk"
    {
        float inputs:radius = 100
        float inputs:intensity = 4000
        bool inputs:normalize = true
    }`,
        0.01,
      ),
    );
    // 5 cm radius: 30 000 × 0.001 × π × 0.05²
    expect(lightByName(robot, "small").intensity).toBeCloseTo(30 * Math.PI * 0.0025, 9);
    expect(lightByName(robot, "normalized").intensity).toBeCloseTo(30 / 4, 9);
    expect(lightByName(robot, "point").intensity).toBeCloseTo(30, 9);
    // 2 m × 0.5 m panel, normalized: 15 nits-scaled / 1 m²
    expect(lightByName(robot, "panel").intensity).toBeCloseTo(15 / 1, 9);
    // 1 m disk, normalized: 4 / (π r²) × π/4 = 1 / r² × 1/4 ... = 1
    expect(lightByName(robot, "disk").intensity).toBeCloseTo((4 / Math.PI) * (Math.PI / 4), 9);
  });

  it("keeps the point model on unitless stages unless lightEmitterModel forces radiance", async () => {
    const unitless = litStage(`    def SphereLight "lamp"
    {
        float inputs:radius = 0.1
        float inputs:intensity = 7
    }`);
    const auto = await new ThreeUsdRobotLoader().parse(unitless);
    expect(auto.lightEmitterModel).toBe("point");
    expect(lightByName(auto, "lamp").intensity).toBeCloseTo(7, 9);

    const forced = await new ThreeUsdRobotLoader({ lightEmitterModel: "radiance" }).parse(unitless);
    expect(forced.lightEmitterModel).toBe("radiance");
    expect(lightByName(forced, "lamp").intensity).toBeCloseTo(7 * Math.PI * 0.01, 9);

    const photometric = litStage(`    def SphereLight "bulb"
    {
        float inputs:radius = 0.1
        float inputs:intensity = 30000
    }`);
    const point = await new ThreeUsdRobotLoader({ lightEmitterModel: "point" }).parse(photometric);
    expect(point.lightEmitterModel).toBe("point");
    expect(lightByName(point, "bulb").intensity).toBeCloseTo(30, 9);
  });
});

/** Encode one new-style RLE scanline: `[2, 2, hi, lo]` then four planar channels. */
function rleScanline(width: number, channels: number[][]): number[] {
  const out = [2, 2, width >> 8, width & 0xff];
  for (const values of channels) {
    // Alternate a literal block and a run so both decoder paths execute.
    const half = Math.floor(width / 2);
    out.push(half, ...values.slice(0, half));
    out.push(128 + (width - half), values[half]!);
  }
  return out;
}

describe("Radiance HDR decoder (M29)", () => {
  it("decodes new-style RLE scanlines with RGBELoader's conversion", () => {
    const width = 8;
    const header = new TextEncoder().encode(
      `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=1.0\n\n-Y 2 +X ${width}\n`,
    );
    const row = (e: number) =>
      rleScanline(width, [
        Array(width).fill(128),
        Array(width).fill(64),
        Array(width).fill(32),
        Array(width).fill(e),
      ]);
    const body = new Uint8Array([...row(129), ...row(130)]);
    const bytes = new Uint8Array(header.length + body.length);
    bytes.set(header);
    bytes.set(body, header.length);

    const image = decodeRadianceHdr(bytes);
    expect(image.width).toBe(width);
    expect(image.height).toBe(2);
    expect(image.data.length).toBe(width * 2 * 4);
    const px = (i: number) => THREE.DataUtils.fromHalfFloat(image.data[i]!);
    // 128 × 2^(129−128) / 255
    expect(px(0)).toBeCloseTo(128 * (2 / 255), 3);
    expect(px(1)).toBeCloseTo(64 * (2 / 255), 3);
    expect(px(2)).toBeCloseTo(32 * (2 / 255), 3);
    expect(px(3)).toBe(1);
    // Last pixel of the second row: exponent 130 doubles it.
    const last = (width * 2 - 1) * 4;
    expect(px(last)).toBeCloseTo(128 * (4 / 255), 3);
  });

  it("decodes flat scanlines and zero exponents", () => {
    const header = new TextEncoder().encode("#?RGBE\n\n-Y 1 +X 2\n");
    const pixels = new Uint8Array([255, 0, 0, 128, 10, 10, 10, 0]);
    const bytes = new Uint8Array([...header, ...pixels]);
    const image = decodeRadianceHdr(bytes);
    expect(THREE.DataUtils.fromHalfFloat(image.data[0]!)).toBeCloseTo(1, 3);
    expect(THREE.DataUtils.fromHalfFloat(image.data[4]!)).toBe(0);
  });

  it("rejects other orientations, formats and truncated data", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(() => decodeRadianceHdr(enc("#?RADIANCE\n\n+Y 1 +X 2\n\0\0\0\0\0\0\0\0"))).toThrow(
      /orientation/,
    );
    expect(() =>
      decodeRadianceHdr(enc("#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 1 +X 2\n")),
    ).toThrow(/FORMAT/);
    expect(() => decodeRadianceHdr(enc("#?RADIANCE\n\n-Y 1 +X 2\n\0\0"))).toThrow(/truncated/);
    expect(() => decodeRadianceHdr(enc("PF\n"))).toThrow(/signature/);
  });
});

describe("three release shims (M29)", () => {
  it("picks PCFSoftShadowMap before r182 and the (now soft) PCFShadowMap from r182", () => {
    expect(softShadowMapType(181)).toBe(THREE.PCFSoftShadowMap);
    expect(softShadowMapType(182)).toBe(THREE.PCFShadowMap);
    expect(softShadowMapType(186)).toBe(THREE.PCFShadowMap);
  });

  it("inverts the environment Euler before r184 and passes it through from r184", () => {
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4);
    expect(environmentEulerFor(yaw, 183).y).toBeCloseTo(-0.4, 9);
    expect(environmentEulerFor(yaw, 184).y).toBeCloseTo(0.4, 9);
    expect(environmentEulerFor(yaw, 186).y).toBeCloseTo(0.4, 9);
  });
});
