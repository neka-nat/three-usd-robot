import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ThreeUsdRobotLoader } from "../src/index.js";
import { type RenderDefaultsTarget, applyRenderDefaults } from "../src/rendering.js";

function fakeRenderer(): RenderDefaultsTarget {
  return {
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
  };
}

describe("applyRenderDefaults (M28)", () => {
  it("installs ACES and soft shadow maps by default, leaving exposure alone", () => {
    const renderer = fakeRenderer();
    renderer.toneMappingExposure = 0.7;
    applyRenderDefaults(renderer);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFSoftShadowMap);
    expect(renderer.toneMappingExposure).toBe(0.7);
  });

  it("maps the tone-mapping presets", () => {
    const renderer = fakeRenderer();
    applyRenderDefaults(renderer, { toneMapping: "AgX" });
    expect(renderer.toneMapping).toBe(THREE.AgXToneMapping);
    applyRenderDefaults(renderer, { toneMapping: "neutral" });
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    applyRenderDefaults(renderer, { toneMapping: "none" });
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping);
  });

  it("keeps shadow maps untouched with shadows: false", () => {
    const renderer = fakeRenderer();
    applyRenderDefaults(renderer, { shadows: false });
    expect(renderer.shadowMap.enabled).toBe(false);
  });

  it("takes exposure as a number or as a UsdGeomCamera description", async () => {
    const renderer = fakeRenderer();
    applyRenderDefaults(renderer, { exposure: 0.25 });
    expect(renderer.toneMappingExposure).toBeCloseTo(0.25, 9);

    const robot = await new ThreeUsdRobotLoader().parse(`#usda 1.0
(
    defaultPrim = "W"
)

def Xform "W"
{
    def Camera "cam"
    {
        float exposure = 1
        float exposure:iso = 200
        float exposure:time = 0.02
        float exposure:fStop = 2
    }
}
`);
    applyRenderDefaults(renderer, { exposure: robot.cameras[0]!.userData.usdCamera });
    // time 0.02 × iso 200/100 ÷ fStop² 4 × 2^1
    expect(renderer.toneMappingExposure).toBeCloseTo(0.02, 9);
  });
});
