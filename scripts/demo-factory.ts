/**
 * Factory-cell export demo (Isaac Sim verification sample).
 *
 * Authors a detailed robot cell with this package's Three.js authoring API and
 * exports it as a single simulation-ready USD stage:
 *
 *   - **FactoryArm** — 7-DOF industrial arm (yaw + 3 pitch + roll wrist and a
 *     2-finger parallel gripper) with joint housings, drives and mass properties
 *   - **Conveyor** — roller bed with a prismatic belt, drive motor and guards
 *   - **Turntable** — continuous positioner with fixture pins
 *   - **Environment** — floor with painted markings, walls, safety fencing with
 *     a gate, control cabinet, pallet racking, workbench, stack light, overhead
 *     lighting, pallets and free crates, plus a `PhysicsScene`
 *
 *   npx tsx scripts/demo-factory.ts
 *   npx tsx scripts/render-preview.ts out/factory.usda out/factory-preview.png
 *   python scripts/pxr-validate.py out/factory.usda out/factory.usdz
 *
 * Open `out/factory.usda` in Isaac Sim (File → Open), or view it in the web
 * example: `examples/vite-basic-viewer` with `?asset=/factory.usda`.
 *
 * Machines go through `RobotBuilder` → `exportRobotUsda` (rigid bodies driven
 * by joints); scenery is emitted as plain `UsdGeom.Mesh` prims with static
 * colliders — the two halves share one `UsdPreviewSurface` material library.
 */

import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import * as THREE from "three";
import {
  type AttributeSpec,
  type ExportMesh,
  exportRobotUsda,
  extractRobotDescription,
  geometryToExportMesh,
  type PrimSpec,
  type PropertySpec,
  Quat,
  type RelationshipSpec,
  RobotBuilder,
  serializeUsda,
  Stage,
  toUsdMatrix,
  type UsdaFile,
  type UsdValue,
  validateRobotDescription,
  type Vec3,
  writeUsdz,
} from "../src/index.js";

const OUT_DIR = new URL("../out/", import.meta.url).pathname;
/** Both example viewers offer the cell as a preset, so ship it to each. */
const EXAMPLE_PUBLIC_DIRS = [
  new URL("../examples/vite-basic-viewer/public/", import.meta.url).pathname,
  new URL("../examples/vite-joint-slider/public/", import.meta.url).pathname,
];

// ---------------------------------------------------------------------------
// Material library — one UsdPreviewSurface per entry, shared by every prim
// ---------------------------------------------------------------------------

type MatDef = { color: number; metallic?: number; roughness?: number; emissive?: number };

const MATERIALS: Record<string, MatDef> = {
  concrete: { color: 0x8d8d88, roughness: 0.96 },
  concreteDark: { color: 0x6f6f6b, roughness: 0.96 },
  hazardPaint: { color: 0xd8a521, roughness: 0.72 },
  walkway: { color: 0x3e5f86, roughness: 0.8 },
  wall: { color: 0xd2d5d6, roughness: 0.92 },
  wallTrim: { color: 0x9aa1a5, roughness: 0.8 },
  steel: { color: 0x9ba1a7, metallic: 0.9, roughness: 0.28 },
  darkSteel: { color: 0x33383d, metallic: 0.8, roughness: 0.38 },
  fenceYellow: { color: 0xd7a41d, metallic: 0.25, roughness: 0.5 },
  fenceMesh: { color: 0x3a4045, metallic: 0.6, roughness: 0.45 },
  robotOrange: { color: 0xe2661b, metallic: 0.15, roughness: 0.34 },
  robotGray: { color: 0x2f343a, metallic: 0.7, roughness: 0.34 },
  conveyorGreen: { color: 0x1f6d3c, metallic: 0.4, roughness: 0.44 },
  belt: { color: 0x191b1d, roughness: 0.88 },
  cardboard: { color: 0xba8b55, roughness: 0.95 },
  cardboardAlt: { color: 0xa87a49, roughness: 0.95 },
  wood: { color: 0x8d6c41, roughness: 0.9 },
  cabinet: { color: 0xacb3b8, metallic: 0.55, roughness: 0.36 },
  blueMachine: { color: 0x2f6fb5, metallic: 0.4, roughness: 0.4 },
  lampBody: { color: 0x7f868b, metallic: 0.6, roughness: 0.4 },
  lampLit: { color: 0xf6f3e8, emissive: 0xfff0cc, roughness: 0.35 },
  signalRed: { color: 0x7d1b16, emissive: 0xd6392a, roughness: 0.5 },
  signalAmber: { color: 0x7d5510, emissive: 0xe09a1c, roughness: 0.5 },
  signalGreen: { color: 0x14562a, emissive: 0x35bd52, roughness: 0.5 },
  screen: { color: 0x11202b, emissive: 0x1d5e6e, roughness: 0.25 },
  rubber: { color: 0x1d1f21, roughness: 0.9 },
};

/** Physics materials (friction / restitution), bound to collision meshes. */
const PHYS_STEEL = { name: "steel_phys", staticFriction: 0.6, dynamicFriction: 0.5, restitution: 0.05 };
const PHYS_RUBBER = { name: "rubber_phys", staticFriction: 0.95, dynamicFriction: 0.85, restitution: 0.15 };

const LOOKS_PATH = "/Environment/Looks";

const threeMaterials = new Map<string, THREE.MeshStandardMaterial>();

/** Shared Three.js material for a library entry (name drives USD dedup). */
function mat(name: keyof typeof MATERIALS): THREE.MeshStandardMaterial {
  let material = threeMaterials.get(name);
  if (!material) {
    const def = MATERIALS[name]!;
    material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(def.color),
      metalness: def.metallic ?? 0,
      roughness: def.roughness ?? 0.5,
      ...(def.emissive !== undefined ? { emissive: new THREE.Color(def.emissive) } : {}),
    });
    material.name = name;
    threeMaterials.set(name, material);
  }
  return material;
}

// ---------------------------------------------------------------------------
// Geometry helpers — geometry is pre-rotated so meshes carry pure translations
// ---------------------------------------------------------------------------

type MatName = keyof typeof MATERIALS;

function box(name: string, [sx, sy, sz]: Vec3, [x, y, z]: Vec3, material: MatName): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat(material));
  mesh.name = name;
  mesh.position.set(x, y, z);
  return mesh;
}

/** Box rotated about Z (for diagonal braces and angled panels). */
function boxYaw(
  name: string,
  size: Vec3,
  position: Vec3,
  material: MatName,
  yaw: number,
): THREE.Mesh {
  const mesh = box(name, size, position, material);
  mesh.rotation.z = yaw;
  return mesh;
}

/** Cylinder aligned to a world axis (Three.js builds them along +Y). */
function cyl(
  name: string,
  radius: number,
  height: number,
  [x, y, z]: Vec3,
  material: MatName,
  axis: "X" | "Y" | "Z" = "Z",
  segments = 20,
  radiusTop = radius,
): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(radiusTop, radius, height, segments);
  if (axis === "Z") geometry.rotateX(Math.PI / 2);
  else if (axis === "X") geometry.rotateZ(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, mat(material));
  mesh.name = name;
  mesh.position.set(x, y, z);
  return mesh;
}

/** Solid-box principal inertia diagonal (kg·m²). */
function boxInertia(mass: number, sx: number, sy: number, sz: number): Vec3 {
  const k = mass / 12;
  return [k * (sy * sy + sz * sz), k * (sx * sx + sz * sz), k * (sx * sx + sy * sy)];
}

/** Solid-cylinder (axis Z) principal inertia diagonal. */
function cylinderInertia(mass: number, r: number, h: number): Vec3 {
  const lateral = (mass * (3 * r * r + h * h)) / 12;
  return [lateral, lateral, (mass * r * r) / 2];
}

const translation = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

// ---------------------------------------------------------------------------
// Machine 1 — 7-DOF arm on the pedestal at (0, 0)
// ---------------------------------------------------------------------------

function buildArm(): RobotBuilder {
  const b = new RobotBuilder({ name: "FactoryArm", onWarn: (m) => console.warn("  [arm]", m) });
  const drive = (target: number, stiffness = 900) => ({
    targetPosition: target,
    stiffness,
    damping: stiffness / 10,
    maxForce: 400,
  });

  // base — turret casting bolted to the pedestal
  b.addLink({
    name: "base",
    frame: translation(0, 0, 0.35),
    visuals: [
      cyl("base_housing", 0.185, 0.15, [0, 0, 0.425], "robotGray"),
      cyl("base_collar", 0.155, 0.07, [0, 0, 0.53], "robotOrange"),
      box("base_connector", [0.13, 0.22, 0.1], [-0.16, 0, 0.44], "robotGray"),
    ],
    collisions: [box("base_col", [0.38, 0.38, 0.22], [0, 0, 0.46], "robotGray")],
    inertial: { mass: 14, centerOfMass: [0, 0, 0.11], diagonalInertia: boxInertia(14, 0.38, 0.38, 0.22) },
    collisionApproximation: "convexHull",
    physicsMaterial: PHYS_STEEL,
  });

  // shoulder — rotating turret carrying the j2 housing
  b.addLink({
    name: "shoulder",
    frame: translation(0, 0, 0.55),
    visuals: [
      box("shoulder_body", [0.24, 0.3, 0.2], [0, 0, 0.64], "robotOrange"),
      cyl("shoulder_housing", 0.115, 0.34, [0, 0, 0.74], "robotGray", "Y"),
      cyl("shoulder_cap_l", 0.055, 0.03, [0, 0.175, 0.74], "steel", "Y", 16),
      cyl("shoulder_cap_r", 0.055, 0.03, [0, -0.175, 0.74], "steel", "Y", 16),
    ],
    collisions: [box("shoulder_col", [0.3, 0.4, 0.3], [0, 0, 0.67], "robotOrange")],
    inertial: { mass: 9, centerOfMass: [0, 0, 0.15], diagonalInertia: boxInertia(9, 0.3, 0.4, 0.3) },
    collisionApproximation: "convexHull",
    physicsMaterial: PHYS_STEEL,
  });

  // upper arm — tapered casting between the shoulder and elbow housings
  b.addLink({
    name: "upper_arm",
    frame: translation(0, 0, 0.74),
    visuals: [
      box("upper_arm_body", [0.18, 0.23, 0.42], [0, 0, 0.95], "robotOrange"),
      box("upper_arm_rib_l", [0.2, 0.04, 0.34], [0, 0.115, 0.95], "robotOrange"),
      box("upper_arm_rib_r", [0.2, 0.04, 0.34], [0, -0.115, 0.95], "robotOrange"),
      cyl("elbow_housing", 0.095, 0.27, [0, 0, 1.16], "robotGray", "Y"),
      box("upper_arm_cable", [0.055, 0.055, 0.3], [-0.105, 0, 0.95], "darkSteel"),
    ],
    collisions: [box("upper_arm_col", [0.2, 0.24, 0.48], [0, 0, 0.95], "robotOrange")],
    inertial: { mass: 6.5, centerOfMass: [0, 0, 0.21], diagonalInertia: boxInertia(6.5, 0.16, 0.2, 0.48) },
    collisionApproximation: "convexHull",
    physicsMaterial: PHYS_STEEL,
  });

  // forearm — slimmer link ending in the wrist-pitch housing
  b.addLink({
    name: "forearm",
    frame: translation(0, 0, 1.16),
    visuals: [
      box("forearm_body", [0.15, 0.19, 0.34], [0, 0, 1.33], "robotOrange"),
      box("forearm_shroud", [0.17, 0.05, 0.26], [0, 0.095, 1.33], "robotGray"),
      cyl("wrist_housing", 0.08, 0.2, [0, 0, 1.5], "robotGray", "Y"),
      box("forearm_cable", [0.045, 0.045, 0.24], [-0.088, 0, 1.33], "darkSteel"),
    ],
    collisions: [box("forearm_col", [0.16, 0.2, 0.38], [0, 0, 1.33], "robotOrange")],
    inertial: { mass: 3.6, centerOfMass: [0, 0, 0.17], diagonalInertia: boxInertia(3.6, 0.13, 0.16, 0.38) },
    collisionApproximation: "convexHull",
    physicsMaterial: PHYS_STEEL,
  });

  // wrist — pitch output, carries the roll axis
  b.addLink({
    name: "wrist",
    frame: translation(0, 0, 1.5),
    visuals: [
      cyl("wrist_barrel", 0.062, 0.13, [0, 0, 1.565], "robotGray"),
      cyl("wrist_ring", 0.07, 0.02, [0, 0, 1.615], "steel", "Z", 20),
    ],
    collisions: [box("wrist_col", [0.14, 0.14, 0.15], [0, 0, 1.565], "robotGray")],
    inertial: { mass: 1.3, centerOfMass: [0, 0, 0.065], diagonalInertia: cylinderInertia(1.3, 0.07, 0.13) },
    collisionApproximation: "convexHull",
    physicsMaterial: PHYS_STEEL,
  });

  // tool — flange + gripper body the fingers slide on
  b.addLink({
    name: "tool",
    frame: translation(0, 0, 1.63),
    visuals: [
      cyl("tool_flange", 0.058, 0.025, [0, 0, 1.642], "steel", "Z", 20),
      box("gripper_body", [0.09, 0.13, 0.07], [0, 0, 1.69], "robotGray"),
      box("gripper_rail", [0.03, 0.16, 0.02], [0, 0, 1.732], "steel"),
    ],
    collisions: [box("tool_col", [0.1, 0.16, 0.12], [0, 0, 1.68], "robotGray")],
    inertial: { mass: 0.9, centerOfMass: [0, 0, 0.06], diagonalInertia: boxInertia(0.9, 0.1, 0.16, 0.12) },
    collisionApproximation: "convexHull",
    physicsMaterial: PHYS_STEEL,
  });

  // parallel-gripper fingers (prismatic, mirrored along Y)
  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? 1 : -1;
    b.addLink({
      name: `finger_${side}`,
      frame: translation(0, sign * 0.05, 1.74),
      visuals: [
        box(`finger_${side}_carrier`, [0.05, 0.03, 0.03], [0, sign * 0.05, 1.75], "steel"),
        box(`finger_${side}_jaw`, [0.045, 0.018, 0.09], [0, sign * 0.05, 1.805], "darkSteel"),
        box(`finger_${side}_pad`, [0.045, 0.008, 0.06], [0, sign * 0.04, 1.82], "rubber"),
      ],
      collisions: [box(`finger_${side}_col`, [0.05, 0.03, 0.1], [0, sign * 0.05, 1.8], "steel")],
      inertial: {
        mass: 0.15,
        centerOfMass: [0, 0, 0.05],
        diagonalInertia: boxInertia(0.15, 0.05, 0.03, 0.1),
      },
      collisionApproximation: "convexHull",
      physicsMaterial: PHYS_RUBBER,
    });
  }

  b.addFixedJoint({ name: "root_joint", child: "base" });
  // Initial pose: reaching over the conveyor with the gripper facing down —
  // exported as PhysicsJointStateAPI, so viewers and Isaac open on this pose.
  b.addRevoluteJoint({
    name: "j1_yaw", parent: "base", child: "shoulder",
    frame: translation(0, 0, 0.55), axis: "Z",
    lower: -2.967, upper: 2.967, initialValue: -0.62, drive: drive(-0.62, 1400),
  });
  b.addRevoluteJoint({
    name: "j2_shoulder", parent: "shoulder", child: "upper_arm",
    frame: translation(0, 0, 0.74), axis: "Y",
    lower: -1.92, upper: 1.92, initialValue: 0.85, drive: drive(0.85, 1600),
  });
  b.addRevoluteJoint({
    name: "j3_elbow", parent: "upper_arm", child: "forearm",
    frame: translation(0, 0, 1.16), axis: "Y",
    lower: -2.44, upper: 2.44, initialValue: 0.75, drive: drive(0.75, 1200),
  });
  b.addRevoluteJoint({
    name: "j4_wrist_pitch", parent: "forearm", child: "wrist",
    frame: translation(0, 0, 1.5), axis: "Y",
    lower: -2.9, upper: 2.9, initialValue: 1.15, drive: drive(1.15, 500),
  });
  b.addRevoluteJoint({
    name: "j5_wrist_roll", parent: "wrist", child: "tool",
    frame: translation(0, 0, 1.63), axis: "Z",
    lower: -3.14, upper: 3.14, initialValue: 0.35, drive: drive(0.35, 300),
  });
  for (const side of ["left", "right"] as const) {
    const sign = side === "left" ? 1 : -1;
    b.addPrismaticJoint({
      name: `gripper_${side}`, parent: "tool", child: `finger_${side}`,
      frame: translation(0, sign * 0.05, 1.74), axis: "Y",
      lower: -0.03, upper: 0.03, initialValue: sign * 0.012,
      drive: { targetPosition: sign * 0.012, stiffness: 400, damping: 40, maxForce: 60 },
    });
  }
  return b;
}

// ---------------------------------------------------------------------------
// Machine 2 — roller conveyor with a prismatic belt, along X at y = 1.15
// ---------------------------------------------------------------------------

const BELT_TOP = 0.665;

function buildConveyor(): RobotBuilder {
  const b = new RobotBuilder({ name: "Conveyor", onWarn: (m) => console.warn("  [conveyor]", m) });
  const cx = 1.6;
  const cy = 1.15;

  const structure: THREE.Mesh[] = [
    box("rail_l", [3.0, 0.05, 0.16], [cx, cy + 0.28, 0.6], "conveyorGreen"),
    box("rail_r", [3.0, 0.05, 0.16], [cx, cy - 0.28, 0.6], "conveyorGreen"),
    box("guide_l", [3.0, 0.02, 0.07], [cx, cy + 0.245, 0.7], "fenceYellow"),
    box("guide_r", [3.0, 0.02, 0.07], [cx, cy - 0.245, 0.7], "fenceYellow"),
    box("motor_gearbox", [0.2, 0.22, 0.2], [cx + 1.42, cy, 0.44], "darkSteel"),
    cyl("motor_body", 0.085, 0.24, [cx + 1.42, cy - 0.3, 0.44], "steel", "Y", 20),
    cyl("motor_fan", 0.06, 0.05, [cx + 1.42, cy - 0.44, 0.44], "darkSteel", "Y", 16),
    box("control_box", [0.2, 0.14, 0.26], [cx - 1.42, cy - 0.42, 0.46], "cabinet"),
    box("control_face", [0.02, 0.1, 0.16], [cx - 1.53, cy - 0.42, 0.48], "screen"),
  ];
  for (const [i, dx] of [-1.36, -0.45, 0.45, 1.36].entries()) {
    for (const dy of [-0.28, 0.28]) {
      structure.push(
        box(`leg_${i}_${dy > 0 ? "l" : "r"}`, [0.07, 0.07, 0.56], [cx + dx, cy + dy, 0.28], "conveyorGreen"),
        box(`foot_${i}_${dy > 0 ? "l" : "r"}`, [0.14, 0.14, 0.02], [cx + dx, cy + dy, 0.01], "darkSteel"),
      );
    }
    structure.push(box(`tie_${i}`, [0.05, 0.62, 0.05], [cx + dx, cy, 0.14], "conveyorGreen"));
  }
  // Diagonal end braces.
  for (const dx of [-1.36, 1.36]) {
    structure.push(
      boxYaw(`brace_${dx > 0 ? "e" : "w"}`, [0.04, 0.62, 0.04], [cx + dx, cy, 0.36], "conveyorGreen", 0),
    );
  }
  // Roller bed (visual only — the belt is the moving body).
  for (let i = 0; i < 15; i++) {
    const x = cx - 1.33 + i * 0.19;
    structure.push(cyl(`roller_${i}`, 0.045, 0.5, [x, cy, 0.62], "steel", "Y", 14));
  }

  b.addLink({
    name: "frame",
    frame: translation(cx, cy, 0),
    visuals: structure,
    collisions: [
      box("frame_col_top", [3.0, 0.6, 0.14], [cx, cy, 0.6], "conveyorGreen"),
      box("frame_col_base", [3.0, 0.6, 0.1], [cx, cy, 0.06], "conveyorGreen"),
    ],
    inertial: { mass: 55, centerOfMass: [0, 0, 0.4], diagonalInertia: boxInertia(55, 3, 0.6, 0.7) },
    collisionApproximation: "convexHull",
    physicsMaterial: PHYS_STEEL,
  });
  b.addLink({
    name: "belt",
    frame: translation(cx, cy, BELT_TOP - 0.02),
    visuals: [
      box("belt_surface", [2.86, 0.44, 0.02], [cx, cy, BELT_TOP - 0.01], "belt"),
      box("belt_cleat_a", [0.03, 0.44, 0.012], [cx - 0.9, cy, BELT_TOP + 0.005], "belt"),
      box("belt_cleat_b", [0.03, 0.44, 0.012], [cx + 0.3, cy, BELT_TOP + 0.005], "belt"),
    ],
    collisions: [box("belt_col", [2.86, 0.44, 0.02], [cx, cy, BELT_TOP - 0.01], "belt")],
    inertial: { mass: 9, centerOfMass: [0, 0, 0], diagonalInertia: boxInertia(9, 2.86, 0.44, 0.02) },
    collisionApproximation: "convexHull",
    physicsMaterial: PHYS_RUBBER,
  });

  b.addFixedJoint({ name: "root_joint", child: "frame" });
  b.addPrismaticJoint({
    name: "belt_slide", parent: "frame", child: "belt",
    frame: translation(cx, cy, BELT_TOP - 0.02), axis: "X",
    lower: -1.3, upper: 1.3, initialValue: 0,
    drive: { targetPosition: 0, stiffness: 900, damping: 90, maxForce: 500 },
  });
  return b;
}

// ---------------------------------------------------------------------------
// Machine 3 — continuous turntable positioner at (1.9, -1.2)
// ---------------------------------------------------------------------------

const TURNTABLE = { x: 1.9, y: -1.2, discTop: 0.235 };

function buildTurntable(): RobotBuilder {
  const b = new RobotBuilder({ name: "Turntable", onWarn: (m) => console.warn("  [turntable]", m) });
  const { x, y } = TURNTABLE;

  const baseParts: THREE.Mesh[] = [
    cyl("tt_base", 0.36, 0.1, [x, y, 0.05], "darkSteel", "Z", 28),
    cyl("tt_shoulder", 0.27, 0.08, [x, y, 0.14], "robotGray", "Z", 28),
    box("tt_drive", [0.24, 0.2, 0.16], [x - 0.42, y, 0.08], "darkSteel"),
    cyl("tt_motor", 0.075, 0.2, [x - 0.42, y - 0.2, 0.08], "steel", "Y", 18),
  ];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    baseParts.push(
      cyl(`tt_bolt_${i}`, 0.018, 0.03, [x + 0.3 * Math.cos(a), y + 0.3 * Math.sin(a), 0.105], "steel", "Z", 10),
    );
  }

  const discParts: THREE.Mesh[] = [
    cyl("tt_disc", 0.56, 0.05, [x, y, 0.205], "blueMachine", "Z", 36),
    cyl("tt_disc_rim", 0.58, 0.018, [x, y, 0.226], "steel", "Z", 36),
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    discParts.push(
      cyl(`tt_pin_${i}`, 0.025, 0.09, [x + 0.4 * Math.cos(a), y + 0.4 * Math.sin(a), 0.275], "steel", "Z", 12),
    );
  }

  b.addLink({
    name: "base",
    frame: translation(x, y, 0),
    visuals: baseParts,
    collisions: [cyl("tt_base_col", 0.36, 0.18, [x, y, 0.09], "darkSteel", "Z", 16)],
    inertial: { mass: 22, centerOfMass: [0, 0, 0.09], diagonalInertia: cylinderInertia(22, 0.36, 0.18) },
    collisionApproximation: "convexHull",
    physicsMaterial: PHYS_STEEL,
  });
  b.addLink({
    name: "disc",
    frame: translation(x, y, 0.18),
    visuals: discParts,
    collisions: [cyl("tt_disc_col", 0.56, 0.05, [x, y, 0.205], "blueMachine", "Z", 16)],
    inertial: { mass: 6, centerOfMass: [0, 0, 0.025], diagonalInertia: cylinderInertia(6, 0.56, 0.05) },
    collisionApproximation: "convexHull",
    physicsMaterial: PHYS_RUBBER,
  });

  b.addFixedJoint({ name: "root_joint", child: "base" });
  b.addRevoluteJoint({
    name: "spin", parent: "base", child: "disc",
    frame: translation(x, y, 0.18), axis: "Z",
    drive: { damping: 40, maxForce: 150 }, // velocity-style drive: no stiffness / target
  });
  return b;
}

// ---------------------------------------------------------------------------
// Static scenery — plain Mesh prims with static colliders (no rigid bodies)
// ---------------------------------------------------------------------------

type Prop = {
  name: string;
  visuals: THREE.Object3D[];
  /** Simplified collision shapes; omit for decoration (lights, markings). */
  colliders?: THREE.Object3D[];
  /** Free rigid body (crates); statics stay collider-only. */
  dynamic?: { mass: number; inertia: Vec3 };
};

const props: Prop[] = [];

/** Floor slab, painted markings and walls. */
function buildShell(): void {
  props.push({
    name: "floor",
    visuals: [box("floor_slab", [8.2, 6.9, 0.12], [0.95, 0.15, -0.06], "concrete")],
    colliders: [box("floor_col", [8.2, 6.9, 0.12], [0.95, 0.15, -0.06], "concrete")],
  });

  // Painted hazard ring around the arm's work envelope, a walkway lane, and
  // slab expansion joints — flat decals a few millimetres above the slab.
  const markings: THREE.Mesh[] = [
    // Pedestrian lane runs outside the guarding, along the cell's open side.
    box("walkway", [6.8, 0.85, 0.004], [0.95, -2.92, 0.003], "walkway"),
    box("walkway_edge_n", [6.8, 0.06, 0.005], [0.95, -2.47, 0.004], "hazardPaint"),
    box("walkway_edge_s", [6.8, 0.06, 0.005], [0.95, -3.37, 0.004], "hazardPaint"),
  ];
  for (const [i, [sx, sy, px, py]] of (
    [
      [2.6, 0.1, 0, 1.25],
      [2.6, 0.1, 0, -1.25],
      [0.1, 2.6, 1.25, 0],
      [0.1, 2.6, -1.25, 0],
    ] as const
  ).entries()) {
    markings.push(box(`hazard_${i}`, [sx, sy, 0.005], [px, py, 0.004], "hazardPaint"));
  }
  for (const [i, x] of [-1.15, 0.95, 3.05].entries()) {
    markings.push(box(`joint_x_${i}`, [0.03, 6.9, 0.003], [x, 0.15, 0.0025], "concreteDark"));
  }
  for (const [i, y] of [-1.6, 0.15, 1.9].entries()) {
    markings.push(box(`joint_y_${i}`, [8.2, 0.03, 0.003], [0.95, y, 0.0025], "concreteDark"));
  }
  props.push({ name: "floor_markings", visuals: markings });

  // Two walls (north + east) so the cell reads as an interior without boxing in
  // the camera, each with a kick plate and a ceiling trim band.
  const wallVisuals: THREE.Mesh[] = [
    box("wall_north", [8.2, 0.16, 3.0], [0.95, 3.52, 1.5], "wall"),
    box("wall_north_kick", [8.2, 0.03, 0.25], [0.95, 3.42, 0.125], "wallTrim"),
    box("wall_north_trim", [8.2, 0.05, 0.1], [0.95, 3.41, 2.6], "wallTrim"),
    box("wall_east", [0.16, 6.9, 3.0], [4.98, 0.15, 1.5], "wall"),
    box("wall_east_kick", [0.03, 6.9, 0.25], [4.88, 0.15, 0.125], "wallTrim"),
    box("wall_east_trim", [0.05, 6.9, 0.1], [4.87, 0.15, 2.6], "wallTrim"),
  ];
  // Sandwich-panel seams break up the large blank surfaces.
  for (let i = 0; i < 7; i++) {
    const x = -2.85 + i * 1.15;
    wallVisuals.push(box(`wall_north_seam_${i}`, [0.02, 0.02, 2.7], [x, 3.42, 1.4], "wallTrim"));
  }
  for (let i = 0; i < 6; i++) {
    const y = -2.85 + i * 1.15;
    wallVisuals.push(box(`wall_east_seam_${i}`, [0.02, 0.02, 2.7], [4.88, y, 1.4], "wallTrim"));
  }
  props.push({
    name: "walls",
    visuals: wallVisuals,
    colliders: [
      box("wall_north_col", [8.2, 0.16, 3.0], [0.95, 3.52, 1.5], "wall"),
      box("wall_east_col", [0.16, 6.9, 3.0], [4.98, 0.15, 1.5], "wall"),
    ],
  });
}

/**
 * Perimeter safety fencing with a gate opening. Panels are modelled as real
 * welded-wire grids (thin bars) rather than solid slabs, so the cell stays
 * legible from outside — exactly why guarding is built that way.
 */
function buildFence(): void {
  const visuals: THREE.Mesh[] = [];
  const colliders: THREE.Mesh[] = [];
  const H = 2.0;
  const BAR = 0.014;
  const SOUTH = -2.35;
  const WEST = -2.85;

  /** One infill panel: vertical + horizontal wires inside a yellow frame. */
  const panel = (id: string, cx: number, cy: number, along: "X" | "Y", length: number) => {
    const clear = length - 0.14;
    const meshTop = H - 0.16;
    const meshBottom = 0.2;
    const frame: Vec3 = along === "X" ? [clear, 0.05, 0.05] : [0.05, clear, 0.05];
    visuals.push(
      box(`fence_rail_top_${id}`, frame, [cx, cy, meshTop], "fenceYellow"),
      box(`fence_rail_bot_${id}`, frame, [cx, cy, meshBottom], "fenceYellow"),
    );

    const wires = Math.max(2, Math.round(clear / 0.14));
    for (let i = 0; i <= wires; i++) {
      const t = -clear / 2 + (i / wires) * clear;
      const size: Vec3 = along === "X" ? [BAR, BAR, meshTop - meshBottom] : [BAR, BAR, meshTop - meshBottom];
      const pos: Vec3 =
        along === "X"
          ? [cx + t, cy, (meshTop + meshBottom) / 2]
          : [cx, cy + t, (meshTop + meshBottom) / 2];
      visuals.push(box(`fence_wire_v_${id}_${i}`, size, pos, "fenceMesh"));
    }
    const rows = Math.max(2, Math.round((meshTop - meshBottom) / 0.16));
    for (let i = 0; i <= rows; i++) {
      const z = meshBottom + (i / rows) * (meshTop - meshBottom);
      const size: Vec3 = along === "X" ? [clear, BAR, BAR] : [BAR, clear, BAR];
      visuals.push(box(`fence_wire_h_${id}_${i}`, size, [cx, cy, z], "fenceMesh"));
    }

    const colSize: Vec3 = along === "X" ? [length, 0.08, H] : [0.08, length, H];
    colliders.push(box(`fence_col_${id}`, colSize, [cx, cy, H / 2], "fenceMesh"));
  };
  const post = (id: string, x: number, y: number) => {
    visuals.push(
      box(`fence_post_${id}`, [0.09, 0.09, H], [x, y, H / 2], "fenceYellow"),
      box(`fence_cap_${id}`, [0.11, 0.11, 0.03], [x, y, H + 0.015], "darkSteel"),
      box(`fence_foot_${id}`, [0.2, 0.2, 0.02], [x, y, 0.01], "darkSteel"),
    );
  };

  // South run with a gate gap between x = 0.4 and x = 2.2, plus the west run.
  const southSpans: [number, number][] = [
    [WEST, -1.4],
    [-1.4, 0.4],
    [2.2, 3.55],
    [3.55, 4.9],
  ];
  for (const [i, [x0, x1]] of southSpans.entries()) {
    panel(`s${i}`, (x0 + x1) / 2, SOUTH, "X", x1 - x0);
  }
  for (const [i, x] of [WEST, -1.4, 0.4, 2.2, 3.55, 4.9].entries()) post(`s${i}`, x, SOUTH);

  const westSpans: [number, number][] = [
    [SOUTH, -1.35],
    [-1.35, 0.35],
    [0.35, 2.05],
    [2.05, 3.45],
  ];
  for (const [i, [y0, y1]] of westSpans.entries()) {
    panel(`w${i}`, WEST, (y0 + y1) / 2, "Y", y1 - y0);
  }
  for (const [i, y] of [-1.35, 0.35, 2.05, 3.45].entries()) post(`w${i}`, WEST, y);

  // Gate: hinged at x = 2.2 and swung inward, with a header spanning the gap.
  const hinge: Vec3 = [2.2, SOUTH, 0];
  const swing = (140 * Math.PI) / 180;
  const leaf = 1.5;
  const leafCenter: Vec3 = [
    hinge[0] + (leaf / 2) * Math.cos(swing),
    hinge[1] + (leaf / 2) * Math.sin(swing),
    0,
  ];
  visuals.push(
    box("gate_head", [1.9, 0.05, 0.07], [1.3, SOUTH, H + 0.05], "fenceYellow"),
    boxYaw("gate_frame_top", [leaf, 0.06, 0.06], [leafCenter[0], leafCenter[1], H - 0.16], "fenceYellow", swing),
    boxYaw("gate_frame_bottom", [leaf, 0.06, 0.06], [leafCenter[0], leafCenter[1], 0.2], "fenceYellow", swing),
    boxYaw("gate_stile_hinge", [0.06, 0.06, H - 0.2], [hinge[0], hinge[1], H / 2], "fenceYellow", swing),
    boxYaw(
      "gate_stile_lock",
      [0.06, 0.06, H - 0.2],
      [hinge[0] + leaf * Math.cos(swing), hinge[1] + leaf * Math.sin(swing), H / 2],
      "fenceYellow",
      swing,
    ),
  );
  for (let i = 1; i < 10; i++) {
    const t = (i / 10) * leaf;
    visuals.push(
      boxYaw(
        `gate_wire_${i}`,
        [BAR, BAR, H - 0.4],
        [hinge[0] + t * Math.cos(swing), hinge[1] + t * Math.sin(swing), H / 2],
        "fenceMesh",
        swing,
      ),
    );
  }

  props.push({ name: "safety_fence", visuals, colliders });

  // Bollards guarding the gate approach, on the walkway side.
  const bollardY = SOUTH - 0.45;
  props.push({
    name: "bollards",
    visuals: [
      cyl("bollard_a", 0.07, 0.95, [0.4, bollardY, 0.475], "hazardPaint", "Z", 16),
      cyl("bollard_a_cap", 0.075, 0.05, [0.4, bollardY, 0.97], "darkSteel", "Z", 16),
      cyl("bollard_b", 0.07, 0.95, [2.2, bollardY, 0.475], "hazardPaint", "Z", 16),
      cyl("bollard_b_cap", 0.075, 0.05, [2.2, bollardY, 0.97], "darkSteel", "Z", 16),
    ],
    colliders: [
      box("bollard_a_col", [0.14, 0.14, 0.95], [0.4, bollardY, 0.475], "hazardPaint"),
      box("bollard_b_col", [0.14, 0.14, 0.95], [2.2, bollardY, 0.475], "hazardPaint"),
    ],
  });
}

/** The pedestal the arm bolts onto. */
function buildPedestal(): void {
  const visuals: THREE.Mesh[] = [
    box("pedestal_plate", [0.62, 0.62, 0.03], [0, 0, 0.015], "darkSteel"),
    cyl("pedestal_column", 0.23, 0.32, [0, 0, 0.19], "robotGray", "Z", 24),
    cyl("pedestal_flange", 0.27, 0.03, [0, 0, 0.345], "steel", "Z", 24),
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    visuals.push(
      cyl(`pedestal_bolt_${i}`, 0.02, 0.04, [0.26 * Math.cos(a), 0.26 * Math.sin(a), 0.03], "steel", "Z", 10),
    );
  }
  props.push({
    name: "pedestal",
    visuals,
    colliders: [box("pedestal_col", [0.55, 0.55, 0.36], [0, 0, 0.18], "robotGray")],
  });
}

/** Control cabinet with HMI screen and a stack light. */
function buildCabinet(): void {
  const cx = -2.25;
  const cy = 2.45;
  props.push({
    name: "control_cabinet",
    visuals: [
      box("cabinet_body", [0.8, 0.6, 1.9], [cx, cy, 0.99], "cabinet"),
      box("cabinet_door_seam", [0.012, 0.58, 1.66], [cx + 0.4, cy, 1.02], "darkSteel"),
      box("cabinet_hmi_bezel", [0.03, 0.4, 0.32], [cx + 0.405, cy - 0.08, 1.44], "darkSteel"),
      box("cabinet_hmi", [0.035, 0.34, 0.26], [cx + 0.41, cy - 0.08, 1.44], "screen"),
      box("cabinet_handle", [0.06, 0.04, 0.24], [cx + 0.43, cy + 0.22, 1.1], "steel"),
      box("cabinet_estop_ring", [0.03, 0.11, 0.11], [cx + 0.41, cy + 0.2, 1.5], "signalAmber"),
      box("cabinet_estop", [0.04, 0.08, 0.08], [cx + 0.42, cy + 0.2, 1.5], "signalRed"),
      box("cabinet_vent_a", [0.02, 0.44, 0.025], [cx + 0.4, cy, 0.42], "darkSteel"),
      box("cabinet_vent_b", [0.02, 0.44, 0.025], [cx + 0.4, cy, 0.49], "darkSteel"),
      box("cabinet_vent_c", [0.02, 0.44, 0.025], [cx + 0.4, cy, 0.56], "darkSteel"),
      box("cabinet_plinth", [0.82, 0.62, 0.08], [cx, cy, 0.04], "darkSteel"),
      box("cabinet_roof", [0.86, 0.66, 0.04], [cx, cy, 1.96], "cabinet"),
      cyl("stack_pole", 0.028, 0.3, [cx, cy, 2.13], "steel", "Z", 12),
      cyl("stack_red", 0.075, 0.1, [cx, cy, 2.33], "signalRed", "Z", 20),
      cyl("stack_amber", 0.075, 0.1, [cx, cy, 2.43], "signalAmber", "Z", 20),
      cyl("stack_green", 0.075, 0.1, [cx, cy, 2.53], "signalGreen", "Z", 20),
      cyl("stack_cap", 0.08, 0.03, [cx, cy, 2.59], "darkSteel", "Z", 20),
    ],
    colliders: [box("cabinet_col", [0.8, 0.6, 1.9], [cx, cy, 0.99], "cabinet")],
  });
}

/** Pallet racking along the east wall, loaded with boxes. */
function buildRack(): void {
  const visuals: THREE.Mesh[] = [];
  const colliders: THREE.Mesh[] = [];
  const x = 4.32;
  const H = 2.2;
  const bays: number[] = [-1.6, -0.2, 1.2, 2.6];
  for (const [i, y] of bays.entries()) {
    for (const [j, dx] of [-0.4, 0.4].entries()) {
      visuals.push(box(`rack_post_${i}_${j}`, [0.09, 0.09, H], [x + dx, y, H / 2], "blueMachine"));
    }
    visuals.push(
      box(`rack_brace_${i}`, [0.045, 0.045, 0.8], [x, y, 1.0], "blueMachine"),
      box(`rack_foot_${i}`, [1.0, 0.14, 0.03], [x, y, 0.015], "darkSteel"),
    );
  }
  for (const [i, z] of [0.72, 1.5].entries()) {
    for (const [j, dx] of [-0.37, 0.37].entries()) {
      visuals.push(box(`rack_beam_${i}_${j}`, [0.07, 4.3, 0.11], [x + dx, 0.5, z], "hazardPaint"));
    }
    visuals.push(box(`rack_deck_${i}`, [0.84, 4.3, 0.025], [x, 0.5, z + 0.065], "steel"));
  }
  colliders.push(box("rack_col", [0.95, 4.3, H], [x, 0.5, H / 2], "blueMachine"));

  // Palletised load on the shelves.
  const stack = (id: string, cy: number, cz: number, material: MatName) => {
    visuals.push(
      box(`rack_load_${id}`, [0.6, 0.7, 0.46], [x, cy, cz + 0.23], material),
      box(`rack_load_${id}_band`, [0.61, 0.02, 0.46], [x, cy - 0.18, cz + 0.23], "darkSteel"),
    );
  };
  stack("a", -1.25, 0.8, "cardboard");
  stack("b", -0.35, 0.8, "cardboardAlt");
  stack("c", 1.35, 1.58, "cardboard");
  stack("d", 2.35, 1.58, "cardboardAlt");
  props.push({ name: "pallet_rack", visuals, colliders });
}

/** Wooden pallets (slatted) with stacked cartons. */
function buildPallets(): void {
  const palletAt = (id: string, cx: number, cy: number, cartons: number, material: MatName) => {
    const visuals: THREE.Mesh[] = [];
    for (const [i, dy] of [-0.34, 0, 0.34].entries()) {
      visuals.push(box(`pallet_${id}_bottom_${i}`, [1.15, 0.1, 0.02], [cx, cy + dy, 0.01], "wood"));
    }
    for (const [i, dy] of [-0.34, 0, 0.34].entries()) {
      visuals.push(box(`pallet_${id}_stringer_${i}`, [1.15, 0.09, 0.07], [cx, cy + dy, 0.055], "wood"));
    }
    for (const [i, dx] of [-0.52, -0.26, 0, 0.26, 0.52].entries()) {
      visuals.push(box(`pallet_${id}_top_${i}`, [0.14, 0.8, 0.02], [cx + dx, cy, 0.1], "wood"));
    }
    for (let i = 0; i < cartons; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2;
      visuals.push(
        box(
          `pallet_${id}_carton_${i}`,
          [0.5, 0.36, 0.34],
          [cx + (col ? 0.27 : -0.27), cy + (row % 2 ? 0.02 : -0.02), 0.28 + row * 0.35],
          row % 2 ? material : "cardboardAlt",
        ),
      );
    }
    props.push({
      name: `pallet_${id}`,
      visuals,
      colliders: [box(`pallet_${id}_col`, [1.15, 0.8, 0.11], [cx, cy, 0.055], "wood")],
    });
  };
  palletAt("a", -1.95, -1.45, 6, "cardboard");
  palletAt("b", -1.95, 0.45, 4, "cardboardAlt");
}

/** Workbench with a pegboard back panel and a few parts on top. */
function buildWorkbench(): void {
  const bx = -0.5;
  const by = 2.92;
  const visuals: THREE.Mesh[] = [
    box("bench_top", [1.8, 0.75, 0.06], [bx, by, 0.9], "wood"),
    box("bench_apron", [1.8, 0.06, 0.12], [bx, by + 0.32, 0.81], "steel"),
    box("bench_shelf", [1.7, 0.65, 0.03], [bx, by, 0.35], "steel"),
    box("bench_backboard", [1.8, 0.03, 0.62], [bx, by + 0.36, 1.24], "cabinet"),
    box("bench_backboard_rail", [1.8, 0.05, 0.05], [bx, by + 0.36, 1.56], "steel"),
  ];
  for (const [i, dx] of [-0.82, 0.82].entries()) {
    for (const [j, dy] of [-0.32, 0.32].entries()) {
      visuals.push(box(`bench_leg_${i}_${j}`, [0.06, 0.06, 0.87], [bx + dx, by + dy, 0.435], "steel"));
    }
    visuals.push(box(`bench_upright_${i}`, [0.05, 0.05, 0.68], [bx + dx, by + 0.36, 1.27], "steel"));
  }
  visuals.push(
    box("bench_bin_a", [0.3, 0.22, 0.14], [bx - 0.6, by - 0.06, 1.0], "signalAmber"),
    box("bench_bin_b", [0.3, 0.22, 0.14], [bx - 0.25, by - 0.06, 1.0], "blueMachine"),
    cyl("bench_part", 0.09, 0.14, [bx + 0.6, by - 0.08, 1.0], "steel", "Z", 18),
    box("bench_tool_a", [0.04, 0.04, 0.26], [bx - 0.3, by + 0.33, 1.3], "darkSteel"),
    box("bench_tool_b", [0.05, 0.03, 0.2], [bx + 0.1, by + 0.33, 1.32], "darkSteel"),
  );
  props.push({
    name: "workbench",
    visuals,
    colliders: [box("bench_col", [1.8, 0.75, 0.06], [bx, by, 0.9], "wood")],
  });
}

/** Overhead luminaires and wall cable trays. */
function buildServices(): void {
  const visuals: THREE.Mesh[] = [];
  for (const [i, [x, y]] of ([
    [-1.3, 1.5],
    [1.6, 1.5],
    [-1.3, -1.4],
    [1.6, -1.4],
  ] as const).entries()) {
    visuals.push(
      // The lit panel is wider than the housing so it reads as a lamp from above.
      box(`lamp_${i}_tube`, [1.5, 0.32, 0.05], [x, y, 2.79], "lampLit"),
      box(`lamp_${i}_body`, [1.56, 0.24, 0.1], [x, y, 2.86], "lampBody"),
      box(`lamp_${i}_end_a`, [0.06, 0.32, 0.12], [x - 0.75, y, 2.83], "lampBody"),
      box(`lamp_${i}_end_b`, [0.06, 0.32, 0.12], [x + 0.75, y, 2.83], "lampBody"),
      box(`lamp_${i}_hanger_a`, [0.025, 0.025, 0.14], [x - 0.6, y, 2.98], "steel"),
      box(`lamp_${i}_hanger_b`, [0.025, 0.025, 0.14], [x + 0.6, y, 2.98], "steel"),
    );
  }
  visuals.push(
    box("cable_tray_east", [0.2, 6.6, 0.09], [4.72, 0.15, 2.45], "steel"),
    box("cable_tray_north", [7.9, 0.2, 0.09], [0.95, 3.28, 2.45], "steel"),
    box("conduit_east", [0.055, 6.6, 0.055], [4.78, 0.15, 2.24], "darkSteel"),
    box("conduit_drop", [0.055, 0.055, 1.6], [4.78, 2.9, 1.45], "darkSteel"),
  );
  props.push({ name: "services", visuals });
}

/** Free crates the simulation will settle (rigid bodies with convex colliders). */
function buildCrates(): void {
  const crate = (name: string, center: Vec3, size = 0.24, mass = 2) => {
    const [sx, sy, sz] = [size, size, size * 0.85];
    props.push({
      name,
      visuals: [
        box(`${name}_body`, [sx, sy, sz], center, "cardboard"),
        box(`${name}_tape`, [sx * 0.18, sy + 0.002, sz + 0.002], center, "cardboardAlt"),
      ],
      colliders: [box(`${name}_col`, [sx, sy, sz], center, "cardboard")],
      dynamic: { mass, inertia: boxInertia(mass, sx, sy, sz) },
    });
  };
  crate("crate_belt_a", [1.0, 1.15, BELT_TOP + 0.105]);
  crate("crate_belt_b", [2.15, 1.15, BELT_TOP + 0.105]);
  crate("crate_turntable", [TURNTABLE.x, TURNTABLE.y, TURNTABLE.discTop + 0.105]);
  crate("crate_floor_a", [-1.2, -1.9, 0.105]);
  crate("crate_floor_b", [-1.45, -2.05, 0.105], 0.2, 1.4);
}

// ---------------------------------------------------------------------------
// Three.js objects → USD prims
// ---------------------------------------------------------------------------

function collectMeshes(
  roots: THREE.Object3D[],
  kind: "visual" | "collision",
): { mesh: ExportMesh; material: string }[] {
  const out: { mesh: ExportMesh; material: string }[] = [];
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    root.traverse((obj) => {
      const meshObj = obj as THREE.Mesh;
      if (!meshObj.isMesh) return;
      const material = (Array.isArray(meshObj.material) ? meshObj.material[0] : meshObj.material) as
        | THREE.Material
        | undefined;
      const mesh = geometryToExportMesh(meshObj.geometry, {
        name: meshObj.name || "mesh",
        kind,
        transform: [...meshObj.matrixWorld.elements],
      });
      if (mesh) out.push({ mesh, material: material?.name ?? "concrete" });
    });
  }
  return out;
}

function propPrim(prop: Prop): PrimSpec {
  const children: PrimSpec[] = [];
  const used = new Set<string>();
  const unique = (raw: string) => {
    let name = raw.replace(/[^A-Za-z0-9_]/g, "_");
    if (/^[0-9]/.test(name)) name = `_${name}`;
    let candidate = name;
    for (let i = 2; used.has(candidate); i++) candidate = `${name}_${i}`;
    used.add(candidate);
    return candidate;
  };

  for (const { mesh, material } of collectMeshes(prop.visuals, "visual")) {
    children.push(meshPrim(mesh, unique(mesh.name), `${LOOKS_PATH}/${material}`));
  }
  for (const { mesh } of collectMeshes(prop.colliders ?? [], "collision")) {
    children.push(meshPrim(mesh, unique(mesh.name), undefined));
  }

  const properties: PropertySpec[] = [];
  const apiSchemas: string[] = [];
  if (prop.dynamic) {
    apiSchemas.push("PhysicsRigidBodyAPI", "PhysicsMassAPI");
    properties.push(
      attr("physics:mass", "float", prop.dynamic.mass),
      attr("physics:diagonalInertia", "float3", prop.dynamic.inertia),
      // UsdPhysics requires diagonalInertia and principalAxes to be paired.
      attr("physics:principalAxes", "quatf", Quat.identity()),
    );
  }
  return {
    specifier: "def",
    typeName: "Xform",
    name: prop.name,
    metadata: apiSchemas.length ? { apiSchemas } : {},
    properties,
    children,
    line: 0,
  };
}

function meshPrim(mesh: ExportMesh, name: string, materialPath: string | undefined): PrimSpec {
  const properties: PropertySpec[] = [];
  if (mesh.transform) {
    properties.push(
      attr("xformOp:transform", "matrix4d", toUsdMatrix(mesh.transform)),
      arrayAttr("xformOpOrder", "token", ["xformOp:transform"], "uniform"),
    );
  }
  properties.push(
    arrayAttr("faceVertexCounts", "int", mesh.faceVertexCounts),
    arrayAttr("faceVertexIndices", "int", mesh.faceVertexIndices),
    arrayAttr("points", "point3f", mesh.points),
  );
  if (mesh.normals) properties.push(arrayAttr("normals", "normal3f", mesh.normals));
  properties.push(uniformToken("subdivisionScheme", "none"));

  const apiSchemas: string[] = [];
  if (mesh.kind === "collision") {
    apiSchemas.push("PhysicsCollisionAPI");
    properties.push(uniformToken("purpose", "guide"));
  }
  if (materialPath) {
    apiSchemas.push("MaterialBindingAPI");
    properties.push(rel("material:binding", [materialPath]));
  }
  return {
    specifier: "def",
    typeName: "Mesh",
    name,
    metadata: apiSchemas.length ? { apiSchemas } : {},
    properties,
    children: [],
    line: 0,
  };
}

/** `Scope` of `UsdPreviewSurface` materials shared by the scenery. */
function looksPrim(): PrimSpec {
  const children: PrimSpec[] = [];
  for (const [name, def] of Object.entries(MATERIALS)) {
    const color = new THREE.Color(def.color);
    const shaderProps: PropertySpec[] = [
      uniformToken("info:id", "UsdPreviewSurface"),
      attr("inputs:diffuseColor", "color3f", [color.r, color.g, color.b]),
      attr("inputs:metallic", "float", def.metallic ?? 0),
      attr("inputs:roughness", "float", def.roughness ?? 0.5),
    ];
    if (def.emissive !== undefined) {
      const e = new THREE.Color(def.emissive);
      shaderProps.push(attr("inputs:emissiveColor", "color3f", [e.r, e.g, e.b]));
    }
    shaderProps.push(attr("outputs:surface", "token", undefined));

    const surface = attr("outputs:surface", "token", undefined);
    surface.connections = [`${LOOKS_PATH}/${name}/PreviewSurface.outputs:surface`];
    children.push({
      specifier: "def",
      typeName: "Material",
      name,
      metadata: {},
      properties: [surface],
      children: [
        {
          specifier: "def",
          typeName: "Shader",
          name: "PreviewSurface",
          metadata: {},
          properties: shaderProps,
          children: [],
          line: 0,
        },
      ],
      line: 0,
    });
  }
  return {
    specifier: "def",
    typeName: "Scope",
    name: "Looks",
    metadata: {},
    properties: [],
    children,
    line: 0,
  };
}

// --- AST spec helpers -------------------------------------------------------

function attr(name: string, typeName: string, value: UsdValue | undefined): AttributeSpec {
  return {
    kind: "attribute",
    name,
    typeName,
    isArray: false,
    variability: "varying",
    custom: false,
    ...(value !== undefined ? { value } : {}),
    metadata: {},
    line: 0,
  };
}

function arrayAttr(
  name: string,
  typeName: string,
  value: UsdValue[],
  variability: "varying" | "uniform" = "varying",
): AttributeSpec {
  return {
    kind: "attribute",
    name,
    typeName,
    isArray: true,
    variability,
    custom: false,
    value,
    metadata: {},
    line: 0,
  };
}

function uniformToken(name: string, value: string): AttributeSpec {
  return {
    kind: "attribute",
    name,
    typeName: "token",
    isArray: false,
    variability: "uniform",
    custom: false,
    value,
    metadata: {},
    line: 0,
  };
}

function rel(name: string, targets: string[]): RelationshipSpec {
  return {
    kind: "relationship",
    name,
    custom: false,
    listOp: "explicit",
    targets,
    metadata: {},
    line: 0,
  };
}

// ---------------------------------------------------------------------------
// Assemble the stage
// ---------------------------------------------------------------------------

buildShell();
buildFence();
buildPedestal();
buildCabinet();
buildRack();
buildPallets();
buildWorkbench();
buildServices();
buildCrates();

const machines = [
  { builder: buildArm(), options: { enabledSelfCollisions: false, isaacRobotSchema: true } },
  { builder: buildConveyor(), options: { enabledSelfCollisions: false } },
  { builder: buildTurntable(), options: { enabledSelfCollisions: false } },
];

const machinePrims = machines.map(({ builder, options }) => {
  const { desc, geometry } = builder.build();
  const issues = validateRobotDescription(desc, { geometry });
  console.log(
    `${desc.name}: links=${Object.keys(desc.links).length} joints=${Object.keys(desc.joints).length} ` +
      `validator=${issues.length === 0 ? "clean" : JSON.stringify(issues.map((i) => i.code))}`,
  );
  return exportRobotUsda(desc, { ...options, geometry, onWarn: (m) => console.warn(" ", m) }).prims[0]!;
});

/**
 * `UsdLux` lights so the stage opens lit in Isaac Sim / usdview rather than
 * relying on a viewport camera light. The distant light matches the key light
 * the preview renderer uses (≈48° above the south-west).
 */
const lights: PrimSpec = {
  specifier: "def",
  typeName: "Xform",
  name: "Lights",
  metadata: {},
  properties: [],
  children: [
    {
      specifier: "def",
      typeName: "DomeLight",
      name: "domeLight",
      metadata: {},
      properties: [
        attr("inputs:intensity", "float", 500),
        attr("inputs:color", "color3f", [0.86, 0.9, 1.0]),
        uniformToken("inputs:texture:format", "latlong"),
      ],
      children: [],
      line: 0,
    },
    {
      specifier: "def",
      typeName: "DistantLight",
      name: "keyLight",
      metadata: {},
      properties: [
        attr("inputs:intensity", "float", 2200),
        attr("inputs:angle", "float", 1.2),
        attr("inputs:color", "color3f", [1.0, 0.96, 0.9]),
        attr("xformOp:rotateXYZ", "float3", [39.6, 0, -35.4]),
        arrayAttr("xformOpOrder", "token", ["xformOp:rotateXYZ"], "uniform"),
      ],
      children: [],
      line: 0,
    },
  ],
  line: 0,
};

const physicsScene: PrimSpec = {
  specifier: "def",
  typeName: "PhysicsScene",
  name: "physicsScene",
  metadata: {},
  properties: [
    attr("physics:gravityDirection", "vector3f", [0, 0, -1]),
    attr("physics:gravityMagnitude", "float", 9.81),
  ],
  children: [],
  line: 0,
};

const environment: PrimSpec = {
  specifier: "def",
  typeName: "Xform",
  name: "Environment",
  metadata: {},
  properties: [],
  children: [looksPrim(), ...props.map(propPrim)],
  line: 0,
};

const factory: UsdaFile = {
  version: "1.0",
  metadata: {
    defaultPrim: "FactoryArm",
    metersPerUnit: 1,
    upAxis: "Z",
    doc: "Factory cell authored & exported by three-usd-robot (scripts/demo-factory.ts)",
  },
  prims: [physicsScene, lights, environment, ...machinePrims],
};

const usda = serializeUsda(factory);
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(`${OUT_DIR}factory.usda`, usda);
writeFileSync(`${OUT_DIR}factory.usdz`, writeUsdz({ "factory.usda": usda }));
for (const dir of EXAMPLE_PUBLIC_DIRS) {
  mkdirSync(dir, { recursive: true });
  copyFileSync(`${OUT_DIR}factory.usda`, `${dir}factory.usda`);
}

const merged = extractRobotDescription(Stage.OpenFromString(usda));
const meshCount = Stage.OpenFromString(usda)
  .Traverse()
  .filter((p) => p.GetTypeName() === "Mesh").length;
console.log(
  `merged stage: links=${Object.keys(merged.links).length} joints=${Object.keys(merged.joints).length} ` +
    `meshes=${meshCount} size=${(usda.length / 1024 / 1024).toFixed(2)} MB ` +
    "(crates ride along as free bodies; multi-root warnings are expected)",
);
console.log(`wrote ${OUT_DIR}factory.usda / factory.usdz (+ example public copy)`);
console.log("next: npx tsx scripts/render-preview.ts out/factory.usda out/factory-preview.png");
