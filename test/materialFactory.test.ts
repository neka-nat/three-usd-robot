import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  type MaterialFactory,
  Stage,
  ThreeUsdRobotLoader,
  buildGprimObject,
  findBoundSurfaceShader,
} from "../src/index.js";

// M22: the materialFactory hook — the single core-side change that lets the
// optional ./nodes entry replace material creation without the core ever
// importing three/webgpu.

const SCENE = `#usda 1.0
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
                color3f inputs:diffuseColor = (1, 0, 0)
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
    def Points "cloud"
    {
        point3f[] points = [(0, 0, 0), (1, 1, 1)]
    }
}`;

const stageOf = (usda: string) => Stage.OpenFromString(usda);

describe("materialFactory hook (M22)", () => {
  it("replaces the mesh material and receives the gprim and stage", () => {
    const stage = stageOf(SCENE);
    const custom = new THREE.MeshBasicMaterial({ wireframe: true });
    const seen: string[] = [];
    const factory: MaterialFactory = (prim, factoryStage) => {
      seen.push(prim.GetPath());
      expect(factoryStage).toBe(stage);
      return custom;
    };
    const mesh = buildGprimObject(stage.GetPrimAtPath("/World/geom")!, stage, {
      materialFactory: factory,
    }) as THREE.Mesh;
    expect(mesh.material).toBe(custom);
    expect(seen).toEqual(["/World/geom"]);
  });

  it("falls back to the UsdShade resolution when the factory returns null", () => {
    const stage = stageOf(SCENE);
    const mesh = buildGprimObject(stage.GetPrimAtPath("/World/geom")!, stage, {
      materialFactory: () => null,
    }) as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(material.type).toBe("MeshStandardMaterial");
    expect(material.color.r).toBeCloseTo(1, 9);
  });

  it("is not consulted for Points and BasisCurves gprims", () => {
    const stage = stageOf(SCENE);
    let calls = 0;
    const object = buildGprimObject(stage.GetPrimAtPath("/World/cloud")!, stage, {
      materialFactory: () => {
        calls++;
        return new THREE.MeshBasicMaterial();
      },
    });
    expect(object).toBeInstanceOf(THREE.Points);
    expect(calls).toBe(0);
  });

  it("threads through the loader options into scene binding", async () => {
    const custom = new THREE.MeshBasicMaterial();
    const loader = new ThreeUsdRobotLoader({
      loadTextures: false,
      materialFactory: () => custom,
    });
    const robot = await loader.parse(SCENE, "");
    const mesh = robot.getObjectByName("geom") as THREE.Mesh;
    expect(mesh.material).toBe(custom);
  });
});

describe("findBoundSurfaceShader (M22)", () => {
  it("returns the shader prim behind the resolved binding", () => {
    const stage = stageOf(SCENE);
    const shader = findBoundSurfaceShader(stage, stage.GetPrimAtPath("/World/geom")!);
    expect(shader?.GetPath()).toBe("/World/Looks/Mat/Surface");
    expect(findBoundSurfaceShader(stage, stage.GetPrimAtPath("/World/cloud")!)).toBeUndefined();
  });
});
