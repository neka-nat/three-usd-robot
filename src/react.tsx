/**
 * `three-usd-robot/react`
 *
 * React Three Fiber bindings: a `<UsdRobot>` component plus hooks. `react` and
 * `@react-three/fiber` are optional peer dependencies — non-React consumers are
 * unaffected. A {@link ThreeUsdRobot} is a `THREE.Object3D`, so it mounts via
 * R3F's `<primitive>`; joint values, toggles and animation are driven through
 * effects/`useFrame` (R3F does not re-render on object mutation).
 */

import { type ThreeElements, useFrame } from "@react-three/fiber";
import * as React from "react";
import type { ThreeUsdRobot } from "./three/ThreeUsdRobot.js";
import {
  ThreeUsdRobotLoader,
  type ThreeUsdRobotLoaderOptions,
} from "./three/ThreeUsdRobotLoader.js";

type CacheEntry = {
  promise: Promise<ThreeUsdRobot>;
  robot?: ThreeUsdRobot;
  error?: unknown;
};

const cache = new Map<string, CacheEntry>();

function loadEntry(url: string, options?: ThreeUsdRobotLoaderOptions): CacheEntry {
  const cached = cache.get(url);
  if (cached) return cached;

  const entry = {} as CacheEntry;
  entry.promise = new ThreeUsdRobotLoader(options).loadAsync(url).then(
    (robot) => {
      entry.robot = robot;
      return robot;
    },
    (error) => {
      entry.error = error;
      throw error;
    },
  );
  cache.set(url, entry);
  return entry;
}

/**
 * Load a robot for use under `<Suspense>`. Throws the load promise until ready
 * (suspends) and the error if it fails (for an error boundary). Cached by `url`.
 */
export function useUsdRobot(url: string, options?: ThreeUsdRobotLoaderOptions): ThreeUsdRobot {
  const entry = loadEntry(url, options);
  if (entry.error) throw entry.error;
  if (!entry.robot) throw entry.promise;
  return entry.robot;
}

/** Warm the cache so a later `<UsdRobot>`/`useUsdRobot` resolves instantly. */
export function preloadUsdRobot(url: string, options?: ThreeUsdRobotLoaderOptions): void {
  loadEntry(url, options);
}

/** Drop one cached robot (or the whole cache) so it reloads next time. */
export function clearUsdRobotCache(url?: string): void {
  if (url) cache.delete(url);
  else cache.clear();
}

/**
 * Advance a robot's time-sampled animation every frame while `playing`. No-op
 * for robots without an authored time range.
 */
export function useRobotAnimation(robot: ThreeUsdRobot | null | undefined, playing = true): void {
  const range = robot?.getTimeRange() ?? null;
  const time = React.useRef(range?.start ?? 0);
  useFrame((_, delta) => {
    if (!robot || !range || !playing) return;
    time.current += delta * robot.getTimeCodesPerSecond();
    if (time.current > range.end) time.current = range.start;
    robot.setTime(time.current);
  });
}

/**
 * Transform / event props forwarded to the underlying `<primitive>`. Picked
 * explicitly so R3F's broad element index signature doesn't widen our own props.
 */
type ForwardedProps = Partial<
  Pick<
    ThreeElements["primitive"],
    | "position"
    | "rotation"
    | "quaternion"
    | "scale"
    | "visible"
    | "renderOrder"
    | "name"
    | "userData"
    | "onClick"
    | "onPointerOver"
    | "onPointerOut"
    | "onPointerMove"
  >
>;

export type UsdRobotProps = ForwardedProps & {
  /** Asset URL (`.usda` / `.usdc` / binary `.usd` / `.usdz`). */
  url: string;
  /** Loader options (resolver, up-axis, textures, …). */
  loaderOptions?: ThreeUsdRobotLoaderOptions;
  /** Controlled joint values (re-applied when this object changes). */
  jointValues?: Record<string, number>;
  /** Auto-play time-sampled joint animation (default `false`). */
  animate?: boolean;
  showVisual?: boolean;
  showCollision?: boolean;
  showJointAxes?: boolean;
  showLinkFrames?: boolean;
  /** Called once the robot has loaded. */
  onLoad?: (robot: ThreeUsdRobot) => void;
};

/**
 * Declaratively mount a USD robot in an R3F `<Canvas>`. Wrap in `<Suspense>`.
 *
 * @example
 * ```tsx
 * <Suspense fallback={null}>
 *   <UsdRobot url="/robot.usda" jointValues={{ joint1: 0.4 }} showJointAxes />
 * </Suspense>
 * ```
 */
export const UsdRobot = React.forwardRef<ThreeUsdRobot, UsdRobotProps>(
  function UsdRobot(props, ref) {
    const {
      url,
      loaderOptions,
      jointValues,
      animate = false,
      showVisual,
      showCollision,
      showJointAxes,
      showLinkFrames,
      onLoad,
      ...rest
    } = props;

    const robot = useUsdRobot(url, loaderOptions);
    React.useImperativeHandle(ref, () => robot, [robot]);

    React.useEffect(() => {
      onLoad?.(robot);
    }, [robot, onLoad]);

    React.useEffect(() => {
      if (jointValues) robot.setJointValues(jointValues);
    }, [robot, jointValues]);

    React.useEffect(() => {
      if (showVisual !== undefined) robot.showVisual = showVisual;
    }, [robot, showVisual]);
    React.useEffect(() => {
      if (showCollision !== undefined) robot.showCollision = showCollision;
    }, [robot, showCollision]);
    React.useEffect(() => {
      if (showJointAxes !== undefined) robot.showJointAxes = showJointAxes;
    }, [robot, showJointAxes]);
    React.useEffect(() => {
      if (showLinkFrames !== undefined) robot.showLinkFrames = showLinkFrames;
    }, [robot, showLinkFrames]);

    // `useFrame` only runs inside a Canvas, so gate it behind a child component —
    // this keeps <UsdRobot> renderable (and testable) without an R3F frame loop.
    return (
      <primitive object={robot} {...rest}>
        {animate ? <RobotAnimator robot={robot} /> : null}
      </primitive>
    );
  },
);

function RobotAnimator({ robot }: { robot: ThreeUsdRobot }): null {
  useRobotAnimation(robot, true);
  return null;
}
