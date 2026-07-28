/**
 * Load a stock Isaac Sim robot straight from NVIDIA's public asset CDN.
 *
 * The Franka Panda ships as Isaac Sim assets normally do — a binary crate root
 * whose geometry and physics hang off variant selections and sublayers — and
 * this package composes all of it in the browser or in Node, with no OpenUSD
 * dependency. The script loads it, reports the articulation, poses it, and
 * writes the result back out as a single self-contained USD file:
 *
 *   npx tsx scripts/demo-franka.ts
 *   npx tsx scripts/render-preview.ts out/franka.usda out/franka.png 1400 1000
 *   python scripts/pxr-validate.py out/franka.usda out/franka.usdz
 *
 * Pass any other asset path under `Isaac/` as an argument, e.g.
 *   npx tsx scripts/demo-franka.ts Isaac/Robots/Kawasaki/RS007N/rs007n_onrobot_rg2.usd
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  type AssetResolver,
  exportThreeUsdRobot,
  RAD2DEG,
  serializeUsda,
  ThreeUsdRobotLoader,
  writeUsdz,
} from "../src/index.js";

const ISAAC_ROOT =
  "https://omniverse-content-production.s3-us-west-2.amazonaws.com/Assets/Isaac/5.1";
const ASSET = process.argv[2] ?? "Isaac/Robots/FrankaRobotics/FrankaPanda/franka.usd";
const OUT_DIR = new URL("../out/", import.meta.url).pathname;
const CACHE_DIR = `${OUT_DIR}.isaac-cache/`;

/** Franka's documented ready pose (radians), plus an open gripper. */
const READY_POSE: Record<string, number> = {
  panda_joint1: 0,
  panda_joint2: -0.785,
  panda_joint3: 0,
  panda_joint4: -2.356,
  panda_joint5: 0,
  panda_joint6: 1.571,
  panda_joint7: 0.785,
  panda_finger_joint1: 0.04,
  panda_finger_joint2: 0.04,
};

// ---------------------------------------------------------------------------
// Resolver: plain fetch, with an on-disk cache so re-runs are instant
// ---------------------------------------------------------------------------

mkdirSync(CACHE_DIR, { recursive: true });
let downloaded = 0;

const resolver: Required<AssetResolver> = {
  resolve: (assetPath, baseUrl) => new URL(assetPath, baseUrl || undefined).href,
  async fetchBytes(url) {
    const file = `${CACHE_DIR}${createHash("sha1").update(url).digest("hex")}`;
    if (existsSync(file)) return new Uint8Array(readFileSync(file));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    downloaded += bytes.length;
    writeFileSync(file, bytes);
    return bytes;
  },
  async fetchText(url) {
    return new TextDecoder().decode(await this.fetchBytes(url));
  },
};

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const url = `${ISAAC_ROOT}/${ASSET}`;
console.log(`loading ${url}`);
const started = Date.now();
const warnings: string[] = [];
const robot = await new ThreeUsdRobotLoader({
  assetResolver: resolver,
  upAxisConversion: "none",
  onWarn: (m) => warnings.push(m),
}).loadAsync(url);
console.log(
  `loaded in ${Date.now() - started}ms (${(downloaded / 1024 / 1024).toFixed(2)} MB downloaded)`,
);

const desc = robot.robot;
let meshes = 0;
let triangles = 0;
robot.traverse((obj) => {
  const mesh = obj as { isMesh?: boolean; geometry?: { getIndex(): { count: number } | null } };
  if (!mesh.isMesh || !mesh.geometry) return;
  meshes++;
  triangles += (mesh.geometry.getIndex()?.count ?? 0) / 3;
});

console.log(`\n${desc.name}: ${Object.keys(desc.links).length} links, ` +
  `${robot.getJointNames().length} articulated joints, ${meshes} meshes ` +
  `(${Math.round(triangles).toLocaleString()} triangles)`);
console.log(`root link: ${robot.getKinematicTree().root}   up axis: ${desc.upAxis}   ` +
  `metersPerUnit: ${desc.metersPerUnit}`);

console.log("\njoint                       type        limits (deg)      initial");
for (const name of robot.getJointNames()) {
  const joint = desc.joints[name]!;
  const angular = joint.type !== "prismatic";
  const unit = (v: number | undefined) =>
    v === undefined ? "     —" : (angular ? v * RAD2DEG : v).toFixed(angular ? 1 : 3).padStart(6);
  console.log(
    `  ${name.padEnd(24)} ${joint.type.padEnd(11)} ${unit(joint.lower)} … ${unit(joint.upper)}   ` +
      `${unit(joint.initialValue)}`,
  );
}
if (warnings.length) console.log(`\nwarnings (${warnings.length}): ${warnings[0]}`);

// ---------------------------------------------------------------------------
// Drive it
// ---------------------------------------------------------------------------

const pose = Object.fromEntries(
  Object.entries(READY_POSE).filter(([name]) => robot.getJointNames().includes(name)),
);
if (Object.keys(pose).length > 0) {
  robot.setJointValues(pose);
  robot.updateKinematics();
  const tool = robot.getLinkNames().find((n) => /hand|tool|flange|ee/i.test(n));
  if (tool) {
    const p = robot.getLinkWorldPosition(tool);
    console.log(
      `\nready pose → ${tool} at (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)}) m`,
    );
  }
  // Bake the pose in so the exported file (and its preview) opens posed.
  for (const [name, value] of Object.entries(pose)) {
    const joint = desc.joints[name];
    if (joint) joint.initialValue = value;
  }
}

// ---------------------------------------------------------------------------
// Export: multi-file, variant-driven asset → one self-contained file
// ---------------------------------------------------------------------------

const name = ASSET.split("/").pop()?.replace(/\.usd[a-z]?$/, "") ?? "robot";
const usda = serializeUsda(exportThreeUsdRobot(robot));
writeFileSync(`${OUT_DIR}${name}.usda`, usda);
writeFileSync(`${OUT_DIR}${name}.usdz`, writeUsdz({ [`${name}.usda`]: usda }));
console.log(
  `\nre-exported to ${OUT_DIR}${name}.usda / .usdz ` +
    `(${(usda.length / 1024 / 1024).toFixed(2)} MB, single file)`,
);
console.log(`next: npx tsx scripts/render-preview.ts out/${name}.usda out/${name}.png 1400 1000`);
