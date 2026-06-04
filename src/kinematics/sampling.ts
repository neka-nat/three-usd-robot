/**
 * Time-sample interpolation for animated values (e.g. joint trajectories).
 *
 * USD time samples are keyed by time code. We linearly interpolate between the
 * two bracketing samples and hold the endpoints outside the authored range
 * (matching USD's held extrapolation).
 */

/** A sorted time-sampled scalar channel. */
export type SampleChannel = {
  /** Sample times, ascending. */
  times: number[];
  /** Sample values, parallel to {@link times} (SI units). */
  values: number[];
};

/** Linearly sample `channel` at time `t` (held outside the range). */
export function interpolate(channel: SampleChannel, t: number): number {
  const { times, values } = channel;
  const n = times.length;
  if (n === 0) return 0;
  if (t <= times[0]!) return values[0]!;
  if (t >= times[n - 1]!) return values[n - 1]!;

  // Binary search for the first sample time > t.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1; // times[i] <= t < times[i+1]
  const t0 = times[i]!;
  const t1 = times[i + 1]!;
  const span = t1 - t0;
  const f = span > 0 ? (t - t0) / span : 0;
  return values[i]! + (values[i + 1]! - values[i]!) * f;
}

/** Build a sorted {@link SampleChannel} from `(time → value)` pairs via `map`. */
export function channelFromSamples(samples: Map<number, number>): SampleChannel {
  const times = [...samples.keys()].sort((a, b) => a - b);
  const values = times.map((t) => samples.get(t) ?? 0);
  return { times, values };
}
