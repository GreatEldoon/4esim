import assert from 'node:assert/strict';
import { simulateWarlock } from '../src/sim/warlock.js';
import { simulateGeneric } from '../src/sim/generic.js';
const dot = { name: 'Bane of Agony', school: 'Shadow', specialization: 'Affliction', cast: 0, damage: 1000, directDamage: 0, periodicDamage: 1000, periodicDuration: 100, periodicTickInterval: 1, mana: 0, coefficient: 0, cooldown: 200, tooltip: '1000 Shadow damage over 100 sec.' };
for (const engine of [simulateWarlock, simulateGeneric]) {
  const result = engine([dot], 100, 5000, 0, 0, {}, 1, 100, 0);
  const ticks = result.castLog.filter(entry => entry.type === 'tick');
  assert.ok(ticks.some(entry => entry.crit), `${engine.name}: DoT ticks must roll crits`);
  assert.ok(ticks.some(entry => !entry.crit), 'Ticks roll independently');
  assert.ok(result.castLog.filter(entry => entry.type === 'cast').every(entry => !entry.crit && entry.damage === 0));
  for (const tick of ticks) assert.equal(tick.damage, tick.crit ? 15 : 10);
  assert.equal(result.crits, ticks.filter(entry => entry.crit).length);
  assert.equal(result.events[0].crits, result.crits);
  assert.equal(result.damage, ticks.reduce((sum, tick) => sum + tick.damage, 0));
}
console.log('Periodic crit regression passed');
for (const name of ['Bane of Agony', 'Corruption', 'Siphon Life', 'Wrack', 'Drain Life', 'Drain Soul']) {
  const spell = { ...dot, name, channeled: ['Wrack', 'Drain Life', 'Drain Soul'].includes(name), cast: ['Wrack', 'Drain Life', 'Drain Soul'].includes(name) ? 100 : 0, channelTickInterval: 1 };
  const result = simulateWarlock([spell], 100, 5000, 0, 0, { Pandemic: 3 }, 1, 100, 0);
  assert.ok(result.castLog.filter(entry => entry.type === 'cast').every(entry => !entry.crit), `${name} application cannot crit`);
  const ticks = result.castLog.filter(entry => entry.type === 'tick');
  assert.ok(ticks.some(entry => entry.crit) && ticks.some(entry => !entry.crit), `${name} independent ticks`);
  const normalDamage = ticks.find(entry => !entry.crit).damage;
  for (const tick of ticks) assert.equal(tick.damage, normalDamage * (tick.crit ? 2 : 1), `${name} Pandemic multiplier applies once`);
  assert.equal(result.crits, ticks.filter(entry => entry.crit).length);
  assert.equal(result.events[0].crits, result.crits);
}
for (const engine of [simulateWarlock, simulateGeneric]) {
  let directCrits = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const hybrid = { ...dot, name: 'Immolate', specialization: 'Fire', school: 'Fire', directDamage: 100, damage: 1100 };
    const result = engine([hybrid], 100, 5000, 0, 0, {}, seed, 100, 0);
    const application = result.castLog.find(entry => entry.type === 'cast');
    if (application.crit) directCrits++;
    assert.equal(application.damage, application.crit ? 150 : 100, 'Actual direct damage can crit');
    for (const tick of result.castLog.filter(entry => entry.type === 'tick')) assert.equal(tick.damage, tick.crit ? 15 : 10, 'Direct crit must not multiply the DoT');
    assert.equal(result.crits, result.castLog.filter(entry => entry.crit).length);
    assert.equal(result.damage, result.castLog.reduce((sum, entry) => sum + entry.damage, 0));
  }
  assert.ok(directCrits > 0, 'Direct crit behavior preserved');
  const miss = engine([dot], 100, 5000, 0, 0, {}, 1, 0, 0);
  assert.equal(miss.crits, 0);
  assert.equal(miss.damage, 0);
  assert.equal(miss.castLog.filter(entry => entry.type === 'tick').length, 0);
}
console.log('Passed named DoTs, channels, Pandemic scaling, mixed direct/periodic damage, and misses');
