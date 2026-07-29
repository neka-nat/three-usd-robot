/**
 * Click-to-select + transform gizmo for whole objects.
 *
 * A click picks the *unit* the hit mesh belongs to — the direct child of the
 * loaded root: the articulated robot's root link (so the robot moves as one
 * rigid body, no FK involved), an isolated free body, or a scenery mesh. The
 * unit gets a `TransformControls` gizmo and a bounding-box highlight.
 */

import * as THREE from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";

export type GizmoMode = "translate" | "rotate" | "scale";

export type SelectionGizmo = {
  /** Currently selected unit, if any. */
  readonly object: THREE.Object3D | null;
  /** Attach the gizmo to a unit (`null` deselects). Does not fire `onPick`. */
  select(unit: THREE.Object3D | null): void;
  setMode(mode: GizmoMode): void;
  setSpace(space: "world" | "local"): void;
  /** Call once per frame to keep the highlight box tracking the object. */
  update(): void;
  dispose(): void;
};

export type SelectionGizmoOptions = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  domElement: HTMLElement;
  /** Orbit controls to pause while dragging the gizmo. */
  orbit: { enabled: boolean };
  /** Object whose direct children are the selectable units. */
  getRoot: () => THREE.Object3D | null;
  /** Fired on viewport picks only: the unit and the exact mesh hit. */
  onPick?: (unit: THREE.Object3D | null, hit: THREE.Object3D | null) => void;
};

export function createSelectionGizmo(options: SelectionGizmoOptions): SelectionGizmo {
  const { scene, camera, domElement, orbit, getRoot } = options;

  const gizmo = new TransformControls(camera, domElement);
  const helper = gizmo.getHelper();
  scene.add(helper);
  gizmo.addEventListener("dragging-changed", (event) => {
    orbit.enabled = !event.value;
  });

  let selected: THREE.Object3D | null = null;
  let box: THREE.BoxHelper | null = null;

  function clearBox(): void {
    if (!box) return;
    scene.remove(box);
    box.geometry.dispose();
    (box.material as THREE.Material).dispose();
    box = null;
  }

  function select(unit: THREE.Object3D | null): void {
    selected = unit;
    gizmo.detach();
    clearBox();
    if (!unit) return;
    // Links / scenery are placed by fixed matrices; hand ownership of the
    // transform to the gizmo by decomposing into position/quaternion/scale.
    if (!unit.matrixAutoUpdate) {
      unit.matrix.decompose(unit.position, unit.quaternion, unit.scale);
      unit.matrixAutoUpdate = true;
    }
    gizmo.attach(unit);
    box = new THREE.BoxHelper(unit, 0xffb347);
    scene.add(box);
  }

  // -- viewport picking (click, not drag) ------------------------------------

  const raycaster = new THREE.Raycaster();
  const downAt = new THREE.Vector2();

  function onPointerDown(event: PointerEvent): void {
    downAt.set(event.clientX, event.clientY);
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.button !== 0) return;
    if (Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 5) return; // orbit drag
    if (gizmo.dragging || gizmo.axis) return; // interacting with the gizmo itself

    const root = getRoot();
    if (!root) return;

    const rect = domElement.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    // Meshes only (skips axis-helper lines); raycast sees hidden collision
    // meshes, so drop anything with an invisible ancestor.
    const hit = raycaster
      .intersectObject(root, true)
      .find(
        (i) => (i.object as THREE.Mesh).isMesh && isShown(i.object, root),
      )?.object;

    const unit = hit ? unitOf(hit, root) : null;
    select(unit);
    options.onPick?.(unit, hit ?? null);
  }

  domElement.addEventListener("pointerdown", onPointerDown);
  domElement.addEventListener("pointerup", onPointerUp);

  return {
    get object() {
      return selected;
    },
    select,
    setMode(mode: GizmoMode): void {
      gizmo.setMode(mode);
    },
    setSpace(space: "world" | "local"): void {
      gizmo.setSpace(space);
    },
    update(): void {
      box?.update();
    },
    dispose(): void {
      domElement.removeEventListener("pointerdown", onPointerDown);
      domElement.removeEventListener("pointerup", onPointerUp);
      select(null);
      scene.remove(helper);
      gizmo.dispose();
    },
  };
}

/** Walk up to the direct child of `root` that contains `obj`. */
function unitOf(obj: THREE.Object3D, root: THREE.Object3D): THREE.Object3D | null {
  let cur = obj;
  while (cur.parent && cur.parent !== root) cur = cur.parent;
  return cur.parent === root ? cur : null;
}

/** Whether the object and all ancestors up to `root` are visible. */
function isShown(obj: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let cur: THREE.Object3D | null = obj; cur && cur !== root; cur = cur.parent) {
    if (!cur.visible) return false;
  }
  return true;
}
