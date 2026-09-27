import assert from 'node:assert/strict';
import { simulateWarlock } from '../src/sim/warlock.js';
const wrack = { name: 'Wrack', school: 'Shadow', specialization: 'Affliction', cast: 6, damage: 216, directDamage: 0, periodicDamage: 216, periodicDuration: 6, periodicTickInterval: 1, mana: 0, coefficient: 0, tooltip: '36 Shadow damage every 1 sec. Lasts 6 sec.' };
const result = simulateWarlock([wrack], 15, 5000, 0, 0, {}, 1, 0, 0);
assert.equal(result.castLog.filter(entry => entry.type === 'cast')[1].time, 1.5, 'A missed opening channel must release the rotation after 1.5 seconds');
assert.equal(result.castLog.filter(entry => entry.type === 'tick').length, 0, 'A cancelled channel must not emit later ticks');
console.log('Channel miss regression passed');

import { createServer } from 'vite';
import { simulateGeneric } from '../src/sim/generic.js';
import fs from 'node:fs';
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { simulate, buildDamageSpellCatalog } = await server.ssrLoadModule('/src/App.jsx');
  for (const [className, engine] of [['mage', simulate], ['warlock', simulateWarlock], ['priest', simulateGeneric], ['hunter', simulateGeneric], ['druid', simulateGeneric]]) {
    const catalog = buildDamageSpellCatalog(JSON.parse(fs.readFileSync(new URL(`../src/data/${className}.json`, import.meta.url))));
    const channels = catalog.filter(spell => spell.channeled);
    assert.ok(channels.length, `${className} has damage channels`);
    for (const spell of channels) {
      const channel = { ...spell, mana: 0, manaFraction: 0, cooldown: 0, conditional: false };
      const run = (duration, hit, build = {}) => engine([channel], duration, 5000, 0, 0, build, 1, hit, 0, {});
      const miss = run(20, 0);
      const casts = miss.castLog.filter(entry => entry.type === 'cast');
      assert.equal(casts[1].time, 1.5, `${className}/${spell.name} miss recovery`);
      assert.equal(miss.damage, 0, `${spell.name} miss damage`);
      assert.equal(miss.castLog.filter(entry => entry.type === 'tick').length, 0, `${spell.name} cancelled ticks`);
      const filler = { name: 'Test filler', school: spell.school, specialization: spell.specialization, damage: 10, directDamage: 10, cast: 0, mana: 0, coefficient: 0, tooltip: '' };
      const resumed = engine([{ ...channel, cooldown: 30 }, filler], 10, 5000, 0, 0, {}, 1, 0, 0, {});
      assert.equal(resumed.castLog.find(entry => entry.name === filler.name).time, 1.5, `${spell.name} resumes next ready priority`);
      const hit = run(spell.cast, 100);
      const ticks = hit.castLog.filter(entry => entry.type === 'tick');
      assert.equal(ticks.length, Math.ceil(spell.cast / spell.channelTickInterval), `${spell.name} full channel ticks`);
      assert.ok(ticks.every(entry => entry.time > 0 && entry.time <= spell.cast && entry.damage > 0), `${spell.name} damage during channel`);
      assert.equal(hit.castLog.find(entry => entry.type === 'cast').damage, 0, `${spell.name} no upfront damage`);
      assert.ok(Math.abs(hit.damage - hit.castLog.reduce((sum, entry) => sum + entry.damage, 0)) < 1e-6, `${spell.name} damage accounting`);
      const partial = run(spell.cast - 0.1, 100);
      assert.equal(partial.castLog.filter(entry => entry.type === 'tick').length, ticks.length - 1, `${spell.name} partial channel damage`);
      if (spell.name === 'Arcane Missiles') {
        assert.equal(ticks.length, 5);
        const presence = run(5, 100, { 'Presence of Mind': 1 });
        assert.equal(presence.castLog.filter(entry => entry.type === 'tick').length, 5, 'Presence of Mind must not make channels instant');
      }
      console.log(`Passed ${className}: ${spell.name}`);
    }
  }
} finally { await server.close(); }
