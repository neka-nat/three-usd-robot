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
    expect(mat?.colorTexture).toBe("./textures/wood.png");
  });

  it("reads an OmniPBR diffuse_texture input directly", () => {
    const stage = Stage.OpenFromString(OMNI_TEX);
    const mat = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/geom")!);
    expect(mat?.colorTexture).toBe("./albedo.jpg");
  });

  it("resolves every UsdPreviewSurface PBR channel + emissive constant", () => {
    const stage = Stage.OpenFromString(PREVIEW_PBR);
    const mat = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/geom")!);
    expect(mat?.colorTexture).toBe("./albedo.png");
    expect(mat?.normalTexture).toBe("./normal.png");
    expect(mat?.roughnessTexture).toBe("./rough.png");
    expect(mat?.metalnessTexture).toBe("./metal.png");
    expect(mat?.occlusionTexture).toBe("./ao.png");
    expect(mat?.emissiveTexture).toBe("./emit.png");
  });

  it("resolves OmniPBR direct PBR texture inputs and gated emission", () => {
    const stage = Stage.OpenFromString(OMNI_PBR);
    const mat = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/geom")!);
    expect(mat?.normalTexture).toBe("./n.png");
    expect(mat?.roughnessTexture).toBe("./r.png");
    expect(mat?.metalnessTexture).toBe("./m.png");
    expect(mat?.occlusionTexture).toBe("./ao.png");
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
    const provider = (path: string, colorSpace: "srgb" | "linear" = "srgb") => {
      const t = new THREE.Texture();
      t.colorSpace = colorSpace === "linear" ? THREE.NoColorSpace : THREE.SRGBColorSpace;
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
