import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  CrateReader,
  type MdlModuleProvider,
  Stage,
  type TextureOptions,
  type TextureProvider,
  ThreeUsdRobotLoader,
  buildMeshMaterial,
  crateToUsdaFile,
  createMemoryResolver,
  parseMdl,
  resolveBoundMaterial,
} from "../src/index.js";

// M20: MDL coverage — Omni material families (OmniGlass / OmniPBR_ClearCoat /
// OmniSurface), .mdl wrapper/declaration value fallback, and the value
// priority chain (authored USD inputs > wrapper args > declaration defaults).

const stageOf = (usda: string) => Stage.OpenFromString(usda);
const geomOf = (stage: Stage) => stage.GetPrimAtPath("/World/geom")!;

/** A minimal stage with one MDL-shaded material bound to a triangle mesh. */
function mdlUsda(module: string, sub: string, inputs = ""): string {
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
                uniform asset info:mdl:sourceAsset = @${module}@
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

/** A texture provider stub that records every request. */
function recordingProvider(calls: { path: string; options?: TextureOptions }[]): TextureProvider {
  return (path, options) => {
    calls.push({ path, ...(options ? { options } : {}) });
    return new THREE.Texture();
  };
}

describe("OmniGlass (M20)", () => {
  it("maps authored inputs to a transmissive MeshPhysicalMaterial", () => {
    const stage = stageOf(
      mdlUsda(
        "OmniGlass.mdl",
        "OmniGlass",
        `                color3f inputs:glass_color = (0.2, 0.7, 0.9)
                float inputs:glass_ior = 1.2
                float inputs:frosting_roughness = 0.25
                float inputs:depth = 0.01`,
      ),
    );
    const bound = resolveBoundMaterial(stage, geomOf(stage))!;
    expect(bound.transmission).toBe(1);
    expect(bound.color).toEqual([0.2, 0.7, 0.9]);
    expect(bound.ior).toBe(1.2);
    expect(bound.roughness).toBe(0.25);
    expect(bound.thickness).toBe(0.01);
    expect(bound.metalness).toBe(0);

    const material = buildMeshMaterial(geomOf(stage), stage);
    expect(material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    const physical = material as THREE.MeshPhysicalMaterial;
    expect(physical.transmission).toBe(1);
    expect(physical.ior).toBe(1.2);
    expect(physical.thickness).toBe(0.01);
    expect(physical.roughness).toBe(0.25);
  });

  it("applies canonical glass defaults when no inputs are authored", () => {
    const stage = stageOf(mdlUsda("OmniGlass.mdl", "OmniGlass"));
    const bound = resolveBoundMaterial(stage, geomOf(stage))!;
    expect(bound.transmission).toBe(1);
    expect(bound.ior).toBeCloseTo(1.491, 6);
    expect(bound.roughness).toBe(0);
    expect(bound.color).toEqual([1, 1, 1]);
    expect(buildMeshMaterial(geomOf(stage), stage)).toBeInstanceOf(THREE.MeshPhysicalMaterial);
  });

  it("thin-walled glass gets no refraction volume", () => {
    const stage = stageOf(
      mdlUsda(
        "OmniGlass.mdl",
        "OmniGlass",
        `                bool inputs:thin_walled = true
                float inputs:depth = 0.01`,
      ),
    );
    expect(resolveBoundMaterial(stage, geomOf(stage))?.thickness).toBeUndefined();
  });
});

describe("OmniPBR_ClearCoat (M20)", () => {
  it("adds the coat on top of the OmniPBR base mapping", () => {
    const stage = stageOf(
      mdlUsda(
        "OmniPBR_ClearCoat.mdl",
        "OmniPBR_ClearCoat",
        `                color3f inputs:diffuse_color_constant = (0.5, 0.1, 0.1)
                float inputs:metallic_constant = 0.9
                float inputs:clearcoat_reflection_roughness = 0.15`,
      ),
    );
    const bound = resolveBoundMaterial(stage, geomOf(stage))!;
    expect(bound.color).toEqual([0.5, 0.1, 0.1]);
    expect(bound.metalness).toBe(0.9);
    expect(bound.clearcoat).toBe(1);
    expect(bound.clearcoatRoughness).toBe(0.15);

    const material = buildMeshMaterial(geomOf(stage), stage) as THREE.MeshPhysicalMaterial;
    expect(material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    expect(material.clearcoat).toBe(1);
    expect(material.clearcoatRoughness).toBe(0.15);
  });

  it("enable_clearcoat = false keeps the plain OmniPBR standard material", () => {
    const stage = stageOf(
      mdlUsda(
        "OmniPBR_ClearCoat.mdl",
        "OmniPBR_ClearCoat",
        `                color3f inputs:diffuse_color_constant = (0.5, 0.1, 0.1)
                bool inputs:enable_clearcoat = false`,
      ),
    );
    const bound = resolveBoundMaterial(stage, geomOf(stage))!;
    expect(bound.clearcoat).toBeUndefined();
    expect(bound.color).toEqual([0.5, 0.1, 0.1]);
    const material = buildMeshMaterial(geomOf(stage), stage);
    expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(material).not.toBeInstanceOf(THREE.MeshPhysicalMaterial);
  });

  it("clearcoat normal maps load as linear data on clearcoatNormalMap", () => {
    const stage = stageOf(
      mdlUsda(
        "OmniPBR_ClearCoat.mdl",
        "OmniPBR_ClearCoat",
        "                asset inputs:clearcoat_normalmap_texture = @coat_n.png@",
      ),
    );
    expect(resolveBoundMaterial(stage, geomOf(stage))?.clearcoatNormalTexture?.path).toBe(
      "coat_n.png",
    );
    const calls: { path: string; options?: TextureOptions }[] = [];
    const material = buildMeshMaterial(
      geomOf(stage),
      stage,
      recordingProvider(calls),
    ) as THREE.MeshPhysicalMaterial;
    expect(material.clearcoatNormalMap).toBeInstanceOf(THREE.Texture);
    const call = calls.find((c) => c.path === "coat_n.png");
    expect(call?.options?.colorSpace).toBe("linear");
  });
});

describe("OmniSurface (M20)", () => {
  it("maps the constants subset", () => {
    const stage = stageOf(
      mdlUsda(
        "OmniSurface.mdl",
        "OmniSurface",
        `                color3f inputs:diffuse_reflection_color = (0.1, 0.6, 0.2)
                float inputs:metalness = 0.4
                float inputs:specular_reflection_roughness = 0.35
                float inputs:specular_reflection_ior = 1.6
                float inputs:coat_weight = 0.8
                float inputs:coat_roughness = 0.05
                float inputs:emission_weight = 2
                color3f inputs:emission_color = (1, 0.5, 0)
                bool inputs:enable_opacity = true
                float inputs:geometry_opacity = 0.75`,
      ),
    );
    const bound = resolveBoundMaterial(stage, geomOf(stage))!;
    expect(bound.color).toEqual([0.1, 0.6, 0.2]);
    expect(bound.metalness).toBe(0.4);
    expect(bound.roughness).toBe(0.35);
    expect(bound.ior).toBe(1.6);
    expect(bound.clearcoat).toBe(0.8);
    expect(bound.clearcoatRoughness).toBe(0.05);
    expect(bound.emissiveColor).toEqual([1, 0.5, 0]);
    expect(bound.emissiveIntensity).toBe(2);
    expect(bound.opacity).toBe(0.75);
  });
});

describe("MDL family detection (M20)", () => {
  it("warns once about unknown families and falls back to the OmniPBR mapping", () => {
    const stage = stageOf(
      mdlUsda(
        "MyProceduralWood.mdl",
        "MyProceduralWood",
        "                color3f inputs:diffuse_color_constant = (0.4, 0.25, 0.1)",
      ),
    );
    const warnings: string[] = [];
    const bound = resolveBoundMaterial(stage, geomOf(stage), {
      onWarn: (m) => warnings.push(m),
    })!;
    expect(bound.color).toEqual([0.4, 0.25, 0.1]); // best effort still applies
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('unknown MDL material "MyProceduralWood"');
  });

  it("known families do not warn", () => {
    const stage = stageOf(mdlUsda("OmniGlass.mdl", "OmniGlass"));
    const warnings: string[] = [];
    resolveBoundMaterial(stage, geomOf(stage), { onWarn: (m) => warnings.push(m) });
    expect(warnings).toHaveLength(0);
  });

  it("falls back to the module file stem when subIdentifier is absent", () => {
    const stage = stageOf(`#usda 1.0
def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Mat"
        {
            token outputs:mdl:surface.connect = </World/Looks/Mat/Shader.outputs:out>

            def Shader "Shader"
            {
                uniform asset info:mdl:sourceAsset = @materials/OmniGlass.mdl@
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
}`);
    expect(resolveBoundMaterial(stage, geomOf(stage))?.transmission).toBe(1);
  });
});

const RED_PAINT_MDL = `mdl 1.6;

import ::OmniPBR::OmniPBR;
import ::anno::*;
import ::tex::gamma_mode;

export material RedPaint(*)
[[ anno::display_name("Red Paint") ]]
 = OmniPBR::OmniPBR(
    diffuse_color_constant: color(0.8f, 0.1f, 0.1f),
    reflection_roughness_constant: 0.3f,
    metallic_constant: 1.0f,
    diffuse_texture: texture_2d("./tex/red.png", ::tex::gamma_srgb),
    texture_scale: float2(4.0f)
);
`;

const redPaintProvider: MdlModuleProvider = (path) =>
  path === "./materials/RedPaint.mdl" ? parseMdl(RED_PAINT_MDL) : undefined;

describe(".mdl wrapper values and priority (M20)", () => {
  const wrapperUsda = (inputs = "") => mdlUsda("./materials/RedPaint.mdl", "RedPaint", inputs);

  it("an input-less shader takes its whole look from the wrapper module", () => {
    const stage = stageOf(wrapperUsda());
    const warnings: string[] = [];
    const bound = resolveBoundMaterial(stage, geomOf(stage), {
      mdl: redPaintProvider,
      onWarn: (m) => warnings.push(m),
    })!;
    expect(warnings).toHaveLength(0); // family resolves through the wrapper base
    expect(bound.color).toEqual([0.8, 0.1, 0.1]);
    expect(bound.roughness).toBe(0.3);
    expect(bound.metalness).toBe(1);
    // Texture path is module-relative; UV transform and colorspace carry over.
    expect(bound.colorTexture?.path).toBe("materials/tex/red.png");
    expect(bound.colorTexture?.sourceColorSpace).toBe("sRGB");
    expect(bound.colorTexture?.transform?.scale).toEqual([4, 4]);
  });

  it("authored USD inputs beat wrapper arguments", () => {
    const stage = stageOf(
      wrapperUsda("                float inputs:reflection_roughness_constant = 0.9"),
    );
    const bound = resolveBoundMaterial(stage, geomOf(stage), { mdl: redPaintProvider })!;
    expect(bound.roughness).toBe(0.9); // authored wins
    expect(bound.color).toEqual([0.8, 0.1, 0.1]); // wrapper still fills the rest
  });

  it("wrapper args beat declaration defaults", () => {
    const module = parseMdl(`mdl 1.6;
export material RedPaint(float reflection_roughness_constant = 0.7)
 = OmniPBR(reflection_roughness_constant: 0.3);`);
    const stage = stageOf(wrapperUsda());
    const bound = resolveBoundMaterial(stage, geomOf(stage), { mdl: () => module })!;
    expect(bound.roughness).toBe(0.3);
  });

  it("without the module the shader falls back to authored inputs only", () => {
    const stage = stageOf(wrapperUsda());
    const bound = resolveBoundMaterial(stage, geomOf(stage))!;
    expect(bound.color).toBeUndefined();
    expect(bound.colorTexture).toBeUndefined();
  });
});

describe("loader integration (M20)", () => {
  const sceneUsda = mdlUsda("./materials/RedPaint.mdl", "RedPaint");

  it("prefetches referenced .mdl modules through the asset resolver", async () => {
    const loader = new ThreeUsdRobotLoader({
      assetResolver: createMemoryResolver({ "materials/RedPaint.mdl": RED_PAINT_MDL }),
      loadTextures: false,
    });
    const robot = await loader.parse(sceneUsda, "");
    const mesh = robot.getObjectByName("geom") as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(material.color.r).toBeCloseTo(0.8, 6);
    expect(material.roughness).toBe(0.3);
    expect(material.metalness).toBe(1);
  });

  it("falls back silently when the module cannot be fetched", async () => {
    const loader = new ThreeUsdRobotLoader({
      assetResolver: createMemoryResolver({}),
      loadTextures: false,
    });
    const robot = await loader.parse(sceneUsda, "");
    const mesh = robot.getObjectByName("geom") as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(material.color.getHex()).toBe(0x9a9a9a); // default gray, no throw
  });
});

describe("crate parity (M20)", () => {
  const usdc = new Uint8Array(
    readFileSync(new URL("../test-assets/mdl_materials.usdc", import.meta.url)),
  );
  const usda = readFileSync(new URL("../test-assets/mdl_materials.usda", import.meta.url), "utf8");
  const cratePaint = parseMdl(
    readFileSync(new URL("../test-assets/materials/CratePaint.mdl", import.meta.url), "utf8"),
  );
  const provider: MdlModuleProvider = (path) =>
    path === "./materials/CratePaint.mdl" ? cratePaint : undefined;

  const stages: [string, Stage][] = [
    ["usdc", Stage.OpenFromFile(crateToUsdaFile(new CrateReader(usdc)))],
    ["usda", stageOf(usda)],
  ];

  it.each(stages)("resolves the MDL families from %s", (_label, stage) => {
    const glass = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/glass")!)!;
    expect(glass.transmission).toBe(1);
    expect(glass.ior).toBeCloseTo(1.2, 5);
    expect(glass.roughness).toBeCloseTo(0.25, 5);
    expect(glass.thickness).toBeCloseTo(0.01, 5);
    expect(glass.color?.[0]).toBeCloseTo(0.2, 5);
    expect(glass.color?.[2]).toBeCloseTo(0.9, 5);

    const coated = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/coated")!)!;
    expect(coated.clearcoat).toBe(1);
    expect(coated.clearcoatRoughness).toBeCloseTo(0.15, 5);
    expect(coated.metalness).toBeCloseTo(0.9, 5);
  });

  it.each(stages)("resolves the wrapper-only material from %s", (_label, stage) => {
    const painted = resolveBoundMaterial(stage, stage.GetPrimAtPath("/World/painted")!, {
      mdl: provider,
    })!;
    expect(painted.color).toEqual([0.8, 0.12, 0.1]);
    expect(painted.roughness).toBe(0.3);
    expect(painted.metalness).toBe(1);
    expect(painted.colorTexture?.path).toBe("materials/crate.png");
    expect(painted.colorTexture?.sourceColorSpace).toBe("sRGB");
    expect(painted.colorTexture?.transform?.scale).toEqual([2, 2]);
  });
});
