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

The Three.js intensity is `inputs:intensity × 2^inputs:exposure ×
lightIntensityScale` — the UsdLux formula with one multiplier and no hidden
per-type constants. The *units* differ by authoring app, so the multiplier's
default is **`"auto"`**, decided once per stage:

- **Omniverse / Isaac Sim** authors photometric values — a ceiling `RectLight`
  at 15 000, a `DomeLight` at 1 000. When any light or dome exceeds `100`,
  `"auto"` scales the whole stage by `0.001`: Isaac's Simple Room lands as a
  5 m × 0.5 m `RectAreaLight` at intensity 15 with the dome environment at
  1.0, out of the box.
- **Unitless / DCC-neutral stages** (intensities around 1) pass through
  unchanged.
- A number opts out of the heuristic: `lightIntensityScale: 1` keeps raw
  photometric values (pair it with a real camera exposure — see
  `applyRenderDefaults`), any other value multiplies verbatim.
- The `DistantLight` schema fallback is 50 000 (lux-flavored daylight) when no
  intensity is authored, per the USD spec — note that it alone trips the
  photometric detection.

The resolved multiplier is stored on `robot.lightIntensityScale` (and
`applyUsdEnvironment` defaults to it), and the authored value always remains
on `userData.usdLight.intensity` for apps doing their own photometric
mapping. Omniverse MDL emissive materials author the same unit (nits), so
their `emissiveIntensity` follows the multiplier too and counts toward the
detection (M29, see the materials guide).

## Emitter model (sizes → intensities)

UsdLux `intensity` on an area light is a radiance: a bigger emitter puts out
more light. three's point / spot lights take candela and its rect lights
nits, so the binder converts per emitter (`lightEmitterModel`, M29):

| light | `"radiance"` (UsdLux / RTX) | with `normalize = true` |
| --- | --- | --- |
| `SphereLight` | `π r² × intensity` cd (projected disc of the sphere); `treatAsPoint` keeps `intensity` as cd | `intensity / 4` (power spread over `4 π r²`) |
| `RectLight` | `intensity` nits | `intensity / (w × h)` |
| `DiskLight` | `intensity × π/4` nits on the 2r square | `intensity / (π r²) × π/4` |
| `CylinderLight` (point approximation) | `2 r l × intensity` cd | `intensity / π` |
| `DistantLight` | `intensity` (lux-like) | unchanged |

Sizes are world meters (prim scale and `metersPerUnit` applied). `"point"`
passes `intensity` through unchanged — the pre-M29 behavior, and what
Storm-style unitless stages expect. The default `"auto"` uses `"radiance"`
exactly when the stage reads as photometric (the same test as the intensity
scale) and `"point"` otherwise; the resolved choice is on
`robot.lightEmitterModel`. Isaac's Franka `SphereLight` (30 000, r = 0.5 m)
lands at `30 000 × 0.001 × π × 0.25 ≈ 23.6` cd, a 5 cm bulb at the same
radiance a hundred times dimmer — as in RTX, where it is a hundred times
smaller.

## Shadows

With `shadows: true` (the default):

- Mesh gprims get `receiveShadow`, and `castShadow` unless every material slot
  is transparent or transmissive (a glass cover would otherwise cast an opaque
  black blob). Collision meshes never join shadow passes.
- Distant and spot lights cast per ShadowAPI (`shadow:enable`, default on);
  point lights only when `shadow:enable` is *explicitly* authored `true`,
  because a point shadow renders six cube faces.
- **Area lights** (`RectLight` / `DiskLight`) cannot cast shadows in
  Three.js, so each one gets a shadow proxy (M30, `areaLightShadows`,
  default on): a `SpotLight` child at the panel's origin, aimed along its
  −Z, that takes `share` (default 0.5) of the emission — the panel's on-axis
  luminous intensity `radiance × area` in candela — and casts a soft shadow
  map, while the `RectAreaLight` keeps the rest. The shadow's darkness is
  the share; the cone is widened to cover the scene as seen from the light.
  The proxy sits on `light.userData.shadowProxy` (not in `robot.lights`);
  `{ share, mapSize }` tunes it, `false` turns it off, and ShadowAPI
  `shadow:enable = false` skips it. Isaac's Simple Room ceiling panel thus
  finally drops a shadow under the table.
- Shadow cameras are fitted to the loaded geometry's bounding sphere (map
  sizes 2048 / 1024 / 512 for distant / spot / point) — or, with
  `shadowFocus: "robot"`, to the robot's links only (sharper on the robot
  inside a large cell; scenery outside the frustum casts nothing). Override
  any of it on `robot.lights[i].shadow` afterwards.

None of this costs anything until you enable shadow maps on the renderer —
which `applyRenderDefaults` (below) does for you, or manually:

```ts
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // r182+: soft (Vogel disk); PCFSoftShadowMap before
```

`softShadowMapType()` from the `rendering` entry picks the right constant for
the installed three — `PCFSoftShadowMap` is deprecated since r182 and gone
from `WebGPURenderer` in r186.

## DomeLight → environment (IBL)

A `DomeLight` is the scene's environment rather than a discrete light, and
`scene.environment` is scene state the loader cannot reach — so realizing it
is one explicit call, from the `three-usd-robot/rendering` entry (which,
like `/nodes`, is split off because it imports three's addons):

```ts
import { applyUsdEnvironment } from "three-usd-robot/rendering";

const robot = await new ThreeUsdRobotLoader().loadAsync(url);
scene.add(robot);
await applyUsdEnvironment(robot, scene, { background: true });
```

- **Textures** — `.hdr` (Radiance, decoded in-house — three's
  `RGBELoader` became `HDRLoader` in r180) and `.exr` (three's `EXRLoader`)
  decode to float equirectangular data textures; other formats decode as LDR
  images (browser only). Fetching
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
  (`environmentRotation`) — skipped with a warning on older peers. three
  r184 changed what the Euler means (it used to rotate the sampling vector,
  showing the inverse); the helper compensates per release
  (`environmentEulerFor`), so the sky faces the same way everywhere.
- **Intensity** — `intensity × 2^exposure × scale` goes to
  `scene.environmentIntensity` (three r163+). The scale defaults to the
  `lightIntensityScale` the robot was loaded with, so the environment stays
  in balance with the bound lights; override per call with
  `intensityScale`. Isaac's Simple Room (dome intensity 1000, scale `0.001`)
  lands at exactly `1.0`.
- `background: true` mirrors the same texture, rotation and intensity onto
  `scene.background`.
- **No dome?** Most robot-only Isaac assets author none, and without an
  environment their metals and glossy plastics reflect nothing. `fallback:
  "room"` (M30) prefilters three's `RoomEnvironment` (a neutral studio box)
  through the `renderer` you pass and installs it at `fallbackIntensity`
  (default 1); a `THREE.Texture` of your own is used as given. The result's
  `source` says which path ran (`"dome"`, `"room"`, `"texture"`), and
  `createRoomEnvironment(renderer)` builds the texture on its own for reuse.
  Backgrounds stay dome-only.

  ```ts
  const env = await applyUsdEnvironment(robot, scene, {
    background: true,
    fallback: "room",
    renderer,
  });
  ```

## Render defaults (tone mapping, shadows, exposure)

USD lights and HDRI domes are HDR values; three's default `NoToneMapping`
clips them hard. `applyRenderDefaults` from `three-usd-robot/rendering`
installs the viewer baseline in one call:

```ts
import { applyRenderDefaults } from "three-usd-robot/rendering";

applyRenderDefaults(renderer); // ACES tone mapping + soft shadow maps
applyRenderDefaults(renderer, {
  toneMapping: "AgX", // "ACES" | "AgX" | "neutral" (r162+) | "none"
  exposure: robot.cameras[0]?.userData.usdCamera, // number, or a UsdGeomCamera
});
```

An `exposure` given as a camera description applies its USD 24.11 linear
exposure scale (`computeCameraExposureScale`) — the bridge that makes a
physically authored stage (`lightIntensityScale: 1` plus real photographic
camera values) land in range. The helper only switches things on or assigns
what you pass; `shadows: false` merely skips enabling shadow maps.

Post-processing (GTAO / SSGI / SSR / TAA / bloom) deliberately stays out of
the library — compose three's own passes in your app. The Vite example ships
the recipe: `RenderPass → GTAOPass → OutputPass`, toggled from its Lighting
panel.

## Renderer notes

- `RectAreaLight` needs its LTC lookup tables once per app: under WebGL
  `RectAreaLightUniformsLib.init()` from
  `three/addons/lights/RectAreaLightUniformsLib.js`; under `WebGPURenderer`
  `RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init())` from
  `three/addons/lights/RectAreaLightTexturesLib.js` (otherwise the light's
  node fails to compile).
- A robot-only stage usually authors no lights at all — keep your own rig as a
  fallback when `robot.lights.length === 0 && robot.domeLights.length === 0`
  (the Vite example does exactly this, with a `RoomEnvironment` fallback for
  the ambient and reflections, GTAO on an MSAA composer, and a lower
  exposure for photometric stages).
- Image-based lighting is never occluded by the scene: inside a closed room
  the dome shines through the walls, whereas a ray tracer only lets it in
  through openings. The Vite example applies the dome at 0.3× when a stage
  brings fixtures (rect / disk / sphere lights) and no distant sun, with a
  slider to change it; a path tracer (see the WebGPU example) resolves it
  properly.

## Measuring against Isaac Sim

`scripts/reference/` holds the comparison harness (M32): calibration stages
with one light each under `examples/vite-usd-inspector/public/calibration/`,
`isaac_capture.py` to render them in Isaac Sim from a fixed camera,
`capture_demo.py` for the same frame out of a demo, and `compare.py` for
SSIM / ΔE / per-region luminance ratios — the exposure factor that would
match the two. See `scripts/reference/README.md` for the protocol; the
demos' exposure for photometric stages was set that way.

## Out of scope (for now)

Mesh lights (`LightAPI` on gprims), light filters and linking, non-latlong
dome texture formats, UDIM texture sets beyond the tile-1001 fallback, and
post-processing passes (app-side; see Render defaults above). `UsdGeomCamera`
support is in the [runtime guide](./runtime.md#cameras-usdgeomcamera).
