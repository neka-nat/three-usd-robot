/**
 * Headless preview renderer for exported USD scenes → PNG (no GPU, no WebGL).
 *
 * Loads the asset with `ThreeUsdRobotLoader` (articulated machines, posed by
 * their authored initial joint values) plus any scenery meshes the robot IR
 * doesn't own, then software-rasterizes it: isometric orthographic camera,
 * directional key light with a PCF shadow map, hemisphere ambient, a fill
 * light, Blinn-Phong speculars driven by the USD `metallic` / `roughness`
 * inputs, ACES-ish tone mapping, sRGB encode and 2× supersampling.
 *
 *   npx tsx scripts/render-preview.ts out/factory.usda out/factory-preview.png [1600] [1000]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import * as THREE from "three";
import { ThreeUsdRobotLoader } from "../src/index.js";

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const numbers = (value: string | undefined): number[] | undefined =>
  value?.split(",").map(Number);

const [input = "out/factory.usda", output = "out/factory-preview.png"] = positional;
const WIDTH = Number(positional[2] ?? 1600);
const HEIGHT = Number(positional[3] ?? 1000);
/** `--target=x,y,z --radius=r` frames a sphere instead of the whole scene. */
const focusTarget = numbers(flag("target"));
const focusRadius = Number(flag("radius") ?? 0);
/** `--dir=x,y,z` overrides the camera direction (world offset from the target). */
const cameraDir = numbers(flag("dir")) ?? [-1.05, -1.5, 0.92];
/** `--clip=m` hides geometry more than `m` metres in front of the target. */
const clipDistance = Number(flag("clip") ?? 0);
/** `--ground` adds a shadow-catching floor under a scene that has none. */
const wantGround = argv.includes("--ground");
const SS = 2; // supersampling factor
const SW = WIDTH * SS;
const SH = HEIGHT * SS;
const SHADOW_SIZE = 2048;

// ---------------------------------------------------------------------------
// Scene collection
// ---------------------------------------------------------------------------

type Surface = {
  albedo: [number, number, number];
  metalness: number;
  roughness: number;
  emissive: [number, number, number];
};

type Tri = {
  /** World-space vertex positions and normals, flattened per corner. */
  p: Float64Array; // 9
  n: Float64Array; // 9
  surface: Surface;
};

const tris: Tri[] = [];
const bbox = new THREE.Box3();
const scratchNormal = new THREE.Matrix3();

function addGeometry(
  geometry: THREE.BufferGeometry,
  matrixWorld: THREE.Matrix4,
  surface: Surface,
): void {
  const position = geometry.getAttribute("position");
  if (!position) return;
  const normalAttr = geometry.getAttribute("normal");
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const normalMatrix = scratchNormal.getNormalMatrix(matrixWorld);

  const pos = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  for (let i = 0; i + 2 < count; i += 3) {
    const p = new Float64Array(9);
    const n = new Float64Array(9);
    let degenerate = false;
    for (let k = 0; k < 3; k++) {
      const vi = index ? index.getX(i + k) : i + k;
      pos.set(position.getX(vi), position.getY(vi), position.getZ(vi)).applyMatrix4(matrixWorld);
      p[k * 3] = pos.x;
      p[k * 3 + 1] = pos.y;
      p[k * 3 + 2] = pos.z;
      bbox.expandByPoint(pos);
      if (normalAttr) {
        nrm
          .set(normalAttr.getX(vi), normalAttr.getY(vi), normalAttr.getZ(vi))
          .applyMatrix3(normalMatrix)
          .normalize();
        n[k * 3] = nrm.x;
        n[k * 3 + 1] = nrm.y;
        n[k * 3 + 2] = nrm.z;
      }
    }
    if (!normalAttr) {
      // Flat normal from the winding.
      const ux = p[3]! - p[0]!, uy = p[4]! - p[1]!, uz = p[5]! - p[2]!;
      const vx = p[6]! - p[0]!, vy = p[7]! - p[1]!, vz = p[8]! - p[2]!;
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const len = Math.hypot(cx, cy, cz);
      if (len === 0) degenerate = true;
      else for (let k = 0; k < 3; k++) {
        n[k * 3] = cx / len;
        n[k * 3 + 1] = cy / len;
        n[k * 3 + 2] = cz / len;
      }
    }
    if (!degenerate) tris.push({ p, n, surface });
  }
}

const DEFAULT_SURFACE: Surface = {
  albedo: [0.7, 0.7, 0.7],
  metalness: 0,
  roughness: 0.6,
  emissive: [0, 0, 0],
};

const text = readFileSync(input, "utf8");
// `loadSceneGeometry` brings in the static cell (floor, guarding, racking, …)
// alongside the articulated machines, each posed by its authored initial pose.
const robot = await new ThreeUsdRobotLoader({
  upAxisConversion: "none",
  loadSceneGeometry: true,
}).parse(text);
robot.updateMatrixWorld(true);
robot.traverse((obj) => {
  const mesh = obj as THREE.Mesh;
  if (!mesh.isMesh || !mesh.visible || mesh.userData.kind === "collision") return;
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    | THREE.MeshStandardMaterial
    | undefined;
  addGeometry(
    mesh.geometry,
    mesh.matrixWorld,
    material
      ? {
          albedo: [material.color.r, material.color.g, material.color.b],
          metalness: material.metalness,
          roughness: material.roughness,
          emissive: [material.emissive.r, material.emissive.g, material.emissive.b],
        }
      : DEFAULT_SURFACE,
  );
});

if (tris.length === 0) throw new Error("no visible triangles found");

// Optional floor: a bare robot reads much better standing on something that
// catches its shadow. Sized to the model and placed at its lowest point.
if (wantGround) {
  const framing = bbox.clone(); // the floor must not drive the framing
  const size = bbox.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y) * 0.85;
  const center = bbox.getCenter(new THREE.Vector3());
  const z = bbox.min.z;
  const corner = (sx: number, sy: number) =>
    new THREE.Vector3(center.x + sx * span, center.y + sy * span, z);
  const plane = new THREE.BufferGeometry().setFromPoints([
    corner(-1, -1), corner(1, -1), corner(1, 1),
    corner(-1, -1), corner(1, 1), corner(-1, 1),
  ]);
  plane.computeVertexNormals();
  addGeometry(plane, new THREE.Matrix4(), {
    albedo: [0.17, 0.18, 0.2],
    metalness: 0,
    roughness: 0.95,
    emissive: [0, 0, 0],
  });
  bbox.copy(framing);
}

// ---------------------------------------------------------------------------
// Cameras (main isometric view + directional light)
// ---------------------------------------------------------------------------

const sceneCenter = bbox.getCenter(new THREE.Vector3());
const extent = bbox.getSize(new THREE.Vector3()).length();

// Framing volume: the whole scene, or the requested focus sphere.
const focusBox = bbox.clone();
const center = sceneCenter.clone();
if (focusTarget?.length === 3 && focusRadius > 0) {
  center.set(focusTarget[0]!, focusTarget[1]!, focusTarget[2]!);
  focusBox.setFromCenterAndSize(
    center,
    new THREE.Vector3(focusRadius * 2, focusRadius * 2, focusRadius * 2),
  );
}

/** Fit an orthographic camera to the framing bounds along its own view axis. */
function fitOrtho(
  camera: THREE.OrthographicCamera,
  aspect: number,
  margin: number,
  bounds: THREE.Box3 = focusBox,
): void {
  camera.updateMatrixWorld(true);
  const view = camera.matrixWorldInverse;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const corner = new THREE.Vector3();
  for (const dx of [bounds.min.x, bounds.max.x])
    for (const dy of [bounds.min.y, bounds.max.y])
      for (const dz of [bounds.min.z, bounds.max.z]) {
        corner.set(dx, dy, dz).applyMatrix4(view);
        minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
        minZ = Math.min(minZ, corner.z); maxZ = Math.max(maxZ, corner.z);
      }
  const spanX = ((maxX - minX) / 2) * margin;
  const spanY = ((maxY - minY) / 2) * margin;
  const [halfW, halfH] = spanX / spanY > aspect ? [spanX, spanX / aspect] : [spanY * aspect, spanY];
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  camera.left = cx - halfW;
  camera.right = cx + halfW;
  camera.bottom = cy - halfH;
  camera.top = cy + halfH;
  camera.near = -maxZ - extent * 0.1;
  camera.far = -minZ + extent * 0.1;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

// Look in from the open (south-west) corner so the two walls sit behind.
const camera = new THREE.OrthographicCamera();
camera.up.set(0, 0, 1);
camera.position
  .copy(center)
  .add(
    new THREE.Vector3(cameraDir[0]!, cameraDir[1]!, cameraDir[2]!).normalize().multiplyScalar(extent),
  );
camera.lookAt(center);
fitOrtho(camera, SW / SH, 1.04);

/** Direction the key light travels (from ~48° above the south-west). */
const lightTravel = new THREE.Vector3(0.5, 0.7, -1.05).normalize();
const lightCam = new THREE.OrthographicCamera();
lightCam.up.set(0, 0, 1);
lightCam.position.copy(sceneCenter).sub(lightTravel.clone().multiplyScalar(extent));
lightCam.lookAt(sceneCenter);
// Shadow casters come from the whole scene even when the view is focused.
fitOrtho(lightCam, 1, 1.02, bbox);

const viewProj = (cam: THREE.OrthographicCamera) =>
  new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
const mainVP = viewProj(camera);
const lightVP = viewProj(lightCam);

/** Project a world point with a flattened view-projection matrix (ortho ⇒ w = 1). */
function project(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

// ---------------------------------------------------------------------------
// Shadow map
// ---------------------------------------------------------------------------

const shadow = new Float32Array(SHADOW_SIZE * SHADOW_SIZE).fill(Infinity);
{
  const sx = new Float64Array(3);
  const sy = new Float64Array(3);
  const sz = new Float64Array(3);
  for (const tri of tris) {
    for (let k = 0; k < 3; k++) {
      const [px, py, pz] = project(lightVP, tri.p[k * 3]!, tri.p[k * 3 + 1]!, tri.p[k * 3 + 2]!);
      sx[k] = (px + 1) * 0.5 * SHADOW_SIZE;
      sy[k] = (1 - py) * 0.5 * SHADOW_SIZE;
      sz[k] = pz;
    }
    const area = (sx[1]! - sx[0]!) * (sy[2]! - sy[0]!) - (sx[2]! - sx[0]!) * (sy[1]! - sy[0]!);
    if (area === 0) continue;
    const x0 = Math.max(0, Math.floor(Math.min(sx[0]!, sx[1]!, sx[2]!)));
    const x1 = Math.min(SHADOW_SIZE - 1, Math.ceil(Math.max(sx[0]!, sx[1]!, sx[2]!)));
    const y0 = Math.max(0, Math.floor(Math.min(sy[0]!, sy[1]!, sy[2]!)));
    const y1 = Math.min(SHADOW_SIZE - 1, Math.ceil(Math.max(sy[0]!, sy[1]!, sy[2]!)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((sx[1]! - px) * (sy[2]! - py) - (sx[2]! - px) * (sy[1]! - py)) / area;
        const w1 = ((sx[2]! - px) * (sy[0]! - py) - (sx[0]! - px) * (sy[2]! - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * sz[0]! + w1 * sz[1]! + w2 * sz[2]!;
        const idx = y * SHADOW_SIZE + x;
        if (z < shadow[idx]!) shadow[idx] = z;
      }
    }
  }
}

/** 3×3 PCF lookup: fraction of the kernel that is lit. */
function shadowFactor(x: number, y: number, z: number, ndotl: number): number {
  const [lx, ly, lz] = project(lightVP, x, y, z);
  const sx = (lx + 1) * 0.5 * SHADOW_SIZE;
  const sy = (1 - ly) * 0.5 * SHADOW_SIZE;
  const bias = 0.0012 + 0.004 * (1 - ndotl);
  let lit = 0;
  let taken = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const px = Math.floor(sx + dx);
      const py = Math.floor(sy + dy);
      if (px < 0 || py < 0 || px >= SHADOW_SIZE || py >= SHADOW_SIZE) continue;
      taken++;
      if (lz - bias <= shadow[py * SHADOW_SIZE + px]!) lit++;
    }
  }
  return taken === 0 ? 1 : lit / taken;
}

// ---------------------------------------------------------------------------
// Main pass
// ---------------------------------------------------------------------------

const color = new Float32Array(SW * SH * 3);
const depth = new Float32Array(SW * SH).fill(Infinity);

// Studio background gradient (linear space).
for (let y = 0; y < SH; y++) {
  const t = y / (SH - 1);
  const r = 0.3 - 0.17 * t;
  const g = 0.33 - 0.19 * t;
  const b = 0.38 - 0.22 * t;
  for (let x = 0; x < SW; x++) {
    const i = (y * SW + x) * 3;
    color[i] = r;
    color[i + 1] = g;
    color[i + 2] = b;
  }
}

const KEY = { dir: lightTravel.clone().negate(), color: [1.0, 0.95, 0.87], intensity: 2.5 };
const FILL = {
  dir: new THREE.Vector3(-0.6, -0.45, 0.35).normalize(),
  color: [0.6, 0.69, 0.84],
  intensity: 0.5,
};
const SKY: [number, number, number] = [0.26, 0.31, 0.4];
const GROUND: [number, number, number] = [0.11, 0.105, 0.1];
const viewDir = new THREE.Vector3().subVectors(camera.position, center).normalize();

const sxA = new Float64Array(3);
const syA = new Float64Array(3);
const szA = new Float64Array(3);

// Near-clip for focused shots: drop anything wholly in front of the subject
// (guarding, foreground props) while it still casts shadows into the scene.
const clipNdc =
  clipDistance > 0
    ? project(mainVP, center.x, center.y, center.z)[2] -
      (2 * clipDistance) / (camera.far - camera.near)
    : Number.NEGATIVE_INFINITY;

for (const tri of tris) {
  for (let k = 0; k < 3; k++) {
    const [px, py, pz] = project(mainVP, tri.p[k * 3]!, tri.p[k * 3 + 1]!, tri.p[k * 3 + 2]!);
    sxA[k] = (px + 1) * 0.5 * SW;
    syA[k] = (1 - py) * 0.5 * SH;
    szA[k] = pz;
  }
  if (szA[0]! < clipNdc && szA[1]! < clipNdc && szA[2]! < clipNdc) continue;
  const area = (sxA[1]! - sxA[0]!) * (syA[2]! - syA[0]!) - (sxA[2]! - sxA[0]!) * (syA[1]! - syA[0]!);
  if (area === 0) continue;

  const x0 = Math.max(0, Math.floor(Math.min(sxA[0]!, sxA[1]!, sxA[2]!)));
  const x1 = Math.min(SW - 1, Math.ceil(Math.max(sxA[0]!, sxA[1]!, sxA[2]!)));
  const y0 = Math.max(0, Math.floor(Math.min(syA[0]!, syA[1]!, syA[2]!)));
  const y1 = Math.min(SH - 1, Math.ceil(Math.max(syA[0]!, syA[1]!, syA[2]!)));

  const { albedo, metalness, roughness, emissive } = tri.surface;
  const alpha = Math.max(0.02, roughness * roughness);
  const shininess = Math.min(2048, Math.max(2, 2 / (alpha * alpha) - 2));
  // Metals reflect their albedo; dielectrics use a fixed 4% specular.
  const f0: [number, number, number] = [
    0.04 + (albedo[0] - 0.04) * metalness,
    0.04 + (albedo[1] - 0.04) * metalness,
    0.04 + (albedo[2] - 0.04) * metalness,
  ];
  const diffuse: [number, number, number] = [
    albedo[0] * (1 - metalness),
    albedo[1] * (1 - metalness),
    albedo[2] * (1 - metalness),
  ];

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((sxA[1]! - px) * (syA[2]! - py) - (sxA[2]! - px) * (syA[1]! - py)) / area;
      const w1 = ((sxA[2]! - px) * (syA[0]! - py) - (sxA[0]! - px) * (syA[2]! - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * szA[0]! + w1 * szA[1]! + w2 * szA[2]!;
      const idx = y * SW + x;
      if (z >= depth[idx]!) continue;
      depth[idx] = z;

      const wx = w0 * tri.p[0]! + w1 * tri.p[3]! + w2 * tri.p[6]!;
      const wy = w0 * tri.p[1]! + w1 * tri.p[4]! + w2 * tri.p[7]!;
      const wz = w0 * tri.p[2]! + w1 * tri.p[5]! + w2 * tri.p[8]!;
      let nx = w0 * tri.n[0]! + w1 * tri.n[3]! + w2 * tri.n[6]!;
      let ny = w0 * tri.n[1]! + w1 * tri.n[4]! + w2 * tri.n[7]!;
      let nz = w0 * tri.n[2]! + w1 * tri.n[5]! + w2 * tri.n[8]!;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      nx /= nlen; ny /= nlen; nz /= nlen;
      // Two-sided shading: face the camera.
      if (nx * viewDir.x + ny * viewDir.y + nz * viewDir.z < 0) {
        nx = -nx; ny = -ny; nz = -nz;
      }

      // Hemisphere ambient (diffuse).
      const hemi = 0.5 + 0.5 * nz;
      let r = diffuse[0] * (GROUND[0] + (SKY[0] - GROUND[0]) * hemi);
      let g = diffuse[1] * (GROUND[1] + (SKY[1] - GROUND[1]) * hemi);
      let b = diffuse[2] * (GROUND[2] + (SKY[2] - GROUND[2]) * hemi);

      // Ambient specular — stands in for an environment map. Without it metals
      // (which have no diffuse lobe) render black wherever the key light's
      // highlight misses them.
      const ndotv = nx * viewDir.x + ny * viewDir.y + nz * viewDir.z;
      const rz = 2 * ndotv * nz - viewDir.z;
      const hemiR = Math.min(1, Math.max(0, 0.5 + 0.5 * rz));
      const envGain = (1 - roughness * 0.55) * 1.15;
      r += f0[0] * (GROUND[0] + (SKY[0] - GROUND[0]) * hemiR) * envGain;
      g += f0[1] * (GROUND[1] + (SKY[1] - GROUND[1]) * hemiR) * envGain;
      b += f0[2] * (GROUND[2] + (SKY[2] - GROUND[2]) * hemiR) * envGain;

      for (const [light, shadowed] of [
        [KEY, true],
        [FILL, false],
      ] as const) {
        const ndotl = nx * light.dir.x + ny * light.dir.y + nz * light.dir.z;
        if (ndotl <= 0) continue;
        const visibility = shadowed ? shadowFactor(wx, wy, wz, ndotl) : 1;
        if (visibility === 0) continue;
        const k = ndotl * light.intensity * visibility;
        r += diffuse[0] * light.color[0] * k;
        g += diffuse[1] * light.color[1] * k;
        b += diffuse[2] * light.color[2] * k;

        // Blinn-Phong specular with the half vector.
        let hx = light.dir.x + viewDir.x;
        let hy = light.dir.y + viewDir.y;
        let hz = light.dir.z + viewDir.z;
        const hlen = Math.hypot(hx, hy, hz) || 1;
        hx /= hlen; hy /= hlen; hz /= hlen;
        const ndoth = Math.max(0, nx * hx + ny * hy + nz * hz);
        const spec = ndotl * light.intensity * visibility * (shininess + 8) / 25 * ndoth ** shininess;
        r += f0[0] * light.color[0] * spec;
        g += f0[1] * light.color[1] * spec;
        b += f0[2] * light.color[2] * spec;
      }

      const i = idx * 3;
      color[i] = r + emissive[0] * 1.5;
      color[i + 1] = g + emissive[1] * 1.5;
      color[i + 2] = b + emissive[2] * 1.5;
    }
  }
}

// ---------------------------------------------------------------------------
// Screen-space ambient occlusion
// ---------------------------------------------------------------------------

/**
 * Depth-difference AO: a pixel that sits *behind* the average of its
 * neighbourhood is in a crevice, so darken it. Two radii give both tight
 * contact shadows and broader corner darkening — cheap, and it is what keeps
 * flat-shaded geometry from reading as floating cut-outs.
 */
{
  const worldPerNdc = (camera.far - camera.near) / 2;
  const blurred = new Float32Array(SW * SH);
  const tmp = new Float32Array(SW * SH);
  const occlusion = new Float32Array(SW * SH);

  const blurDepth = (radius: number) => {
    // Separable box blur that ignores background pixels.
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        let sum = 0;
        let n = 0;
        for (let dx = -radius; dx <= radius; dx += 2) {
          const sx = x + dx;
          if (sx < 0 || sx >= SW) continue;
          const d = depth[y * SW + sx]!;
          if (d === Infinity) continue;
          sum += d;
          n++;
        }
        tmp[y * SW + x] = n > 0 ? sum / n : Infinity;
      }
    }
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        let sum = 0;
        let n = 0;
        for (let dy = -radius; dy <= radius; dy += 2) {
          const sy = y + dy;
          if (sy < 0 || sy >= SH) continue;
          const d = tmp[sy * SW + x]!;
          if (d === Infinity) continue;
          sum += d;
          n++;
        }
        blurred[y * SW + x] = n > 0 ? sum / n : Infinity;
      }
    }
  };

  for (const [radius, threshold, weight] of [
    [Math.round(SS * 5), 0.07, 0.55],
    [Math.round(SS * 16), 0.55, 0.3],
  ] as const) {
    blurDepth(radius);
    for (let i = 0; i < SW * SH; i++) {
      const d = depth[i]!;
      const b = blurred[i]!;
      if (d === Infinity || b === Infinity) continue;
      const behind = (d - b) * worldPerNdc; // metres this pixel sits behind its neighbourhood
      if (behind <= 0) continue;
      occlusion[i] = Math.min(1, occlusion[i]! + weight * Math.min(1, behind / threshold));
    }
  }

  for (let i = 0; i < SW * SH; i++) {
    const ao = 1 - 0.55 * Math.min(1, occlusion[i]!);
    if (ao === 1) continue;
    color[i * 3] *= ao;
    color[i * 3 + 1] *= ao;
    color[i * 3 + 2] *= ao;
  }
}

// ---------------------------------------------------------------------------
// Tone map, sRGB encode, downsample
// ---------------------------------------------------------------------------

const EXPOSURE = 0.72;

/** ACES filmic approximation (Krzysztof Narkowicz). */
function tonemap(x: number): number {
  const v = Math.max(0, x * EXPOSURE);
  return Math.min(1, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14));
}

function encodeSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * SW + (x * SS + sx)) * 3;
        r += encodeSrgb(tonemap(color[i]!));
        g += encodeSrgb(tonemap(color[i + 1]!));
        b += encodeSrgb(tonemap(color[i + 2]!));
      }
    }
    const n = SS * SS;
    const o = (y * WIDTH + x) * 4;
    rgba[o] = (r / n) * 255;
    rgba[o + 1] = (g / n) * 255;
    rgba[o + 2] = (b / n) * 255;
    rgba[o + 3] = 255;
  }
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (8-bit RGBA, filter 0)
// ---------------------------------------------------------------------------

function crc32(buf: Uint8Array): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const ihdr = new Uint8Array(13);
new DataView(ihdr.buffer).setUint32(0, WIDTH);
new DataView(ihdr.buffer).setUint32(4, HEIGHT);
ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA

const raw = new Uint8Array(HEIGHT * (1 + WIDTH * 4));
for (let y = 0; y < HEIGHT; y++) {
  raw[y * (1 + WIDTH * 4)] = 0; // filter: none
  raw.set(rgba.subarray(y * WIDTH * 4, (y + 1) * WIDTH * 4), y * (1 + WIDTH * 4) + 1);
}

writeFileSync(
  output,
  new Uint8Array([
    ...[137, 80, 78, 71, 13, 10, 26, 10],
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", new Uint8Array(deflateSync(raw))),
    ...chunk("IEND", new Uint8Array(0)),
  ]),
);
console.log(`rendered ${tris.length} triangles → ${output} (${WIDTH}×${HEIGHT}, ${SS}× SSAA)`);
