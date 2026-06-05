import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Stage, buildMeshMaterial, resolveBoundMaterial } from "../src/index.js";

// UsdPreviewSurface whose diffuse color is driven by a UsdUVTexture network.
const PREVIEW_TEX = `#usda 1.0
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
                asset inputs:file = @./textures/wood.png@
                token outputs:rgb
            }
        }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/Mat>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`;

// OmniPBR MDL with a direct diffuse texture input.
const OMNI_TEX = `#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            def Shader "Shader"
            {
                uniform token info:id = "UsdPreviewSurface"
                asset inputs:diffuse_texture = @./albedo.jpg@
                token outputs:surface
            }
        }
    }
    def Mesh "geom" { rel material:binding = </World/Looks/Mat> }
}`;

// Full UsdPreviewSurface PBR network: normal / roughness / metallic / occlusion
// via connected UsdUVTexture nodes, plus a constant + map emissive.
const PREVIEW_PBR = `#usda 1.0
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
                color3f inputs:diffuseColor.connect = </World/Looks/Mat/Albedo.outputs:rgb>
                normal3f inputs:normal.connect = </World/Looks/Mat/Normal.outputs:rgb>
                float inputs:roughness.connect = </World/Looks/Mat/Rough.outputs:r>
                float inputs:metallic.connect = </World/Looks/Mat/Metal.outputs:r>
                float inputs:occlusion.connect = </World/Looks/Mat/Occ.outputs:r>
                color3f inputs:emissiveColor.connect = </World/Looks/Mat/Emit.outputs:rgb>
                token outputs:surface
            }
            def Shader "Albedo"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./albedo.png@
                token outputs:rgb
            }
            def Shader "Normal"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./normal.png@
                token outputs:rgb
            }
            def Shader "Rough"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./rough.png@
                token outputs:r
            }
            def Shader "Metal"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./metal.png@
                token outputs:r
            }
            def Shader "Occ"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./ao.png@
                token outputs:r
            }
            def Shader "Emit"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./emit.png@
                token outputs:rgb
            }
        }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/Mat>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`;

// OmniPBR MDL with direct asset-valued PBR texture inputs.
const OMNI_PBR = `#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            def Shader "Shader"
            {
                uniform token info:id = "UsdPreviewSurface"
                asset inputs:normalmap_texture = @./n.png@
                asset inputs:reflectionroughness_texture = @./r.png@
                asset inputs:metallic_texture = @./m.png@
                asset inputs:ao_texture = @./ao.png@
                color3f inputs:emissive_color = (1, 0, 0)
                bool inputs:enable_emission = 1
                token outputs:surface
            }
        }
    }
    def Mesh "geom" { rel material:binding = </World/Looks/Mat> }
}`;

describe("texture detection", () => {
  it("follows a UsdPreviewSurface -> UsdUVTexture network to the file", () => {
    const stage = Stage.OpenFromString(PREVIEW_TEX);
    const mat = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/geom")!);
    expect(mat?.colorTexture?.path).toBe("./textures/wood.png");
  });

  it("reads an OmniPBR diffuse_texture input directly", () => {
    const stage = Stage.OpenFromString(OMNI_TEX);
    const mat = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/geom")!);
    expect(mat?.colorTexture?.path).toBe("./albedo.jpg");
  });

  it("resolves every UsdPreviewSurface PBR channel + emissive constant", () => {
    const stage = Stage.OpenFromString(PREVIEW_PBR);
    const mat = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/geom")!);
    expect(mat?.colorTexture?.path).toBe("./albedo.png");
    expect(mat?.normalTexture?.path).toBe("./normal.png");
    expect(mat?.roughnessTexture?.path).toBe("./rough.png");
    expect(mat?.metalnessTexture?.path).toBe("./metal.png");
    expect(mat?.occlusionTexture?.path).toBe("./ao.png");
    expect(mat?.emissiveTexture?.path).toBe("./emit.png");
  });

  it("resolves OmniPBR direct PBR texture inputs and gated emission", () => {
    const stage = Stage.OpenFromString(OMNI_PBR);
    const mat = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/geom")!);
    expect(mat?.normalTexture?.path).toBe("./n.png");
    expect(mat?.roughnessTexture?.path).toBe("./r.png");
    expect(mat?.metalnessTexture?.path).toBe("./m.png");
    expect(mat?.occlusionTexture?.path).toBe("./ao.png");
    expect(mat?.emissiveColor).toEqual([1, 0, 0]);
  });
});

describe("buildMeshMaterial — texture map", () => {
  it("assigns material.map from the provider and whitens the base color", () => {
    const stage = Stage.OpenFromString(PREVIEW_TEX);
    const mesh = stage.GetPrimAtPath("/World/geom")!;
    const fakeTexture = new THREE.Texture();
    const provider = (path: string) => (path === "./textures/wood.png" ? fakeTexture : null);

    const material = buildMeshMaterial(mesh, stage, provider) as THREE.MeshStandardMaterial;
    expect(material.map).toBe(fakeTexture);
    expect(material.color.getHex()).toBe(0xffffff);
  });

  it("leaves map unset when no provider is given", () => {
    const stage = Stage.OpenFromString(PREVIEW_TEX);
    const material = buildMeshMaterial(
      stage.GetPrimAtPath("/World/geom")!,
      stage,
    ) as THREE.MeshStandardMaterial;
    expect(material.map).toBeNull();
  });

  it("wires PBR maps with the right color spaces and unattenuated factors", () => {
    const stage = Stage.OpenFromString(PREVIEW_PBR);
    const mesh = stage.GetPrimAtPath("/World/geom")!;
    // The provider tags each returned texture so we can assert color space.
    const provider = (path: string, options: { colorSpace?: "srgb" | "linear" } = {}) => {
      const t = new THREE.Texture();
      t.colorSpace = options.colorSpace === "linear" ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      t.userData.path = path;
      return t;
    };

    const m = buildMeshMaterial(mesh, stage, provider) as THREE.MeshStandardMaterial;
    expect(m.map?.userData.path).toBe("./albedo.png");
    expect(m.map?.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(m.normalMap?.userData.path).toBe("./normal.png");
    expect(m.normalMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(m.roughnessMap?.userData.path).toBe("./rough.png");
    expect(m.roughnessMap?.colorSpace).toBe(THREE.NoColorSpace);
    expect(m.metalnessMap?.userData.path).toBe("./metal.png");
    expect(m.aoMap?.userData.path).toBe("./ao.png");
    expect(m.emissiveMap?.userData.path).toBe("./emit.png");
    expect(m.emissiveMap?.colorSpace).toBe(THREE.SRGBColorSpace);
    // Scalar maps present but no authored constant ⇒ factors default to 1.
    expect(m.roughness).toBe(1);
    expect(m.metalness).toBe(1);
    // Emissive map present, no constant ⇒ emissive defaults to white to pass it through.
    expect(m.emissive.getHex()).toBe(0xffffff);
  });
});

// UsdUVTexture with wrap modes, scale/bias, and a UsdTransform2d on `st`.
const SAMPLER = `#usda 1.0
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
                float inputs:roughness.connect = </World/Looks/Mat/Rough.outputs:r>
                token outputs:surface
            }
            def Shader "Tex"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./wood.png@
                token inputs:wrapS = "clamp"
                token inputs:wrapT = "mirror"
                float4 inputs:scale = (0.5, 0.25, 0.75, 1)
                float2 inputs:st.connect = </World/Looks/Mat/Place.outputs:result>
                token outputs:rgb
            }
            def Shader "Rough"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./rough.png@
                float4 inputs:scale = (0.4, 0, 0, 1)
                token outputs:r
            }
            def Shader "Place"
            {
                uniform token info:id = "UsdTransform2d"
                float2 inputs:translation = (0.1, 0.2)
                float inputs:rotation = 90
                float2 inputs:scale = (2, 3)
                float2 outputs:result
            }
        }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/Mat>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    }
}`;

describe("UsdUVTexture sampler / transform", () => {
  it("resolves wrap modes, scale, and the UsdTransform2d", () => {
    const stage = Stage.OpenFromString(SAMPLER);
    const mat = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/geom")!);
    const ct = mat?.colorTexture;
    expect(ct?.wrapS).toBe("clamp");
    expect(ct?.wrapT).toBe("mirror");
    expect(ct?.scale).toEqual([0.5, 0.25, 0.75, 1]);
    expect(ct?.transform).toEqual({ translation: [0.1, 0.2], rotation: 90, scale: [2, 3] });
  });

  it("forwards wrap/transform to the provider and folds scale into factors", () => {
    const stage = Stage.OpenFromString(SAMPLER);
    const mesh = stage.GetPrimAtPath("/World/geom")!;
    const seen: Record<string, { wrapS?: string; wrapT?: string; transform?: unknown }> = {};
    const provider = (
      path: string,
      options: { wrapS?: string; wrapT?: string; transform?: unknown } = {},
    ) => {
      seen[path] = options;
      const t = new THREE.Texture();
      t.userData.path = path;
      return t;
    };

    const m = buildMeshMaterial(mesh, stage, provider) as THREE.MeshStandardMaterial;
    // Wrap + transform reach the provider for the diffuse texture.
    expect(seen["./wood.png"]).toMatchObject({
      wrapS: "clamp",
      wrapT: "mirror",
      transform: { translation: [0.1, 0.2], rotation: 90, scale: [2, 3] },
    });
    // Diffuse `inputs:scale.rgb` tints the (otherwise-white) textured base color.
    expect(m.color.toArray()).toEqual([0.5, 0.25, 0.75]);
    // Roughness `inputs:scale[0]` becomes the roughness factor.
    expect(m.roughness).toBe(0.4);
  });
});

// A constant translucent opacity (UsdPreviewSurface), no texture.
const TRANSLUCENT = `#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            token outputs:surface.connect = </World/Looks/Mat/S.outputs:surface>
            def Shader "S"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (0.2, 0.6, 0.9)
                float inputs:opacity = 0.4
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

// Alpha-clip cutout: opacity driven by the diffuse texture's own alpha + a
// threshold (binary mask). The opacity input connects to the SAME UsdUVTexture.
const CUTOUT = `#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            token outputs:surface.connect = </World/Looks/Mat/S.outputs:surface>
            def Shader "S"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor.connect = </World/Looks/Mat/Tex.outputs:rgb>
                float inputs:opacity.connect = </World/Looks/Mat/Tex.outputs:a>
                float inputs:opacityThreshold = 0.5
                token outputs:surface
            }
            def Shader "Tex"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./leaf.png@
                token outputs:rgb
                float outputs:a
            }
        }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/Mat>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)]
    }
}`;

// A dedicated grayscale opacity texture, separate from the diffuse map.
const MASKED = `#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            token outputs:surface.connect = </World/Looks/Mat/S.outputs:surface>
            def Shader "S"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor.connect = </World/Looks/Mat/Albedo.outputs:rgb>
                float inputs:opacity.connect = </World/Looks/Mat/Mask.outputs:r>
                token outputs:surface
            }
            def Shader "Albedo"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./albedo.png@
                token outputs:rgb
            }
            def Shader "Mask"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./mask.png@
                token outputs:r
            }
        }
    }
    def Mesh "geom"
    {
        rel material:binding = </World/Looks/Mat>
        point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (0, 1)]
    }
}`;

describe("opacity / alpha clip", () => {
  const tagProvider = () => {
    const t = new THREE.Texture();
    return (path: string) => {
      const tex = t.clone();
      tex.userData.path = path;
      return tex;
    };
  };

  it("resolves opacity constant, threshold, and the opacity texture", () => {
    const cut = resolveBoundMaterial(
      Stage.OpenFromString(CUTOUT),
      Stage.OpenFromString(CUTOUT).GetPrimAtPath("/World/geom")!,
    );
    expect(cut?.opacityThreshold).toBe(0.5);
    expect(cut?.opacityTexture?.path).toBe("./leaf.png");

    const tl = resolveBoundMaterial(
      Stage.OpenFromString(TRANSLUCENT),
      Stage.OpenFromString(TRANSLUCENT).GetPrimAtPath("/World/geom")!,
    );
    expect(tl?.opacity).toBe(0.4);
    expect(tl?.opacityThreshold).toBeUndefined();
  });

  it("blends a constant sub-unit opacity (no threshold)", () => {
    const stage = Stage.OpenFromString(TRANSLUCENT);
    const m = buildMeshMaterial(
      stage.GetPrimAtPath("/World/geom")!,
      stage,
    ) as THREE.MeshStandardMaterial;
    expect(m.opacity).toBe(0.4);
    expect(m.transparent).toBe(true);
    expect(m.alphaTest).toBe(0);
  });

  it("alpha-clips via the diffuse map's own alpha (shared image, no alphaMap)", () => {
    const stage = Stage.OpenFromString(CUTOUT);
    const m = buildMeshMaterial(
      stage.GetPrimAtPath("/World/geom")!,
      stage,
      tagProvider(),
    ) as THREE.MeshStandardMaterial;
    expect(m.alphaTest).toBe(0.5);
    expect(m.transparent).toBe(false); // masked cutout renders in the opaque pass
    expect(m.map?.userData.path).toBe("./leaf.png");
    expect(m.alphaMap).toBeNull(); // diffuse map's alpha is reused
  });

  it("uses a dedicated alphaMap when opacity is a separate texture", () => {
    const stage = Stage.OpenFromString(MASKED);
    const m = buildMeshMaterial(
      stage.GetPrimAtPath("/World/geom")!,
      stage,
      tagProvider(),
    ) as THREE.MeshStandardMaterial;
    expect(m.map?.userData.path).toBe("./albedo.png");
    expect(m.alphaMap?.userData.path).toBe("./mask.png");
    expect(m.transparent).toBe(true); // no threshold ⇒ blended
  });
});
