/**
 * Three.js-side export (M14).
 *
 * Converts `BufferGeometry` / `MeshStandardMaterial` into the plain
 * {@link ExportMesh} data the exporter consumes, harvests the meshes attached
 * under a loaded robot's links, and re-exports a {@link ThreeUsdRobot} as a
 * USDA AST. Texture maps are not carried yet (M15) — constants only.
 */

import * as THREE from "three";
import type {
  ExportMaterial,
  ExportMesh,
  RobotGeometryProvider,
} from "../export/GeometryProvider.js";
import { stageGeometryProvider } from "../export/GeometryProvider.js";
import { type ExportRobotOptions, exportRobotUsda } from "../export/exportRobot.js";
import type { Mat4 } from "../kinematics/transforms.js";
import type { UsdaFile, Vec2, Vec3 } from "../parser/ast.js";
import type { Stage } from "../usd/Stage.js";
import type { ThreeUsdRobot } from "./ThreeUsdRobot.js";

export type GeometryToExportMeshOptions = {
  name: string;
  kind?: "visual" | "collision";
  /** Transform relative to the link frame (column-major); identity when omitted. */
  transform?: Mat4;
  material?: ExportMaterial;
  doubleSided?: boolean;
};

/**
 * Convert a triangle `BufferGeometry` into exportable mesh data. Non-indexed
 * geometry becomes sequential triangles; a trailing partial triangle (or the
 * absence of a position attribute) returns `null`.
 */
export function geometryToExportMesh(
  geometry: THREE.BufferGeometry,
  options: GeometryToExportMeshOptions,
): ExportMesh | null {
  const position = geometry.getAttribute("position");
  if (!position || position.count === 0) return null;

  const points: Vec3[] = [];
  for (let i = 0; i < position.count; i++) {
    points.push([position.getX(i), position.getY(i), position.getZ(i)]);
  }

  const index = geometry.getIndex();
  let faceVertexIndices = index
    ? Array.from(index.array as ArrayLike<number>)
    : points.map((_, i) => i);
  const triangles = Math.floor(faceVertexIndices.length / 3);
  if (triangles === 0) return null;
  faceVertexIndices = faceVertexIndices.slice(0, triangles * 3);

  const mesh: ExportMesh = {
    name: options.name,
    kind: options.kind ?? "visual",
    points,
    faceVertexCounts: new Array(triangles).fill(3),
    faceVertexIndices,
  };

  const normal = geometry.getAttribute("normal");
  if (normal && normal.count === position.count) {
    const normals: Vec3[] = [];
    for (let i = 0; i < normal.count; i++) {
      normals.push([normal.getX(i), normal.getY(i), normal.getZ(i)]);
    }
    mesh.normals = normals;
  }
  const uv = geometry.getAttribute("uv");
  if (uv && uv.count === position.count) {
    const st: Vec2[] = [];
    for (let i = 0; i < uv.count; i++) st.push([uv.getX(i), uv.getY(i)]);
    mesh.st = st;
  }

  if (options.transform && !isIdentityMat4(options.transform)) mesh.transform = options.transform;
  if (options.material) mesh.material = options.material;
  if (options.doubleSided) mesh.doubleSided = true;
  return mesh;
}

/**
 * Extract constant PBR parameters from a Three.js material. Only
 * `MeshStandardMaterial` maps onto `UsdPreviewSurface`; anything else returns
 * `undefined` (with a warning). Texture maps are reported but not carried.
 */
export function materialToExportMaterial(
  material: THREE.Material,
  name: string,
  onWarn?: (message: string) => void,
): ExportMaterial | undefined {
  const std = material as THREE.MeshStandardMaterial;
  if (!std.isMeshStandardMaterial) {
    onWarn?.(`material "${name}": only MeshStandardMaterial exports to UsdPreviewSurface; skipped`);
    return undefined;
  }
  if (
    std.map ||
    std.normalMap ||
    std.roughnessMap ||
    std.metalnessMap ||
    std.aoMap ||
    std.emissiveMap ||
    std.alphaMap
  ) {
    onWarn?.(
      `material "${name}": texture maps are not carried from Three.js materials (image extraction is app-side); constants only`,
    );
  }

  const out: ExportMaterial = {
    name,
    diffuseColor: [std.color.r, std.color.g, std.color.b],
    metallic: std.metalness,
    roughness: std.roughness,
  };
  if (std.transparent && std.opacity < 1) out.opacity = std.opacity;
  if (std.emissive.r > 0 || std.emissive.g > 0 || std.emissive.b > 0) {
    out.emissiveColor = [std.emissive.r, std.emissive.g, std.emissive.b];
  }
  return out;
}

/**
 * Provider over the meshes `bindRobotMeshes` attached under each link of a
 * loaded robot (direct children tagged `userData.kind`), with their link-local
 * transforms and materials.
 */
export function threeGeometryProvider(
  robot: ThreeUsdRobot,
  onWarn?: (message: string) => void,
): RobotGeometryProvider {
  const materialNames = new Map<THREE.Material, ExportMaterial | undefined>();
  let autoId = 0;
  const convertMaterial = (material: THREE.Material): ExportMaterial | undefined => {
    if (!materialNames.has(material)) {
      const name = material.name || `Material_${autoId++}`;
      materialNames.set(material, materialToExportMaterial(material, name, onWarn));
    }
    return materialNames.get(material);
  };

  return (linkKey) => {
    const linkObj = robot.getLinkObject(linkKey);
    if (!linkObj) return [];

    const out: ExportMesh[] = [];
    for (const childObj of linkObj.children) {
      const meshObj = childObj as THREE.Mesh;
      if (!meshObj.isMesh) continue;
      const material = Array.isArray(meshObj.material) ? meshObj.material[0] : meshObj.material;
      if (Array.isArray(meshObj.material) && meshObj.material.length > 1) {
        onWarn?.(`mesh "${meshObj.name}": multi-material meshes export their first material only`);
      }
      const exportMaterial = material ? convertMaterial(material) : undefined;
      const mesh = geometryToExportMesh(meshObj.geometry, {
        name: meshObj.name || "mesh",
        kind: meshObj.userData.kind === "collision" ? "collision" : "visual",
        transform: [...meshObj.matrix.elements],
        ...(exportMaterial ? { material: exportMaterial } : {}),
        doubleSided: material?.side === THREE.DoubleSide,
      });
      if (mesh) out.push(mesh);
    }
    return out;
  };
}

export type ExportThreeUsdRobotOptions = Omit<ExportRobotOptions, "geometry"> & {
  /** Re-read mesh data from the source stage instead of the Three.js scene. */
  stage?: Stage;
};

/** Export a loaded robot back to a USDA AST (pass the result to `serializeUsda`). */
export function exportThreeUsdRobot(
  robot: ThreeUsdRobot,
  options: ExportThreeUsdRobotOptions = {},
): UsdaFile {
  const { stage, ...rest } = options;
  const geometry = stage
    ? stageGeometryProvider(stage)
    : threeGeometryProvider(robot, options.onWarn);
  return exportRobotUsda(robot.robot, { ...rest, geometry });
}

function isIdentityMat4(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) {
    if (m[i] !== (i % 5 === 0 ? 1 : 0)) return false;
  }
  return true;
}
