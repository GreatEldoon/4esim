/** Track effect lifetimes independently of damage ticks and timeline sampling. */
export function createEffectTracker(duration) {
  const effects = new Map();
  const keyFor = (name, type) => `${type}:${name}`;
  return {
    apply(name, type, start, end = duration) {
      if (end <= start) return;
      const id = keyFor(name, type);
      const effect = effects.get(id) || { id, name, type, intervals: [] };
      effect.intervals.push([start, end]);
      effects.set(id, effect);
    },
    remove(name, type, at) {
      for (const interval of effects.get(keyFor(name, type))?.intervals || []) {
        if (interval[0] <= at && interval[1] > at) interval[1] = at;
      }
    },
    active(type, at) {
      return [...effects.values()].filter(effect => effect.type === type).flatMap(effect => {
        const ends = effect.intervals.filter(([start, end]) => start <= at && end > at).map(([, end]) => end);
        return ends.length ? [{ id: effect.id, name: effect.name, remaining: Math.max(...ends) - at }] : [];
      });
    },
    summary() {
      return [...effects.values()].map(({ intervals, ...effect }) => {
        const sorted = intervals.map(([start, end]) => [Math.max(0, start), Math.min(duration, end)]).filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
        let uptime = 0, coveredUntil = 0;
        for (const [start, end] of sorted) {
          uptime += Math.max(0, end - Math.max(start, coveredUntil));
          coveredUntil = Math.max(coveredUntil, end);
        }
        return { ...effect, uptime, uptimePct: duration > 0 ? uptime / duration * 100 : 0 };
      }).filter(effect => effect.uptime > 0).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    },
  };
}
