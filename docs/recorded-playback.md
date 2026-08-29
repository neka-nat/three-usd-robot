# Animation & recorded playback

Two playback paths: **joint trajectories** (time-sampled joint states / drive
targets, the fk path) and **baked body transforms** (Isaac Sim stage-recorder
output, which drives link poses directly).

## Joint trajectory playback

If the asset has time-sampled joint trajectories, the robot plays them back:

```ts
const range = robot.getTimeRange();
if (range) {
  // in your render loop, advance a time code between range.start and range.end:
  robot.setTime(t); // interpolates every animated joint and updates FK
}
```

`robot.getTimeCodesPerSecond()` gives the playback rate (stage metadata,
default 24). Samples authored on mimic-follower joints are ignored — the
constraint re-derives them from their leader.

## Baked link transforms

Recordings baked as **body transforms** (Isaac Sim stage-recorder output,
maximal-coordinate solver playback) can drive link poses directly, bypassing
the joints — usdview-style display semantics:

```ts
// A world-pose track keyed by prim path (or link key), quaternion in [x, y, z, w]:
robot.setLinkTransforms({
  "/World/link1": { position: [0, 0, 1], quaternion: [0, 0, 0, 1] },
  "/World/link2": { position: [0.3, 0, 2], quaternion: [0, 0, 0, 1] },
}); // batched — one matrix update; unlisted links keep their current world pose

robot.displayMode; // "baked": joint values are untouched and no longer place links
robot.setJointValues(liveValues); // recompute all links from joint values → "fk"
```

Poses are read in the **three.js scene world after `worldUp` normalization** —
pair a Z-up meter track (Isaac / ROS convention) with `worldUp: "Z"`; feeding
it into the default Y-up normalization lays the robot on its side. Transforms
on the `robot` object itself (placement, uniform scaling) are accounted for,
and `{ space: "stage" }` reads authored stage coordinates instead.

## Diagnostics & projection

Constraint deviations — a recording from a different model version, solver
drift, a coordinate-convention bug — are shown, never silently corrected.
Measure them, or project onto the joints instead:

```ts
robot.validateLinkTransforms(poses);
// { "/World/joint1": { anchorError /* m */, axisError /* rad */, q, limitExceeded }, … }
// covers every joint: fixed joints, loop joints dropped from the FK tree,
// and the world-fixed root attachment

const { values, residuals } = robot.jointValuesFromLinkTransforms(poses, {
  previous: lastValues, // ±π branch continuity, frame to frame
});
robot.setJointValues(values); // constraint-respecting playback of the same track
```

Typical deviation signatures: a constant `anchorError` offset on every joint
means a recording/model mismatch (wrong version or scale); growth over time
means solver drift; a large uniform `axisError` means a coordinate-convention
bug (Y/Z-up or quaternion order).

`new ThreeUsdRobotLoader({ debugBakedTransforms: true })` warns once per baked
session when poses deviate beyond 1 mm / 0.01 rad.
