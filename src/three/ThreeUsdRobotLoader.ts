import type { RobotDescription } from "../robot/RobotDescription.js";
import { extractRobotDescription } from "../robot/RobotExtractor.js";
import { buildKinematicTree } from "../robot/buildKinematicTree.js";
import { type AssetResolver, DefaultAssetResolver } from "../usd/AssetResolver.js";
import { Stage } from "../usd/Stage.js";
import { composeFile, composeLayer } from "../usd/composition.js";
import { CrateReader } from "../usd/crate/CrateReader.js";
import { crateToUsdaFile } from "../usd/crate/toUsdaFile.js";
import { openUsdz } from "../usd/usdz.js";
import { bindRobotMeshes } from "./MeshBinding.js";
import { createTextureProvider } from "./TextureBinding.js";
import { ThreeUsdRobot, type ThreeUsdRobotOptions } from "./ThreeUsdRobot.js";

export type ThreeUsdRobotLoaderOptions = {
  /** Resolver for references / payloads / sublayers (default {@link DefaultAssetResolver}). */
  assetResolver?: AssetResolver;
  /** Render visual meshes (M6). */
  loadVisuals?: boolean;
  /** Render collision meshes (M6). */
  loadCollisions?: boolean;
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
   * composed from their entries; everything else is treated as USDA text.
   */
  async loadAsync(url: string): Promise<ThreeUsdRobot> {
    if (/\.usdz$/i.test(url)) {
      return this.parseUsdz(await this.fetchRootBytes(url));
    }
    // Fetch bytes so we can detect a binary crate (`.usd` may be USDC or USDA).
    const bytes = await this.fetchRootBytes(url);
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
    const rootText = await pkg.resolver.fetchText(pkg.rootEntry);
    const stage = await this.composeStage(rootText, pkg.rootEntry, pkg.resolver);
    return this.buildFromStage(stage, pkg.rootEntry, pkg.resolver);
  }

  /** Build a robot from the bytes of a binary crate (`.usdc` / binary `.usd`). */
  async parseCrate(bytes: Uint8Array, baseUrl = ""): Promise<ThreeUsdRobot> {
    const file = crateToUsdaFile(new CrateReader(bytes));
    const composeOptions = this.options.onWarn ? { onWarn: this.options.onWarn } : {};
    const composed = await composeFile(file, baseUrl, this.resolver, composeOptions);
    return this.buildFromStage(Stage.OpenFromFile(composed), baseUrl, this.resolver);
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
    if (loadVisuals || loadCollisions) {
      const textureProvider =
        (this.options.loadTextures ?? true) ? createTextureProvider(resolver, baseUrl) : undefined;
      bindRobotMeshes(stage, robot3d, robot, {
        loadVisuals,
        loadCollisions,
        ...(textureProvider ? { textureProvider } : {}),
      });
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
