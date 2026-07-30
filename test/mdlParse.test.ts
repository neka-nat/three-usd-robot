import { describe, expect, it } from "vitest";
import { isMdlTexture, parseMdl, parseMdlLiteral } from "../src/index.js";

// M20: the .mdl declaration parser — wrapper materials, parameter defaults,
// literal evaluation, and robustness against everything it does not support.

const RED_PAINT = `/* wrapper fixture */
mdl 1.6;

import ::OmniPBR::OmniPBR;
import ::anno::*;
import ::tex::gamma_mode;

export material RedPaint(*)
[[
    anno::display_name("Red Paint"),
    anno::version(1, 0, 0)
]]
 = OmniPBR::OmniPBR(
    diffuse_color_constant: color(0.8f, 0.1f, 0.1f),
    reflection_roughness_constant: 0.3f,
    metallic_constant: 1.0f,
    diffuse_texture: texture_2d("./tex/red.png", ::tex::gamma_srgb),
    texture_scale: float2(4.0f)
);
`;

describe("parseMdl — wrapper materials", () => {
  it("reads (*) params, the base material, and literal call arguments", () => {
    const decl = parseMdl(RED_PAINT).materials.get("RedPaint");
    expect(decl).toBeDefined();
    expect(decl?.base).toBe("OmniPBR");
    expect(decl?.defaults.size).toBe(0);
    expect(decl?.args.get("diffuse_color_constant")).toEqual([0.8, 0.1, 0.1]);
    expect(decl?.args.get("reflection_roughness_constant")).toBe(0.3);
    expect(decl?.args.get("metallic_constant")).toBe(1);
    expect(decl?.args.get("texture_scale")).toEqual([4, 4]); // float2(x) broadcasts
    const texture = decl?.args.get("diffuse_texture");
    expect(isMdlTexture(texture)).toBe(true);
    if (isMdlTexture(texture)) {
      expect(texture.assetPath).toBe("./tex/red.png");
      expect(texture.sourceColorSpace).toBe("sRGB");
    }
  });

  it("collapses qualified / global-scope base names to the last segment", () => {
    const module = parseMdl(`mdl 1.7;
export material A(*) = ::nvidia::core_definitions::flex_material(
    base_color: color(1.0, 0.0, 0.0)
);`);
    const decl = module.materials.get("A");
    expect(decl?.base).toBe("flex_material");
    expect(decl?.args.get("base_color")).toEqual([1, 0, 0]);
  });

  it("skips non-literal arguments but keeps literal siblings", () => {
    const decl = parseMdl(`mdl 1.6;
export material Mixed(*) = OmniPBR(
    diffuse_color_constant: tint_color,
    reflection_roughness_constant: 0.5 * intensity,
    metallic_constant: 1.0,
    enable_emission: true,
    mono_source: ::base::mono_average
);`).materials.get("Mixed");
    expect(decl?.base).toBe("OmniPBR");
    expect(decl?.args.get("diffuse_color_constant")).toBeUndefined();
    expect(decl?.args.get("reflection_roughness_constant")).toBeUndefined();
    expect(decl?.args.get("metallic_constant")).toBe(1);
    expect(decl?.args.get("enable_emission")).toBe(true);
    expect(decl?.args.get("mono_source")).toBeUndefined();
  });
});

describe("parseMdl — declaration defaults", () => {
  it("reads literal parameter defaults of a full material definition", () => {
    const decl = parseMdl(`mdl 1.7;
export material OmniPBRStub(
    uniform color diffuse_color_constant = color(0.2)
        [[ anno::display_name("Albedo") ]],
    float reflection_roughness_constant = 0.5f,
    uniform texture_2d diffuse_texture = texture_2d(),
    uniform ::tex::gamma_mode diffuse_gamma = ::tex::gamma_srgb,
    bool enable_emission = false,
    uniform float3 emissive_color = float3(1.0, 0.5, 0.0),
    int uv_index = 2,
    uniform texture_2d normalmap_texture = texture_2d("n.png", ::tex::gamma_linear)
) = let {
    float unused = 1.0;
} in material();
`).materials.get("OmniPBRStub");
    expect(decl?.base).toBeUndefined(); // a definition, not a wrapper
    expect(decl?.defaults.get("diffuse_color_constant")).toEqual([0.2, 0.2, 0.2]);
    expect(decl?.defaults.get("reflection_roughness_constant")).toBe(0.5);
    expect(decl?.defaults.get("diffuse_texture")).toBeUndefined(); // empty texture_2d()
    expect(decl?.defaults.get("diffuse_gamma")).toBeUndefined(); // enum reference
    expect(decl?.defaults.get("enable_emission")).toBe(false);
    expect(decl?.defaults.get("emissive_color")).toEqual([1, 0.5, 0]);
    expect(decl?.defaults.get("uv_index")).toBe(2);
    const normal = decl?.defaults.get("normalmap_texture");
    expect(isMdlTexture(normal) && normal.assetPath).toBe("n.png");
    expect(isMdlTexture(normal) && normal.sourceColorSpace).toBe("raw");
  });

  it("ignores comments / annotations and reads multiple exports", () => {
    const module = parseMdl(`mdl 1.6;
// export material NotReal(*) = OmniPBR(metallic_constant: 9.0);
/* export material AlsoFake(x = 1) */
export material First(*) [[ anno::key_words("a", "b") ]] = OmniPBR(
    metallic_constant: 0.25 // trailing comment
);
export material Second(float glass_ior = 1.4) = OmniGlass(
    glass_ior: glass_ior
);`);
    expect([...module.materials.keys()]).toEqual(["First", "Second"]);
    expect(module.materials.get("First")?.args.get("metallic_constant")).toBe(0.25);
    expect(module.materials.get("Second")?.base).toBe("OmniGlass");
    expect(module.materials.get("Second")?.defaults.get("glass_ior")).toBe(1.4);
  });

  it("survives malformed and empty input", () => {
    expect(parseMdl("").materials.size).toBe(0);
    expect(parseMdl("export material Broken(").materials.size).toBe(0);
    expect(parseMdl("mdl 1.6; export material X(*)").materials.get("X")?.base).toBeUndefined();
  });
});

describe("parseMdlLiteral", () => {
  it("evaluates the supported literal subset", () => {
    expect(parseMdlLiteral(" 0.5f ")).toBe(0.5);
    expect(parseMdlLiteral("-3")).toBe(-3);
    expect(parseMdlLiteral("1.5e-2")).toBe(0.015);
    expect(parseMdlLiteral(".25")).toBe(0.25);
    expect(parseMdlLiteral("true")).toBe(true);
    expect(parseMdlLiteral('"a \\"b\\""')).toBe('a "b"');
    expect(parseMdlLiteral("color(1.0, 0.5, 0.0)")).toEqual([1, 0.5, 0]);
    expect(parseMdlLiteral("float2(1, 2)")).toEqual([1, 2]);
    expect(parseMdlLiteral("float4(0.5)")).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it("rejects everything else", () => {
    expect(parseMdlLiteral("some_identifier")).toBeUndefined();
    expect(parseMdlLiteral("::tex::gamma_srgb")).toBeUndefined();
    expect(parseMdlLiteral("0.5 * x")).toBeUndefined();
    expect(parseMdlLiteral("color(1.0, 0.5)")).toBeUndefined(); // wrong arity
    expect(parseMdlLiteral("texture_2d()")).toBeUndefined();
    expect(parseMdlLiteral("unknown_fn(1.0)")).toBeUndefined();
  });
});
