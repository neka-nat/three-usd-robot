/**
 * Robot IR → USDA layer (M13).
 *
 * Builds a self-contained UsdPhysics robot layer from a {@link RobotDescription}:
 * one `Xform` prim per link placed at its **zero-pose** world transform
 * (folding joint frames root-down, `T_child = T_parent · frame0 · frame1⁻¹` —
 * see docs/export-design.md §4), one `Physics*Joint` prim per joint, and the
 * link meshes supplied by a {@link RobotGeometryProvider}. Initial joint values
 * author as `PhysicsJointStateAPI` opinions rather than being baked into link
 * transforms, so a re-import applies them exactly once. Values convert back
 * from SI to authored units (angular radians → degrees).
 */

import {
  type Mat4,
  decomposeRigid,
  identity4,
  invert,
  multiply,
  toUsdMatrix,
} from "../kinematics/transforms.js";
import type {
  AttributeSpec,
  MetadataMap,
  PrimSpec,
  PropertySpec,
  RelationshipSpec,
  UsdValue,
  UsdaFile,
} from "../parser/ast.js";
import { AssetPath, Quat } from "../parser/ast.js";
import type {
  JointDescription,
  JointType,
  LinkInertialDescription,
  RobotDescription,
} from "../robot/RobotDescription.js";
import { buildKinematicTree } from "../robot/buildKinematicTree.js";
import { jointValueFromSI } from "../robot/normalize.js";
import {
  ARTICULATION_ROOT_API,
  COLLISION_API,
  MASS_API,
  MESH_COLLISION_API,
  PHYSICS_MATERIAL_API,
  RIGID_BODY_API,
  driveKindFor,
} from "../schemas/usdPhysics.js";
import type {
  ExportMaterial,
  ExportMesh,
  ExportPhysicsMaterial,
  RobotGeometryProvider,
  TextureChannel,
} from "./GeometryProvider.js";

/** PhysX articulation tuning API (Isaac / Omniverse). */
const PHYSX_ARTICULATION_API = "PhysxArticulationAPI";

export type ExportRobotOptions = {
  /** Supplies each link's meshes; omit for a kinematics-only layer. */
  geometry?: RobotGeometryProvider;
  /** Root prim name; defaults to the (sanitized) robot name. */
  robotName?: string;
  /**
   * Author `physxArticulation:enabledSelfCollisions` on the articulation root
   * (M16). `false` is the common Isaac stabilizer for adjacent-link contact.
   */
  enabledSelfCollisions?: boolean;
  /**
   * Apply the Isaac Sim Robot Schema (M16): `IsaacRobotAPI` on the root with
   * ordered `isaac:physics:robotLinks` / `robotJoints` relationships,
   * `IsaacLinkAPI` per link, and `IsaacJointAPI` (+ DOF order) per joint.
   */
  isaacRobotSchema?: boolean;
  /** Receives non-fatal export diagnostics. */
  onWarn?: (message: string) => void;
};

const JOINT_SCHEMA_BY_TYPE: Record<JointType, string> = {
  fixed: "PhysicsFixedJoint",
  revolute: "PhysicsRevoluteJoint",
  continuous: "PhysicsRevoluteJoint",
  prismatic: "PhysicsPrismaticJoint",
};

/** Serialize a robot IR into a single-layer USDA AST (pass to `serializeUsda`). */
export function exportRobotUsda(
  desc: RobotDescription,
  options: ExportRobotOptions = {},
): UsdaFile {
  const warn = (m: string) => options.onWarn?.(m);
  const tree = buildKinematicTree(desc, { onWarn: warn });

  const robotName = sanitizeName(options.robotName ?? desc.name ?? "robot");

  // One flat sibling namespace under the root prim for links and joints.
  const alloc = nameAllocator(warn);
  const linkNames = new Map<string, string>();
  for (const key of Object.keys(desc.links)) linkNames.set(key, alloc(key, `link "${key}"`));
  const jointNames = new Map<string, string>();
  for (const key of Object.keys(desc.joints)) jointNames.set(key, alloc(key, `joint "${key}"`));
  const linkPath = (key: string) => `/${robotName}/${linkNames.get(key)}`;

  // Zero-pose world placement per link, folded root-down along the tree.
  // Links no joint chain reaches (floating root / isolated) keep their
  // authored stage placement when the IR carries one.
  const authoredWorld = (key: string) => desc.links[key]?.worldTransform ?? identity4();
  const worldByLink = new Map<string, Mat4>();
  for (const key of tree.order) {
    const node = tree.nodes[key]!;
    if (node.parent === null || node.jointToParent === null) {
      const rootJoint = tree.rootJoint ? desc.joints[tree.rootJoint] : undefined;
      worldByLink.set(
        key,
        rootJoint
          ? multiply(rootJoint.jointFrame0, invert(rootJoint.jointFrame1))
          : authoredWorld(key),
      );
      continue;
    }
    const joint = desc.joints[node.jointToParent]!;
    const parentWorld = worldByLink.get(node.parent) ?? identity4();
    worldByLink.set(
      key,
      multiply(multiply(parentWorld, joint.jointFrame0), invert(joint.jointFrame1)),
    );
  }
  for (const key of tree.isolatedLinks) worldByLink.set(key, authoredWorld(key));

  // Articulation root: preserve link-level APIs from the IR; otherwise apply it
  // on the container prim (never both — nested articulation roots are invalid).
  const articulationLinks = new Set(desc.articulationRoots ?? []);

  // Gather meshes once, then dedupe their (physics) materials by name.
  const meshesByLink = new Map<string, ExportMesh[]>();
  const materials = new Map<string, ExportMaterial>();
  const physicsMaterials = new Map<string, ExportPhysicsMaterial>();
  for (const [key, link] of Object.entries(desc.links)) {
    const meshes = options.geometry?.(key, link) ?? [];
    meshesByLink.set(key, meshes);
    for (const mesh of meshes) {
      if (mesh.material && !materials.has(mesh.material.name)) {
        materials.set(mesh.material.name, mesh.material);
      }
      if (mesh.physicsMaterial && !physicsMaterials.has(mesh.physicsMaterial.name)) {
        physicsMaterials.set(mesh.physicsMaterial.name, mesh.physicsMaterial);
      }
    }
  }
  const looksName = materials.size > 0 ? alloc("Looks") : undefined;
  const materialAlloc = nameAllocator();
  const materialNames = new Map<string, string>();
  for (const name of materials.keys()) materialNames.set(name, materialAlloc(name));
  const materialPath = (name: string) =>
    looksName ? `/${robotName}/${looksName}/${materialNames.get(name)}` : undefined;

  const physicsScopeName = physicsMaterials.size > 0 ? alloc("PhysicsMaterials") : undefined;
  const physicsMaterialAlloc = nameAllocator();
  const physicsMaterialNames = new Map<string, string>();
  for (const name of physicsMaterials.keys()) {
    physicsMaterialNames.set(name, physicsMaterialAlloc(name));
  }
  const physicsMaterialPath = (name: string) =>
    physicsScopeName
      ? `/${robotName}/${physicsScopeName}/${physicsMaterialNames.get(name)}`
      : undefined;

  const isaac = options.isaacRobotSchema === true;
  const children: PrimSpec[] = [];
  for (const [key, link] of Object.entries(desc.links)) {
    const apiSchemas = [RIGID_BODY_API];
    if (articulationLinks.has(key)) apiSchemas.push(ARTICULATION_ROOT_API);
    if (link.inertial) apiSchemas.push(MASS_API);
    if (isaac) apiSchemas.push("IsaacLinkAPI");
    const selfCollision = articulationLinks.has(key) ? options.enabledSelfCollisions : undefined;
    if (selfCollision !== undefined) apiSchemas.push(PHYSX_ARTICULATION_API);
    children.push(
      buildLinkPrim({
        name: linkNames.get(key)!,
        world: worldByLink.get(key) ?? identity4(),
        apiSchemas,
        meshes: meshesByLink.get(key) ?? [],
        materialPath,
        physicsMaterialPath,
        warn,
        ...(link.inertial ? { inertial: link.inertial } : {}),
        ...(selfCollision !== undefined ? { selfCollision } : {}),
      }),
    );
  }
  const emittedJoints = new Set<string>();
  for (const [key, joint] of Object.entries(desc.joints)) {
    if (!desc.links[joint.child] || (joint.parent !== "" && !desc.links[joint.parent])) {
      warn(`joint "${key}" references an unknown link; skipped`);
      continue;
    }
    emittedJoints.add(key);
    children.push(buildJointPrim(jointNames.get(key)!, key, joint, linkPath, isaac, warn));
  }
  if (looksName) {
    children.push(buildLooksPrim(looksName, materials, materialNames, materialPath));
  }
  if (physicsScopeName) {
    children.push(
      buildPhysicsMaterialsPrim(physicsScopeName, physicsMaterials, physicsMaterialNames),
    );
  }

  const rootApiSchemas: string[] = [];
  const rootProperties: PropertySpec[] = [];
  if (articulationLinks.size === 0) {
    rootApiSchemas.push(ARTICULATION_ROOT_API);
    if (options.enabledSelfCollisions !== undefined) {
      rootApiSchemas.push(PHYSX_ARTICULATION_API);
      rootProperties.push(
        attr("physxArticulation:enabledSelfCollisions", "bool", options.enabledSelfCollisions),
      );
    }
  }
  if (isaac) {
    rootApiSchemas.push("IsaacRobotAPI");
    const orderedLinks = [...tree.order, ...tree.isolatedLinks];
    const orderedJoints: string[] = [];
    const pushJoint = (key: string | null | undefined) => {
      if (key && emittedJoints.has(key) && !orderedJoints.includes(key)) orderedJoints.push(key);
    };
    pushJoint(tree.rootJoint);
    for (const linkKey of tree.order) pushJoint(tree.nodes[linkKey]?.jointToParent);
    for (const jointKey of tree.loopJoints) pushJoint(jointKey);
    for (const jointKey of Object.keys(desc.joints)) pushJoint(jointKey);

    rootProperties.push(rel("isaac:physics:robotLinks", orderedLinks.map(linkPath)));
    rootProperties.push(
      rel(
        "isaac:physics:robotJoints",
        orderedJoints.map((key) => `/${robotName}/${jointNames.get(key)}`),
      ),
    );
  }

  const root: PrimSpec = {
    specifier: "def",
    typeName: "Xform",
    name: robotName,
    metadata: rootApiSchemas.length > 0 ? { apiSchemas: rootApiSchemas } : {},
    properties: rootProperties,
    children,
    line: 0,
  };

  const metadata: MetadataMap = {
    defaultPrim: robotName,
    metersPerUnit: desc.metersPerUnit,
    upAxis: desc.upAxis,
    ...(desc.timeCodesPerSecond !== undefined
      ? { timeCodesPerSecond: desc.timeCodesPerSecond }
      : {}),
    ...(desc.startTimeCode !== undefined ? { startTimeCode: desc.startTimeCode } : {}),
    ...(desc.endTimeCode !== undefined ? { endTimeCode: desc.endTimeCode } : {}),
  };

  return { version: "1.0", metadata, prims: [root] };
}

// ---------------------------------------------------------------------------
// Links & meshes
// ---------------------------------------------------------------------------

type LinkPrimArgs = {
  name: string;
  world: Mat4;
  apiSchemas: string[];
  meshes: ExportMesh[];
  inertial?: LinkInertialDescription;
  /** `physxArticulation:enabledSelfCollisions` for link-level articulation roots. */
  selfCollision?: boolean;
  materialPath: (name: string) => string | undefined;
  physicsMaterialPath: (name: string) => string | undefined;
  warn: (message: string) => void;
};

function buildLinkPrim(args: LinkPrimArgs): PrimSpec {
  const meshAlloc = nameAllocator();
  const properties: PropertySpec[] = transformProps(args.world);
  if (args.inertial) properties.push(...massProps(args.inertial, args.name, args.warn));
  if (args.selfCollision !== undefined) {
    properties.push(attr("physxArticulation:enabledSelfCollisions", "bool", args.selfCollision));
  }
  return {
    specifier: "def",
    typeName: "Xform",
    name: args.name,
    metadata: { apiSchemas: args.apiSchemas },
    properties,
    children: args.meshes.map((mesh) =>
      buildMeshPrim(mesh, meshAlloc(mesh.name), args.materialPath, args.physicsMaterialPath),
    ),
    line: 0,
  };
}

/**
 * `UsdPhysicsMassAPI` attributes for a link's mass properties. UsdPhysics
 * requires `diagonalInertia` and `principalAxes` to be authored together, so a
 * missing principal-axes frame is completed with the identity quaternion
 * (equivalent — the diagonal is then in the body frame) and axes without a
 * diagonal are dropped (meaningless alone).
 */
function massProps(
  inertial: LinkInertialDescription,
  linkName: string,
  warn: (message: string) => void,
): PropertySpec[] {
  const out: PropertySpec[] = [];
  if (inertial.mass !== undefined) out.push(attr("physics:mass", "float", inertial.mass));
  if (inertial.density !== undefined) out.push(attr("physics:density", "float", inertial.density));
  if (inertial.centerOfMass) {
    out.push(attr("physics:centerOfMass", "point3f", inertial.centerOfMass));
  }
  if (inertial.diagonalInertia) {
    out.push(attr("physics:diagonalInertia", "float3", inertial.diagonalInertia));
    out.push(attr("physics:principalAxes", "quatf", inertial.principalAxes ?? Quat.identity()));
  } else if (inertial.principalAxes) {
    warn(`link "${linkName}": principalAxes without diagonalInertia is meaningless; dropped`);
  }
  return out;
}

function buildMeshPrim(
  mesh: ExportMesh,
  name: string,
  materialPath: (name: string) => string | undefined,
  physicsMaterialPath: (name: string) => string | undefined,
): PrimSpec {
  const properties: PropertySpec[] = [];
  if (mesh.transform) properties.push(...transformProps(mesh.transform));
  properties.push(
    arrayAttr("faceVertexCounts", "int", mesh.faceVertexCounts),
    arrayAttr("faceVertexIndices", "int", mesh.faceVertexIndices),
    arrayAttr("points", "point3f", mesh.points),
  );
  if (mesh.normals) properties.push(arrayAttr("normals", "normal3f", mesh.normals));
  if (mesh.st) {
    properties.push(arrayAttr("primvars:st", "texCoord2f", mesh.st, { interpolation: "vertex" }));
  }
  if (mesh.displayColor) {
    properties.push(arrayAttr("primvars:displayColor", "color3f", [mesh.displayColor]));
  }
  if (mesh.doubleSided) properties.push(attr("doubleSided", "bool", true));
  properties.push(uniformToken("subdivisionScheme", "none"));

  const apiSchemas: string[] = [];
  if (mesh.kind === "collision") {
    apiSchemas.push(COLLISION_API);
    // `guide` keeps collision shapes out of the render pass (usdview, Isaac Sim,
    // and this package's own loader) while PhysX still collides with them.
    properties.push(uniformToken("purpose", "guide"));
    if (mesh.collisionApproximation) {
      apiSchemas.push(MESH_COLLISION_API);
      properties.push(uniformToken("physics:approximation", mesh.collisionApproximation));
    }
  }
  const binding = mesh.material ? materialPath(mesh.material.name) : undefined;
  if (binding) properties.push(rel("material:binding", [binding]));
  const physicsBinding =
    mesh.kind === "collision" && mesh.physicsMaterial
      ? physicsMaterialPath(mesh.physicsMaterial.name)
      : undefined;
  if (physicsBinding) properties.push(rel("material:binding:physics", [physicsBinding]));
  if (binding || physicsBinding) apiSchemas.push("MaterialBindingAPI");

  return {
    specifier: "def",
    typeName: "Mesh",
    name,
    metadata: apiSchemas.length > 0 ? { apiSchemas } : {},
    properties,
    children: [],
    line: 0,
  };
}

// ---------------------------------------------------------------------------
// Physics materials
// ---------------------------------------------------------------------------

/** `Scope` holding one `PhysicsMaterialAPI` material per unique name. */
function buildPhysicsMaterialsPrim(
  scopeName: string,
  materials: Map<string, ExportPhysicsMaterial>,
  names: Map<string, string>,
): PrimSpec {
  const children: PrimSpec[] = [];
  for (const [key, material] of materials) {
    children.push(buildPhysicsMaterialPrim(names.get(key)!, material));
  }
  return {
    specifier: "def",
    typeName: "Scope",
    name: scopeName,
    metadata: {},
    properties: [],
    children,
    line: 0,
  };
}

function buildPhysicsMaterialPrim(name: string, material: ExportPhysicsMaterial): PrimSpec {
  const properties: PropertySpec[] = [];
  if (material.staticFriction !== undefined) {
    properties.push(attr("physics:staticFriction", "float", material.staticFriction));
  }
  if (material.dynamicFriction !== undefined) {
    properties.push(attr("physics:dynamicFriction", "float", material.dynamicFriction));
  }
  if (material.restitution !== undefined) {
    properties.push(attr("physics:restitution", "float", material.restitution));
  }
  if (material.density !== undefined) {
    properties.push(attr("physics:density", "float", material.density));
  }
  return {
    specifier: "def",
    typeName: "Material",
    name,
    metadata: { apiSchemas: [PHYSICS_MATERIAL_API] },
    properties,
    children: [],
    line: 0,
  };
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

/** `Scope` holding one `Material` + `UsdPreviewSurface` shader per material. */
function buildLooksPrim(
  looksName: string,
  materials: Map<string, ExportMaterial>,
  materialNames: Map<string, string>,
  materialPath: (name: string) => string | undefined,
): PrimSpec {
  const children: PrimSpec[] = [];
  for (const [key, material] of materials) {
    children.push(buildMaterialPrim(materialNames.get(key)!, material, materialPath(key)!));
  }
  return {
    specifier: "def",
    typeName: "Scope",
    name: looksName,
    metadata: {},
    properties: [],
    children,
    line: 0,
  };
}

/** How each texture channel wires into `UsdPreviewSurface`. */
const TEXTURE_WIRING: Record<
  TextureChannel,
  { input: string; inputType: string; output: string; outputType: string; colorSpace: string }
> = {
  color: {
    input: "inputs:diffuseColor",
    inputType: "color3f",
    output: "outputs:rgb",
    outputType: "float3",
    colorSpace: "sRGB",
  },
  emissive: {
    input: "inputs:emissiveColor",
    inputType: "color3f",
    output: "outputs:rgb",
    outputType: "float3",
    colorSpace: "sRGB",
  },
  normal: {
    input: "inputs:normal",
    inputType: "normal3f",
    output: "outputs:rgb",
    outputType: "float3",
    colorSpace: "raw",
  },
  opacity: {
    input: "inputs:opacity",
    inputType: "float",
    output: "outputs:a",
    outputType: "float",
    colorSpace: "raw",
  },
  roughness: {
    input: "inputs:roughness",
    inputType: "float",
    output: "outputs:r",
    outputType: "float",
    colorSpace: "raw",
  },
  metalness: {
    input: "inputs:metallic",
    inputType: "float",
    output: "outputs:r",
    outputType: "float",
    colorSpace: "raw",
  },
  occlusion: {
    input: "inputs:occlusion",
    inputType: "float",
    output: "outputs:r",
    outputType: "float",
    colorSpace: "raw",
  },
};

function buildMaterialPrim(name: string, material: ExportMaterial, selfPath: string): PrimSpec {
  const textures = material.textures ?? {};
  const shaderProps: PropertySpec[] = [uniformToken("info:id", "UsdPreviewSurface")];

  // A surface input: constant value, texture connection, or both (the
  // connection wins per UsdShade; the constant stays for flat consumers).
  const input = (channel: TextureChannel, value?: UsdValue) => {
    const wiring = TEXTURE_WIRING[channel];
    const texturePath = textures[channel];
    if (value === undefined && texturePath === undefined) return;
    const spec = attr(wiring.input, wiring.inputType, value);
    if (texturePath !== undefined) {
      spec.connections = [`${selfPath}/${channel}Texture.${wiring.output}`];
    }
    shaderProps.push(spec);
  };
  input("color", material.diffuseColor);
  input("metalness", material.metallic);
  input("roughness", material.roughness);
  input("opacity", material.opacity);
  input("emissive", material.emissiveColor);
  input("normal");
  input("occlusion");
  shaderProps.push(attr("outputs:surface", "token", undefined));

  const children: PrimSpec[] = [shaderPrim("PreviewSurface", shaderProps)];
  const textureEntries = Object.entries(textures) as [TextureChannel, string][];
  if (textureEntries.length > 0) {
    children.push(
      shaderPrim("stReader", [
        uniformToken("info:id", "UsdPrimvarReader_float2"),
        attr("inputs:varname", "string", "st"),
        attr("outputs:result", "float2", undefined),
      ]),
    );
    for (const [channel, path] of textureEntries) {
      children.push(buildUvTexturePrim(channel, path, selfPath));
    }
  }

  const surfaceConnect = attr("outputs:surface", "token", undefined);
  surfaceConnect.connections = [`${selfPath}/PreviewSurface.outputs:surface`];

  return {
    specifier: "def",
    typeName: "Material",
    name,
    metadata: {},
    properties: [surfaceConnect],
    children,
    line: 0,
  };
}

/** `UsdUVTexture` node for one channel, fed by the material's `stReader`. */
function buildUvTexturePrim(channel: TextureChannel, path: string, selfPath: string): PrimSpec {
  const wiring = TEXTURE_WIRING[channel];
  const st = attr("inputs:st", "float2", undefined);
  st.connections = [`${selfPath}/stReader.outputs:result`];
  return shaderPrim(`${channel}Texture`, [
    uniformToken("info:id", "UsdUVTexture"),
    attr("inputs:file", "asset", new AssetPath(path)),
    uniformToken("inputs:sourceColorSpace", wiring.colorSpace),
    st,
    attr(wiring.output, wiring.outputType, undefined),
  ]);
}

function shaderPrim(name: string, properties: PropertySpec[]): PrimSpec {
  return {
    specifier: "def",
    typeName: "Shader",
    name,
    metadata: {},
    properties,
    children: [],
    line: 0,
  };
}

/** `xformOp:transform` + `xformOpOrder` for an explicit matrix placement. */
function transformProps(m: Mat4): PropertySpec[] {
  return [
    attr("xformOp:transform", "matrix4d", toUsdMatrix(m)),
    arrayAttr("xformOpOrder", "token", ["xformOp:transform"], undefined, "uniform"),
  ];
}

// ---------------------------------------------------------------------------
// Joints
// ---------------------------------------------------------------------------

function buildJointPrim(
  name: string,
  key: string,
  joint: JointDescription,
  linkPath: (key: string) => string,
  isaac: boolean,
  warn: (m: string) => void,
): PrimSpec {
  const kind = driveKindFor(joint.type);
  const angular = kind === "angular";
  const properties: PropertySpec[] = [];
  const apiSchemas: string[] = [];

  if (joint.parent !== "") properties.push(rel("physics:body0", [linkPath(joint.parent)]));
  properties.push(rel("physics:body1", [linkPath(joint.child)]));
  if (joint.type !== "fixed") properties.push(uniformToken("physics:axis", joint.axis));
  if (joint.lower !== undefined) {
    properties.push(attr("physics:lowerLimit", "float", jointValueFromSI(angular, joint.lower)));
  }
  if (joint.upper !== undefined) {
    properties.push(attr("physics:upperLimit", "float", jointValueFromSI(angular, joint.upper)));
  }

  for (const index of [0, 1] as const) {
    const frame = index === 0 ? joint.jointFrame0 : joint.jointFrame1;
    const { position, orientation, rigid } = decomposeRigid(frame);
    if (!rigid) {
      warn(`joint "${key}": jointFrame${index} is not rigid; scale/shear was discarded`);
    }
    properties.push(attr(`physics:localPos${index}`, "point3f", position));
    properties.push(attr(`physics:localRot${index}`, "quatf", orientation));
  }

  // Joint state: the initial value and/or the sampled trajectory (SI → authored).
  if (joint.initialValue !== undefined || joint.valueSamples) {
    const state = attr(
      `state:${kind}:physics:position`,
      "float",
      joint.initialValue !== undefined ? jointValueFromSI(angular, joint.initialValue) : undefined,
    );
    if (joint.valueSamples) {
      state.timeSamples = new Map(
        joint.valueSamples.times.map((t, i) => [
          t,
          jointValueFromSI(angular, joint.valueSamples!.values[i] ?? 0),
        ]),
      );
    }
    properties.push(state);
    apiSchemas.push(`PhysicsJointStateAPI:${kind}`);
  }

  if (joint.drive) {
    const d = joint.drive;
    if (d.targetPosition !== undefined) {
      properties.push(
        attr(
          `drive:${kind}:physics:targetPosition`,
          "float",
          jointValueFromSI(angular, d.targetPosition),
        ),
      );
    }
    if (d.stiffness !== undefined) {
      properties.push(attr(`drive:${kind}:physics:stiffness`, "float", d.stiffness));
    }
    if (d.damping !== undefined) {
      properties.push(attr(`drive:${kind}:physics:damping`, "float", d.damping));
    }
    if (d.maxForce !== undefined) {
      properties.push(attr(`drive:${kind}:physics:maxForce`, "float", d.maxForce));
    }
    apiSchemas.push(`PhysicsDriveAPI:${kind}`);
  }

  if (isaac) {
    apiSchemas.push("IsaacJointAPI");
    if (joint.type !== "fixed") {
      const prefix = joint.type === "prismatic" ? "Trans" : "Rot";
      properties.push(
        arrayAttr("isaac:physics:DofOffsetOpOrder", "token", [`${prefix}${joint.axis}`]),
      );
    }
  }

  return {
    specifier: "def",
    typeName: JOINT_SCHEMA_BY_TYPE[joint.type],
    name,
    metadata: apiSchemas.length > 0 ? { apiSchemas } : {},
    properties,
    children: [],
    line: 0,
  };
}

// ---------------------------------------------------------------------------
// Naming & spec helpers
// ---------------------------------------------------------------------------

/** Make a valid USD identifier out of an arbitrary key (`/a/b c` → `_a_b_c`). */
function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  const named = cleaned.length > 0 ? cleaned : "_";
  return /^[0-9]/.test(named) ? `_${named}` : named;
}

/** Allocates unique sanitized sibling names, warning when a name changes. */
function nameAllocator(warn?: (m: string) => void): (raw: string, label?: string) => string {
  const used = new Set<string>();
  return (raw, label) => {
    let name = sanitizeName(raw);
    for (let i = 2; used.has(name); i++) name = `${sanitizeName(raw)}_${i}`;
    used.add(name);
    if (name !== raw && label && warn) warn(`${label} exported as prim "${name}"`);
    return name;
  };
}

function attr(
  name: string,
  typeName: string,
  value: UsdValue | undefined,
  metadata: MetadataMap = {},
): AttributeSpec {
  return {
    kind: "attribute",
    name,
    typeName,
    isArray: false,
    variability: "varying",
    custom: false,
    ...(value !== undefined ? { value } : {}),
    metadata,
    line: 0,
  };
}

function arrayAttr(
  name: string,
  typeName: string,
  value: UsdValue[],
  metadata: MetadataMap = {},
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
    metadata,
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
