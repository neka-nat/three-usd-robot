import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  CrateReader,
  Stage,
  type TextureOptions,
  type TextureProvider,
  buildMeshGeometry,
  buildMeshMaterial,
  crateToUsdaFile,
  resolveBoundMaterial,
} from "../src/index.js";

// M19: material/shader fidelity — faceVarying/indexed primvars, physical
// promotion, UV-set selection, colorspace, channel packing, OmniPBR extras,
// and binding strength.

const stageOf = (usda: string) => Stage.OpenFromString(usda);
const geomOf = (stage: Stage) => stage.GetPrimAtPath("/World/geom")!;

/** A texture provider stub that records every request. */
function recordingProvider(calls: { path: string; options?: TextureOptions }[]): TextureProvider {
  return (path, options) => {
    calls.push({ path, ...(options ? { options } : {}) });
    return new THREE.Texture();
  };
}

const attrOf = (g: THREE.BufferGeometry, name: string) =>
  g.getAttribute(name) as THREE.BufferAttribute;

describe("primvar interpolation (M19-1)", () => {
  it("de-indexes meshes with faceVarying st", () => {
    const stage = stageOf(`#usda 1.0
def Xform "World"
{
    def Mesh "geom"
    {
        int[] faceVertexCounts = [3, 3]
        int[] faceVertexIndices = [0, 1, 2, 0, 2, 3]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        texcoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 0), (1, 1), (0, 1)]
    }
}`);
    const geometry = buildMeshGeometry(geomOf(stage))!;
    expect(geometry.index).toBeNull(); // de-indexed: a vertex per face corner
    expect(attrOf(geometry, "position").count).toBe(6);
    const uv = attrOf(geometry, "uv");
    expect(uv.count).toBe(6);
    expect([uv.getX(0), uv.getY(0)]).toEqual([0, 0]);
    expect([uv.getX(5), uv.getY(5)]).toEqual([0, 1]);
    // Positions still follow faceVertexIndices: corner 3 is point 0 again.
    expect(attrOf(geometry, "position").getX(3)).toBe(0);
  });

  it("resolves primvars:st:indices for vertex-interpolated UVs", () => {
    const stage = stageOf(`#usda 1.0
def Xform "World"
{
    def Mesh "geom"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        texcoord2f[] primvars:st = [(0.25, 0.5), (0.75, 0.25)]
        int[] primvars:st:indices = [0, 1, 0]
    }
}`);
    const geometry = buildMeshGeometry(geomOf(stage))!;
    expect(geometry.index).not.toBeNull(); // stays shared-vertex
    const uv = attrOf(geometry, "uv");
    expect(uv.count).toBe(3);
    expect([uv.getX(1), uv.getY(1)]).toEqual([0.75, 0.25]);
    expect([uv.getX(2), uv.getY(2)]).toEqual([0.25, 0.5]);
  });

  it("turns per-vertex displayColor into vertex colors", () => {
    const stage = stageOf(`#usda 1.0
def Xform "World"
{
    def Mesh "geom"
    {
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        color3f[] primvars:displayColor = [(1, 0, 0), (0, 1, 0), (0, 0, 1)]
    }
}`);
    const geometry = buildMeshGeometry(geomOf(stage))!;
    expect(attrOf(geometry, "color").count).toBe(3);
    const material = buildMeshMaterial(geomOf(stage), stage) as THREE.MeshStandardMaterial;
    expect(material.vertexColors).toBe(true);
    expect(material.color.getHex()).toBe(0xffffff); // colors drive, base is white
  });

  it("expands faceVarying displayColor onto face corners", () => {
    const stage = stageOf(`#usda 1.0
def Xform "World"
{
    def Mesh "geom"
    {
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
        color3f[] primvars:displayColor = [(1, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)] (
            interpolation = "faceVarying"
        )
    }
}`);
    const geometry = buildMeshGeometry(geomOf(stage))!;
    expect(geometry.index).toBeNull();
    const color = attrOf(geometry, "color");
    expect(color.count).toBe(6); // quad → 2 triangles
    // Triangle fan corners: slots [0,1,2] and [0,2,3].
    expect(color.getX(0)).toBe(1);
    expect([color.getX(5), color.getY(5), color.getZ(5)]).toEqual([0, 0, 1]);
  });
});

const PHYSICAL = `#usda 1.0
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
                color3f inputs:diffuseColor = (0.2, 0.3, 0.4)
                float inputs:ior = 1.45
                float inputs:clearcoat = 0.6
                float inputs:clearcoatRoughness = 0.2
                int inputs:useSpecularWorkflow = 1
                color3f inputs:specularColor = (1, 0.5, 0.25)
                token outputs:surface
            }
        }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/Mat>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`;

describe("MeshPhysicalMaterial promotion (M19-2)", () => {
  it("promotes when ior/clearcoat/specular inputs are authored", () => {
    const stage = stageOf(PHYSICAL);
    const material = buildMeshMaterial(geomOf(stage), stage) as THREE.MeshPhysicalMaterial;
    expect(material.type).toBe("MeshPhysicalMaterial");
    expect(material.ior).toBeCloseTo(1.45, 9);
    expect(material.clearcoat).toBeCloseTo(0.6, 9);
    expect(material.clearcoatRoughness).toBeCloseTo(0.2, 9);
    expect(material.specularColor.r).toBeCloseTo(1, 9);
    expect(material.specularColor.g).toBeCloseTo(0.5, 9);
  });

  it("keeps plain materials on MeshStandardMaterial", () => {
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
        rel material:binding = </World/Looks/Mat>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`);
    const material = buildMeshMaterial(geomOf(stage), stage);
    expect(material.type).toBe("MeshStandardMaterial");
  });

  it("ignores specularColor when the metallic workflow is active", () => {
    const stage = stageOf(PHYSICAL.replace("int inputs:useSpecularWorkflow = 1", ""));
    expect(resolveBoundMaterial(stage, geomOf(stage))?.specularColor).toBeUndefined();
  });
});

const MULTI_UV = `#usda 1.0
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
                asset inputs:file = @./decal.png@
                token inputs:sourceColorSpace = "raw"
                float2 inputs:st.connect = </World/Looks/Mat/Transform.outputs:result>
            }
            def Shader "Transform"
            {
                uniform token info:id = "UsdTransform2d"
                float2 inputs:scale = (2, 3)
                float2 inputs:in.connect = </World/Looks/Mat/Reader.outputs:result>
            }
            def Shader "Reader"
            {
                uniform token info:id = "UsdPrimvarReader_float2"
                token inputs:varname = "st1"
            }
        }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/Mat>
        int[] faceVertexCounts = [3]
        int[] faceVertexIndices = [0, 1, 2]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        texcoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)]
        texcoord2f[] primvars:st1 = [(0.5, 0.5), (1, 0.5), (0.5, 1)]
    }
}`;

describe("UV-set selection & colorspace (M19-3/4)", () => {
  it("resolves the primvar reader's varname through a UsdTransform2d", () => {
    const stage = stageOf(MULTI_UV);
    const tex = resolveBoundMaterial(stage, geomOf(stage))?.colorTexture;
    expect(tex?.uvSet).toBe("st1");
    expect(tex?.transform?.scale).toEqual([2, 3]);
    expect(tex?.sourceColorSpace).toBe("raw");
  });

  it("loads extra UV sets as uv1 and samples the texture from that channel", () => {
    const stage = stageOf(MULTI_UV);
    const geometry = buildMeshGeometry(geomOf(stage))!;
    expect(attrOf(geometry, "uv").getX(1)).toBe(1); // st  → channel 0
    expect(attrOf(geometry, "uv1").getX(0)).toBe(0.5); // st1 → channel 1

    const calls: { path: string; options?: TextureOptions }[] = [];
    buildMeshMaterial(geomOf(stage), stage, recordingProvider(calls));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options?.channel).toBe(1);
    // sourceColorSpace = "raw" overrides the diffuse sRGB default.
    expect(calls[0]!.options?.colorSpace).toBe("linear");
  });
});

describe("packed-channel diagnostics (M19-5)", () => {
  const packed = (output: string) => `#usda 1.0
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
                float inputs:roughness.connect = </World/Looks/Mat/Tex.outputs:${output}>
                token outputs:surface
            }
            def Shader "Tex"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./pack.png@
            }
        }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/Mat>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`;

  it("warns when a map's output channel disagrees with three.js sampling", () => {
    const stage = stageOf(packed("r"));
    const warnings: string[] = [];
    buildMeshMaterial(geomOf(stage), stage, undefined, undefined, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("outputs:r");
    expect(warnings[0]).toContain("roughness");
  });

  it("stays silent for the glTF ORM layout", () => {
    const stage = stageOf(packed("g"));
    const warnings: string[] = [];
    buildMeshMaterial(geomOf(stage), stage, undefined, undefined, (m) => warnings.push(m));
    expect(warnings).toHaveLength(0);
  });
});

describe("OmniPBR extensions (M19-6)", () => {
  const OMNI = `#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            def Shader "Shader"
            {
                uniform token info:id = "OmniPBR"
                color3f inputs:diffuse_color_constant = (0.8, 0.1, 0.1)
                asset inputs:diffuse_texture = @./albedo.png@
                float2 inputs:texture_scale = (2, 2)
                bool inputs:enable_ORM_texture = true
                asset inputs:ORM_texture = @./orm.png@
                color3f inputs:emissive_color = (1, 0.5, 0)
                float inputs:emissive_intensity = 5
            }
        }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/Mat>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`;

  it("maps the packed ORM texture onto all three channels", () => {
    const bound = resolveBoundMaterial(stageOf(OMNI), geomOf(stageOf(OMNI)))!;
    expect(bound.occlusionTexture?.path).toBe("./orm.png");
    expect(bound.occlusionTexture?.outputChannel).toBe("r");
    expect(bound.roughnessTexture?.outputChannel).toBe("g");
    expect(bound.metalnessTexture?.outputChannel).toBe("b");
  });

  it("applies the MDL texture transform and emissive intensity", () => {
    const stage = stageOf(OMNI);
    const bound = resolveBoundMaterial(stage, geomOf(stage))!;
    expect(bound.colorTexture?.transform?.scale).toEqual([2, 2]);
    expect(bound.emissiveIntensity).toBe(5);
    const material = buildMeshMaterial(geomOf(stage), stage) as THREE.MeshStandardMaterial;
    expect(material.emissiveIntensity).toBe(5);
  });
});

describe("normal map scale (M19-4)", () => {
  it("maps authored scale onto normalScale (2 ≙ identity, sign flips green)", () => {
    const stage = stageOf(`#usda 1.0
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
                normal3f inputs:normal.connect = </World/Looks/Mat/Tex.outputs:rgb>
                token outputs:surface
            }
            def Shader "Tex"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./normal.png@
                float4 inputs:scale = (2, -2, 2, 1)
            }
        }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/Mat>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`);
    const calls: { path: string; options?: TextureOptions }[] = [];
    const material = buildMeshMaterial(
      geomOf(stage),
      stage,
      recordingProvider(calls),
    ) as THREE.MeshStandardMaterial;
    expect(material.normalMap).not.toBeNull();
    expect(material.normalScale.x).toBeCloseTo(1, 9);
    expect(material.normalScale.y).toBeCloseTo(-1, 9);
  });
});

describe("binding resolution (M19-7)", () => {
  it("prefers material:binding:preview over the all-purpose binding", () => {
    const stage = stageOf(`#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "A" { def Shader "S" { uniform token info:id = "UsdPreviewSurface" } }
        def Material "B" { def Shader "S" { uniform token info:id = "UsdPreviewSurface" } }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/A>
        rel material:binding:preview = </World/Looks/B>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`);
    expect(resolveBoundMaterial(stage, geomOf(stage))?.name).toBe("B");
  });

  it("lets a strongerThanDescendants ancestor override a leaf binding", () => {
    const strong = `#usda 1.0
def Xform "World" (
    prepend apiSchemas = ["MaterialBindingAPI"]
)
{
    rel material:binding = </World/Looks/A> (
        bindMaterialAs = "strongerThanDescendants"
    )

    def Scope "Looks"
    {
        def Material "A" { def Shader "S" { uniform token info:id = "UsdPreviewSurface" } }
        def Material "B" { def Shader "S" { uniform token info:id = "UsdPreviewSurface" } }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/B>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`;
    expect(resolveBoundMaterial(stageOf(strong), geomOf(stageOf(strong)))?.name).toBe("A");
    // Without the strength metadata the nearest (leaf) binding wins.
    const weak = strong.replace(
      ' (\n        bindMaterialAs = "strongerThanDescendants"\n    )',
      "",
    );
    expect(resolveBoundMaterial(stageOf(weak), geomOf(stageOf(weak)))?.name).toBe("B");
  });
});

describe("crate parity (M19)", () => {
  const usdc = new Uint8Array(
    readFileSync(new URL("../test-assets/anim_arm.usdc", import.meta.url)),
  );

  it("surfaces shader connections and primvar interpolation from crate files", () => {
    const file = crateToUsdaFile(new CrateReader(usdc));
    const world = file.prims.find((p) => p.name === "World")!;
    const looks = world.children.find((p) => p.name === "Looks")!;
    const surface = looks.children
      .find((p) => p.name === "Mat")!
      .children.find((p) => p.name === "Surface")!;
    const diffuse = surface.properties.find((p) => p.name === "inputs:diffuseColor");
    expect(diffuse?.kind === "attribute" && diffuse.connections).toEqual([
      "/World/Looks/Mat/Tex.outputs:rgb",
    ]);

    const skin = world.children
      .find((p) => p.name === "base")!
      .children.find((p) => p.name === "skin")!;
    const st = skin.properties.find((p) => p.name === "primvars:st");
    expect(st?.kind === "attribute" && st.metadata.interpolation).toBe("faceVarying");
  });

  it("resolves the crate-composed material with its texture network", () => {
    const stage = Stage.OpenFromFile(crateToUsdaFile(new CrateReader(usdc)));
    const skin = stage.GetPrimAtPath("/World/base/skin")!;
    expect(resolveBoundMaterial(stage, skin)?.colorTexture?.path).toBe("./checker.png");
    const geometry = buildMeshGeometry(skin)!;
    expect(geometry.index).toBeNull(); // faceVarying st → de-indexed quad
    expect(attrOf(geometry, "uv").count).toBe(6);
  });
});
