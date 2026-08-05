import * as THREE from "three";
import { MeshPhysicalNodeMaterial } from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  Stage,
  type TextureOptions,
  type TextureProvider,
  ThreeUsdRobotLoader,
} from "../src/index.js";
import { createMaterialXNodeFactory } from "../src/nodes.js";

// M22: MaterialX → TSL execution — ND_* graphs (noise, math, images) become
// MeshPhysicalNodeMaterial through the materialFactory hook; anything outside
// the conversion table falls back to the M21 parameter mapping with a warning.

const stageOf = (usda: string) => Stage.OpenFromString(usda);
const geomOf = (stage: Stage) => stage.GetPrimAtPath("/World/geom")!;

/** A standard_surface material (plus optional sibling shaders) bound to a mesh. */
function mtlxUsda(shaderBody: string, extraShaders = ""): string {
  return `#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            token outputs:mtlx:surface.connect = </World/Looks/Mat/Surface.outputs:out>

            def Shader "Surface"
            {
                uniform token info:id = "ND_standard_surface_surfaceshader"
${shaderBody}
                token outputs:out
            }
${extraShaders}
        }
    }

    def Mesh "geom"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        texcoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)]
        rel material:binding = </World/Looks/Mat>
    }
}`;
}

/** A texture provider stub that records every request. */
function recordingProvider(calls: { path: string; options?: TextureOptions }[]): TextureProvider {
  return (path, options) => {
    calls.push({ path, ...(options ? { options } : {}) });
    return new THREE.Texture();
  };
}

const constValue = (node: unknown): number => (node as { value: number }).value;

describe("standard_surface → NodeMaterial (M22)", () => {
  it("builds a NodeMaterial from a noise-driven graph", () => {
    const stage = stageOf(
      mtlxUsda(
        `                float inputs:base = 0.8
                color3f inputs:base_color.connect = </World/Looks/Mat/Noise.outputs:out>
                float inputs:specular_roughness = 0.35`,
        `            def Shader "Noise"
            {
                uniform token info:id = "ND_noise2d_color3"
                float inputs:amplitude = 0.5
                float inputs:pivot = 0.4
                color3f outputs:out
            }`,
      ),
    );
    const material = createMaterialXNodeFactory()(geomOf(stage), stage);
    expect(material).toBeInstanceOf(MeshPhysicalNodeMaterial);
    const node = material as MeshPhysicalNodeMaterial;
    expect(node.colorNode).toBeTruthy(); // base × mx_noise_vec3
    expect(constValue(node.roughnessNode)).toBe(0.35);
  });

  it("maps the physical inputs and constants onto material nodes", () => {
    const stage = stageOf(
      mtlxUsda(`                float inputs:base = 0.5
                color3f inputs:base_color = (0.4, 0.6, 0.8)
                float inputs:metalness = 0.9
                float inputs:coat = 1
                float inputs:coat_roughness = 0.15
                float inputs:specular_IOR = 1.6
                float inputs:transmission = 0.7
                float inputs:emission = 3
                color3f inputs:emission_color = (1, 0.5, 0)
                color3f inputs:opacity = (0.5, 0.5, 0.5)`),
    );
    const material = createMaterialXNodeFactory()(geomOf(stage), stage) as MeshPhysicalNodeMaterial;
    expect(material.colorNode).toBeTruthy();
    expect(constValue(material.metalnessNode)).toBe(0.9);
    expect(constValue(material.clearcoatNode)).toBe(1);
    expect(constValue(material.clearcoatRoughnessNode)).toBe(0.15);
    expect(constValue(material.iorNode)).toBeCloseTo(1.6, 9);
    expect(constValue(material.transmissionNode)).toBeCloseTo(0.7, 9);
    expect(material.emissiveNode).toBeTruthy();
    expect(material.opacityNode).toBeTruthy();
    expect(material.transparent).toBe(true);
  });

  it("converts math / mix / ramp chains", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Mix.outputs:out>",
        `            def Shader "Mix"
            {
                uniform token info:id = "ND_mix_color3"
                color3f inputs:fg = (1, 0, 0)
                color3f inputs:bg.connect = </World/Looks/Mat/Mul.outputs:out>
                float inputs:mix.connect = </World/Looks/Mat/Ramp.outputs:out>
                color3f outputs:out
            }
            def Shader "Mul"
            {
                uniform token info:id = "ND_multiply_color3FA"
                color3f inputs:in1 = (0.2, 0.4, 0.6)
                float inputs:in2 = 0.5
                color3f outputs:out
            }
            def Shader "Ramp"
            {
                uniform token info:id = "ND_ramplr_float"
                float inputs:valuel = 0
                float inputs:valuer = 1
                float outputs:out
            }`,
      ),
    );
    const material = createMaterialXNodeFactory()(geomOf(stage), stage) as MeshPhysicalNodeMaterial;
    expect(material).toBeInstanceOf(MeshPhysicalNodeMaterial);
    expect(material.colorNode).toBeTruthy();
  });

  it("samples images with the texture provider (colorspace + texcoord channel)", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Image.outputs:out>",
        `            def Shader "Image"
            {
                uniform token info:id = "ND_image_color3"
                asset inputs:file = @./albedo.png@
                float2 inputs:texcoord.connect = </World/Looks/Mat/Texcoord.outputs:out>
                color3f outputs:out
            }
            def Shader "Texcoord"
            {
                uniform token info:id = "ND_texcoord_vector2"
                int inputs:index = 1
                float2 outputs:out
            }`,
      ),
    );
    const calls: { path: string; options?: TextureOptions }[] = [];
    const material = createMaterialXNodeFactory({ textureProvider: recordingProvider(calls) })(
      geomOf(stage),
      stage,
    ) as MeshPhysicalNodeMaterial;
    expect(material.colorNode).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("./albedo.png");
    expect(calls[0]!.options?.colorSpace).toBe("srgb");
    expect(calls[0]!.options?.channel).toBe(1);
  });
});

describe("fallback to the parameter mapping (M22)", () => {
  it("returns null with a warning for nodes outside the conversion table", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Blur.outputs:out>",
        `            def Shader "Blur"
            {
                uniform token info:id = "ND_blur_color3"
                color3f outputs:out
            }`,
      ),
    );
    const warnings: string[] = [];
    const factory = createMaterialXNodeFactory({ onWarn: (m) => warnings.push(m) });
    expect(factory(geomOf(stage), stage)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ND_blur_color3");
    expect(warnings[0]).toContain("falling back");
  });

  it("returns null with a warning when an image has no texture provider", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Image.outputs:out>",
        `            def Shader "Image"
            {
                uniform token info:id = "ND_image_color3"
                asset inputs:file = @./albedo.png@
                color3f outputs:out
            }`,
      ),
    );
    const warnings: string[] = [];
    const factory = createMaterialXNodeFactory({ onWarn: (m) => warnings.push(m) });
    expect(factory(geomOf(stage), stage)).toBeNull();
    expect(warnings[0]).toContain("texture provider");
  });

  it("declines non-MaterialX materials without warning", () => {
    const stage = stageOf(`#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            def Shader "Surface"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (1, 0, 0)
            }
        }
    }
    def Mesh "geom"
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        rel material:binding = </World/Looks/Mat>
    }
}`);
    const warnings: string[] = [];
    const factory = createMaterialXNodeFactory({ onWarn: (m) => warnings.push(m) });
    expect(factory(geomOf(stage), stage)).toBeNull();
    expect(warnings).toHaveLength(0);
  });
});

describe("loader integration (M22)", () => {
  const NOISE_SCENE = mtlxUsda(
    "                color3f inputs:base_color.connect = </World/Looks/Mat/Noise.outputs:out>",
    `            def Shader "Noise"
            {
                uniform token info:id = "ND_noise3d_color3"
                color3f outputs:out
            }`,
  );

  it("renders a noise material as a NodeMaterial end to end", async () => {
    const loader = new ThreeUsdRobotLoader({
      loadTextures: false,
      materialFactory: createMaterialXNodeFactory(),
    });
    const robot = await loader.parse(NOISE_SCENE, "");
    const mesh = robot.getObjectByName("geom") as THREE.Mesh;
    expect(mesh.material).toBeInstanceOf(MeshPhysicalNodeMaterial);
  });

  it("keeps the M21 parameter mapping when the factory declines", async () => {
    const loader = new ThreeUsdRobotLoader({
      loadTextures: false,
      materialFactory: createMaterialXNodeFactory(),
    });
    // A graph with an unsupported node: the factory declines, the core builds
    // the parameter-mapped material (the blurred channel warned away there).
    const robot = await loader.parse(
      mtlxUsda(
        `                color3f inputs:base_color = (0.8, 0.1, 0.1)
                float inputs:specular_roughness.connect = </World/Looks/Mat/Blur.outputs:out>`,
        `            def Shader "Blur"
            {
                uniform token info:id = "ND_blur_color3"
                color3f outputs:out
            }`,
      ),
      "",
    );
    const mesh = robot.getObjectByName("geom") as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(material).not.toBeInstanceOf(MeshPhysicalNodeMaterial);
    expect(material.color.r).toBeCloseTo(0.8, 6);
  });
});
