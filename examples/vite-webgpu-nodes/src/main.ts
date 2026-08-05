/**
 * M22 demo: MaterialX (`ND_*`) procedural materials executed as TSL node
 * materials on WebGPURenderer. The USDA below authors three standard_surface
 * graphs — fractal-noise marble, worley cells, and noise-driven lava emission
 * — none of which a flat parameter mapping could display.
 */

import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { ThreeUsdRobotLoader } from "three-usd-robot";
import { createMaterialXNodeFactory } from "three-usd-robot/nodes";

const SCENE_USDA = `#usda 1.0
(
    upAxis = "Y"
    metersPerUnit = 1
)

def Xform "World"
{
    def Scope "Looks"
    {
        def Material "Marble"
        {
            token outputs:mtlx:surface.connect = </World/Looks/Marble/Surface.outputs:out>

            def Shader "Surface"
            {
                uniform token info:id = "ND_standard_surface_surfaceshader"
                color3f inputs:base_color.connect = </World/Looks/Marble/Mix.outputs:out>
                float inputs:specular_roughness = 0.25
                float inputs:coat = 1
                float inputs:coat_roughness = 0.1
                token outputs:out
            }
            def Shader "Mix"
            {
                uniform token info:id = "ND_mix_color3"
                color3f inputs:bg = (0.92, 0.9, 0.86)
                color3f inputs:fg = (0.18, 0.2, 0.3)
                float inputs:mix.connect = </World/Looks/Marble/Veins.outputs:out>
                color3f outputs:out
            }
            def Shader "Veins"
            {
                uniform token info:id = "ND_fractal3d_float"
                int inputs:octaves = 5
                float inputs:lacunarity = 2.4
                float inputs:amplitude = 1
                float outputs:out
            }
        }

        def Material "Cells"
        {
            token outputs:mtlx:surface.connect = </World/Looks/Cells/Surface.outputs:out>

            def Shader "Surface"
            {
                uniform token info:id = "ND_standard_surface_surfaceshader"
                color3f inputs:base_color.connect = </World/Looks/Cells/Tint.outputs:out>
                float inputs:metalness = 0.8
                float inputs:specular_roughness.connect = </World/Looks/Cells/Worley.outputs:out>
                token outputs:out
            }
            def Shader "Worley"
            {
                uniform token info:id = "ND_worleynoise2d_float"
                float inputs:jitter = 1
                float outputs:out
            }
            def Shader "Tint"
            {
                uniform token info:id = "ND_multiply_color3FA"
                color3f inputs:in1 = (0.4, 0.7, 0.9)
                float inputs:in2.connect = </World/Looks/Cells/Worley.outputs:out>
                color3f outputs:out
            }
        }

        def Material "Lava"
        {
            token outputs:mtlx:surface.connect = </World/Looks/Lava/Surface.outputs:out>

            def Shader "Surface"
            {
                uniform token info:id = "ND_standard_surface_surfaceshader"
                color3f inputs:base_color = (0.05, 0.02, 0.02)
                float inputs:specular_roughness = 0.7
                float inputs:emission = 2
                color3f inputs:emission_color.connect = </World/Looks/Lava/Glow.outputs:out>
                token outputs:out
            }
            def Shader "Glow"
            {
                uniform token info:id = "ND_multiply_color3FA"
                color3f inputs:in1 = (1, 0.25, 0.05)
                float inputs:in2.connect = </World/Looks/Lava/Noise.outputs:out>
                color3f outputs:out
            }
            def Shader "Noise"
            {
                uniform token info:id = "ND_noise3d_float"
                float inputs:amplitude = 0.5
                float inputs:pivot = 0.5
                float outputs:out
            }
        }
    }

    def Sphere "marble" (prepend apiSchemas = ["MaterialBindingAPI"])
    {
        rel material:binding = </World/Looks/Marble>
        double radius = 0.5
        double3 xformOp:translate = (-1.4, 0.5, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
    def Sphere "cells" (prepend apiSchemas = ["MaterialBindingAPI"])
    {
        rel material:binding = </World/Looks/Cells>
        double radius = 0.5
        double3 xformOp:translate = (0, 0.5, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
    def Sphere "lava" (prepend apiSchemas = ["MaterialBindingAPI"])
    {
        rel material:binding = </World/Looks/Lava>
        double radius = 0.5
        double3 xformOp:translate = (1.4, 0.5, 0)
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
}
`;

const renderer = new WebGPURenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202024);
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
camera.position.set(0, 1.6, 4.2);

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(3, 5, 2);
scene.add(sun);
scene.add(new THREE.GridHelper(6, 12, 0x555555, 0x333333));

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);

const loader = new ThreeUsdRobotLoader({
  materialFactory: createMaterialXNodeFactory({ onWarn: (m) => console.warn(m) }),
  onWarn: (m) => console.warn(m),
});
const stage = await loader.parse(SCENE_USDA, "");
scene.add(stage);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
