/**
 * Controller-ray link picking — the shape proposed for `three-usd-robot/xr`
 * (xr-design §4.2), on top of the library's `pickLink` (M34). Raycasts along a
 * controller's target ray each frame and reports hover changes; three's
 * `WebXRController` dispatches the WebXR `select*` / `squeeze*` events on the
 * same object, so a trigger press turns the current hover into a `select`.
 */

import * as THREE from "three";
import type { ThreeUsdRobot } from "three-usd-robot";
import { type LinkMeshKind, type LinkPick, pickLink } from "three-usd-robot/helpers";

export type XrRayPickerEventMap = {
  /** The hovered link changed (`hit` is `null` when the ray left every link). */
  hover: { hit: LinkPick | null };
  /** The select event fired while a link was hovered. */
  select: { hit: LinkPick };
};

export type XrRayPickerOptions = {
  /** Mesh kinds that count (default `["visual"]`). */
  kinds?: LinkMeshKind[];
  /** Ray length in world units (default `10`). */
  maxDistance?: number;
  /** Which controller event commits a selection (default `"select"` = trigger release). */
  selectEvent?: "select" | "selectstart";
};

export class XrRayPicker extends THREE.EventDispatcher<XrRayPickerEventMap> {
  readonly controller: THREE.Object3D;
  private readonly targets: () => ThreeUsdRobot[];
  private readonly kinds: LinkMeshKind[] | undefined;
  private readonly raycaster = new THREE.Raycaster();
  private readonly selectEvent: "select" | "selectstart";
  private _current: LinkPick | null = null;

  private readonly onSelect = (): void => {
    if (this._current) this.dispatchEvent({ type: "select", hit: this._current });
  };

  constructor(
    controller: THREE.Object3D,
    targets: () => ThreeUsdRobot[],
    options: XrRayPickerOptions = {},
  ) {
    super();
    this.controller = controller;
    this.targets = targets;
    this.kinds = options.kinds;
    this.raycaster.far = options.maxDistance ?? 10;
    this.selectEvent = options.selectEvent ?? "select";
    (controller as THREE.XRTargetRaySpace).addEventListener(this.selectEvent, this.onSelect);
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
    this.controller.updateMatrixWorld();
    const m = this.controller.matrixWorld;
    this.raycaster.ray.origin.setFromMatrixPosition(m);
    this.raycaster.ray.direction.set(0, 0, -1).transformDirection(m);
    this.set(pickLink(robots, this.raycaster, { kinds: this.kinds, visibleOnly: true }));
  }

  dispose(): void {
    (this.controller as THREE.XRTargetRaySpace).removeEventListener(this.selectEvent, this.onSelect);
    this.set(null);
  }

  private set(hit: LinkPick | null): void {
    const changed = hit?.link !== this._current?.link || hit?.robot !== this._current?.robot;
    this._current = hit;
    if (changed) this.dispatchEvent({ type: "hover", hit });
  }
}
