# Reference comparison harness (M32)

Tools to measure how far a three-usd-robot render is from an Isaac Sim (RTX)
render of the same stage, and to calibrate light units against it instead of
guessing. Three scripts and five calibration stages:

| piece | what it does |
| --- | --- |
| `isaac_capture.py` | Renders a USD stage in Isaac Sim from a given camera to PNG (standalone `SimulationApp`; run with Isaac's `python.sh`). |
| `capture_demo.py` | Captures one deterministic frame of a demo (`vite-usd-inspector` / `vite-webgpu-viewer`) from the same camera, headless (Playwright, software GL is fine). |
| `compare.py` | SSIM, mean ΔE76 and per-region linear-luminance ratios between the two images, plus a side-by-side diff strip. |
| `examples/vite-usd-inspector/public/calibration/*.usda` | One light per stage (distant 3000, rect 15000, sphere 30000 at r 0.5 and r 0.05, dome 1000 — the Kit creation defaults) over a 50 % gray floor and ball, with a fixed `MeasureCam`. |

## Protocol

1. **Reference**: render each calibration stage in Isaac Sim.

   ```sh
   ./python.sh scripts/reference/isaac_capture.py \
     --usd $REPO/examples/vite-usd-inspector/public/calibration/rect_15000.usda \
     --out out/rect_15000_isaac.png --tonemap Aces
   ```

   The default camera is the stage's `MeasureCam` pose (eye `-2.45,-2.45,2.25`,
   target `0,0,0.25`, Z-up stage units). Use `--tonemap Linear` for
   measurement-friendly output and keep the same choice on both sides.

2. **Test**: start the inspector (`cd examples/vite-usd-inspector && npm run
   dev`) and capture the same stage from the same camera. The demo is Y-up:
   a Z-up stage point `(x, y, z)` becomes `(x, z, -y)`.

   ```sh
   python3 scripts/reference/capture_demo.py \
     "http://127.0.0.1:5173/?asset=/calibration/rect_15000.usda" out/rect_15000_three.png \
     --eye -2.45,2.25,2.45 --target 0,0.25,0 --ao 0 --exposure 1
   ```

   `--exposure 1` and `--env` pin the viewer's heuristics so the numbers
   reflect the library's calibration (`lightIntensityScale`, emitter model)
   rather than the demo's exposure guess.

3. **Compare**:

   ```sh
   python3 scripts/reference/compare.py out/rect_15000_isaac.png out/rect_15000_three.png \
     --region floor=0.1,0.7,0.3,0.2 --region ball=0.47,0.45,0.08,0.1 --out out/rect_15000_diff.png
   ```

   `exposure_factor` per region is `ref / test` in linear luminance: the
   multiplier that would bring the three render onto the Isaac level (through
   the same tone curve — exact for Linear/Clamp, approximate under ACES).
   Repeat per light type; a factor that differs between types means the
   per-emitter conversion (`lightEmitterModel`, docs/lighting.md) needs
   adjusting, a common factor means the global scale / exposure does.

## What the numbers mean

- **SSIM** compares structure, so it only says something when both renders
  share the camera — for the official Simple Room screenshot (unknown camera)
  it stays low no matter how close the look gets.
- **ΔE76** is the mean perceptual distance; under 2.3 is a just-noticeable
  difference, 5–10 is "same picture, different grade".
- **Region luminance ratios** are the actionable output. Measured on the
  official Simple Room screenshot (unknown camera, so only the large floor
  region is comparable) against the inspector from its interior camera: the
  floor reads test / ref = 1.05 at exposure 0.8 and 1.39 at exposure 1.0 with
  the demo's interior dome fraction (0.3) — which is how the demos' default
  exposure for photometric stages (`PHOTOMETRIC_EXPOSURE = 0.8`) was set.
  SSIM stayed at 0.63 and ΔE76 at 13–15 because the framing differs; a
  same-camera pair (the calibration stages) is what the harness is for.

## Limits

- `isaac_capture.py` targets Isaac Sim 4.5 / 5.x APIs and is not run in CI;
  the tone-mapping operator index table follows NVIDIA's kit sample (Isaac's
  own docs list ACES at a different index — confirm in the Render Settings
  panel once).
- The viewer's `applyUsdEnvironment` dome path (`×0.001`, `intensityScale`)
  and the demo heuristics (`PHOTOMETRIC_EXPOSURE`, `INTERIOR_DOME_FRACTION`)
  are the knobs these measurements should set; the library keeps the UsdLux
  formula itself (`intensity × 2^exposure × scale`).
