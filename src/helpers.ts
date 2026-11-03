/**
 * `three-usd-robot/helpers`
 *
 * Optional Three.js viewer helpers for inspecting a {@link ThreeUsdRobot}:
 * per-joint axis arrows, link-frame gizmos, and joint range-of-motion guides
 * (plus convenience functions to attach them to a whole robot), per-link
 * appearance tools — highlight, material replacement, translucent ghost
 * clones — and the input-agnostic interaction pieces shared by mouse and XR
 * front ends: link picking (`resolveLink` / `pickLink`) and the TCP target
 * handle. Depends only on `three` (a peer dependency).
 */

export {
  createGhostRobot,
  getLinkMeshes,
  type GhostRobotOptions,
  type HighlightLinkOptions,
  highlightLink,
  type LinkMeshKind,
  restoreAllLinkMaterials,
  restoreLinkMaterials,
  setLinkMaterial,
} from "./helpers/appearance.js";
export {
  addJointAxisHelpers,
  addJointLimitHelpers,
  addLinkFrameHelpers,
} from "./helpers/attach.js";
export { JointAxisHelper } from "./helpers/JointAxisHelper.js";
export {
  type LinkHit,
  type LinkHitKind,
  type LinkPick,
  type PickLinkOptions,
  pickLink,
  resolveLink,
} from "./helpers/picking.js";
export {
  type HandleSpace,
  type TcpConstraints,
  type TcpTargetEvent,
  TcpTargetHandle,
  type TcpTargetHandleEventMap,
  type TcpTargetHandleOptions,
  type TcpTargetPhase,
  type TcpTargetStatus,
} from "./helpers/TcpTargetHandle.js";
export { JointLimitHelper } from "./helpers/JointLimitHelper.js";
export { LinkFrameHelper } from "./helpers/LinkFrameHelper.js";
