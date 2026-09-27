import assert from 'node:assert/strict';
import { targetHealthAt } from '../src/sim/target-health.js';
import { simulateWarlock } from '../src/sim/warlock.js';
const options = { scaleTargetHealth: true, targetHealthPercent: 20 };
for (const duration of [100, 180, 237]) {
  assert.equal(targetHealthAt(0, duration, options), 100);
  assert.equal(targetHealthAt(duration / 100 - 0.0001, duration, options), 100);
  assert.equal(targetHealthAt(duration / 100, duration, options), 99);
  assert.equal(targetHealthAt(duration * 0.65, duration, options), 35);
  assert.equal(targetHealthAt(duration * 0.66, duration, options), 34);
  assert.equal(targetHealthAt(duration, duration, options), 0);
  assert.equal(targetHealthAt(duration * 2, duration, options), 0);
}
assert.equal(targetHealthAt(99, 100, { targetHealthPercent: 40 }), 40);
const bolt = { name: 'Shadow Bolt', cast: 0, damage: 100, directDamage: 100, periodicDamage: 0, mana: 0, coefficient: 0, school: 'Shadow', specialization: 'Destruction', tooltip: '' };
const run = power => simulateWarlock([bolt], 100, 5000, 0, 0, { Decimation: 2 }, 1, 100, power, {}, options);
for (const power of [0, 10000]) {
  const result = run(power);
  const procs = result.castLog.filter(entry => entry.type === 'cast' && entry.targetHealthPercent < 35);
  assert.equal(procs[0].time, 66);
  assert.equal(result.effectUptimes.find(effect => effect.name === 'Decimation').uptime, 34);
}
console.log('Passed target-health steps, fixed-health mode, Decimation threshold, and damage independence');
