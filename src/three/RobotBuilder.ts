/**
 * Authoring API (M14): assemble a robot from Three.js objects and export it.
 *
 * Links and joints are declared by name. Every joint takes **one** world-space
 * frame; both body-local joint frames derive from it —
 * `frame0 = linkWorld(parent)⁻¹ · frame`, `frame1 = linkWorld(child)⁻¹ · frame`
 * — so the arrangement at build time is the robot's zero pose. Values are SI
 * (radians / stage linear units); the exporter converts to authored units on
 * write. World matrices are captured at `addLink`/`add*Joint` time.
 */

import * as THREE from "three";
import type {
  CollisionApproximation,
  ExportMaterial,
  ExportMesh,
  ExportPhysicsMaterial,
  RobotGeometryProvider,
} from "../export/GeometryProvider.js";
import { type ExportRobotOptions, exportRobotUsda } from "../export/exportRobot.js";
import { type Mat4, identity4, invert, multiply } from "../kinematics/transforms.js";
import type { UsdaFile } from "../parser/ast.js";
import type {
  Axis,
  JointDescription,
  JointDriveDescription,
  JointType,
  LinkDescription,
  LinkInertialDescription,
  RobotDescription,
} from "../robot/RobotDescription.js";
import { type KinematicTree, buildKinematicTree } from "../robot/buildKinematicTree.js";
import { refineJointType } from "../robot/normalize.js";
import { geometryToExportMesh, materialToExportMaterial } from "./exportThreeUsdRobot.js";

/** A world-space frame: a matrix, or an object whose `matrixWorld` is used. */
export type WorldFrame = THREE.Matrix4 | THREE.Object3D;

export type RobotBuilderOptions = {
  name: string;
  /** Stage up axis; defaults to `"Z"` (Isaac Sim convention). */
  upAxis?: "Y" | "Z";
  /** Stage linear unit; defaults to `1` (meters). */
  metersPerUnit?: number;
  /** Link to flag with `PhysicsArticulationRootAPI` (default: the container prim). */
  articulationRoot?: string;
  onWarn?: (message: string) => void;
};

export type AddLinkOptions = {
  name: string;
  /** Link frame in world space at build pose (default identity). */
  frame?: WorldFrame;
  /** Objects whose `THREE.Mesh` descendants become the link's visual meshes. */
  visuals?: THREE.Object3D[];
  /** Objects whose `THREE.Mesh` descendants become collision meshes. */
  collisions?: THREE.Object3D[];
  /** Mass properties, exported as `PhysicsMassAPI` (M16). */
  inertial?: LinkInertialDescription;
  /** `physics:approximation` applied to this link's collision meshes (M16). */
  collisionApproximation?: CollisionApproximation;
  /** Physics material bound to this link's collision meshes (M16). */
  physicsMaterial?: ExportPhysicsMaterial;
};

export type AddJointOptions = {
  name: string;
  /** Parent link name; omit to fix the child to the world. */
  parent?: string;
  child: string;
  /** Joint frame in world space (default: the child link's frame). */
  frame?: WorldFrame;
  /** Rotation / sliding axis token in the joint frame (default `"X"`). */
  axis?: Axis;
  /** Limits in SI: radians (revolute) or stage linear units (prismatic). */
  lower?: number;
  upper?: number;
  /** Initial joint value in SI, exported as `PhysicsJointStateAPI`. */
  initialValue?: number;
  drive?: JointDriveDescription;
};

type PendingJoint = {
  type: JointType;
  options: AddJointOptions;
  /** Joint frame world matrix captured at add time (undefined → child frame). */
  world?: Mat4;
};

export class RobotBuilder {
  private readonly robotName: string;
  private readonly upAxis: "Y" | "Z";
  private readonly metersPerUnit: number;
  private readonly articulationRoot?: string;
  private readonly warn: (message: string) => void;

  private readonly links = new Map<
    string,
    { world: Mat4; meshes: ExportMesh[]; inertial?: LinkInertialDescription }
  >();
  private readonly joints = new Map<string, PendingJoint>();
  private readonly materialCache = new Map<THREE.Material, ExportMaterial | undefined>();
  private materialAutoId = 0;

  constructor(options: RobotBuilderOptions) {
    this.robotName = options.name;
    this.upAxis = options.upAxis ?? "Z";
    this.metersPerUnit = options.metersPerUnit ?? 1;
    if (options.articulationRoot !== undefined) this.articulationRoot = options.articulationRoot;
    this.warn = options.onWarn ?? (() => {});
  }

  addLink(options: AddLinkOptions): this {
    if (this.links.has(options.name)) {
      throw new Error(`RobotBuilder: link "${options.name}" is already defined`);
    }
    const world = resolveFrame(options.frame) ?? identity4();
    const collisionExtras = {
      ...(options.collisionApproximation !== undefined
        ? { approximation: options.collisionApproximation }
        : {}),
      ...(options.physicsMaterial ? { material: options.physicsMaterial } : {}),
    };
    const meshes = [
      ...this.gatherMeshes(options.visuals ?? [], world, "visual"),
      ...this.gatherMeshes(options.collisions ?? [], world, "collision", collisionExtras),
    ];
    this.links.set(options.name, {
      world,
      meshes,
      ...(options.inertial ? { inertial: options.inertial } : {}),
    });
    return this;
  }

  addFixedJoint(options: Omit<AddJointOptions, "axis" | "lower" | "upper">): this {
    return this.addJoint("fixed", options);
  }

  addRevoluteJoint(options: AddJointOptions): this {
    return this.addJoint("revolute", options);
  }

  addPrismaticJoint(options: AddJointOptions): this {
    return this.addJoint("prismatic", options);
  }

  private addJoint(type: JointType, options: AddJointOptions): this {
    if (this.joints.has(options.name)) {
      throw new Error(`RobotBuilder: joint "${options.name}" is already defined`);
    }
    const world = resolveFrame(options.frame);
    this.joints.set(options.name, { type, options, ...(world ? { world } : {}) });
    return this;
  }

  /** Assemble the IR + geometry provider (validates the kinematic graph). */
  build(): { desc: RobotDescription; geometry: RobotGeometryProvider; tree: KinematicTree } {
    const links: Record<string, LinkDescription> = {};
    for (const [name, link] of this.links) {
      links[name] = {
        name,
        primPath: `/${this.robotName}/${name}`,
        visualPrims: [],
        ...(link.inertial ? { inertial: link.inertial } : {}),
        // Authored placement, so links no joint reaches keep their build pose.
        ...(isIdentityMat4(link.world) ? {} : { worldTransform: link.world }),
      };
    }

    const joints: Record<string, JointDescription> = {};
    for (const [name, pending] of this.joints) {
      const { options } = pending;
      const parent = options.parent ?? "";
      if (parent !== "" && !this.links.has(parent)) {
        throw new Error(`RobotBuilder: joint "${name}" references unknown parent "${parent}"`);
      }
      const childLink = this.links.get(options.child);
      if (!childLink) {
        throw new Error(
          `RobotBuilder: joint "${name}" references unknown child "${options.child}"`,
        );
      }

      const jointWorld = pending.world ?? childLink.world;
      const parentWorld = parent === "" ? identity4() : this.links.get(parent)!.world;
      const type = refineJointType(pending.type, options.lower, options.upper);

      joints[name] = {
        name,
        primPath: `/${this.robotName}/${name}`,
        type,
        parent,
        child: options.child,
        axis: options.axis ?? "X",
        jointFrame0: multiply(invert(parentWorld), jointWorld),
        jointFrame1: multiply(invert(childLink.world), jointWorld),
        ...(options.lower !== undefined ? { lower: options.lower } : {}),
        ...(options.upper !== undefined ? { upper: options.upper } : {}),
        ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
        ...(options.drive ? { drive: options.drive } : {}),
      };
    }

    if (this.articulationRoot !== undefined && !this.links.has(this.articulationRoot)) {
      throw new Error(`RobotBuilder: articulationRoot "${this.articulationRoot}" is not a link`);
    }

    const desc: RobotDescription = {
      name: this.robotName,
      rootLink: "",
      links,
      joints,
      upAxis: this.upAxis,
      metersPerUnit: this.metersPerUnit,
      ...(this.articulationRoot !== undefined
        ? { articulationRoots: [this.articulationRoot] }
        : {}),
    };

    const tree = buildKinematicTree(desc, { onWarn: this.warn });
    desc.rootLink = tree.root;
    if (tree.loopJoints.length > 0) desc.loopJoints = tree.loopJoints;
    if (tree.warnings.length > 0) desc.warnings = tree.warnings;

    const byLink = this.links;
    const geometry: RobotGeometryProvider = (linkKey) => byLink.get(linkKey)?.meshes ?? [];
    return { desc, geometry, tree };
  }

  /** Build and export in one step (pass the result to `serializeUsda`). */
  toUsda(options: Omit<ExportRobotOptions, "geometry"> = {}): UsdaFile {
    const { desc, geometry } = this.build();
    return exportRobotUsda(desc, { onWarn: this.warn, ...options, geometry });
  }

  /** Collect `THREE.Mesh` descendants of `roots` as link-relative export meshes. */
  private gatherMeshes(
    roots: THREE.Object3D[],
    linkWorld: Mat4,
    kind: "visual" | "collision",
    collisionExtras: {
      approximation?: CollisionApproximation;
      material?: ExportPhysicsMaterial;
    } = {},
  ): ExportMesh[] {
    const linkInverse = invert(linkWorld);
    const out: ExportMesh[] = [];
    for (const root of roots) {
      root.updateWorldMatrix(true, true);
      root.traverse((obj) => {
        const meshObj = obj as THREE.Mesh;
        if (!meshObj.isMesh) return;
        const material = Array.isArray(meshObj.material) ? meshObj.material[0] : meshObj.material;
        if (Array.isArray(meshObj.material) && meshObj.material.length > 1) {
          this.warn(
            `mesh "${meshObj.name}": multi-material meshes export their first material only`,
          );
        }
        const exportMaterial = material ? this.convertMaterial(material) : undefined;
        const mesh = geometryToExportMesh(meshObj.geometry, {
          name: meshObj.name || "mesh",
          kind,
          transform: multiply(linkInverse, [...meshObj.matrixWorld.elements]),
          ...(exportMaterial ? { material: exportMaterial } : {}),
          doubleSided: material?.side === THREE.DoubleSide,
        });
        if (mesh) {
          if (kind === "collision") {
            if (collisionExtras.approximation !== undefined) {
              mesh.collisionApproximation = collisionExtras.approximation;
            }
            if (collisionExtras.material) mesh.physicsMaterial = collisionExtras.material;
          }
          out.push(mesh);
        } else {
          this.warn(`mesh "${meshObj.name}": no triangle geometry; skipped`);
        }
      });
    }
    return out;
  }

  private convertMaterial(material: THREE.Material): ExportMaterial | undefined {
    if (!this.materialCache.has(material)) {
      const name = material.name || `Material_${this.materialAutoId++}`;
      this.materialCache.set(material, materialToExportMaterial(material, name, this.warn));
    }
    return this.materialCache.get(material);
  }
}

function isIdentityMat4(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) {
    if (m[i] !== (i % 5 === 0 ? 1 : 0)) return false;
  }
  return true;
}

/** World matrix of a frame argument (`matrixWorld` refreshed for objects). */
function resolveFrame(frame: WorldFrame | undefined): Mat4 | undefined {
  if (!frame) return undefined;
  if ((frame as THREE.Object3D).isObject3D) {
    const obj = frame as THREE.Object3D;
    obj.updateWorldMatrix(true, false);
    return [...obj.matrixWorld.elements];
  }
  return [...(frame as THREE.Matrix4).elements];
}
