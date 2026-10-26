# Materials

How `UsdShade` networks become Three.js materials, and how far each shading
system is covered.

## Coverage model

Materials target **UsdPreviewSurface fidelity plus Omniverse MDL and MaterialX
mappings**: constant and textured inputs, faceVarying / indexed UVs, multiple
UV sets, per-vertex display colors, physical extensions (`ior` / `clearcoat` /
specular workflow → `MeshPhysicalMaterial`), packed ORM maps,
`sourceColorSpace`, and purpose/strength-aware bindings.

## Omniverse MDL

MDL shaders are identified by `info:mdl:sourceAsset` and mapped **by family**
— no shader execution — and referenced `.mdl` modules are fetched and parsed
for their declaration values, so wrapper materials
(`export material X(*) = OmniPBR(…)`) render correctly even when the USD
shader authors no inputs at all. Value priority: authored USD inputs >
wrapper arguments > declaration defaults.

| MDL family | three.js mapping |
| --- | --- |
| `OmniPBR` (and derivatives, e.g. `OmniPBR_Opacity`) | color / metalness / roughness / emissive (`emissive_intensity`, nits), per-channel texture maps and packed `ORM_texture`, opacity, normal map, `texture_translate/rotate/scale`, plus the OmniPBR semantics below: albedo adjustments, `*_texture_influence`, declaration defaults, `specular_level`, DirectX normal maps, `ao_to_diffuse` |
| `OmniPBR_ClearCoat` | the OmniPBR mapping plus `clearcoat` / `clearcoatRoughness` / `clearcoatNormalMap` |
| `OmniGlass` | `MeshPhysicalMaterial` with `transmission` / `ior` (default 1.491) / `roughness` / `thickness`, glass color + texture |
| `OmniSurface(Lite)` | constants subset: diffuse color / metalness / roughness / IOR / coat / emission / opacity |

### OmniPBR semantics

Omniverse evaluates OmniPBR with rules a plain parameter copy gets wrong, so
the mapping applies them (M29) — measured against stock Isaac assets
(Simple Room, Franka), where every item below is authored:

- **Declaration defaults** — an input nobody authored takes the OmniPBR
  default: base color 0.2 gray, roughness 0.5, metallic 0, specular 0.5.
  UsdPreviewSurface shaders use their spec fallbacks (roughness 0.5,
  metallic 0), and so do unbound meshes.
- **Albedo adjustments** — `albedo_desaturation` (toward luminance),
  `× albedo_brightness`, `+ albedo_add`, `× diffuse_tint`. A constant albedo
  gets them folded in; a textured one keeps `brightness × tint` as the
  three `color` factor (add / desaturation would need per-texel math and are
  reported through `onWarn`).
- **Map influence** — Omniverse mixes `lerp(constant, map, influence)` for
  roughness and metallic, with `reflection_roughness_texture_influence` /
  `metallic_texture_influence` defaulting to **0**: a map authored without
  its influence does nothing there, and the mapping honors that (with a
  warning). three multiplies `factor × map`, so an influence that rounds to
  1 uses the map with factor 1 and one that rounds to 0 uses the constant;
  fractional values are approximated and reported. Packed `ORM_texture`
  channels follow the same rule.
- **`specular_level`** — F0 = 0.08 × level, so 0.5 is three's default 4 %;
  any other value promotes the material to `MeshPhysicalMaterial` with
  `specularIntensity = level / 0.5`.
- **Normal maps** — OmniPBR expects **DirectX** maps by default
  (`flip_tangent_v = true`); three expects OpenGL ones, so `normalScale`
  lands as `(bump_factor, −bump_factor)` unless the flags say otherwise
  (`flip_tangent_u` flips red). Clear-coat normal maps follow
  `clearcoat_bump_factor` / `clearcoat_flip_tangent_*`.
- **`ao_to_diffuse`** — weights the AO map on diffuse lighting; its default 0
  drops the map (Omniverse ray-traces occlusion instead — pair the viewer
  with GTAO). Otherwise it becomes `aoMapIntensity`.
- **Emission units** — `emissive_intensity` (and OmniSurface
  `emission_weight × emission_intensity`) is a radiance in nits, the same
  unit as the stage's lights, so the loader scales it with the resolved
  `lightIntensityScale` (`material.userData.emissiveIntensityScale`) and
  counts it toward the `"auto"` calibration. UsdPreviewSurface emission
  stays a unitless multiplier.

Material textures also request 16× anisotropic filtering (three clamps to
the device maximum; `textureAnisotropy` on the loader, or the
`createTextureProvider` option, changes it).

## MaterialX (parameter mapping)

MaterialX networks authored natively in UsdShade (`outputs:mtlx:surface` +
`ND_*` shaders) resolve the same way — by parameter mapping, without graph
execution. `ND_standard_surface_surfaceshader` maps `base × base_color` /
`metalness` / `specular_roughness` / `specular_IOR` / `coat(_roughness)` /
`transmission` / `emission (× emission_color)` / `opacity` / `normal` onto
the standard (or, when coat / transmission / IOR are authored, physical)
three material; the `ND_Usd*` compatibility nodes delegate to the
UsdPreviewSurface readers. Image and UV nodes are supported
(`ND_image_*` address modes, `ND_tiledimage_*` uvtiling/uvoffset,
`ND_texcoord_*` UV-channel index, `ND_geompropvalue_*` primvar name,
`ND_normalmap`), and constant-only `ND_multiply_* / ND_mix_* / ND_convert_*`
(plus `ND_constant_*` / `ND_dot_*`) fold into values. Anything that needs
real evaluation (noise, ramps, …) skips just that channel with a warning —
the rest of the material still renders — unless you opt into the TSL entry
below. External `.mtlx` file references (UsdMtlx) are not parsed; load them
with `loadMaterialXDocument` (a thin wrapper over three's official
`MaterialXLoader`) from `three-usd-robot/nodes`.

## Executing MaterialX graphs (optional, WebGPU)

The separate `three-usd-robot/nodes` entry converts `ND_*` graphs (noise,
ramps, math, images, procedural UV warps — a ~45-node practical subset) into
three.js TSL `MeshPhysicalNodeMaterial`s and plugs in through the loader's
`materialFactory` hook:

```ts
import { ThreeUsdRobotLoader } from "three-usd-robot";
import { createMaterialXNodeFactory } from "three-usd-robot/nodes";

const loader = new ThreeUsdRobotLoader({
  materialFactory: createMaterialXNodeFactory({ onWarn: console.warn }),
});
```

Requires `WebGPURenderer` (it falls back to WebGL2 internally). Graphs with
nodes outside the conversion table fall back to the parameter mapping with a
warning, and the WebGL core bundles never import `three/webgpu` / `three/tsl`
(verified at build time). See `examples/vite-webgpu-nodes` for a procedural
marble / worley / lava demo.

## Out of scope

Executing MDL remains out of scope (a language, not a graph — it would need
an MDL SDK-class compiler); unknown MDL materials fall back to the OmniPBR
mapping (and unknown `ND_*` surface shaders to the UsdPreviewSurface reads)
with a warning. Not yet supported: collection-based material bindings, and
the exotic curve schemas (`NurbsCurves`, `HermiteCurves`, `NurbsPatch`)
which load with a warning and are skipped. `<UDIM>` texture paths resolve to
their first tile (1001) with a warning; full UDIM sets are out of scope.
