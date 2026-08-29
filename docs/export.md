# Exporting USD

The loader's inverse: re-export something you loaded, or author a robot from
Three.js objects and open the result in Isaac Sim.

![The exported cell opened in Isaac Sim](../assets/isaacsim.png)

## Re-export & authoring

```ts
import {
  exportThreeUsdRobot,
  RobotBuilder,
  serializeUsda,
  writeUsdz,
} from "three-usd-robot";

// Re-export a loaded robot (meshes harvested from the Three.js scene):
const usda = serializeUsda(exportThreeUsdRobot(robot));

// …or build one from Three.js meshes. Z-up and metres by default; each joint
// takes ONE world-space frame, and the build-time arrangement is the zero pose.
const builder = new RobotBuilder({ name: "my_robot" });
builder.addLink({ name: "base", visuals: [baseMesh] });
builder.addLink({ name: "arm", frame: armFrame, visuals: [armMesh] });
builder.addFixedJoint({ name: "root_joint", child: "base" });
builder.addRevoluteJoint({
  name: "j1", parent: "base", child: "arm",
  frame: jointFrame, axis: "Z", lower: -Math.PI, upper: Math.PI,
});

const file = builder.toUsda();
writeFileSync("robot.usda", serializeUsda(file));
writeFileSync("robot.usdz", writeUsdz({ "robot.usda": serializeUsda(file) }));
```

Joints export as `UsdPhysics` prims with their limits, drives, mimic couplings
(`NewtonMimicAPI`; see the [runtime guide](./runtime.md#mimic-joints-coupled-dofs))
and initial pose (`PhysicsJointStateAPI`, so a re-import applies it exactly
once). Time-sampled joint trajectories serialize as `timeSamples`.

## Simulation-ready assets

For a simulation-ready asset, links also take mass properties, and collision
meshes take physics materials and a collision approximation:

```ts
builder.addLink({
  name: "arm",
  visuals: [armMesh],
  collisions: [armCollisionMesh],
  inertial: { mass: 2.5, centerOfMass: [0, 0, 0.2], diagonalInertia: [0.02, 0.02, 0.004] },
  collisionApproximation: "convexHull",
  physicsMaterial: { name: "steel", staticFriction: 0.6, dynamicFriction: 0.5 },
});
```

Export options (`exportRobotUsda` / `builder.toUsda`):

- `enabledSelfCollisions` — authors `physxArticulation:enabledSelfCollisions`
  on the articulation root (`false` is the common Isaac stabilizer for
  adjacent-link contact).
- `isaacRobotSchema` — applies the Isaac Sim Robot Schema: `IsaacRobotAPI` on
  the root with ordered `isaac:physics:robotLinks` / `robotJoints`
  relationships, `IsaacLinkAPI` per link, and `IsaacJointAPI` (+ DOF order)
  per joint.

`validateRobotDescription(desc, { geometry })` checks the result the way
Isaac Sim's Asset Validator would — graph connectivity, limit sanity, mass
properties, collision setup, mimic references — returning `error` /
`warning` issues with stable codes.

## Packaging & demos

`writeUsdz` produces an uncompressed, 64-byte-aligned zip with the root layer
first (Quick Look compatible), bundling textures alongside the layer.

`npx tsx scripts/demo-factory.ts` authors a complete robot cell — a 7-DOF arm
with a gripper, a conveyor, a turntable and the surrounding scenery — and
exports it to `out/factory.usda` / `.usdz`; the screenshot above is that file
opened in Isaac Sim.
