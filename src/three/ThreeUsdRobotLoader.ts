import type { RobotDescription } from "../robot/RobotDescription.js";
import { extractRobotDescription } from "../robot/RobotExtractor.js";
import { buildKinematicTree } from "../robot/buildKinematicTree.js";
import { isUnsupportedGprim } from "../schemas/usdGeom.js";
import { type AssetResolver, DefaultAssetResolver } from "../usd/AssetResolver.js";
import { Stage } from "../usd/Stage.js";
import { type BinarySource, type UsdSource, toBytes } from "../usd/bytes.js";
import { composeFile, composeLayer } from "../usd/composition.js";
import { CrateReader } from "../usd/crate/CrateReader.js";
import { crateToUsdaFile } from "../usd/crate/toUsdaFile.js";
import { loadMdlModules } from "../usd/mdl/loadMdlModules.js";
import { isZip, openUsdz } from "../usd/usdz.js";
import { bindRobotMeshes, bindSceneMeshes } from "./MeshBinding.js";
import { createTextureProvider } from "./TextureBinding.js";
import { ThreeUsdRobot, type ThreeUsdRobotOptions, type WorldUpAxis } from "./ThreeUsdRobot.js";

export type ThreeUsdRobotLoaderOptions = {
  /** Resolver for references / payloads / sublayers (default {@link DefaultAssetResolver}). */
  assetResolver?: AssetResolver;
  /** Render visual meshes (M6). */
  loadVisuals?: boolean;
  /** Render collision meshes (M6). */
  loadCollisions?: boolean;
  /**
   * Also render gprims that belong to no link — the static scenery of a cell
   * that contains robots (floor, guarding, racking, …). Placed by their
   * authored stage transform. Default `false`; a stage with no articulation at
   * all (a pure static scene) defaults to `true` so it renders out of the box.
   */
  loadSceneGeometry?: boolean;
  /** Load diffuse textures referenced by materials (default `true`). */
  loadTextures?: boolean;
  /**
   * Render `BasisCurves` that author `widths` as tube meshes instead of
   * 1-px lines (default `false`, M18).
   */
  curveTubes?: boolean;
  /**
   * Target world up-axis. Any stage (Y-up or Z-up) is normalized into this
   * convention: `"Y"` for a standard three.js scene (the default behavior),
   * `"Z"` for a robotics-style Z-up world, `"keep"` to leave the authored
   * orientation. Takes precedence over {@link upAxisConversion}.
   */
  worldUp?: WorldUpAxis;
  /**
   * Legacy up-axis correction (M9). Default `"auto"` ≡ `worldUp: "Y"`.
   * @deprecated Use {@link worldUp}.
   */
  upAxisConversion?: "auto" | "Y" | "Z" | "none";
  /** Extra uniform scale multiplied with `metersPerUnit` (M9). */
  unitScale?: number;
  /** Clamp `setJointValue` to authored limits (default `true`). */
  clampJointLimits?: boolean;
  /** Seed joints from drive targets / joint state (M9). */
  applyDriveTargetsAsInitialPose?: boolean;
  /** Override the robot name. */
  robotName?: string;
  /** Receives non-fatal load diagnostics. */
  onWarn?: (message: string) => void;
};

/** A composed stage plus the context needed to bind its meshes and textures. */
type OpenedStage = { stage: Stage; baseUrl: string; resolver: AssetResolver };

/**
 * Loads Isaac Sim / OpenUSD robot assets into a controllable {@link ThreeUsdRobot}.
 *
 * Assets load by URL ({@link loadAsync}) or from in-memory content
 * ({@link parse} — USDA text, `ArrayBuffer`, typed array, or `Blob`/`File`).
 * Composition (references / payloads / sublayers, M8) is resolved through an
 * {@link AssetResolver}. Mesh rendering is M6; unit / up-axis / initial-pose
 * handling is M9; USDC and variants are M10.
 */
export class ThreeUsdRobotLoader {
  readonly options: ThreeUsdRobotLoaderOptions;

  constructor(options: ThreeUsdRobotLoaderOptions = {}) {
    this.options = options;
  }

  private get resolver(): AssetResolver {
    return this.options.assetResolver ?? new DefaultAssetResolver();
  }

  /**
   * Fetch an asset by URL and build the robot. `.usdz` packages are unzipped and
   * composed from their entries; everything else is sniffed for the zip / crate
   * magic and parsed as USDZ, binary USDC, or USDA text.
   */
  async loadAsync(url: string): Promise<ThreeUsdRobot> {
    const bytes = await this.fetchRootBytes(url);
    // Extension first: sniffing only sees offset 0, the extension also covers
    // zip archives with a prefix (fflate reads the central directory anyway).
    if (/\.usdz$/i.test(url)) return this.parseUsdz(bytes);
    return this.parse(bytes, url);
  }

  private async fetchRootBytes(url: string): Promise<Uint8Array> {
    const resolver = this.resolver;
    if (resolver.fetchBytes) return resolver.fetchBytes(url);
    return new TextEncoder().encode(await resolver.fetchText(url));
  }

  /**
   * Build a robot from in-memory content — no fetch involved. Accepts USDA
   * source text, or an `ArrayBuffer` / typed array / `Blob` (e.g. a dropped
   * `File`) holding USDA text, a binary crate, or a `.usdz` package; binary
   * input is sniffed for the zip / crate magic. `baseUrl` anchors relative
   * references, payloads, and texture paths of non-package input.
   */
  async parse(data: UsdSource, baseUrl = ""): Promise<ThreeUsdRobot> {
    return this.buildFromStage(await this.openSource(data, baseUrl));
  }

  /** Build a robot from a `.usdz` package (bytes, `ArrayBuffer`, or `Blob`). */
  async parseUsdz(data: BinarySource): Promise<ThreeUsdRobot> {
    return this.buildFromStage(await this.openUsdzStage(await toBytes(data)));
  }

  /** Build a robot from a binary crate (`.usdc` / binary `.usd`). */
  async parseCrate(data: BinarySource, baseUrl = ""): Promise<ThreeUsdRobot> {
    const stage = await this.composeStageFromBytes(await toBytes(data), baseUrl, this.resolver);
    return this.buildFromStage({ stage, baseUrl, resolver: this.resolver });
  }

  /**
   * Parse + compose in-memory content (same formats as {@link parse}) into the
   * Three.js-independent robot IR.
   */
  async parseRobotDescription(data: UsdSource, baseUrl = ""): Promise<RobotDescription> {
    const { stage } = await this.openSource(data, baseUrl);
    return extractRobotDescription(stage, this.extractOptions());
  }

  /** Sniff in-memory content (text / zip / crate) and compose it into a stage. */
  private async openSource(data: UsdSource, baseUrl: string): Promise<OpenedStage> {
    const resolver = this.resolver;
    if (typeof data === "string") {
      return { stage: await this.composeStage(data, baseUrl, resolver), baseUrl, resolver };
    }
    const bytes = await toBytes(data);
    if (isZip(bytes)) return this.openUsdzStage(bytes);
    const stage = CrateReader.isCrate(bytes)
      ? await this.composeStageFromBytes(bytes, baseUrl, resolver)
      : await this.composeStage(new TextDecoder().decode(bytes), baseUrl, resolver);
    return { stage, baseUrl, resolver };
  }

  private async openUsdzStage(bytes: Uint8Array): Promise<OpenedStage> {
    const pkg = openUsdz(bytes);
    // The root layer of a usdz is typically binary USDC — sniff, don't assume text.
    const rootBytes = await pkg.resolver.fetchBytes(pkg.rootEntry);
    const stage = await this.composeStageFromBytes(rootBytes, pkg.rootEntry, pkg.resolver);
    return { stage, baseUrl: pkg.rootEntry, resolver: pkg.resolver };
  }

  private async buildFromStage({ stage, baseUrl, resolver }: OpenedStage): Promise<ThreeUsdRobot> {
    const robot = extractRobotDescription(stage, this.extractOptions());
    const tree = buildKinematicTree(robot);
    const robot3d = new ThreeUsdRobot(robot, tree, this.robotOptions());
    robot3d.stage = stage;

    const loadVisuals = this.options.loadVisuals ?? true;
    const loadCollisions = this.options.loadCollisions ?? false;
    // A stage with no articulation at all is a pure static scene; default to
    // drawing its geometry — otherwise the load would be silently empty.
    const isStaticScene =
      Object.keys(robot.links).length === 0 && Object.keys(robot.joints).length === 0;
    if (isStaticScene && this.options.loadSceneGeometry === undefined) {
      this.options.onWarn?.(
        "no articulation found (0 links / 0 joints); rendering the stage as static scene geometry",
      );
    }
    const loadScene = this.options.loadSceneGeometry ?? isStaticScene;
    if (loadVisuals || loadCollisions || loadScene) {
      const textureProvider =
        (this.options.loadTextures ?? true) ? createTextureProvider(resolver, baseUrl) : undefined;
      const curveTubes = this.options.curveTubes ?? false;
      const onWarn = this.options.onWarn;
      // Prefetch referenced `.mdl` modules (M20) — wrapper materials often
      // carry the whole look while the USD shader authors no inputs at all.
      const mdl = await loadMdlModules(stage, resolver, baseUrl);
      if (loadVisuals || loadCollisions) {
        bindRobotMeshes(stage, robot3d, robot, {
          loadVisuals,
          loadCollisions,
          ...(textureProvider ? { textureProvider } : {}),
          ...(curveTubes ? { curveTubes } : {}),
          ...(onWarn ? { onWarn } : {}),
          ...(mdl ? { mdl } : {}),
        });
      }
      if (loadScene) {
        bindSceneMeshes(stage, robot3d, robot, {
          ...(textureProvider ? { textureProvider } : {}),
          ...(curveTubes ? { curveTubes } : {}),
          ...(onWarn ? { onWarn } : {}),
          ...(mdl ? { mdl } : {}),
        });
      }
      this.warnUnsupportedGprims(stage);
    }
    return robot3d;
  }

  /** Surface recognized-but-unrenderable gprim schemas instead of silence (M18). */
  private warnUnsupportedGprims(stage: Stage): void {
    const firstByType = new Map<string, string>();
    for (const prim of stage.Traverse()) {
      const type = prim.GetTypeName();
      if (isUnsupportedGprim(prim) && !firstByType.has(type)) {
        firstByType.set(type, prim.GetPath());
      }
    }
    for (const [type, path] of firstByType) {
      this.options.onWarn?.(`${type} gprims are not supported yet; skipping (e.g. ${path})`);
    }
  }

  private async composeStage(
    text: string,
    baseUrl: string,
    resolver: AssetResolver,
  ): Promise<Stage> {
    const composeOptions = this.options.onWarn ? { onWarn: this.options.onWarn } : {};
    return Stage.OpenFromFile(await composeLayer(text, baseUrl, resolver, composeOptions));
  }

  /** Compose a layer from raw bytes, sniffing binary crate vs USDA text. */
  private async composeStageFromBytes(
    bytes: Uint8Array,
    baseUrl: string,
    resolver: AssetResolver,
  ): Promise<Stage> {
    const composeOptions = this.options.onWarn ? { onWarn: this.options.onWarn } : {};
    const composed = CrateReader.isCrate(bytes)
      ? await composeFile(
          crateToUsdaFile(new CrateReader(bytes)),
          baseUrl,
          resolver,
          composeOptions,
        )
      : await composeLayer(new TextDecoder().decode(bytes), baseUrl, resolver, composeOptions);
    return Stage.OpenFromFile(composed);
  }

  private robotOptions(): ThreeUsdRobotOptions {
    return {
      ...(this.options.worldUp
        ? { worldUp: this.options.worldUp }
        : { upAxisConversion: this.options.upAxisConversion ?? "auto" }),
      ...(this.options.clampJointLimits !== undefined
        ? { clampJointLimits: this.options.clampJointLimits }
        : {}),
      ...(this.options.unitScale !== undefined ? { unitScale: this.options.unitScale } : {}),
      ...(this.options.applyDriveTargetsAsInitialPose !== undefined
        ? { applyInitialPose: this.options.applyDriveTargetsAsInitialPose }
        : {}),
    };
  }

  private extractOptions(): { robotName?: string; onWarn?: (message: string) => void } {
    return {
      ...(this.options.robotName !== undefined ? { robotName: this.options.robotName } : {}),
      ...(this.options.onWarn !== undefined ? { onWarn: this.options.onWarn } : {}),
    };
  }
}
