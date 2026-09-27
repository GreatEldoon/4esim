import assert from 'node:assert/strict';
import { simulateWarlock } from '../src/sim/warlock.js';
const names = ['Bane of Agony', 'Corruption', 'Siphon Life'];
const spells = names.map(name => ({ name, school: 'Shadow', specialization: 'Affliction', cast: 0, damage: 100, directDamage: 0, periodicDamage: 100, periodicDuration: 10, periodicTickInterval: 2, cooldown: 60, mana: 0, coefficient: 0, tooltip: '100 Shadow damage over 10 sec.' }));
const result = simulateWarlock(spells, 20, 5000, 0, 0, {}, 1, 100, 0);
for (const name of names) {
  assert.ok(result.castLog.some(entry => entry.enemyDebuffs.some(effect => effect.name === name)), `${name} must appear in timeline debuffs`);
  const uptime = result.effectUptimes.find(effect => effect.name === name);
  assert.equal(uptime.uptime, 10);
  assert.equal(uptime.uptimePct, 50);
}
console.log('DoT visibility and uptime passed');

import { createEffectTracker } from '../src/sim/effect-uptime.js';
const tracker = createEffectTracker(20);
tracker.apply('Refresh', 'debuff', 2, 8);
tracker.apply('Refresh', 'debuff', 5, 12);
tracker.apply('Refresh', 'debuff', 15, 30);
assert.equal(tracker.summary()[0].uptime, 15, 'Merge refresh overlap, retain gaps, cap at encounter end');
tracker.remove('Refresh', 'debuff', 18);
assert.equal(tracker.summary()[0].uptime, 13, 'Early removal truncates active interval');
assert.equal(tracker.active('debuff', 1).length, 0, 'No debuff before application');
assert.equal(tracker.active('debuff', 12).length, 0, 'No debuff after expiry');
assert.equal(tracker.active('debuff', 6)[0].remaining, 6);
const missed = simulateWarlock(spells, 20, 5000, 0, 0, {}, 1, 0, 0);
assert.equal(missed.effectUptimes.length, 0, 'Missed applications have no uptime');
const refreshed = simulateWarlock([{ ...spells[0], cooldown: 0 }], 20, 5000, 0, 0, {}, 1, 100, 0);
assert.equal(refreshed.effectUptimes[0].uptimePct, 100, 'Repeated DoT refreshes never exceed 100%');
assert.ok(result.castLog.filter(entry => entry.type === 'cast')[0].enemyDebuffs.length === 0, 'Cast-start snapshot excludes new application');
const casted = simulateWarlock([{ ...spells[1], cast: 2 }], 20, 5000, 0, 0, {}, 1, 100, 0);
assert.equal(casted.effectUptimes[0].uptime, 10, 'Uptime begins at cast completion');

import { createServer } from 'vite';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import fs from 'node:fs';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { simulate, buildDamageSpellCatalog } = await server.ssrLoadModule('/src/App.jsx');
  const catalog = buildDamageSpellCatalog(JSON.parse(fs.readFileSync(new URL('../src/data/mage.json', import.meta.url))));
  const frostbolt = { ...catalog.find(spell => spell.name === 'Frostbolt'), mana: 0 };
  const mage = simulate([frostbolt], 60, 5000, 0, 0, { 'Arcane Power': 1, 'Fingers of Frost': 2, "Winter's Chill": 5 }, 1, 100, 0, {});
  assert.equal(mage.effectUptimes.find(effect => effect.name === 'Arcane Power').uptime, 15);
  assert.ok(mage.effectUptimes.some(effect => effect.name === "Winter's Chill" && effect.uptime > 0));
  assert.ok(mage.effectUptimes.every(effect => effect.uptimePct <= 100));
  const fingers = mage.buffs.find(effect => effect.name === 'Fingers of Frost');
  assert.equal(mage.effectUptimes.find(effect => effect.name === fingers.name)?.uptime || 0, fingers.uptime, 'Tracked proc uptime matches original counter');
  const { EffectUptimeSection } = await server.ssrLoadModule('/src/EffectUptimeSection.jsx');
  const html = renderToStaticMarkup(createElement(EffectUptimeSection, { effects: [...result.effectUptimes, { id: 'wrack', name: 'Wrack', type: 'debuff', uptime: 6, uptimePct: 30 }] }));
  for (const name of names) assert.ok(html.includes(name));
  assert.ok(!html.includes('Wrack'), 'Wrack excluded only from the uptime section');
  assert.ok(html.includes('50.0%') && html.includes('10.0s'));
  assert.ok(renderToStaticMarkup(createElement(EffectUptimeSection)).includes('Run a new simulation'));
} finally { await server.close(); }
console.log('Passed refresh, expiry, misses, cast completion, mage effects, and uptime rendering');
