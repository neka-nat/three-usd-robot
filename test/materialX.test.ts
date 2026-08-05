import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  CrateReader,
  Stage,
  type TextureOptions,
  type TextureProvider,
  ThreeUsdRobotLoader,
  buildMeshMaterial,
  crateToUsdaFile,
  resolveBoundMaterial,
} from "../src/index.js";

// M21: MaterialX basic — natively-authored UsdShade ND_* networks resolved by
// parameter mapping: the standard_surface reader, image/UV nodes, constant
// folding, per-channel warning skips, and ND_Usd* delegation.

const stageOf = (usda: string) => Stage.OpenFromString(usda);
const geomOf = (stage: Stage) => stage.GetPrimAtPath("/World/geom")!;

/** A texture provider stub that records every request. */
function recordingProvider(calls: { path: string; options?: TextureOptions }[]): TextureProvider {
  return (path, options) => {
    calls.push({ path, ...(options ? { options } : {}) });
    return new THREE.Texture();
  };
}

/** A standard_surface material (plus optional sibling shaders) bound to a mesh. */
function mtlxUsda(shaderBody: string, extraShaders = "", meshExtra = ""): string {
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
        texcoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)]${meshExtra}
        rel material:binding = </World/Looks/Mat>
    }
}`;
}

describe("standard_surface constants (M21)", () => {
  it("maps base × base_color, metalness and specular_roughness", () => {
    const stage = stageOf(
      mtlxUsda(`                float inputs:base = 0.5
                color3f inputs:base_color = (0.4, 0.6, 0.8)
                float inputs:metalness = 0.9
                float inputs:specular_roughness = 0.35`),
    );
    const bound = resolveBoundMaterial(stage, geomOf(stage))!;
    expect(bound.color).toEqual([0.2, 0.3, 0.4]);
    expect(bound.metalness).toBe(0.9);
    expect(bound.roughness).toBe(0.35);
    const material = buildMeshMaterial(geomOf(stage), stage);
    expect(material.type).toBe("MeshStandardMaterial");
  });

  it("promotes coat / specular_IOR / transmission to MeshPhysicalMaterial", () => {
    const stage = stageOf(
      mtlxUsda(`                float inputs:coat = 1
                float inputs:coat_roughness = 0.15
                float inputs:specular_IOR = 1.6
                float inputs:transmission = 0.7`),
    );
    const material = buildMeshMaterial(geomOf(stage), stage) as THREE.MeshPhysicalMaterial;
    expect(material.type).toBe("MeshPhysicalMaterial");
    expect(material.clearcoat).toBe(1);
    expect(material.clearcoatRoughness).toBeCloseTo(0.15, 9);
    expect(material.ior).toBeCloseTo(1.6, 9);
    expect(material.transmission).toBeCloseTo(0.7, 9);
  });

  it("gates emission_color behind the emission weight", () => {
    const lit = stageOf(
      mtlxUsda(`                float inputs:emission = 3
                color3f inputs:emission_color = (1, 0.5, 0)`),
    );
    const bound = resolveBoundMaterial(lit, geomOf(lit))!;
    expect(bound.emissiveColor).toEqual([1, 0.5, 0]);
    expect(bound.emissiveIntensity).toBe(3);

    // emission defaults to 0 — an authored color alone must stay dark.
    const dark = stageOf(mtlxUsda("                color3f inputs:emission_color = (1, 0.5, 0)"));
    expect(resolveBoundMaterial(dark, geomOf(dark))!.emissiveColor).toBeUndefined();
  });

  it("takes the mean of the color3 opacity", () => {
    const stage = stageOf(mtlxUsda("                color3f inputs:opacity = (0.4, 0.5, 0.6)"));
    expect(resolveBoundMaterial(stage, geomOf(stage))!.opacity).toBeCloseTo(0.5, 9);
    const material = buildMeshMaterial(geomOf(stage), stage);
    expect(material.opacity).toBeCloseTo(0.5, 9);
    expect(material.transparent).toBe(true);
  });
});

describe("image & UV nodes (M21)", () => {
  it("reads ND_image with address modes and a texcoord UV-channel index", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Image.outputs:out>",
        `            def Shader "Image"
            {
                uniform token info:id = "ND_image_color3"
                asset inputs:file = @./albedo.png@
                token inputs:uaddressmode = "clamp"
                float2 inputs:texcoord.connect = </World/Looks/Mat/Texcoord.outputs:out>
                color3f outputs:out
            }
            def Shader "Texcoord"
            {
                uniform token info:id = "ND_texcoord_vector2"
                int inputs:index = 1
                float2 outputs:out
            }`,
        "\n        texcoord2f[] primvars:st1 = [(0.5, 0.5), (1, 0.5), (0.5, 1)]",
      ),
    );
    const tex = resolveBoundMaterial(stage, geomOf(stage))!.colorTexture;
    expect(tex?.path).toBe("./albedo.png");
    expect(tex?.wrapS).toBe("clamp");
    expect(tex?.uvChannel).toBe(1);

    const calls: { path: string; options?: TextureOptions }[] = [];
    buildMeshMaterial(geomOf(stage), stage, recordingProvider(calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options?.channel).toBe(1);
    expect(calls[0]!.options?.colorSpace).toBe("srgb");
  });

  it("maps ND_tiledimage uvtiling/uvoffset onto the texture transform", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Image.outputs:out>",
        `            def Shader "Image"
            {
                uniform token info:id = "ND_tiledimage_color3"
                asset inputs:file = @./tile.png@
                float2 inputs:uvtiling = (2, 3)
                float2 inputs:uvoffset = (0.1, 0.2)
                color3f outputs:out
            }`,
      ),
    );
    const tex = resolveBoundMaterial(stage, geomOf(stage))!.colorTexture;
    expect(tex?.wrapS).toBe("repeat");
    expect(tex?.wrapT).toBe("repeat");
    expect(tex?.transform?.scale).toEqual([2, 3]);
    expect(tex?.transform?.translation).toEqual([0.1, 0.2]);
  });

  it("resolves ND_geompropvalue to a UV set by primvar name", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Image.outputs:out>",
        `            def Shader "Image"
            {
                uniform token info:id = "ND_image_color3"
                asset inputs:file = @./decal.png@
                float2 inputs:texcoord.connect = </World/Looks/Mat/Coords.outputs:out>
                color3f outputs:out
            }
            def Shader "Coords"
            {
                uniform token info:id = "ND_geompropvalue_vector2"
                string inputs:geomprop = "st1"
                float2 outputs:out
            }`,
        "\n        texcoord2f[] primvars:st1 = [(0.5, 0.5), (1, 0.5), (0.5, 1)]",
      ),
    );
    expect(resolveBoundMaterial(stage, geomOf(stage))!.colorTexture?.uvSet).toBe("st1");
    const calls: { path: string; options?: TextureOptions }[] = [];
    buildMeshMaterial(geomOf(stage), stage, recordingProvider(calls));
    expect(calls[0]!.options?.channel).toBe(1);
  });

  it("follows ND_normalmap to its image and maps its scale to normalScale", () => {
    const stage = stageOf(
      mtlxUsda(
        "                float3 inputs:normal.connect = </World/Looks/Mat/Nm.outputs:out>",
        `            def Shader "Nm"
            {
                uniform token info:id = "ND_normalmap"
                float3 inputs:in.connect = </World/Looks/Mat/NImg.outputs:out>
                float inputs:scale = 0.8
                float3 outputs:out
            }
            def Shader "NImg"
            {
                uniform token info:id = "ND_image_vector3"
                asset inputs:file = @./n.png@
                float3 outputs:out
            }`,
      ),
    );
    expect(resolveBoundMaterial(stage, geomOf(stage))!.normalTexture?.path).toBe("./n.png");
    const calls: { path: string; options?: TextureOptions }[] = [];
    const material = buildMeshMaterial(
      geomOf(stage),
      stage,
      recordingProvider(calls),
    ) as THREE.MeshStandardMaterial;
    expect(material.normalMap).not.toBeNull();
    expect(material.normalScale.x).toBeCloseTo(0.8, 9);
    expect(calls[0]!.options?.colorSpace).toBe("linear");
  });
});

describe("constant folding (M21)", () => {
  it("folds ND_multiply over an ND_constant input", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Mul.outputs:out>",
        `            def Shader "Mul"
            {
                uniform token info:id = "ND_multiply_color3"
                color3f inputs:in1 = (0.5, 0.5, 1)
                color3f inputs:in2.connect = </World/Looks/Mat/Const.outputs:out>
                color3f outputs:out
            }
            def Shader "Const"
            {
                uniform token info:id = "ND_constant_color3"
                color3f inputs:value = (0.8, 0.4, 1)
                color3f outputs:out
            }`,
      ),
    );
    expect(resolveBoundMaterial(stage, geomOf(stage))!.color).toEqual([0.4, 0.2, 1]);
  });

  it("broadcasts the color3FA float factor", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Mul.outputs:out>",
        `            def Shader "Mul"
            {
                uniform token info:id = "ND_multiply_color3FA"
                color3f inputs:in1 = (0.5, 1, 0.25)
                float inputs:in2 = 0.5
                color3f outputs:out
            }`,
      ),
    );
    expect(resolveBoundMaterial(stage, geomOf(stage))!.color).toEqual([0.25, 0.5, 0.125]);
  });

  it("folds ND_mix between constant backgrounds and foregrounds", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Mix.outputs:out>",
        `            def Shader "Mix"
            {
                uniform token info:id = "ND_mix_color3"
                color3f inputs:fg = (1, 0, 0)
                color3f inputs:bg = (0, 0, 1)
                float inputs:mix = 0.25
                color3f outputs:out
            }`,
      ),
    );
    expect(resolveBoundMaterial(stage, geomOf(stage))!.color).toEqual([0.25, 0, 0.75]);
  });

  it("passes ND_dot through and broadcasts ND_convert", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Dot.outputs:out>",
        `            def Shader "Dot"
            {
                uniform token info:id = "ND_dot_color3"
                color3f inputs:in.connect = </World/Looks/Mat/Conv.outputs:out>
                color3f outputs:out
            }
            def Shader "Conv"
            {
                uniform token info:id = "ND_convert_float_color3"
                float inputs:in = 0.25
                color3f outputs:out
            }`,
      ),
    );
    expect(resolveBoundMaterial(stage, geomOf(stage))!.color).toEqual([0.25, 0.25, 0.25]);
  });
});

describe("per-channel warning skips (M21)", () => {
  it("skips a noise-driven channel with a warning but keeps the rest", () => {
    const stage = stageOf(
      mtlxUsda(
        `                color3f inputs:base_color.connect = </World/Looks/Mat/Noise.outputs:out>
                float inputs:metalness = 1`,
        `            def Shader "Noise"
            {
                uniform token info:id = "ND_noise2d_color3"
                color3f outputs:out
            }`,
      ),
    );
    const warnings: string[] = [];
    const bound = resolveBoundMaterial(stage, geomOf(stage), {
      onWarn: (m) => warnings.push(m),
    })!;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ND_noise2d_color3");
    expect(warnings[0]).toContain("base_color");
    expect(bound.color).toBeUndefined();
    expect(bound.metalness).toBe(1); // the other channels survive
  });

  it("refuses to fold a multiply with a textured input", () => {
    const stage = stageOf(
      mtlxUsda(
        "                color3f inputs:base_color.connect = </World/Looks/Mat/Mul.outputs:out>",
        `            def Shader "Mul"
            {
                uniform token info:id = "ND_multiply_color3"
                color3f inputs:in1.connect = </World/Looks/Mat/Image.outputs:out>
                color3f inputs:in2 = (0.5, 0.5, 0.5)
                color3f outputs:out
            }
            def Shader "Image"
            {
                uniform token info:id = "ND_image_color3"
                asset inputs:file = @./albedo.png@
                color3f outputs:out
            }`,
      ),
    );
    const warnings: string[] = [];
    const bound = resolveBoundMaterial(stage, geomOf(stage), {
      onWarn: (m) => warnings.push(m),
    })!;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("constant folding");
    expect(bound.color).toBeUndefined();
    expect(bound.colorTexture).toBeUndefined();
  });

  it("warns on an unknown ND_* surface shader and keeps the best-effort reads", () => {
    const stage = stageOf(
      mtlxUsda("                color3f inputs:base_color = (0.8, 0.1, 0.1)").replace(
        "ND_standard_surface_surfaceshader",
        "ND_open_pbr_surface_surfaceshader",
      ),
    );
    const warnings: string[] = [];
    const bound = resolveBoundMaterial(stage, geomOf(stage), {
      onWarn: (m) => warnings.push(m),
    })!;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ND_open_pbr_surface_surfaceshader");
    expect(bound.color).toEqual([0.8, 0.1, 0.1]); // base_color is a generic diffuse name
  });
});

/** The same texture network authored with native and ND_Usd* node ids. */
function previewNetworkUsda(surfaceOutput: string, ids: Record<string, string>): string {
  return `#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            token ${surfaceOutput}.connect = </World/Looks/Mat/Surface.outputs:surface>

            def Shader "Surface"
            {
                uniform token info:id = "${ids.surface}"
                color3f inputs:diffuseColor.connect = </World/Looks/Mat/Tex.outputs:rgb>
                float inputs:roughness = 0.4
                float inputs:metallic = 0.8
                token outputs:surface
            }
            def Shader "Tex"
            {
                uniform token info:id = "${ids.texture}"
                asset inputs:file = @./decal.png@
                float2 inputs:st.connect = </World/Looks/Mat/Transform.outputs:result>
            }
            def Shader "Transform"
            {
                uniform token info:id = "${ids.transform}"
                float2 inputs:scale = (2, 3)
                float2 inputs:in.connect = </World/Looks/Mat/Reader.outputs:result>
            }
            def Shader "Reader"
            {
                uniform token info:id = "${ids.reader}"
                token inputs:varname = "st1"
            }
        }
    }

    def Mesh "geom"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        texcoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)]
        texcoord2f[] primvars:st1 = [(0.5, 0.5), (1, 0.5), (0.5, 1)]
        rel material:binding = </World/Looks/Mat>
    }
}`;
}

describe("ND_Usd* delegation (M21)", () => {
  it("resolves the ND_UsdPreviewSurface network identically to the native one", () => {
    const native = stageOf(
      previewNetworkUsda("outputs:surface", {
        surface: "UsdPreviewSurface",
        texture: "UsdUVTexture",
        transform: "UsdTransform2d",
        reader: "UsdPrimvarReader_float2",
      }),
    );
    const mtlx = stageOf(
      previewNetworkUsda("outputs:mtlx:surface", {
        surface: "ND_UsdPreviewSurface_surfaceshader",
        texture: "ND_UsdUVTexture",
        transform: "ND_UsdTransform2d",
        reader: "ND_UsdPrimvarReader_vector2",
      }),
    );
    const nativeBound = resolveBoundMaterial(native, geomOf(native))!;
    const mtlxBound = resolveBoundMaterial(mtlx, geomOf(mtlx))!;
    expect(mtlxBound).toEqual(nativeBound);
    expect(mtlxBound.colorTexture?.uvSet).toBe("st1");
    expect(mtlxBound.colorTexture?.transform?.scale).toEqual([2, 3]);
  });

  it("prefers the universal surface output over outputs:mtlx:surface", () => {
    const stage = stageOf(`#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            token outputs:surface.connect = </World/Looks/Mat/Preview.outputs:surface>
            token outputs:mtlx:surface.connect = </World/Looks/Mat/Standard.outputs:out>

            def Shader "Preview"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (0, 1, 0)
                token outputs:surface
            }
            def Shader "Standard"
            {
                uniform token info:id = "ND_standard_surface_surfaceshader"
                color3f inputs:base_color = (1, 0, 0)
                token outputs:out
            }
        }
    }
    def Mesh "geom"
    {
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        rel material:binding = </World/Looks/Mat>
    }
}`);
    expect(resolveBoundMaterial(stage, geomOf(stage))!.color).toEqual([0, 1, 0]);
  });
});

describe("loader integration (M21)", () => {
  it("renders a standard_surface scene end to end", async () => {
    const loader = new ThreeUsdRobotLoader({ loadTextures: false });
    const robot = await loader.parse(
      mtlxUsda(`                float inputs:base = 0.5
                color3f inputs:base_color = (0.4, 0.6, 0.8)
                float inputs:specular_IOR = 1.6`),
      "",
    );
    const mesh = robot.getObjectByName("geom") as THREE.Mesh;
    const material = mesh.material as THREE.MeshPhysicalMaterial;
    expect(material.type).toBe("MeshPhysicalMaterial");
    expect(material.color.r).toBeCloseTo(0.2, 6);
    expect(material.ior).toBeCloseTo(1.6, 6);
  });
});

describe("crate parity (M21)", () => {
  const usdc = new Uint8Array(
    readFileSync(new URL("../test-assets/mtlx_materials.usdc", import.meta.url)),
  );
  const usda = readFileSync(new URL("../test-assets/mtlx_materials.usda", import.meta.url), "utf8");

  const stages: [string, Stage][] = [
    ["usdc", Stage.OpenFromFile(crateToUsdaFile(new CrateReader(usdc)))],
    ["usda", stageOf(usda)],
  ];

  it.each(stages)("resolves the standard_surface constants from %s", (_label, stage) => {
    const prim = stage.GetPrimAtPath("/World/steel")!;
    const steel = resolveBoundMaterial(stage, prim)!;
    expect(steel.color?.[0]).toBeCloseTo(0.2, 5);
    expect(steel.color?.[2]).toBeCloseTo(0.4, 5);
    expect(steel.metalness).toBeCloseTo(0.9, 5);
    expect(steel.roughness).toBeCloseTo(0.35, 5);
    expect(steel.clearcoat).toBe(1);
    expect(steel.clearcoatRoughness).toBeCloseTo(0.15, 5);
    expect(steel.ior).toBeCloseTo(1.6, 5);
    expect(buildMeshMaterial(prim, stage).type).toBe("MeshPhysicalMaterial");
  });

  it.each(stages)("resolves the tiled image network from %s", (_label, stage) => {
    const textured = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/textured")!)!;
    expect(textured.colorTexture?.path).toBe("./crate.png");
    expect(textured.colorTexture?.wrapS).toBe("repeat");
    expect(textured.colorTexture?.transform?.scale).toEqual([2, 2]);
  });

  it.each(stages)("delegates the ND_UsdPreviewSurface material from %s", (_label, stage) => {
    const preview = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/preview")!)!;
    expect(preview.color?.[0]).toBeCloseTo(0.8, 5);
    expect(preview.color?.[1]).toBeCloseTo(0.1, 5);
    expect(preview.roughness).toBeCloseTo(0.5, 5);
  });
});
