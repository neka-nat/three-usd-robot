/**
 * Controller-ray link picking: {@link pickLink} along a controller's target
 * ray every frame, with hover changes and the WebXR `select` event (the
 * trigger) turned into a `select` on the hovered link. Nothing here depends
 * on the input device beyond "an Object3D whose −Z is the ray" — a hand's
 * pointer space or a desktop debugging object work the same.
 */

import * as THREE from "three";
import type { LinkMeshKind } from "../helpers/appearance.js";
import { type LinkPick, pickLink } from "../helpers/picking.js";
import type { ThreeUsdRobot } from "../three/ThreeUsdRobot.js";
import { onXrInput } from "./events.js";

export type XrRayPickerEventMap = {
  /** The hovered link changed (`hit` is `null` when the ray left every link). */
  hover: { hit: LinkPick | null };
  /** The select event fired while a link was hovered. */
  select: { hit: LinkPick };
};

export type XrRayPickerOptions = {
  /** Mesh kinds that count (default `["visual"]`). */
  kinds?: LinkMeshKind[];
  /** Ray length in world units (default `10`); see {@link XrRayPicker.maxDistance}. */
  maxDistance?: number;
  /** Which controller event commits a selection (default `"select"` — trigger release). */
  selectEvent?: "select" | "selectstart";
  /** Whether the robots' static scenery blocks the ray (default `true`). */
  occludeScenery?: boolean;
  /** Further objects that block the ray. */
  occluders?: THREE.Object3D[];
};

export class XrRayPicker extends THREE.EventDispatcher<XrRayPickerEventMap> {
  readonly controller: THREE.Object3D;
  private readonly targets: () => ThreeUsdRobot[];
  private readonly raycaster = new THREE.Raycaster();
  private readonly kinds: LinkMeshKind[] | undefined;
  private readonly occludeScenery: boolean | undefined;
  private readonly occluders: THREE.Object3D[] | undefined;
  private readonly unsubscribe: () => void;
  private _current: LinkPick | null = null;

  /**
   * @param controller the space whose −Z is the ray (`renderer.xr.getController(i)`)
   * @param targets the robots to pick from — an array, or a function returning the current set
   */
  constructor(
    controller: THREE.Object3D,
    targets: ThreeUsdRobot[] | (() => ThreeUsdRobot[]),
    options: XrRayPickerOptions = {},
  ) {
    super();
    this.controller = controller;
    this.targets = typeof targets === "function" ? targets : () => targets;
    this.kinds = options.kinds;
    this.occludeScenery = options.occludeScenery;
    this.occluders = options.occluders;
    this.raycaster.far = options.maxDistance ?? 10;
    this.unsubscribe = onXrInput(controller, options.selectEvent ?? "select", () => {
      if (this._current) this.dispatchEvent({ type: "select", hit: this._current });
    });
  }

  /** The link under the ray right now. */
  get current(): LinkPick | null {
    return this._current;
  }

  /** Ray length in world units — scale it with the player when the origin is scaled. */
  get maxDistance(): number {
    return this.raycaster.far;
  }
  set maxDistance(value: number) {
    this.raycaster.far = value;
  }

  /** Recast along the controller's −Z. Call once per frame while presenting. */
  update(): void {
    const robots = this.targets();
    if (robots.length === 0) {
      this.set(null);
      return;
    }
    this.controller.updateWorldMatrix(true, false);
    const m = this.controller.matrixWorld;
    this.raycaster.ray.origin.setFromMatrixPosition(m);
    this.raycaster.ray.direction.set(0, 0, -1).transformDirection(m);
    this.set(
      pickLink(robots, this.raycaster, {
        ...(this.kinds ? { kinds: this.kinds } : {}),
        ...(this.occludeScenery !== undefined ? { occludeScenery: this.occludeScenery } : {}),
        ...(this.occluders ? { occluders: this.occluders } : {}),
        visibleOnly: true,
      }),
    );
  }

  dispose(): void {
    this.unsubscribe();
    this.set(null);
  }

  private set(hit: LinkPick | null): void {
    const changed = hit?.link !== this._current?.link || hit?.robot !== this._current?.robot;
    this._current = hit;
    if (changed) this.dispatchEvent({ type: "hover", hit });
  }
}
