/**
 * Judge threshold bands (proof of concept for #307).
 *
 * A band turns one raw Noul probability into the engine's ternary flag:
 * `p >= trueBound` is true, `p <= falseBound` is false, and anything
 * between is unknown (`null`).
 *
 * Bands are code constants, not configuration. A pinned judge profile
 * selects one BY NAME through its judge descriptor (`judge-config.ts`),
 * and the adapter and the candidate path both resolve that name here.
 * Neither keeps a private copy of the numbers, so the classification and
 * candidate paths cannot drift apart.
 *
 * Contract:
 *   - Every band is registered below. The registry is the only source of
 *     the bounds.
 *   - A band's revision changes whenever either bound changes.
 *   - A judge may report which REGISTERED band it applied; it can never
 *     supply bounds. An unknown revision is a typed rejection.
 */

export interface JudgeThresholdBand {
  /** `p >= trueBound` translates to true. */
  readonly trueBound: number;
  /** `p <= falseBound` translates to false. */
  readonly falseBound: number;
  /** Names the band. Changes whenever either bound changes. */
  readonly revision: string;
  /** False until the bounds are derived from a labelled development set. */
  readonly calibrated: boolean;
}

/**
 * Trial `.9/.1` band: engineering trial values, not calibrated for any
 * model. Every profile without a calibrated band is read under it.
 */
export const JUDGE_TRIAL_THRESHOLD_BAND = Object.freeze({
  trueBound: 0.9,
  falseBound: 0.1,
  revision: "trial-v1-p9-p1",
  calibrated: false,
} as const) satisfies JudgeThresholdBand;

/**
 * Test fixture band. It is registered so the per-profile mechanism can be
 * exercised end to end offline, and it is NOT assigned to any profile and
 * NOT calibrated. A calibrated band takes its place with a new revision id
 * and a comment linking its development-set evidence.
 */
export const JUDGE_FIXTURE_THRESHOLD_BAND = Object.freeze({
  trueBound: 0.8,
  falseBound: 0.2,
  revision: "fixture-v1-p8-p2",
  calibrated: false,
} as const) satisfies JudgeThresholdBand;

const REGISTERED_BANDS: ReadonlyMap<string, JudgeThresholdBand> = new Map<string, JudgeThresholdBand>([
  [JUDGE_TRIAL_THRESHOLD_BAND.revision, JUDGE_TRIAL_THRESHOLD_BAND],
  [JUDGE_FIXTURE_THRESHOLD_BAND.revision, JUDGE_FIXTURE_THRESHOLD_BAND],
]);

function plausible(band: JudgeThresholdBand): boolean {
  return (
    Number.isFinite(band.trueBound) &&
    Number.isFinite(band.falseBound) &&
    band.falseBound >= 0 &&
    band.trueBound <= 1 &&
    band.falseBound < band.trueBound
  );
}

/** The registered band with this revision, or undefined when none is. */
export function judgeThresholdBandByRevision(revision: unknown): JudgeThresholdBand | undefined {
  if (typeof revision !== "string") return undefined;
  const band = REGISTERED_BANDS.get(revision);
  return band !== undefined && plausible(band) ? band : undefined;
}

/**
 * True only when `value` is exactly a registered band: the same revision
 * AND the same bounds. A descriptor therefore cannot carry numbers that
 * the registry does not define.
 */
export function isRegisteredThresholdBand(value: unknown): value is JudgeThresholdBand {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const band = judgeThresholdBandByRevision(candidate.revision);
  return band !== undefined && candidate.trueBound === band.trueBound && candidate.falseBound === band.falseBound;
}

/** Translate one raw Noul probability under a band. */
export function translateNoul(p: number, band: JudgeThresholdBand): boolean | null {
  return p >= band.trueBound ? true : p <= band.falseBound ? false : null;
}
