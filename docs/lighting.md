# Lighting

How `UsdLux` light prims become Three.js lights (M25), what shadows are set up
for you, and how to calibrate intensities.

## Coverage model

Lights load by default (`loadLights: false` to opt out) — even when scene
geometry is off, since they light the robot. Every bound light is attached
into the hierarchy exactly like a mesh: a light under a link prim moves with
the joint chain, scenery lights parent into the mirrored scenery groups, and
up-axis / unit normalization applies at the root. The lights land on
`robot.lights`; each carries `userData.primPath` and `userData.usdLight`
(the resolved values, including the raw authored intensity).

| UsdLux | three.js mapping |
| --- | --- |
| `DistantLight` | `DirectionalLight` (angular size ignored) |
| `SphereLight` | `PointLight`; with a ShapingAPI cone (half-angle < 90°) a `SpotLight` (`angle` / `softness` → penumbra) |
| `RectLight` | `RectAreaLight`, sized in world meters (`texture:file` ignored) |
| `DiskLight` | `RectAreaLight` of side 2r, emission × π⁄4 (area-matched approximation) |
| `CylinderLight` | `PointLight` approximation (warned once) |
| `DomeLight` / `DomeLight_1` | no Three.js light — collected on `robot.domeLights`; realized as the scene environment by `applyUsdEnvironment` (below) |
| `PortalLight`, `GeometryLight` | skipped with a warning |

Inputs read the `inputs:` namespace first and fall back to the pre-21.02
un-namespaced spelling (stock Isaac DomeLights author `texture:file` only that
way). `color`, `intensity × 2^exposure`, `enableColorTemperature` +
`colorTemperature` (blackbody tint, 6500 K = white), ShapingAPI cones and
ShadowAPI `shadow:enable` are honored; `normalize`, `diffuse` / `specular`
multipliers and IES profiles are recorded or ignored, not simulated. Lights
with `visibility = "invisible"` or a guide/proxy purpose are skipped.

Emitter sizes are converted to world meters through the full transform chain —
including the light prim's own `xformOp:scale` (stock Isaac rooms scale their
light prims) and `metersPerUnit` — because Three.js ignores ancestor scale for
`RectAreaLight` dimensions.

## Intensity calibration

The library applies the UsdLux formula verbatim: the Three.js intensity is
`inputs:intensity × 2^inputs:exposure × lightIntensityScale` (default scale
`1`). No hidden per-type constants — but the *units* differ by authoring app:

- **Omniverse / Isaac Sim** authors photometric values — a ceiling `RectLight`
  at 15 000, a `DomeLight` at 1 000. Rendered raw at exposure 1 these blow
  out; pass **`lightIntensityScale: 0.001`** (or drive
  `renderer.toneMappingExposure`) to land in a conventional Three.js range.
  Isaac's Simple Room then yields a 5 m × 0.5 m `RectAreaLight` at
  intensity 15.
- **Unitless / DCC-neutral stages** (intensities around 1) pass through
  unchanged with the default scale.
- The `DistantLight` schema fallback is 50 000 (lux-flavored daylight) when no
  intensity is authored, per the USD spec.

The authored value always remains on `userData.usdLight.intensity` for apps
doing their own photometric mapping.

## Shadows

With `shadows: true` (the default):

- Mesh gprims get `receiveShadow`, and `castShadow` unless every material slot
  is transparent or transmissive (a glass cover would otherwise cast an opaque
  black blob). Collision meshes never join shadow passes.
- Distant and spot lights cast per ShadowAPI (`shadow:enable`, default on);
  point lights only when `shadow:enable` is *explicitly* authored `true`,
  because a point shadow renders six cube faces. `RectAreaLight` cannot cast
  shadows in Three.js.
- Shadow cameras are fitted to the loaded geometry's bounding sphere (map
  sizes 2048 / 1024 / 512 for distant / spot / point) — override any of it on
  `robot.lights[i].shadow` afterwards.

None of this costs anything until you enable shadow maps on the renderer:

```ts
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
```

## DomeLight → environment (IBL)

A `DomeLight` is the scene's environment rather than a discrete light, and
`scene.environment` is scene state the loader cannot reach — so realizing it
is one explicit call, from the `three-usd-robot/rendering` entry (which,
like `/nodes`, is split off because it imports three's addons):

```ts
import { applyUsdEnvironment } from "three-usd-robot/rendering";

const robot = await new ThreeUsdRobotLoader({ lightIntensityScale: 0.001 }).loadAsync(url);
scene.add(robot);
await applyUsdEnvironment(robot, scene, { background: true });
```

- **Textures** — `.hdr` (Radiance) and `.exr` decode to float equirectangular
  data textures; other formats decode as LDR images (browser only). Fetching
  goes through the robot's captured asset context, so relative CDN paths and
  images inside a `.usdz` package both work. Three prefilters equirectangular
  environments itself — no PMREM setup. A dome with no texture (or one that
  fails to fetch/decode, with a warning) becomes a uniform environment of the
  dome's color. `texture:format` values other than `latlong` / `automatic`
  are sampled as latlong with a warning.
- **Orientation** — the dome prim's rotation, the loader's up-axis
  normalization, and the pole convention (`DomeLight_1.poleAxis`, or the
  stage up-axis for the original schema) compose into
  `scene.environmentRotation`: an Isaac Z-up stage lands with a level horizon,
  and a dome yawed about stage-up spins the sky. Needs three r162+
  (`environmentRotation`) — skipped with a warning on older peers.
- **Intensity** — `intensity × 2^exposure × scale` goes to
  `scene.environmentIntensity` (three r163+). The scale defaults to the
  `lightIntensityScale` the robot was loaded with, so the environment stays
  in balance with the bound lights; override per call with
  `intensityScale`. Isaac's Simple Room (dome intensity 1000, scale `0.001`)
  lands at exactly `1.0`.
- `background: true` mirrors the same texture, rotation and intensity onto
  `scene.background`.

## Renderer notes

- `RectAreaLight` needs its LTC lookup tables once per app under WebGL:
  `RectAreaLightUniformsLib.init()` from
  `three/addons/lights/RectAreaLightUniformsLib.js` (WebGPU does not).
- A robot-only stage usually authors no lights at all — keep your own rig as a
  fallback when `robot.lights.length === 0 && robot.domeLights.length === 0`
  (the Vite example does exactly this).

## Out of scope (for now)

`UsdGeomCamera` (M27), tone-mapping / exposure presets (M28), mesh lights
(`LightAPI` on gprims), light filters and linking, non-latlong dome texture
formats, UDIM texture sets beyond the tile-1001 fallback.
