/**
 * A small canvas-text billboard for in-headset labels (link names, frame stats).
 *
 * A plain quad, not a `THREE.Sprite`: three's sprite shader sizes sprites from
 * their *world* scale but positions them through the (scaled) view matrix, so
 * inside a scaled XR origin (tabletop view) sprites render `playerScale`
 * times too large. Regular geometry goes through the same matrices as the
 * rest of the scene and stays consistent.
 */

import * as THREE from "three";

export class TextLabel extends THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private lastText = "";

  constructor(widthMeters = 0.2, lines = 1) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 32 + 56 * lines;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    super(
      new THREE.PlaneGeometry(widthMeters, (widthMeters * canvas.height) / canvas.width),
      new THREE.MeshBasicMaterial({ map: texture, depthTest: false, transparent: true }),
    );
    this.canvas = canvas;
    this.texture = texture;
    this.ctx = canvas.getContext("2d")!;
    this.renderOrder = 100;
    this.visible = false;
  }

  /** Turn to face the camera (call once per frame; cheap). */
  billboard(camera: THREE.Camera): void {
    if (!this.visible) return;
    const q = camera.getWorldQuaternion(new THREE.Quaternion());
    const parentQ = this.parent?.getWorldQuaternion(new THREE.Quaternion());
    if (parentQ) q.premultiply(parentQ.invert());
    this.quaternion.copy(q);
  }

  setText(text: string): void {
    if (text === this.lastText) return;
    this.lastText = text;
    this.visible = text.length > 0;
    if (!this.visible) return;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(20, 22, 28, 0.85)";
    roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 18);
    ctx.fill();
    ctx.fillStyle = "#e8eef8";
    ctx.font = "500 40px system-ui, sans-serif";
    ctx.textBaseline = "top";
    text.split("\n").forEach((line, i) => ctx.fillText(line, 24, 20 + i * 56, canvas.width - 48));
    this.texture.needsUpdate = true;
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
