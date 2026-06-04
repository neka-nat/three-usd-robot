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
});
