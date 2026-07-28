import type { RobotDescription } from "../robot/RobotDescription.js";
import { extractRobotDescription } from "../robot/RobotExtractor.js";
import { buildKinematicTree } from "../robot/buildKinematicTree.js";
import { type AssetResolver, DefaultAssetResolver } from "../usd/AssetResolver.js";
import { Stage } from "../usd/Stage.js";
import { composeFile, composeLayer } from "../usd/composition.js";
import { CrateReader } from "../usd/crate/CrateReader.js";
import { crateToUsdaFile } from "../usd/crate/toUsdaFile.js";
import { openUsdz } from "../usd/usdz.js";
import { bindRobotMeshes, bindSceneMeshes } from "./MeshBinding.js";
import { createTextureProvider } from "./TextureBinding.js";
import { ThreeUsdRobot, type ThreeUsdRobotOptions } from "./ThreeUsdRobot.js";

export type ThreeUsdRobotLoaderOptions = {
  /** Resolver for references / payloads / sublayers (default {@link DefaultAssetResolver}). */
  assetResolver?: AssetResolver;
  /** Render visual meshes (M6). */
  loadVisuals?: boolean;
  /** Render collision meshes (M6). */
  loadCollisions?: boolean;
  /**
   * Also render Mesh prims that belong to no link — the static scenery of a
   * cell that contains robots (floor, guarding, racking, …). Placed by their
   * authored stage transform. Default `false`.
   */
  loadSceneGeometry?: boolean;
  /** Load diffuse textures referenced by materials (default `true`). */
  loadTextures?: boolean;
  /** Up-axis correction strategy (M9). */
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

/**
 * Loads Isaac Sim / OpenUSD robot assets into a controllable {@link ThreeUsdRobot}.
 *
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
   * composed from their entries; everything else is sniffed for the crate magic
   * and parsed as binary USDC or USDA text.
   */
  async loadAsync(url: string): Promise<ThreeUsdRobot> {
    const bytes = await this.fetchRootBytes(url);
    if (/\.usdz$/i.test(url)) return this.parseUsdz(bytes);
    if (CrateReader.isCrate(bytes)) return this.parseCrate(bytes, url);
    return this.parse(new TextDecoder().decode(bytes), url);
  }

  private async fetchRootBytes(url: string): Promise<Uint8Array> {
    const resolver = this.resolver;
    if (resolver.fetchBytes) return resolver.fetchBytes(url);
    return new TextEncoder().encode(await resolver.fetchText(url));
  }

  /** Build a robot (composed, with meshes) from USDA source text. */
  async parse(text: string, baseUrl = ""): Promise<ThreeUsdRobot> {
    return this.buildFromStage(
      await this.composeStage(text, baseUrl, this.resolver),
      baseUrl,
      this.resolver,
    );
  }

  /** Build a robot from the bytes of a `.usdz` package. */
  async parseUsdz(bytes: Uint8Array): Promise<ThreeUsdRobot> {
    const pkg = openUsdz(bytes);
    // The root layer of a usdz is typically binary USDC — sniff, don't assume text.
    const rootBytes = await pkg.resolver.fetchBytes(pkg.rootEntry);
    const stage = await this.composeStageFromBytes(rootBytes, pkg.rootEntry, pkg.resolver);
    return this.buildFromStage(stage, pkg.rootEntry, pkg.resolver);
  }

  /** Build a robot from the bytes of a binary crate (`.usdc` / binary `.usd`). */
  async parseCrate(bytes: Uint8Array, baseUrl = ""): Promise<ThreeUsdRobot> {
    const stage = await this.composeStageFromBytes(bytes, baseUrl, this.resolver);
    return this.buildFromStage(stage, baseUrl, this.resolver);
  }

  /** Parse + compose USDA source into the Three.js-independent robot IR. */
  async parseRobotDescription(text: string, baseUrl = ""): Promise<RobotDescription> {
    const stage = await this.composeStage(text, baseUrl, this.resolver);
    return extractRobotDescription(stage, this.extractOptions());
  }

  private buildFromStage(stage: Stage, baseUrl: string, resolver: AssetResolver): ThreeUsdRobot {
    const robot = extractRobotDescription(stage, this.extractOptions());
    const tree = buildKinematicTree(robot);
    const robot3d = new ThreeUsdRobot(robot, tree, this.robotOptions());

    const loadVisuals = this.options.loadVisuals ?? true;
    const loadCollisions = this.options.loadCollisions ?? false;
    const loadScene = this.options.loadSceneGeometry ?? false;
    if (loadVisuals || loadCollisions || loadScene) {
      const textureProvider =
        (this.options.loadTextures ?? true) ? createTextureProvider(resolver, baseUrl) : undefined;
      if (loadVisuals || loadCollisions) {
        bindRobotMeshes(stage, robot3d, robot, {
          loadVisuals,
          loadCollisions,
          ...(textureProvider ? { textureProvider } : {}),
        });
      }
      if (loadScene) {
        bindSceneMeshes(stage, robot3d, robot, {
          ...(textureProvider ? { textureProvider } : {}),
        });
      }
    }
    return robot3d;
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
      upAxisConversion: this.options.upAxisConversion ?? "auto",
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
