/** Encounter clock only: damage never changes this health model. */
export function targetHealthAt(time, duration, options = {}) {
  if (!options.scaleTargetHealth) return Math.min(100, Math.max(0, Number(options.targetHealthPercent ?? 100)));
  if (!(duration > 0)) return 100;
  const elapsedSteps = Math.floor(Math.max(0, time) / duration * 100 + 1e-9);
  return Math.max(0, 100 - elapsedSteps);
}
