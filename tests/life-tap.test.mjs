import assert from 'node:assert/strict';
import { simulateWarlock } from '../src/sim/warlock.js';
const dots = ['Bane of Agony', 'Corruption', 'Siphon Life'].map(name => ({ name, school: 'Shadow', specialization: 'Affliction', cast: 0, damage: 100, directDamage: 0, periodicDamage: 100, periodicDuration: 24, periodicTickInterval: 3, mana: 450, coefficient: 0, tooltip: '100 Shadow damage over 24 sec.', conditional: true, conditions: ['debuffRefresh'] }));
const filler = { name: 'Shadow Bolt', school: 'Shadow', specialization: 'Destruction', cast: 2, damage: 10, directDamage: 10, mana: 10, coefficient: 0, tooltip: '' };
const run = (priority, lifeTap = { mana: 100 }) => simulateWarlock(priority, 30, 500, 0, 0, {}, 1, 100, 0, {}, { lifeTap });
const result = run([...dots, filler]);
const actions = result.castLog.filter(entry => ['cast', 'mana'].includes(entry.type));
assert.deepEqual(actions.slice(0, 6).map(entry => entry.name), ['Bane of Agony', 'Life Tap', 'Life Tap', 'Life Tap', 'Life Tap', 'Corruption']);
assert.ok(actions.find(entry => entry.name === 'Siphon Life').time < actions.find(entry => entry.name === 'Shadow Bolt').time, 'Apply all three DoTs before spending recovered mana on filler');
console.log('Life Tap priority regression passed');
for (let index = 1; index < actions.length; index++) {
  if (actions[index - 1].name === 'Life Tap') assert.equal(actions[index].time - actions[index - 1].time, 1.5, 'Every tap respects the global cooldown');
}
assert.ok(result.castLog.some(entry => dots.every(dot => entry.enemyDebuffs.some(effect => effect.name === dot.name))), 'All three DoTs become active together');
const disabled = run([...dots, filler], null);
assert.ok(!disabled.castLog.some(entry => entry.name === 'Life Tap'), 'No taps without configured Life Tap');
const zero = run([...dots, filler], { mana: 0 });
assert.ok(!zero.castLog.some(entry => entry.name === 'Life Tap'), 'Zero-value taps cannot loop');
const unaffordable = run([{ ...dots[0], mana: 600 }, filler]);
assert.equal(unaffordable.castLog[0].name, 'Shadow Bolt', 'An impossible mana cost must not block the rotation');
const cheapDots = run(dots.map(dot => ({ ...dot, mana: 10 })));
assert.ok(!cheapDots.castLog.some(entry => entry.name === 'Life Tap'), 'No unnecessary taps while DoTs are affordable');
const expiring = run([{ ...dots[0], periodicDuration: 9 }, filler]);
const casts = expiring.castLog.filter(entry => entry.type === 'cast' && entry.name === dots[0].name);
assert.ok(casts.length >= 2, 'Replenish mana for due refreshes as well as missing DoTs');
console.log('Passed GCD, simultaneous DoTs, refreshes, disabled taps, mana cap, and affordable builds');
