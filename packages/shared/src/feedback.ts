/** Survey results per group (department, question breakdown, free texts) need at least this many answers. */
export const MIN_SURVEY_GROUP = 3;
/** Peer reviews are only shown aggregated, and only once this many peers have submitted. */
export const MIN_PEER_REVIEWS = 2;

export const visibleGroup = (count: number, min = MIN_SURVEY_GROUP) => count >= min;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Employee Net Promoter Score: % promoters (9–10) minus % detractors (0–6). */
export function enps(scores: number[]) {
  const valid = scores.filter((s) => Number.isInteger(s) && s >= 0 && s <= 10);
  const promoters = valid.filter((s) => s >= 9).length;
  const detractors = valid.filter((s) => s <= 6).length;
  const passives = valid.length - promoters - detractors;
  const score = valid.length ? Math.round(((promoters - detractors) / valid.length) * 100) : 0;
  return { score, promoters, passives, detractors, count: valid.length };
}

/** Average (one decimal) and count per scale step for values between min and max. */
export function summarizeScale(values: number[], min: number, max: number) {
  const valid = values.filter((v) => Number.isFinite(v) && v >= min && v <= max);
  const distribution = Array.from({ length: max - min + 1 }, () => 0);
  for (const v of valid) distribution[Math.round(v) - min]++;
  const average = valid.length ? round1(valid.reduce((s, v) => s + v, 0) / valid.length) : 0;
  return { count: valid.length, average, distribution };
}

export function summarizeChoice(values: string[], options: string[]) {
  return options.map((option) => ({ option, count: values.filter((v) => v === option).length }));
}
