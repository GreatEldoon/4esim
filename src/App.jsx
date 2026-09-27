import { warlockPetState } from './sim/warlock-pets.js';
import { createEffectTracker } from './sim/effect-uptime.js';
import { EffectUptimeSection } from './EffectUptimeSection.jsx';
import { isDamageChannel, channelTickInterval } from './sim/channels.js';
import { useEffect, useRef, useState } from 'react';
import { TalentImport } from './TalentImport.jsx';
import { classRegistry } from './data/classes.js';
import { petsForClass } from './data/pets.js';
import { simulateWarlock } from './sim/warlock.js';
import { simulateGeneric } from './sim/generic.js';
import { debuffRefreshBehavior, debuffRefreshWindow } from './sim/debuff-conditions.js';
import { addSpellMetadata } from './data/spell-metadata.js';
import { mageEffectIcons } from './data/mage-effect-icons.js';
import { classTalentIcons, spellIcons } from './data/spell-icons.js';
import { petAttackProfileFor, petAttackProfiles } from './data/pet-attack-profiles.js';

const siteBaseUrl = import.meta.env.BASE_URL;
const numberFromText = value => Number(String(value || '').replace(/,/g, '').match(/[\d.]+/)?.[0] || 0);
const formatTime = seconds => `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
function damageFromTooltip(text) {
  if (/absorbs?|damage taken|absorb(?:ed|ing)? damage/i.test(text)) return 0;
  const hits = [...text.matchAll(/([\d,]+)(?:\s+to\s+([\d,]+))?\s+(?:(?:Arcane|Fire|Frostfire|Frost|Shadow|Nature|Holy|Physical)\s+)?damage(?:(?:\s+each second for\s+(\d+)\s+sec)|(?:\s+every\s+(\d+)\s+sec)|(?:\s+over\s+(\d+)\s+sec))?/gi)];
  const damage = hits.reduce((sum, hit) => {
    const amount = (numberFromText(hit[1]) + numberFromText(hit[2] || hit[1])) / 2;
    const everyInterval = Number(hit[4]) || 0;
    const duration = everyInterval ? Number(text.match(/lasts\s+(\d+)\s+sec/i)?.[1] || 0) : 0;
    return sum + amount * (Number(hit[3]) || (everyInterval ? Math.max(1, Math.floor(duration / everyInterval)) : 1));
  }, 0);
  const drainMatches = [...text.matchAll(/transfers?\s+([\d,]+)\s+health(?:\s+from the target(?: to the caster)?)?\s+every\s+(\d+)\s+(?:sec|seconds?)(?:\s+from the target(?: to the caster)?)?/gi)];
  const duration = Number(text.match(/lasts\s+(\d+)\s+sec/i)?.[1] || 0);
  return damage + drainMatches.reduce((sum, match) => sum + numberFromText(match[1]) * Math.max(1, Math.floor(duration / Number(match[2] || 1))), 0);
}
function periodicDamageFromTooltip(text) {
  if (/absorbs?|damage taken|absorb(?:ed|ing)? damage/i.test(text)) return 0;
  const over = [...text.matchAll(/([\d,]+)(?:\s+to\s+([\d,]+))?\s+(?:(?:Arcane|Fire|Frostfire|Frost|Shadow|Nature|Holy|Physical)\s+)?damage\s+over\s+\d+\s+sec/gi)];
  const eachSecond = [...text.matchAll(/([\d,]+)(?:\s+to\s+([\d,]+))?\s+(?:(?:Arcane|Fire|Frostfire|Frost|Shadow|Nature|Holy|Physical)\s+)?damage\s+(?:each second|every (\d+) sec|per second)(?:\s+for\s+(\d+)\s+sec)?/gi)];
  const health = [...text.matchAll(/transfers?\s+([\d,]+)\s+health(?:\s+from the target(?: to the caster)?)?\s+every\s+(\d+)\s+(?:sec|seconds?)(?:\s+from the target(?: to the caster)?)?/gi)];
  const duration = Number(text.match(/(?:lasts|over|for)\s+(\d+)\s+sec/i)?.[1] || 0);
  return over.reduce((sum, hit) => sum + (numberFromText(hit[1]) + numberFromText(hit[2] || hit[1])) / 2, 0)
    + eachSecond.reduce((sum, hit) => {
      const amount = (numberFromText(hit[1]) + numberFromText(hit[2] || hit[1])) / 2;
      const interval = Number(hit[3]) || 1;
      return sum + amount * (Number(hit[4]) || Math.max(1, Math.floor(duration / interval)));
    }, 0) + health.reduce((sum, match) => sum + numberFromText(match[1]) * Math.max(1, Math.floor(duration / Number(match[2] || 1))), 0);
}
export function buildDamageSpellCatalog(classData, level = 60) {
  const className = classData.class;
  return classData.spellbook.tabs.flatMap(tab => {
    const byName = new Map();
    tab.spells.forEach(([name, rank]) => {
      const rankNumber = numberFromText(rank);
      const detail = classData.spell_desc[`${className}|${name}|${rank}`];
      if (!detail || !damageFromTooltip(detail.d || '')) return;
      const ranks = byName.get(name) || [];
      ranks.push({ name, rank, rankNumber, detail, school: tab.name });
      byName.set(name, ranks);
    });
    return [...byName.values()].map(ranks => {
      const spell = ranks.filter(entry => Number(entry.detail.lv?.match(/level\s+(\d+)/i)?.[1] || 1) <= level).sort((a, b) => a.rankNumber - b.rankNumber).at(-1);
      if (!spell) return null;
      const tooltip = spell.detail.d || '';
      const metadata = spell.detail.l || [];
      const manaText = metadata[0]?.[0] || '';
      const castText = metadata[1]?.[0] || '';
      const cooldownText = metadata[1]?.[1] || '';
      const manaFraction = Number(manaText.match(/([\d.]+)%\s+of base mana/i)?.[1] || 0) / 100;
      const resourceType = manaText.match(/\b(Mana|Rage|Energy|Focus)\b/i)?.[1] || (manaFraction ? 'Mana' : 'Mana');
      const castMatch = castText.match(/([\d.]+)\s*sec\s+cast/i);
      const channelDuration = Number(tooltip.match(/(?:for|over|lasts)\s+(\d+)\s+sec/i)?.[1] || 0);
      const cooldownSeconds = numberFromText(cooldownText) * (/min/i.test(cooldownText) ? 60 : 1);
      const damage = damageFromTooltip(tooltip);
      const periodicDamage = periodicDamageFromTooltip(tooltip);
      const periodicDuration = Number(tooltip.match(/(?:over|for|lasts)\s+(\d+)\s+sec/i)?.[1] || 0);
      const periodInterval = Number(tooltip.match(/(?:every|each)\s+(\d+)\s+sec/i)?.[1] || (/each second|every second|per second/i.test(tooltip) ? 1 : spell.name === 'Wrack' ? 1 : 3));
      const channeled = /channeled/i.test(castText);
      const channelInterval = channelTickInterval({ name: spell.name, periodicTickInterval: periodInterval });
      const periodicTicks = periodicDuration ? Math.ceil(periodicDuration / (channeled ? channelInterval : periodInterval)) : 0;
      const coefficientText = spell.detail.co || '';
      const directCoefficient = Number(coefficientText.match(/([\d.]+)%\s+of spell power\s*\(direct\)/i)?.[1] || (!/per tick/i.test(coefficientText) ? coefficientText.match(/([\d.]+)%\s+of spell power/i)?.[1] : 0)) / 100;
      const periodicCoefficient = [...coefficientText.matchAll(/([\d.]+)%\s+of spell power\s*\(per tick\)/gi)].reduce((sum, match) => sum + Number(match[1]) / 100, 0);
      const fallbackCoefficient = Math.min(1, Math.max(1.5, castMatch ? Number(castMatch[1]) : /channeled/i.test(castText) ? channelDuration : 0) / 3.5);
      const totalCoefficient = directCoefficient + periodicCoefficient * periodicTicks || fallbackCoefficient;
      const tooltipSchool = tooltip.match(/\b(Arcane|Fire|Frostfire|Frost|Shadow|Nature|Holy|Physical)\s+damage\b/i)?.[1];
      const spellMetadata = classData.spellbook.spell_metadata?.[`${tab.name}|${spell.name}|${spell.rank}`];
      const school = tooltipSchool || spellMetadata?.school || ({ Affliction: 'Shadow', Demonology: 'Shadow', Destruction: 'Fire', Demons: 'Shadow' }[tab.name] || tab.name);
      return {
        name: spell.name,
        rank: spell.rank,
        // Keep the spellbook tab as a first-class tag. School describes the
        // damage type; specialization controls which tree talents can affect it.
        specialization: spellMetadata?.specialization || tab.name,
        damage: Math.round(damage),
        directDamage: Math.max(0, Math.round(damage - periodicDamage)),
        periodicDamage: Math.min(Math.round(damage), Math.round(periodicDamage)),
        periodicDuration,
        periodicTickInterval: channeled ? channelInterval : periodInterval,
        channeled,
        channelTickInterval: channelInterval,
        directCoefficient: directCoefficient || (periodicCoefficient ? 0 : fallbackCoefficient),
        periodicCoefficient,
        cast: castMatch ? Number(castMatch[1]) : /channeled/i.test(castText) ? channelDuration : 0,
        mana: manaFraction ? 0 : numberFromText(manaText),
        resourceType,
        manaFraction,
        cooldown: cooldownSeconds,
        school,
        coefficient: totalCoefficient,
        tooltip,
      };
    }).filter(Boolean);
  }).sort((a, b) => a.school.localeCompare(b.school) || a.name.localeCompare(b.name));
}
const classDataLoaders = {
  mage: () => import('./data/mage.json'), warlock: () => import('./data/warlock.json'),
  warrior: () => import('./data/warrior.json'), paladin: () => import('./data/paladin.json'),
  hunter: () => import('./data/hunter.json'), rogue: () => import('./data/rogue.json'),
  priest: () => import('./data/priest.json'), shaman: () => import('./data/shaman.json'),
  druid: () => import('./data/druid.json'),
};
const resourceTypeByClass = { warrior: 'Rage', rogue: 'Energy' };
const resourceTypeForClass = classId => resourceTypeByClass[classId] || 'Mana';
const resourceCapForClass = classId => ['warrior', 'rogue'].includes(classId) ? 100 : 5000;
const combustionSpell = { name: 'Combustion', rank: 'Talent', damage: 0, cast: 0, cooldown: 180, mana: 0, manaFraction: 0, school: 'Fire', coefficient: 0, offGcd: true, tooltip: 'Increases your Fire critical strike chance. Off the global cooldown.' };
const talentCookieName = classId => `4esim_${classId}_talents`;
const specStorageKey = classId => `4esim_${classId}_specs`;
const talentIcons = mageEffectIcons;
const effectTalentNames = { missileBarrage: 'Missile Barrage', fingersOfFrost: 'Fingers of Frost', clearcasting: 'Arcane Concentration', winterChill: "Winter's Chill", scorch: 'Improved Scorch', hotStreak: 'Hot Streak', arcaneBlast: 'Arcane Blast', frozen: 'Frostbite', arcanePower: 'Arcane Power', combustion: 'Combustion', presenceOfMind: 'Presence of Mind', ignite: 'Ignite' };
const iconForEffect = effect => {
  const name = effectTalentNames[effect.id] || effect.name;
  const baseName = name.split(' · ')[0];
  return talentIcons[name] || talentIcons[baseName] || classTalentIcons[name] || classTalentIcons[baseName] || spellIcons[name] || spellIcons[baseName] || null;
};
function readSavedSpecs(classId) {
  try {
    const value = JSON.parse(localStorage.getItem(specStorageKey(classId)) || '[]');
    return Array.isArray(value) ? value.filter(spec => spec && typeof spec.id === 'string' && typeof spec.name === 'string' && spec.config && (spec.config.classId || 'mage') === classId) : [];
  } catch { return []; }
}
function readSavedTalents(classId, classData) {
  if (typeof document === 'undefined') return {};
  const cookieName = talentCookieName(classId);
  const rawCookie = document.cookie.split('; ').find(cookie => cookie.startsWith(`${cookieName}=`));
  if (!rawCookie) return {};
  try {
    const saved = JSON.parse(decodeURIComponent(rawCookie.slice(cookieName.length + 1)));
    const caps = Object.fromEntries(classData.talents.trees.flatMap(tree => tree.talents.map(talent => [talent.name, talent.max])));
    return Object.fromEntries(Object.entries(saved).filter(([name, rank]) => caps[name] && Number.isInteger(rank) && rank > 0 && rank <= caps[name]));
  } catch {
    return {};
  }
}
const defaultCondition = spell => ({
  conditional: ['Arcane Missiles', 'Ice Lance', 'Pyroblast', 'Scorch'].includes(spell.name),
  condition: spell.name === 'Arcane Missiles' ? 'missileBarrage' : spell.name === 'Ice Lance' ? 'fingersOfFrost' : spell.name === 'Pyroblast' ? 'hotStreak' : spell.name === 'Scorch' ? 'improvedScorch' : 'always',
});
const conditionForSpell = spell => ['Arcane Missiles', 'Ice Lance', 'Pyroblast', 'Scorch'].includes(spell.name) ? defaultCondition(spell).condition : spell.condition;
const immolateConditions = [
  { value: 'immolateInactive', label: 'Immolate is not active' },
];
function MultiConditionDropdown({ selected = [], onChange, includeImmolate = false, refreshDisabled = false, refreshWindow = 3 }) {
  const toggle = value => onChange(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]);
  const conditions = [...(includeImmolate ? immolateConditions : []), { value: 'debuffRefresh', label: `Apply/refresh debuff below ${refreshWindow} sec`, disabled: refreshDisabled }];
  return <details className="multi-condition-dropdown"><summary>{selected.length ? `CONDITIONS · ${selected.length}` : 'ADD CONDITIONS'}</summary><div className="multi-condition-menu"><small>Apply the debuff if it is missing. Otherwise refresh below 3 seconds, or below 5 seconds for casts longer than 3 seconds and stacking debuffs, to allow another attempt after a miss.</small>{conditions.map(condition => <label className={condition.disabled ? 'disabled' : ''} key={condition.value}><input type="checkbox" aria-label={condition.label} checked={selected.includes(condition.value)} disabled={condition.disabled} onChange={() => toggle(condition.value)}/><span>{condition.label}{condition.disabled ? ' · requires a debuff talent' : ''}</span></label>)}</div></details>;
}
function limitBuildToPoints(build, maxPoints) {
  const next = { ...build };
  let points = Object.values(next).reduce((sum, rank) => sum + rank, 0);
  for (const name of Object.keys(next).reverse()) {
    while (next[name] > 0 && points > maxPoints) {
      next[name]--;
      points--;
    }
    if (!next[name]) delete next[name];
  }
  return next;
}
function PetAbilityKit({ classData, pet, level }) {
  if (!pet) return null;
  return <details className="pet-ability-kit"><summary>VIEW {pet.abilities.length} PET ABILITIES</summary><div className="pet-ability-grid">{pet.abilities.map(ability => {
    const entries = (ability.ranks ? Array.from({ length: ability.ranks }, (_, index) => `Rank ${index + 1}`) : ['']).map(rank => {
      const detail = classData.spell_desc[`${classData.class}|${ability.name}|${rank}`];
      const learnedAt = Number(detail?.lv?.match(/\d+/)?.[0] || 1);
      return { rank, detail, learnedAt };
    });
    const availableEntries = entries.filter(entry => entry.learnedAt <= level);
    const current = availableEntries.at(-1);
    const firstRank = entries[0];
    return <details className={`pet-ability ${current ? '' : 'locked'}`} key={ability.name}><summary><b>{ability.name}</b><small>{current ? `${current.rank || 'Available'} · ${ability.type}` : `Unlocks at level ${firstRank.learnedAt}`}</small></summary><div>{current ? <p><b>{current.rank || ability.type} · max at level {level}</b>{current.detail?.lv && <small>{current.detail.lv}</small>}<span>{current.detail?.d || 'Ability description is not available in this data snapshot.'}</span></p> : <p><b>Not available yet</b><span>Unlocks at level {firstRank.learnedAt}.</span></p>}</div></details>;
  })}</div></details>;
}
const defaultNames = ['Arcane Missiles', 'Ice Lance', 'Frostbolt'];
const initialPriorityFor = (classData, level) => defaultNames.map(name => buildDamageSpellCatalog(classData, level).find(spell => spell.name === name)).filter(Boolean).map(spell => ({ ...spell, ...defaultCondition(spell) }));
const spellRankText = (classData, name, rank) => classData.spell_desc[`${classData.class}|${name}|${rank || ''}`]
  || Object.entries(classData.spell_desc).find(([key]) => key.startsWith(`${classData.class}|${name}|`))?.[1];
const manaCost = (spell, maxMana) => Math.max(0, (Number(spell.mana) || 0) + (Number(spell.manaFraction) || 0) * maxMana);
const talentRank = (build, name) => Number(build[name]) || 0;
const rankValue = (rank, values) => values[Math.max(0, Math.min(values.length - 1, rank - 1))] || 0;
const manaGems = [
  { name: 'Mana Agate', level: 28, minRestore: 375, maxRestore: 425 },
  { name: 'Mana Jade', level: 38, minRestore: 550, maxRestore: 650 },
  { name: 'Mana Citrine', level: 48, minRestore: 775, maxRestore: 925 },
  { name: 'Mana Ruby', level: 58, minRestore: 1000, maxRestore: 1200 },
];
const manaGemForLevel = level => manaGems.filter(gem => gem.level <= level).at(-1) || null;
export function simulate(priority, duration, maxMana, mp5, spirit, build, seed, baseHitChance, spellPower, manaOptions) {
  const effects = createEffectTracker(duration);
  const mp5PerSecond = Math.max(0, mp5) / 5;
  const spiritPerSecond = (Math.max(0, spirit) / 4 + 13) / 2;
  const GCD = 1.5;
  let time = 0, mana = maxMana, gcdUntil = 0, castUntil = 0;
  let damage = 0, casts = 0, crits = 0, manaSpent = 0;
  const cooldowns = new Map();
  const castCounts = new Map();
  const spellDamage = new Map();
  const spellCrits = new Map();
  const spellTicks = new Map();
  const missileBarrage = { active: false, since: null, procs: 0, uses: 0, uptime: 0 };
  const fingersOfFrost = { charges: 0, since: null, procs: 0, uses: 0, uptime: 0 };
  const clearcasting = { active: false, since: null, procs: 0, uses: 0 };
  const winterChill = { stacks: 0, until: -1, procs: 0 };
  const scorchVulnerability = { stacks: 0, until: -1, procs: 0 };
  const hotStreak = { stacks: 0, until: -1, procs: 0 };
  const ignites = [];
  const naturalDebuffs = new Map();
  let igniteDamage = 0, igniteTickCount = 0;
  let frozenUntil = -1;
  let arcaneBlastStacks = 0, arcaneBlastUntil = -1;
  let arcanePowerUntil = talentRank(build, 'Arcane Power') ? 15 : -1;
  let arcanePowerReadyAt = talentRank(build, 'Arcane Power') ? 180 : Infinity;
  if (arcanePowerUntil > 0) effects.apply('Arcane Power', 'buff', 0, arcanePowerUntil);
  let presenceOfMindReadyAt = talentRank(build, 'Presence of Mind') ? 0 : Infinity;
  let combustionActive = false;
  let combustionFireCrits = 0, combustionCritBonus = 0;
  let coldSnapReadyAt = talentRank(build, 'Cold Snap') ? 0 : Infinity;
  let evocationStart = -1, evocationUntil = -1;
  let evocationReadyAt = 0;
  let manaGemUsed = false;
  let lastSpellCastAt = -Infinity;
  const manaActions = { evocationUses: 0, evocationMana: 0, manaGemUses: 0, manaGemMana: 0, manaGemName: manaOptions.manaGem?.name || '' };
  const castLog = [];
  let randomState = seed >>> 0 || 1;
  const roll = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };
  const naturalDebuffDuration = spell => {
    if (spell.name === 'Blizzard' && talentRank(build, 'Improved Blizzard')) return 1.5;
    if (!/slow(?:s|ed|ing)?|freez(?:e|es|ed|ing)|chill/i.test(spell.tooltip || '')) return 0;
    return Number((spell.tooltip || '').match(/(?:for|up to)\s+(\d+)\s+sec/i)?.[1] || (spell.tooltip || '').match(/over\s+(\d+)\s+sec/i)?.[1] || 0);
  };
  const debuffRefreshReady = spell => {
    const refreshWindow = debuffRefreshWindow('mage', spell, build);
    const expiresSoon = until => until > time && until - time < refreshWindow;
    const naturalDebuff = naturalDebuffs.get(spell.name);
    if (naturalDebuffDuration(spell) > 0 && (!naturalDebuff || expiresSoon(naturalDebuff.until))) return true;
    const fire = spell.school === 'Fire' || spell.name === 'Frostfire Bolt';
    const frost = spell.school === 'Frost' || spell.name === 'Frostfire Bolt';
    if (talentRank(build, 'Ignite') && fire && (!ignites.length || ignites.some(ignite => expiresSoon(ignite.expiresAt)))) return true;
    if (talentRank(build, "Winter's Chill") && frost && (winterChill.stacks === 0 || expiresSoon(winterChill.until))) return true;
    if (talentRank(build, 'Improved Scorch') && spell.name === 'Scorch' && (scorchVulnerability.stacks === 0 || expiresSoon(scorchVulnerability.until))) return true;
    if (talentRank(build, 'Frostbite') && appliesChill(spell) && frozenUntil <= time) return true;
    return false;
  };
  const hasCondition = spell => {
    if (!spell.conditional) return true;
    const selected = Array.isArray(spell.conditions) ? spell.conditions : [];
    const legacy = conditionForSpell(spell) !== 'always' ? [conditionForSpell(spell)] : [];
    const conditions = [...new Set([...selected, ...legacy])];
    if (!conditions.length) return false;
    return conditions.some(condition => {
      if (condition === 'missileBarrage') return missileBarrage.active;
      if (condition === 'fingersOfFrost') return fingersOfFrost.charges > 0;
      if (condition === 'hotStreak') return talentRank(build, 'Hot Streak') > 0 && hotStreak.until >= time && (hotStreak.stacks >= 3 || (hotStreak.stacks >= 2 && hotStreak.until - time < 4));
      if (condition === 'improvedScorch') return talentRank(build, 'Improved Scorch') === 0 || scorchVulnerability.until < time || scorchVulnerability.stacks < 5 || scorchVulnerability.until - time < 5;
      if (condition === 'debuffRefresh') return debuffRefreshReady(spell);
      return false;
    });
  };
  const activeBuffs = () => [
    ...(missileBarrage.active ? [{ id: 'missileBarrage', name: 'Missile Barrage' }] : []),
    ...(fingersOfFrost.charges > 0 ? [{ id: 'fingersOfFrost', name: 'Fingers of Frost', charges: fingersOfFrost.charges }] : []),
    ...(clearcasting.active ? [{ id: 'clearcasting', name: 'Clearcasting' }] : []),
    ...(hotStreak.stacks > 0 && hotStreak.until >= time ? [{ id: 'hotStreak', name: 'Hot Streak', charges: hotStreak.stacks }] : []),
    ...(arcaneBlastStacks > 0 && arcaneBlastUntil >= time ? [{ id: 'arcaneBlast', name: 'Arcane Blast stacks', charges: arcaneBlastStacks }] : []),
    ...(frozen(time) ? [{ id: 'frozen', name: 'Frozen' }] : []),
    ...(time < arcanePowerUntil ? [{ id: 'arcanePower', name: 'Arcane Power' }] : []),
    ...(combustionActive ? [{ id: 'combustion', name: 'Combustion', charges: combustionFireCrits }] : []),
    ...(presenceOfMindReadyAt <= time ? [{ id: 'presenceOfMind', name: 'Presence of Mind' }] : []),
  ];
  const activeEnemyDebuffs = at => [
    ...(winterChill.stacks > 0 && winterChill.until >= at ? [{ id: 'winterChill', name: "Winter's Chill", stacks: winterChill.stacks, remaining: Math.max(0, winterChill.until - at) }] : []),
    ...(scorchVulnerability.stacks > 0 && scorchVulnerability.until >= at ? [{ id: 'scorch', name: 'Improved Scorch', stacks: scorchVulnerability.stacks, remaining: Math.max(0, scorchVulnerability.until - at) }] : []),
    ...[...naturalDebuffs].filter(([, effect]) => effect.until > at).map(([name, effect]) => ({ id: `natural-${name.toLowerCase().replaceAll(' ', '-')}`, name: `${name} slow`, remaining: effect.until - at })),
    ...(ignites.length ? [{ id: 'ignite', name: 'Ignite', applications: ignites.length, damage: ignites.reduce((sum, ignite) => sum + ignite.damage * Math.max(0, ignite.expiresAt - ignite.lastTickAt) / 4, 0), remaining: Math.max(0, ...ignites.map(ignite => ignite.expiresAt - at)) }] : []),
  ];
  const advanceIgnite = until => {
    while (ignites.length) {
      const tickAt = Math.min(...ignites.map(ignite => Math.min(ignite.nextTickAt, ignite.expiresAt)));
      if (tickAt > until) break;
      const debuffsAtTick = activeEnemyDebuffs(tickAt);
      let tickDamage = 0;
      for (const ignite of ignites) {
        const igniteTickAt = Math.min(ignite.nextTickAt, ignite.expiresAt);
        if (Math.abs(igniteTickAt - tickAt) > 1e-8) continue;
        tickDamage += ignite.damage * Math.max(0, igniteTickAt - ignite.lastTickAt) / 4;
        ignite.lastTickAt = igniteTickAt;
        if (igniteTickAt < ignite.expiresAt - 1e-8) ignite.nextTickAt += 2;
      }
      for (let i = ignites.length - 1; i >= 0; i--) {
        if (ignites[i].lastTickAt >= ignites[i].expiresAt - 1e-8) ignites.splice(i, 1);
      }
      damage += tickDamage;
      igniteDamage += tickDamage;
      igniteTickCount++;
      castLog.push({ time: tickAt, name: 'Ignite tick', school: 'Fire', hit: true, crit: false, activeBuffs: [], enemyDebuffs: debuffsAtTick, currentMana: mana, consumedBuffs: [], procs: [], damage: tickDamage, type: 'tick' });
    }
  };
  const procMissileBarrage = at => {
    missileBarrage.procs++;
    if (!missileBarrage.active) missileBarrage.since = at;
    missileBarrage.active = true;
    effects.apply('Missile Barrage', 'buff', at);
  };
  const procFingersOfFrost = at => {
    effects.apply('Fingers of Frost', 'buff', at);
    fingersOfFrost.procs++;
    if (fingersOfFrost.charges === 0) fingersOfFrost.since = at;
    fingersOfFrost.charges = Math.min(Math.max(1, build['Fingers of Frost']), Math.max(fingersOfFrost.charges, build['Fingers of Frost']));
  };
  const hasFireComponent = spell => spell.school === 'Fire' || spell.name === 'Frostfire Bolt';
  const hasFrostComponent = spell => spell.school === 'Frost' || spell.name === 'Frostfire Bolt';
  const appliesChill = spell => (spell.name === 'Blizzard' && talentRank(build, 'Improved Blizzard') > 0) || /slow|chill|freez/i.test(spell.tooltip || '');
  const frozen = at => fingersOfFrost.charges > 0 || frozenUntil >= at;
  const currentManaCost = (spell, at, max) => {
    let cost = manaCost(spell, max);
    if (hasFrostComponent(spell)) cost *= 1 - rankValue(talentRank(build, 'Frost Channeling'), [0.05, 0.1, 0.15]);
    if (spell.name === 'Arcane Blast' && arcaneBlastUntil >= at) cost *= 1 + 1.75 * arcaneBlastStacks;
    if (at < arcanePowerUntil) cost *= 1.3;
    if (clearcasting.active) cost = 0;
    return cost;
  };
  const castTimeFor = (spell, at) => {
    let castTime = Math.max(0, Number(spell.cast) || 0);
    if (spell.name === 'Frostbolt') castTime -= 0.1 * talentRank(build, 'Improved Frostbolt');
    if (['Fireball', 'Frostfire Bolt'].includes(spell.name)) castTime -= 0.1 * talentRank(build, 'Improved Fireball');
    if (spell.name === 'Pyroblast' && hotStreak.until >= at) castTime *= Math.max(0, 1 - 0.25 * hotStreak.stacks);
    if (!isDamageChannel(spell) && castTime > 0 && castTime < 10 && presenceOfMindReadyAt <= at) castTime = 0;
    return Math.max(0, castTime);
  };
  const usesPresenceOfMind = (spell, at) => !isDamageChannel(spell) && (Number(spell.cast) || 0) > 0 && (Number(spell.cast) || 0) < 10 && presenceOfMindReadyAt <= at;
  const damageMultiplierFor = (spell, at, frozenTarget, arcBlastBonusStacks = arcaneBlastStacks) => {
    let multiplier = 1 + 0.01 * talentRank(build, 'Arcane Instability');
    if (hasFireComponent(spell)) multiplier *= 1 + 0.02 * talentRank(build, 'Fire Power');
    if (hasFrostComponent(spell)) multiplier *= 1 + 0.02 * talentRank(build, 'Piercing Ice');
    if (spell.name === 'Cone of Cold') multiplier *= 1 + rankValue(talentRank(build, 'Improved Cone of Cold'), [0.12, 0.23, 0.35]);
    if (hasFireComponent(spell) && scorchVulnerability.until >= at) multiplier *= 1 + 0.03 * scorchVulnerability.stacks;
    if (spell.name !== 'Arcane Blast' && arcBlastBonusStacks > 0) multiplier *= 1 + 0.1 * arcBlastBonusStacks;
    if (at < arcanePowerUntil) multiplier *= 1.3;
    if (spell.name === 'Ice Lance' && frozenTarget) multiplier *= 4;
    return multiplier;
  };
  const critChanceFor = (spell, at, frozenTarget) => {
    let chance = 0.05 + 0.01 * talentRank(build, 'Arcane Instability');
    if (spell.school === 'Arcane') chance += 0.02 * talentRank(build, 'Arcane Impact');
    if (['Fire Blast', 'Ice Lance', 'Arcane Blast', 'Scorch'].includes(spell.name)) chance += 0.02 * talentRank(build, 'Incineration');
    if (spell.name === 'Flamestrike') chance += 0.05 * talentRank(build, 'Improved Flamestrike');
    if (hasFireComponent(spell)) chance += 0.02 * talentRank(build, 'Critical Mass');
    if (frozenTarget) chance += rankValue(talentRank(build, 'Shatter'), [0.17, 0.33, 0.5]);
    if (['Ice Lance', 'Frostbolt'].includes(spell.name) && winterChill.until >= at) chance += 0.02 * winterChill.stacks;
    if (combustionActive && hasFireComponent(spell)) chance += combustionCritBonus;
    return Math.min(1, Math.max(0, chance));
  };
  const hitChanceFor = spell => Math.min(1, Math.max(0, baseHitChance / 100 + (spell.school === 'Arcane' ? 0.01 * talentRank(build, 'Arcane Focus') : 0) + (['Fire', 'Frost'].includes(spell.school) ? 0.01 * talentRank(build, 'Elemental Precision') : 0)));
  const critMultiplierFor = spell => 1.5 + (spell.school === 'Arcane' ? 0.2 * talentRank(build, 'Arcane Mind') : 0) + (hasFrostComponent(spell) ? 0.2 * talentRank(build, 'Ice Shards') : 0);
  const maxEvents = Math.max(1000, Math.ceil(duration * 20));

  while (time < duration && casts < maxEvents) {
    const previousTime = time;
    const busyUntil = Math.max(castUntil, evocationUntil);
    const normalActionAt = Math.max(time, gcdUntil, busyUntil);
    time = normalActionAt;
    const elapsed = Math.max(0, time - previousTime);
    const castingElapsed = Math.max(0, Math.min(time, castUntil) - previousTime);
    const meditationRate = rankValue(talentRank(build, 'Arcane Meditation'), [0.17, 0.33, 0.5]);
    const evocationElapsed = evocationUntil > previousTime ? Math.max(0, Math.min(time, evocationUntil) - Math.max(previousTime, evocationStart)) : 0;
    const regularElapsed = Math.max(0, elapsed - evocationElapsed);
    const regularCastingElapsed = Math.min(regularElapsed, castingElapsed);
    const fullSpiritCastElapsed = Math.max(0, previousTime + regularCastingElapsed - Math.max(previousTime, lastSpellCastAt + 5));
    const underRuleSpiritCastElapsed = Math.max(0, regularCastingElapsed - fullSpiritCastElapsed);
    const regularSpiritIdleStart = previousTime + regularCastingElapsed;
    const regularSpiritIdleElapsed = Math.max(0, time - evocationElapsed - Math.max(regularSpiritIdleStart, lastSpellCastAt + 5));
    const regularSpiritGain = spiritPerSecond * (regularSpiritIdleElapsed + fullSpiritCastElapsed + underRuleSpiritCastElapsed * meditationRate);
    const evocationSpiritGain = spiritPerSecond * evocationElapsed * 16;
    const mp5ManaGain = mp5PerSecond * elapsed;
    mana = Math.min(maxMana, mana + regularSpiritGain + evocationSpiritGain + mp5ManaGain);
    advanceIgnite(time);
    if (evocationElapsed > 0 && time >= evocationUntil) evocationStart = -1;
    if (winterChill.until < time) winterChill.stacks = 0;
    if (scorchVulnerability.until < time) scorchVulnerability.stacks = 0;
    if (hotStreak.until < time) hotStreak.stacks = 0;
    if (arcaneBlastUntil < time) arcaneBlastStacks = 0;
    if (talentRank(build, 'Arcane Power') && time >= arcanePowerReadyAt) {
      arcanePowerUntil = time + 15;
      effects.apply('Arcane Power', 'buff', time, arcanePowerUntil);
      arcanePowerReadyAt = time + 180;
    }

    if (time >= duration || !priority.length) break;

    const isReady = spell => {
      if (spell.offGcd) return false;
      const readyAt = cooldowns.get(spell.name) || 0;
      const cost = spell.name === 'Arcane Missiles' && missileBarrage.active ? 0 : currentManaCost(spell, time, maxMana);
      return gcdUntil <= time && readyAt <= time && hasCondition(spell) && cost <= mana;
    };
    const usable = priority.find(spell => spell.conditional && isReady(spell)) || priority.find(spell => !spell.conditional && isReady(spell));
    const combustionReadyAt = cooldowns.get('Combustion') || 0;
    if (priority.some(spell => spell.offGcd && spell.name === 'Combustion') && talentRank(build, 'Combustion') && combustionReadyAt <= time && castUntil <= time && evocationUntil <= time) {
      combustionActive = true;
      effects.apply('Combustion', 'buff', time);
      combustionCritBonus = 0;
      combustionFireCrits = 0;
      cooldowns.set('Combustion', time + combustionSpell.cooldown);
      castLog.push({ time, name: 'Combustion', school: 'Fire', hit: true, crit: false, activeBuffs: activeBuffs(), enemyDebuffs: activeEnemyDebuffs(time), currentMana: mana, consumedBuffs: [], procs: ['OFF-GCD · PRIORITY'], damage: 0, type: 'off-gcd' });
    }

    if (usable) {
      const buffsAtCast = activeBuffs();
      const debuffsAtCast = activeEnemyDebuffs(time);
      const usesMissileBarrage = usable.name === 'Arcane Missiles' && missileBarrage.active;
      const usesClearcasting = clearcasting.active;
      const usesHotStreak = usable.name === 'Pyroblast' && hotStreak.until >= time;
      const frozenTarget = frozen(time);
      const arcBlastBonusStacks = arcaneBlastUntil >= time ? arcaneBlastStacks : 0;
      const cost = usesMissileBarrage || usesClearcasting ? 0 : currentManaCost(usable, time, maxMana);
      let castTime = castTimeFor(usable, time);
      if (usesMissileBarrage) castTime *= 0.5;
      const cooldownReduction = usable.name === 'Fire Blast' ? talentRank(build, 'Wake of Fire') : usable.name === 'Frost Nova' ? 2 * talentRank(build, 'Improved Frost Nova') : 0;
      const cooldown = Math.max(0, (Number(usable.cooldown) || 0) - cooldownReduction);
      const consumedFingersOfFrost = fingersOfFrost.charges > 0;
      const consumedBuffs = [];
      mana = Math.max(0, mana - cost);
      manaSpent += cost;
      lastSpellCastAt = time;
      if (usesClearcasting) {
        clearcasting.active = false;
        effects.remove('Clearcasting', 'buff', time);
        clearcasting.uses++;
        clearcasting.since = null;
        consumedBuffs.push('Clearcasting');
      }
      if (usesPresenceOfMind(usable, time)) {
        presenceOfMindReadyAt = time + 180;
        consumedBuffs.push('Presence of Mind');
      }
      if (usesHotStreak) {
        hotStreak.stacks = 0;
        hotStreak.until = -1;
        effects.remove('Hot Streak', 'buff', time);
        consumedBuffs.push('Hot Streak');
      }
      if (usable.name !== 'Arcane Blast' && arcaneBlastStacks) {
        arcaneBlastStacks = 0;
        arcaneBlastUntil = -1;
        effects.remove('Arcane Blast stacks', 'buff', time);
        consumedBuffs.push('Arcane Blast charges');
      }
      cooldowns.set(usable.name, time + cooldown);
      castUntil = time + castTime;
      gcdUntil = time + GCD;
      if (usesMissileBarrage) {
        missileBarrage.active = false;
        effects.remove('Missile Barrage', 'buff', time);
        missileBarrage.uses++;
        missileBarrage.uptime += Math.max(0, time - missileBarrage.since);
        missileBarrage.since = null;
        consumedBuffs.push('Missile Barrage');
      }
      if (consumedFingersOfFrost) {
        fingersOfFrost.charges--;
        fingersOfFrost.uses++;
        consumedBuffs.push(`Fingers of Frost${fingersOfFrost.charges ? ` (${fingersOfFrost.charges} left)` : ''}`);
        if (fingersOfFrost.charges === 0) {
          effects.remove('Fingers of Frost', 'buff', time);
          fingersOfFrost.uptime += Math.max(0, time - fingersOfFrost.since);
          fingersOfFrost.since = null;
        }
      }
      const channeled = isDamageChannel(usable);
      const channelHit = channeled ? roll() < hitChanceFor(usable) : null;
      const tickCount = channeled ? Math.max(1, Math.ceil((usable.cast || castTime) / channelTickInterval(usable))) : 1;
      if (channeled) {
        casts++;
        castCounts.set(usable, (castCounts.get(usable) || 0) + 1);
        castLog.push({ time, name: usable.name, school: usable.school, specialization: usable.specialization, hit: channelHit, crit: false, activeBuffs: buffsAtCast, enemyDebuffs: debuffsAtCast, currentMana: mana, consumedBuffs, procs: channelHit ? [] : ['Channel cancelled · 1.5s recovery'], damage: 0, type: 'cast' });
        if (!channelHit) { castUntil = time; gcdUntil = time + 1.5; continue; }
      }
      for (let tickIndex = 0; tickIndex < tickCount; tickIndex++) {
        const completionTime = time + (channeled ? castTime * (tickIndex + 1) / tickCount : castTime);
        if (completionTime > duration) break;
        advanceIgnite(completionTime);
        const spellPowerDamage = Math.max(0, Number(spellPower) || 0) * (Number(usable.coefficient) || 0);
        const baseDamage = (Math.max(0, Number(usable.damage) || 0) + spellPowerDamage) * damageMultiplierFor(usable, time, frozenTarget, arcBlastBonusStacks);
        const hit = channeled && tickIndex === 0 ? channelHit : roll() < hitChanceFor(usable);
        const isCrit = hit && roll() < critChanceFor(usable, time, frozenTarget);
        const castDamage = hit ? baseDamage / tickCount * (isCrit ? critMultiplierFor(usable) : 1) : 0;
        const totalCastDamage = castDamage;
        damage += totalCastDamage;
        spellDamage.set(usable, (spellDamage.get(usable) || 0) + totalCastDamage);
        if (isCrit) {
          crits++;
          spellCrits.set(usable, (spellCrits.get(usable) || 0) + 1);
        }
        const masterOfElementsRefund = isCrit && (hasFireComponent(usable) || hasFrostComponent(usable))
          ? manaCost(usable, maxMana) * rankValue(talentRank(build, 'Master of Elements'), [0.1, 0.2, 0.3])
          : 0;
        const actualManaRefund = Math.min(masterOfElementsRefund, maxMana - mana);
        if (actualManaRefund) {
          mana += actualManaRefund;
          manaSpent = Math.max(0, manaSpent - actualManaRefund);
        }
        if (!channeled) { casts++; castCounts.set(usable, (castCounts.get(usable) || 0) + 1); }
        else spellTicks.set(usable, (spellTicks.get(usable) || 0) + 1);
        const procs = [];
        const naturalDuration = naturalDebuffDuration(usable);
        if (hit && naturalDuration > 0) {
          effects.apply(`${usable.name} slow`, 'debuff', completionTime, completionTime + naturalDuration);
          naturalDebuffs.set(usable.name, { until: completionTime + naturalDuration, duration: naturalDuration });
          procs.push(`${usable.name} slow · ${naturalDuration}s`);
        }
        let igniteApplied = 0;
        const ignitePct = rankValue(talentRank(build, 'Ignite'), [0.08, 0.16, 0.24, 0.32, 0.4]);
        if (hit && isCrit && hasFireComponent(usable) && ignitePct > 0) {
          igniteApplied = castDamage * ignitePct;
          effects.apply('Ignite', 'debuff', completionTime, completionTime + 4);
          const nextTickAt = (Math.floor((completionTime + 1e-8) / 2) + 1) * 2;
          ignites.push({ damage: igniteApplied, appliedAt: completionTime, lastTickAt: completionTime, nextTickAt, expiresAt: completionTime + 4 });
          procs.push(`Ignite · +${Math.round(igniteApplied)} damage, expires in 4s`);
        }
        const missileBarrageChance = usable.name === 'Arcane Blast' ? 0.4 : ['Fireball', 'Frostbolt', 'Frostfire Bolt'].includes(usable.name) ? 0.2 : 0;
        if (hit && build['Missile Barrage'] && missileBarrageChance && roll() < missileBarrageChance) {
          procMissileBarrage(completionTime);
          procs.push('Missile Barrage');
        }
        if (hit && build['Fingers of Frost'] && appliesChill(usable) && roll() < 0.15) {
          procFingersOfFrost(completionTime);
          procs.push(`Fingers of Frost${fingersOfFrost.charges > 1 ? ` ×${fingersOfFrost.charges}` : ''}`);
        }
        const clearcastingChance = 0.02 * talentRank(build, 'Arcane Concentration');
        if (hit && clearcastingChance && roll() < clearcastingChance) {
          clearcasting.procs++;
          if (!clearcasting.active) clearcasting.since = completionTime;
          clearcasting.active = true;
          effects.apply('Clearcasting', 'buff', completionTime);
          procs.push('Clearcasting');
        }
        const frostbiteChance = rankValue(talentRank(build, 'Frostbite'), [0.05, 0.1, 0.15]);
        if (hit && frostbiteChance && appliesChill(usable) && roll() < frostbiteChance) {
          frozenUntil = completionTime + 5;
          effects.apply('Frozen', 'debuff', completionTime, frozenUntil);
          procs.push('Frozen');
        }
        const winterChillChance = 0.2 * talentRank(build, "Winter's Chill");
        if (hit && winterChillChance && hasFrostComponent(usable) && roll() < winterChillChance) {
          winterChill.procs++;
          winterChill.stacks = Math.min(talentRank(build, "Winter's Chill"), winterChill.stacks + 1);
          winterChill.until = completionTime + 15;
          effects.apply("Winter's Chill", 'debuff', completionTime, winterChill.until);
          procs.push(`Winter's Chill ×${winterChill.stacks}`);
        }
        const scorchChance = rankValue(talentRank(build, 'Improved Scorch'), [0.33, 0.67, 1]);
        if (hit && scorchChance && usable.name === 'Scorch' && roll() < scorchChance) {
          scorchVulnerability.procs++;
          scorchVulnerability.stacks = Math.min(5, scorchVulnerability.stacks + 1);
          scorchVulnerability.until = completionTime + 30;
          effects.apply('Improved Scorch', 'debuff', completionTime, scorchVulnerability.until);
          procs.push(`Scorch vulnerability ×${scorchVulnerability.stacks}`);
        }
        const hotStreakEligible = ['Fireball', 'Frostfire Bolt', 'Fire Blast', 'Scorch'].includes(usable.name);
        if (build['Hot Streak'] && isCrit && hotStreakEligible) {
          hotStreak.procs++;
          hotStreak.stacks = Math.min(3, hotStreak.stacks + 1);
          hotStreak.until = completionTime + 15;
          effects.apply('Hot Streak', 'buff', completionTime, hotStreak.until);
          procs.push(`Hot Streak ×${hotStreak.stacks}`);
        }
        if (build['Arcane Blast'] && usable.name === 'Arcane Blast') {
          arcaneBlastStacks = Math.min(4, arcaneBlastStacks + 1);
          arcaneBlastUntil = completionTime + 8;
          effects.apply('Arcane Blast stacks', 'buff', completionTime, arcaneBlastUntil);
          procs.push(`Arcane Blast ×${arcaneBlastStacks}`);
        }
        if (hit && build['Combustion'] && combustionActive && hasFireComponent(usable)) {
          combustionCritBonus += 0.1;
          if (isCrit) combustionFireCrits++;
          if (combustionFireCrits >= 4) { combustionActive = false; effects.remove('Combustion', 'buff', completionTime); }
        }
        castLog.push({ time: channeled ? completionTime : time, name: channeled ? `${usable.name} tick` : usable.name, type: channeled ? 'tick' : 'cast', school: usable.school, specialization: usable.specialization, hit, crit: isCrit, activeBuffs: buffsAtCast, enemyDebuffs: debuffsAtCast, currentMana: mana, consumedBuffs: channeled ? [] : consumedBuffs, procs, damage: totalCastDamage, igniteApplied, manaRefund: masterOfElementsRefund });
      }
      continue;
    }

    const manaStarved = priority.some(spell => {
      if (spell.offGcd) return false;
      const readyAt = cooldowns.get(spell.name) || 0;
      const cost = spell.name === 'Arcane Missiles' && missileBarrage.active ? 0 : currentManaCost(spell, time, maxMana);
      return gcdUntil <= time && readyAt <= time && hasCondition(spell) && time + castTimeFor(spell, time) <= duration && cost > mana && cost <= maxMana;
    });
    if (manaStarved && manaOptions.useEvocation && evocationReadyAt <= time && time + 8 <= duration) {
      const restored = spiritPerSecond * 16 * 8 + mp5PerSecond * 8;
      if (restored > 0 && maxMana - mana >= restored) {
        evocationStart = time;
        evocationUntil = time + 8;
        effects.apply('Evocation', 'buff', time, evocationUntil);
        evocationReadyAt = time + 480;
        manaActions.evocationUses++;
        manaActions.evocationMana += restored;
        castLog.push({ time, name: 'Evocation', school: 'Arcane', hit: true, crit: false, activeBuffs: activeBuffs(), enemyDebuffs: activeEnemyDebuffs(time), currentMana: mana, consumedBuffs: [], procs: [`MANA · +${Math.round(restored)}`], damage: 0, type: 'mana' });
        continue;
      }
    }
    const gem = manaOptions.manaGem;
    if (manaStarved && manaOptions.useManaGem && gem && !manaGemUsed && maxMana - mana >= gem.maxRestore) {
      const restored = Math.min(maxMana - mana, Math.floor(gem.minRestore + roll() * (gem.maxRestore - gem.minRestore + 1)));
      mana = Math.min(maxMana, mana + restored);
      manaGemUsed = true;
      manaActions.manaGemUses++;
      manaActions.manaGemMana += restored;
      castLog.push({ time, name: gem.name, school: 'Arcane', hit: true, crit: false, activeBuffs: activeBuffs(), enemyDebuffs: activeEnemyDebuffs(time), currentMana: mana, consumedBuffs: [], procs: [`MANA · +${Math.round(restored)}`], damage: 0, type: 'mana' });
      continue;
    }

    // Cold Snap is modeled as an automatic, off-GCD reset when a selected Frost spell
    // is waiting on cooldown. It can reset again after its 8-minute cooldown.
    const frostSpellOnCooldown = priority.some(spell => spell.school === 'Frost' && (cooldowns.get(spell.name) || 0) > time);
    if (time >= coldSnapReadyAt && talentRank(build, 'Cold Snap') && frostSpellOnCooldown) {
      priority.filter(spell => spell.school === 'Frost').forEach(spell => cooldowns.set(spell.name, time));
      coldSnapReadyAt = time + 480;
      continue;
    }

    let wakeAt = priority.reduce((earliest, spell) => {
      if (spell.offGcd || !hasCondition(spell)) return earliest;
      const cost = spell.name === 'Arcane Missiles' && missileBarrage.active ? 0 : currentManaCost(spell, time, maxMana);
      if (cost > maxMana) return earliest;
      const manaWait = mana >= cost ? 0 : (() => {
        const deficit = cost - mana;
        if (mp5PerSecond <= 0 && spiritPerSecond <= 0) return Infinity;
        const beforeSpirit = Math.max(0, lastSpellCastAt + 5 - time);
        const manaAtSpiritStart = mana + beforeSpirit * mp5PerSecond;
        if (manaAtSpiritStart >= cost) return deficit / Math.max(mp5PerSecond, 0.000001);
        if (mp5PerSecond + spiritPerSecond <= 0) return Infinity;
        return beforeSpirit + (cost - manaAtSpiritStart) / (mp5PerSecond + spiritPerSecond);
      })();
      const usableAt = Math.max(gcdUntil, cooldowns.get(spell.name) || 0, time + manaWait);
      return Math.min(earliest, usableAt);
    }, Infinity);
    if (!Number.isFinite(wakeAt) || wakeAt <= time || wakeAt >= duration) break;
    const idleSpiritStart = Math.max(time, lastSpellCastAt + 5);
    const idleSpiritElapsed = Math.max(0, wakeAt - idleSpiritStart);
    mana = Math.min(maxMana, mana + (wakeAt - time) * mp5PerSecond + idleSpiritElapsed * spiritPerSecond);
    time = wakeAt;
  }

  if (missileBarrage.active && missileBarrage.since !== null) missileBarrage.uptime += Math.max(0, duration - missileBarrage.since);
  if (fingersOfFrost.charges > 0 && fingersOfFrost.since !== null) fingersOfFrost.uptime += Math.max(0, duration - fingersOfFrost.since);
  advanceIgnite(duration);
  castLog.sort((a, b) => a.time - b.time);

  return {
    damage,
    casts,
    crits,
    dps: duration ? damage / duration : 0,
    manaSpent,
    manaActions,
    effectUptimes: effects.summary(),
    buffs: [
      { id: 'missileBarrage', name: 'Missile Barrage', procs: missileBarrage.procs, uses: missileBarrage.uses, uptime: missileBarrage.uptime, uptimePct: duration ? missileBarrage.uptime / duration * 100 : 0, activeAtEnd: missileBarrage.active, rank: build['Missile Barrage'] || 0 },
      { id: 'fingersOfFrost', name: 'Fingers of Frost', procs: fingersOfFrost.procs, uses: fingersOfFrost.uses, uptime: fingersOfFrost.uptime, uptimePct: duration ? fingersOfFrost.uptime / duration * 100 : 0, activeAtEnd: fingersOfFrost.charges > 0, chargesAtEnd: fingersOfFrost.charges, rank: build['Fingers of Frost'] || 0 },
    ],
    castLog,
        events: [...priority.map(spell => ({ name: spell.name, specialization: spell.specialization, damage: spellDamage.get(spell) || 0, casts: castCounts.get(spell) || 0, crits: spellCrits.get(spell) || 0, ticks: spellTicks.get(spell) || 0 })), ...(igniteTickCount ? [{ name: 'Ignite', specialization: 'Fire', damage: igniteDamage, casts: 0, crits: 0, ticks: igniteTickCount }] : [])],
  };
}

const resultStoragePrefix = '4esim_sim_result_';
const batchSize = 1000;
// Add a class data bundle and a simulator here to make it selectable and runnable.
const simulatorByClass = Object.fromEntries(Object.keys(classDataLoaders).map(id => [id, id === 'mage' ? simulate : id === 'warlock' ? simulateWarlock : simulateGeneric]));
const readSimulationReport = id => {
  try { return JSON.parse(localStorage.getItem(`${resultStoragePrefix}${id}`) || 'null'); }
  catch { return null; }
};
const medianOf = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function ResultsPage({ id }) {
  const [report] = useState(() => readSimulationReport(id));
  const [showPetTimelineEvents, setShowPetTimelineEvents] = useState(true);
  if (!report) return <div className="results-shell"><main className="results-main"><p>This simulation report isn’t available in this browser. Return to the simulator and run it again.</p><a className="run-btn" href={siteBaseUrl}>OPEN SIMULATOR</a></main></div>;
  const { metrics, medianRun, histogram, config, completedAt } = report;
  const reportTimeline = showPetTimelineEvents ? medianRun.castLog : medianRun.castLog.filter(entry => entry.type !== 'pet');
  const maxEvents = Math.max(1, ...medianRun.events.map(event => event.damage));
  return <div className="results-shell" style={{ '--accent': config.accent || '#69CCF0' }}>
    <header className="results-topbar"><a href={siteBaseUrl} className="results-brand"><span>4e</span><b>4esim</b></a><div>SIMULATION REPORT <i/> {new Date(completedAt).toLocaleString()}</div><a className="results-back" href={siteBaseUrl}>BACK TO ROTATION LAB ↗</a></header>
    <main className="results-main">
      <div className="eyebrow">MONTE CARLO SIMULATION · {report.runs.toLocaleString()} ITERATIONS</div>
      <h1>Rotation <em>results.</em></h1>
      <p className="results-subtitle">{config.duration}s encounter · {config.baseHitChance}% base hit per school · {config.spellPower.toLocaleString()} spell power · {config.regenPer5s.toLocaleString()} MP5 · {config.spirit.toLocaleString()} Spirit · {config.priority.map((spell, i) => `${i + 1}. ${spell.name}`).join(' → ')}</p>
      <section className="report-metrics">
        <article className="report-metric featured"><span>MEDIAN DPS</span><strong>{metrics.medianDps.toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong><small>primary result across {report.runs.toLocaleString()} runs</small></article>
        <article className="report-metric"><span>MEAN DPS</span><strong>{metrics.meanDps.toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong><small>average of all runs</small></article>
        <article className="report-metric"><span>10TH–90TH PERCENTILE</span><strong>{metrics.p10Dps.toFixed(1)}–{metrics.p90Dps.toFixed(1)}</strong><small>middle 80% of simulated outcomes</small></article>
        <article className="report-metric"><span>LOW–HIGH</span><strong>{metrics.minDps.toFixed(1)}–{metrics.maxDps.toFixed(1)}</strong><small>observed range</small></article>
      </section>
      <section className="report-panel"><div className="report-panel-heading"><div><span>OUTCOME SPREAD</span><h2>DPS distribution</h2></div><b>{report.runs.toLocaleString()} RUNS</b></div><div className="histogram">{histogram.map((bin, i) => <div className="histogram-bar" key={i} title={`${bin.count} runs · ${bin.from.toFixed(1)}–${bin.to.toFixed(1)} DPS`}><i style={{ height: `${Math.max(bin.count ? 3 : 0, bin.count / report.histogramMax * 100)}%` }}/></div>)}</div><div className="histogram-labels"><span>{metrics.minDps.toFixed(1)} DPS</span><span>MEDIAN {metrics.medianDps.toFixed(1)}</span><span>{metrics.maxDps.toFixed(1)} DPS</span></div></section>
      <div className="report-columns">
        <section className="report-panel"><div className="report-panel-heading"><div><span>MEDIAN RUN · {medianRun.casts} CASTS</span><h2>Damage by spell</h2></div><b>{Math.round(medianRun.damage).toLocaleString()} TOTAL</b></div><div className="report-spells"><div className="report-spell-head"><span>SPELL</span><span>CASTS / CRITS</span><span>DAMAGE</span></div>{medianRun.events.map(event => <div className="report-spell-row" key={event.name}><span>{event.name}</span><span>{event.ticks ? `${event.ticks} ticks` : `${event.casts} / ${event.crits}`}</span><div><i><b style={{ width: `${Math.max(event.damage ? 2 : 0, event.damage / maxEvents * 100)}%` }}/></i><strong>{Math.round(event.damage).toLocaleString()}</strong></div></div>)}</div></section>
        <section className="report-panel"><div className="report-panel-heading"><div><span>MEDIAN RUN</span><h2>Encounter details</h2></div></div><div className="report-detail-grid"><div><span>HIT RATE</span><b>{(metrics.medianHitRate * 100).toFixed(1)}%</b></div><div><span>CRIT RATE</span><b>{(metrics.medianCritRate * 100).toFixed(1)}%</b></div><div><span>CRITICAL HITS</span><b>{medianRun.crits}</b></div><div><span>MANA SPENT</span><b>{Math.round(medianRun.manaSpent).toLocaleString()}</b></div></div>{config.classId === 'warlock' && <div className="report-buffs"><span>SOUL SHARDS</span><div><b>{medianRun.soulShards ?? 0} remaining</b><small>{medianRun.startingSoulShards ?? config.soulShards ?? 0} starting · {medianRun.soulShardsSpent ?? 0} spent · {medianRun.soulShardsRefunded ?? 0} refunded</small></div></div>}<EffectUptimeSection effects={medianRun.effectUptimes}/><div className="report-buffs"><span>PROC BUFF ACTIVITY</span>{medianRun.buffs.map(buff => <div key={buff.id}><b>{buff.name}</b><small>{buff.procs} procs · {buff.uses} used · {buff.uptime.toFixed(1)}s uptime</small></div>)}</div>{config.classId === 'mage' && <div className="report-buffs"><span>MANA TOOL USE · MEDIAN RUN</span><div><b>Evocation</b><small>{medianRun.manaActions.evocationUses} uses · {Math.round(medianRun.manaActions.evocationMana).toLocaleString()} mana restored</small></div>{config.manaGem && <div><b>{config.manaGem.name}</b><small>{medianRun.manaActions.manaGemUses} uses · {Math.round(medianRun.manaActions.manaGemMana).toLocaleString()} mana restored</small></div>}</div>}<div className="report-build"><span>SELECTED TALENTS</span><p>{Object.entries(config.build).filter(([, rank]) => rank > 0).map(([name, rank]) => `${name} ${rank}`).join(' · ') || 'None'}</p></div></section>
      </div>
      <section className="report-panel report-timeline"><div className="report-panel-heading"><div><span>REPRESENTATIVE RUN · CLOSEST TO MEDIAN DPS</span><h2>Cast timeline</h2></div><div className="timeline-controls"><label className="log-toggle"><input type="checkbox" checked={showPetTimelineEvents} onChange={event => setShowPetTimelineEvents(event.target.checked)}/> SHOW PET EVENTS</label><b>{reportTimeline.filter(entry => entry.type !== 'tick').length} ACTIONS</b></div></div><div className="cast-timeline"><div className="cast-timeline-head"><span>TIME</span><span>CAST</span><span>DAMAGE</span><span>MANA</span><span>ACTIVE BUFFS</span><span>ENEMY DEBUFFS</span><span>BUFF CHANGES</span></div>{reportTimeline.map((entry, index) => <div className="cast-timeline-row" key={`${entry.time}-${entry.name}-${index}`}><time>{formatTime(entry.time)}</time><span className="cast-log-spell"><i className={`school-icon ${entry.school.toLowerCase()}`}>{entry.school === 'Frost' ? '❄' : entry.school === 'Fire' ? '♨' : '✧'}</i><b>{entry.name}</b>{entry.specialization && <small className="spell-specialization-tag">{entry.specialization}</small>}{entry.crit && <em>CRIT</em>}{!entry.hit && <em className="miss">MISS</em>}</span><span className="cast-log-damage">{Math.round(entry.damage ?? 0).toLocaleString()}</span><span className="cast-log-mana">{Math.round(entry.currentMana ?? 0).toLocaleString()}</span><span className="cast-log-buffs">{entry.activeBuffs.length ? entry.activeBuffs.map(buff => <EffectIcon key={buff.id} effect={buff}/>) : <small>—</small>}</span><span className="cast-log-debuffs">{entry.enemyDebuffs?.length ? entry.enemyDebuffs.map(debuff => <span className="debuff-effect" key={debuff.id}><EffectIcon effect={debuff}/><small>{debuff.remaining.toFixed(1)}s</small></span>) : <small>—</small>}</span><span className="cast-log-changes">{entry.procs.map((buff, i) => <EffectChange key={`p${i}`} label={buff} mode="proc"/> )}{entry.consumedBuffs.map((buff, i) => <EffectChange key={`u${i}`} label={buff} mode="used"/> )}{!entry.procs.length && !entry.consumedBuffs.length && <small>—</small>}</span></div>)}</div></section>
      <p className="report-footnote">Statistics summarize {report.runs.toLocaleString()} independent random simulations. Spell damage, casts, crits, proc activity, and timeline are from the run closest to the median DPS.</p>
    </main>
  </div>;
}

export default function App() {
  const resultId = new URLSearchParams(window.location.search).get('results');
  return resultId ? <ResultsPage id={resultId}/> : <SimulatorApp/>;
}

function SimulatorApp() {
  const [selectedClass, setSelectedClass] = useState(() => {
    try {
      const savedClass = localStorage.getItem('4esim_selected_class');
      if (classRegistry.some(characterClass => characterClass.id === savedClass && characterClass.available)) return savedClass;
    } catch { /* Storage may be unavailable in private browsing. */ }
    return 'mage';
  });
  const [loadedClasses, setLoadedClasses] = useState({});
  const [activePetId, setActivePetId] = useState(() => {
    try {
      const level = Math.min(60, Math.max(1, Number(localStorage.getItem('4esim_character_level')) || 60));
      const unlocked = petsForClass('warlock').filter(pet => pet.level <= level);
      const saved = localStorage.getItem('4esim_active_pet_warlock');
      return unlocked.some(pet => pet.id === saved) ? saved : (unlocked.at(-1)?.id || '');
    } catch { return 'imp'; }
  });
  const [sacrificePet, setSacrificePet] = useState(false);
  const [sacrificedPetId, setSacrificedPetId] = useState('');
  const [soulShards, setSoulShards] = useState(10);
  const [build, setBuild] = useState({});
  const activeClass = classRegistry.find(characterClass => characterClass.id === selectedClass && characterClass.available && classDataLoaders[characterClass.id] && simulatorByClass[characterClass.id]) || classRegistry.find(characterClass => characterClass.available && classDataLoaders[characterClass.id] && simulatorByClass[characterClass.id]);
  const classData = loadedClasses[selectedClass];
  const classPets = petsForClass(selectedClass);
  const activePet = classPets.find(pet => pet.id === activePetId) || null;
  const activeTalentPage = `${activeClass.name} talents`;
  const classBookTabs = classData ? [...(classData.spellbook.general?.length ? [{ name: 'General', spells: classData.spellbook.general }] : []), ...classData.spellbook.tabs] : [];
  const [duration, setDuration] = useState(180);
  const [startingMana, setStartingMana] = useState(5000);
  const [regen, setRegen] = useState(100);
  const [spirit, setSpirit] = useState(0);
  const [spellPower, setSpellPower] = useState(0);
  const [useEvocation, setUseEvocation] = useState(true);
  const [useManaGem, setUseManaGem] = useState(true);
  const [baseHitChance, setBaseHitChance] = useState(83);
  const [targetHealthPercent, setTargetHealthPercent] = useState(100);
  const [scaleTargetHealth, setScaleTargetHealth] = useState(false);
  const [talentLevel, setTalentLevel] = useState(() => {
    try { return Math.min(60, Math.max(1, Number(localStorage.getItem('4esim_character_level')) || 60)); } catch { return 60; }
  });
  const damageSpellCatalog = classData ? buildDamageSpellCatalog(classData, talentLevel) : [];
  const petState = warlockPetState(build, { activePetId, sacrificePet, sacrificedPetId, talentLevel });
  const petAttack = Boolean(petState.activePetId) && (activePet?.abilities.find(ability => ability.type === 'Attack' && damageSpellCatalog.some(spell => spell.name === ability.name))
    || activePet?.abilities.find(ability => damageSpellCatalog.some(spell => spell.name === ability.name)));
  const petSpell = petAttack ? damageSpellCatalog.find(spell => spell.name === petAttack.name) : null;
  const petAttackProfile = selectedClass === 'warlock' && petState.activePetId
    ? petAttackProfileFor(petAttackProfiles, activePetId, talentLevel)
    : null;
  const lifeTapRanks = selectedClass === 'warlock' && classData ? Object.entries(classData.spell_desc).filter(([key, detail]) => key.startsWith('Warlock|Life Tap|') && Number(detail.lv?.match(/level\s+(\d+)/i)?.[1] || 1) <= talentLevel).sort((a, b) => numberFromText(a[0]) - numberFromText(b[0])) : [];
  const lifeTapText = lifeTapRanks.at(-1)?.[1]?.d || '';
  const lifeTap = lifeTapText.match(/Converts\s+([\d,]+)\s+Health into\s+([\d,]+)\s+Mana/i) ? { health: numberFromText(lifeTapText.match(/Converts\s+([\d,]+)\s+Health into\s+([\d,]+)\s+Mana/i)[1]), mana: numberFromText(lifeTapText.match(/Converts\s+([\d,]+)\s+Health into\s+([\d,]+)\s+Mana/i)[2]) } : null;
  const [hoveredTalent, setHoveredTalent] = useState(null);
  const tooltipTimer = useRef(null);
  const [rotation, setRotation] = useState([]);
  const [draggedPriority, setDraggedPriority] = useState(null);
  const [dragOverPriority, setDragOverPriority] = useState(null);
  const [simulation, setSimulation] = useState(null);
  const [showCastTimeline, setShowCastTimeline] = useState(false);
  const [showPetTimelineEvents, setShowPetTimelineEvents] = useState(true);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [spellSearch, setSpellSearch] = useState('');
  const [active, setActive] = useState('Rotation lab');
  const [savedSpecs, setSavedSpecs] = useState(() => readSavedSpecs(selectedClass));
  const [selectedSpecId, setSelectedSpecId] = useState(() => {
    try { return localStorage.getItem(`4esim_active_${selectedClass}_spec`) || ''; } catch { return ''; }
  });
  const [specName, setSpecName] = useState('');
  const setCharacterLevel = rawLevel => {
    const level = Math.min(60, Math.max(1, Number(rawLevel) || 1));
    setTalentLevel(level);
    const availablePoints = Math.max(0, level - 9);
    setBuild(previous => limitBuildToPoints(previous, availablePoints));
    const unlockedPets = classPets.filter(pet => pet.level <= level);
    setActivePetId(current => unlockedPets.some(pet => pet.id === current) ? current : (unlockedPets.at(-1)?.id || ''));
  };
  useEffect(() => {
    if (loadedClasses[selectedClass]) return;
    let cancelled = false;
    classDataLoaders[selectedClass]().then(module => {
      if (!cancelled) setLoadedClasses(current => ({ ...current, [selectedClass]: addSpellMetadata(module.default) }));
    });
    return () => { cancelled = true; };
  }, [selectedClass, loadedClasses]);
  useEffect(() => {
    if (!classData) return;
    document.cookie = `${talentCookieName(selectedClass)}=${encodeURIComponent(JSON.stringify(build))}; Max-Age=31536000; Path=/; SameSite=Lax`;
  }, [build, selectedClass, classData]);
  useEffect(() => {
    try { localStorage.setItem('4esim_selected_class', selectedClass); } catch { /* Storage may be unavailable in private browsing. */ }
    if (!classData) return;
    setStartingMana(selectedClass === 'warrior' ? 0 : resourceCapForClass(selectedClass));
    setRegen(selectedClass === 'warrior' ? 0 : 100);
    setSpirit(0);
    setBuild(limitBuildToPoints(readSavedTalents(selectedClass, classData), Math.max(0, talentLevel - 9)));
    setRotation(selectedClass === 'mage' ? initialPriorityFor(classData, talentLevel) : []);
    setSacrificePet(false);
    setSacrificedPetId('');
    setSoulShards(10);
    if (selectedClass === 'warlock') {
      const unlockedPets = classPets.filter(pet => pet.level <= talentLevel);
      try {
        const savedPet = localStorage.getItem('4esim_active_pet_warlock');
        setActivePetId(unlockedPets.some(pet => pet.id === savedPet) ? savedPet : (unlockedPets.at(-1)?.id || ''));
      } catch { setActivePetId(unlockedPets.at(-1)?.id || ''); }
    }
    setSavedSpecs(readSavedSpecs(selectedClass));
    try { setSelectedSpecId(localStorage.getItem(`4esim_active_${selectedClass}_spec`) || ''); } catch { setSelectedSpecId(''); }
    setSpecName('');
    setSimulation(null);
    setActive('Rotation lab');
  }, [selectedClass, classData]);
  useEffect(() => {
    if (selectedClass === 'warlock' && classPets.some(pet => pet.id === activePetId)) {
      try { localStorage.setItem('4esim_active_pet_warlock', activePetId); } catch { /* Storage may be unavailable in private browsing. */ }
    }
  }, [selectedClass, activePetId]);
  useEffect(() => {
    try { localStorage.setItem('4esim_character_level', String(talentLevel)); } catch { /* Storage may be unavailable in private browsing. */ }
  }, [talentLevel]);
  useEffect(() => {
    try {
      const key = `4esim_active_${selectedClass}_spec`;
      if (selectedSpecId) localStorage.setItem(key, selectedSpecId);
      else localStorage.removeItem(key);
    } catch { /* Storage may be unavailable in private browsing. */ }
  }, [selectedSpecId, selectedClass]);
  const configSignature = JSON.stringify({ rotation, duration, startingMana, regen, spirit, spellPower, baseHitChance, targetHealthPercent, scaleTargetHealth, activePetId, sacrificePet, sacrificedPetId, soulShards, useEvocation, useManaGem, talentLevel, build });
  const result = simulation?.signature === configSignature ? simulation.result : null;
  const runSimulation = () => {
    if (!rotation.length) return;
    const resultTab = window.open('about:blank', '_blank');
    if (!resultTab) return;
    const manaGem = manaGemForLevel(talentLevel);
    const manaOptions = { useEvocation: useEvocation && talentLevel >= 20, useManaGem, manaGem };
    const simulateClass = simulatorByClass[selectedClass];
    if (!simulateClass) return;
    const runs = Array.from({ length: batchSize }, () => simulateClass(rotation, Number(duration), Number(startingMana), Number(regen), Number(spirit), build, Math.floor(Math.random() * 0xffffffff), Number(baseHitChance), Number(spellPower), manaOptions, { classId: selectedClass, resourceType: resourceTypeForClass(selectedClass), resourceCap: resourceCapForClass(selectedClass), activePetId, sacrificePet, sacrificedPetId, soulShards, talentLevel, petSpell, lifeTap, targetHealthPercent: Number(targetHealthPercent), scaleTargetHealth }));
    const sorted = [...runs].sort((a, b) => a.dps - b.dps);
    const medianRun = sorted[Math.floor((sorted.length - 1) / 2)];
    const minimum = sorted[0].dps;
    const maximum = sorted.at(-1).dps;
    const binCount = 20;
    const bins = Array.from({ length: binCount }, (_, i) => ({ from: minimum + (maximum - minimum) * i / binCount, to: minimum + (maximum - minimum) * (i + 1) / binCount, count: 0 }));
    runs.forEach(run => {
      const index = maximum === minimum ? 0 : Math.min(binCount - 1, Math.floor((run.dps - minimum) / (maximum - minimum) * binCount));
      bins[index].count++;
    });
    const dpsSorted = sorted.map(run => run.dps);
    const percentile = p => dpsSorted[Math.round((dpsSorted.length - 1) * p)];
    const mageDamageAttempts = run => run.castLog.filter(entry => !['mana', 'off-gcd'].includes(entry.type) && entry.name !== 'Ignite' && !(isDamageChannel(entry) && entry.hit));
    const medianHitRate = medianOf(runs.map(run => {
      if (selectedClass === 'mage') {
        const attempts = mageDamageAttempts(run);
        return attempts.length ? attempts.filter(entry => entry.hit).length / attempts.length : 0;
      }
      if (selectedClass !== 'warlock') return run.casts ? run.castLog.filter(entry => !['mana', 'tick', 'off-gcd'].includes(entry.type) && entry.hit).length / run.casts : 0;
      const attackAttempts = run.castLog.filter(entry => !['mana', 'tick', 'off-gcd'].includes(entry.type));
      return attackAttempts.length ? attackAttempts.filter(entry => entry.hit).length / attackAttempts.length : 0;
    }));
    const medianCritRate = medianOf(runs.map(run => {
      if (selectedClass === 'mage') {
        const attempts = mageDamageAttempts(run);
        return attempts.length ? attempts.filter(entry => entry.crit).length / attempts.length : 0;
      }
      const landedAttacks = run.castLog.filter(entry => !['mana', 'off-gcd'].includes(entry.type) && entry.hit && entry.damage > 0);
      return landedAttacks.length ? landedAttacks.filter(entry => entry.crit).length / landedAttacks.length : 0;
    }));
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const report = {
      runs: batchSize,
      completedAt: new Date().toISOString(),
      config: { classId: selectedClass, accent: activeClass.accent, duration: Number(duration), startingMana: Number(startingMana), regenPer5s: Number(regen), spirit: Number(spirit), spellPower: Number(spellPower), baseHitChance: Number(baseHitChance), targetHealthPercent: Number(targetHealthPercent), scaleTargetHealth, activePetId, sacrificePet, sacrificedPetId, soulShards, useEvocation, useManaGem, manaGem, build, priority: rotation.map(({ name, school, specialization, conditional, condition, conditions, offGcd }) => ({ name, school, specialization, conditional, condition, conditions, offGcd })) },
      metrics: { medianDps: medianOf(dpsSorted), meanDps: runs.reduce((sum, run) => sum + run.dps, 0) / runs.length, p10Dps: percentile(0.1), p90Dps: percentile(0.9), minDps: minimum, maxDps: maximum, medianHitRate, medianCritRate },
      medianRun,
      histogram: bins,
      histogramMax: Math.max(...bins.map(bin => bin.count)),
    };
    localStorage.setItem(`${resultStoragePrefix}${id}`, JSON.stringify(report));
    resultTab.location.href = `${window.location.origin}${window.location.pathname}?results=${encodeURIComponent(id)}`;
  };
  const totalPoints = Object.values(build).reduce((a, b) => a + b, 0);
  const addSpell = spell => {
    setRotation(prev => prev.some(entry => entry.name === spell.name) ? prev : [...prev, { ...spell, ...defaultCondition(spell) }]);
    setSpellSearch('');
    setAddMenuOpen(false);
  };
  const movePriority = target => setRotation(prev => {
    if (draggedPriority === null || target < 0 || target >= prev.length || target === draggedPriority) return prev;
    const next = [...prev];
    const [movedSpell] = next.splice(draggedPriority, 1);
    next.splice(target, 0, movedSpell);
    return next;
  });
  const currentSpecConfig = () => ({ classId: selectedClass, activePetId: selectedClass === 'warlock' ? activePetId : undefined, sacrificePet: selectedClass === 'warlock' && sacrificePet, sacrificedPetId, soulShards, duration, startingMana, regen, spirit, spellPower, useEvocation, useManaGem, baseHitChance, targetHealthPercent, scaleTargetHealth, talentLevel, build, rotation: rotation.map(({ name, school, specialization, conditional, condition, conditions, offGcd }) => ({ name, school, specialization, conditional, condition, conditions, offGcd })) });
  const loadSpec = spec => {
    const config = spec?.config;
    if (!config) return;
    setDuration(config.duration ?? 180);
    setStartingMana(config.startingMana ?? 5000);
    setRegen(config.regen ?? 100);
    setSpirit(config.spirit ?? 0);
    setSpellPower(config.spellPower ?? 0);
    setUseEvocation(config.useEvocation ?? true);
    setUseManaGem(config.useManaGem ?? true);
    setBaseHitChance(config.baseHitChance ?? 83);
    setTargetHealthPercent(config.targetHealthPercent ?? 100);
    setScaleTargetHealth(config.scaleTargetHealth ?? false);
    setSacrificePet(config.sacrificePet ?? false);
    setSoulShards(Math.max(0, Math.floor(Number(config.soulShards ?? 10) || 0)));
    setSacrificedPetId(config.sacrificedPetId || '');
    const specLevel = Math.min(60, Math.max(1, Number(config.talentLevel) || 60));
    setCharacterLevel(specLevel);
    if (selectedClass === 'warlock') {
      const specPet = classPets.find(pet => pet.id === config.activePetId && pet.level <= specLevel);
      setActivePetId(specPet?.id || classPets.filter(pet => pet.level <= specLevel).at(-1)?.id || '');
    }
    setBuild(limitBuildToPoints(config.build && typeof config.build === 'object' ? config.build : {}, Math.max(0, specLevel - 9)));
    const nextRotation = Array.isArray(config.rotation) ? config.rotation.map(entry => {
      const spell = entry.name === 'Combustion' && selectedClass === 'mage' ? combustionSpell : damageSpellCatalog.find(item => item.name === entry.name);
      return spell ? { ...spell, conditional: entry.conditional ?? defaultCondition(spell).conditional, condition: entry.condition && entry.condition === defaultCondition(spell).condition ? entry.condition : defaultCondition(spell).condition, conditions: [...new Set([...(Array.isArray(entry.conditions) ? entry.conditions : []), ...(entry.condition ? [entry.condition] : [])].map(condition => ['pandemicRefresh', 'immolateRefresh'].includes(condition) ? 'debuffRefresh' : condition).filter(condition => condition !== 'always'))] } : null;
    }).filter(Boolean) : (selectedClass === 'mage' ? initialPriorityFor(classData, talentLevel) : []);
    setRotation(nextRotation);
    setSelectedSpecId(spec.id);
    setSpecName(spec.name);
    setSimulation(null);
  };
  useEffect(() => {
    const savedSpec = savedSpecs.find(spec => spec.id === selectedSpecId && (spec.config.classId || 'mage') === selectedClass);
    if (savedSpec) loadSpec(savedSpec);
  }, [savedSpecs, selectedSpecId, selectedClass]);
  const saveSpec = () => {
    const name = specName.trim();
    if (!name) return;
    const existing = savedSpecs.find(spec => spec.id === selectedSpecId);
    const spec = { id: existing?.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, updatedAt: new Date().toISOString(), config: currentSpecConfig() };
    const next = existing ? savedSpecs.map(item => item.id === existing.id ? spec : item) : [...savedSpecs, spec];
    setSavedSpecs(next);
    localStorage.setItem(specStorageKey(selectedClass), JSON.stringify(next));
    setSelectedSpecId(spec.id);
  };
  const deleteSpec = () => {
    if (!selectedSpecId) return;
    const next = savedSpecs.filter(spec => spec.id !== selectedSpecId);
    setSavedSpecs(next);
    localStorage.setItem(specStorageKey(selectedClass), JSON.stringify(next));
    setSelectedSpecId('');
    setSpecName('');
  };
  const pointsAvailable = Math.max(0, talentLevel - 9);
  const treePoints = tree => Object.entries(build).filter(([name]) => tree.talents.some(talent => talent.name === name)).reduce((sum, [, rank]) => sum + rank, 0);
  const addTalent = (tree, talent) => setBuild(prev => {
    const spent = Object.values(prev).reduce((sum, rank) => sum + rank, 0);
    const inTree = Object.entries(prev).filter(([name]) => tree.talents.some(entry => entry.name === name)).reduce((sum, [, rank]) => sum + rank, 0);
    if (spent >= pointsAvailable || (prev[talent.name] || 0) >= talent.max || inTree < (talent.row - 1) * 5 || (talent.req && !prev[talent.req])) return prev;
    return { ...prev, [talent.name]: (prev[talent.name] || 0) + 1 };
  });
  const removeTalent = (name) => setBuild(prev => ({ ...prev, [name]: Math.max(0, (prev[name] || 0) - 1) }));
  const showTalentTooltip = (event, tree, talent) => {
    clearTimeout(tooltipTimer.current);
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.type === 'focus' ? rect.right : event.clientX;
    const pointerY = event.type === 'focus' ? rect.bottom : event.clientY;
    const left = Math.min(pointerX + 12, Math.max(8, window.innerWidth - 280));
    const top = Math.min(pointerY + 12, Math.max(8, window.innerHeight - 160));
    setHoveredTalent({ talent, tree, left, top });
  };
  const hideTalentTooltip = () => {
    clearTimeout(tooltipTimer.current);
    setHoveredTalent(null);
  };

  if (!classData) return <div className="shell" style={{ '--accent': activeClass.accent }}><main className="main"><p className="panel-desc">Loading {activeClass.name} spellbook and talents…</p></main></div>;
  return <div className="shell" style={{ '--accent': activeClass.accent }}>
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">4e</div><div><strong>4esim</strong><span>FOREVER DPS LAB</span></div></div>
      <div className="side-label">WORKSPACE</div>
      {['Rotation lab', activeTalentPage, 'Spell library'].map(item => <button className={`nav-item ${active === item ? 'selected' : ''}`} key={item} onClick={() => setActive(item)}><span className="nav-icon">{item === 'Rotation lab' ? '◈' : item === activeTalentPage ? '✳' : '▤'}</span>{item}</button>)}
      <div className="side-bottom"><div className="status-dot"/> DATA SNAPSHOT <b>{classData.generated}</b><p>Forever Beta · {classData.class}</p></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><span className="crumb">SIMULATOR /</span> <b>{active.toUpperCase()}</b></div><div className="top-right"><details className="class-switcher"><summary className="pill"><i/> {activeClass.name.toUpperCase()} <span>▾</span></summary><div className="class-menu" role="listbox" aria-label="Select character class">{classRegistry.map(characterClass => <button key={characterClass.id} type="button" role="option" aria-selected={selectedClass === characterClass.id} disabled={!characterClass.available} className={characterClass.available ? 'class-option available' : 'class-option locked'} onClick={event => { event.currentTarget.closest('details').open = false; setSelectedClass(characterClass.id); }}><span className="class-mark"><img src={characterClass.icon} alt=""/></span><span className="class-option-copy"><b>{characterClass.name}</b><small>{characterClass.available ? 'ACTIVE CLASS' : 'COMING LATER'}</small></span><span className="class-option-status">{characterClass.available ? '✓' : 'LOCKED'}</span></button>)}</div></details><span className="build-label">BUILD 0.1</span></div></header>
      {active === 'Rotation lab' && <>
        <section className="page-head"><div><div className="eyebrow">THEORYCRAFT WORKSPACE <span>·</span> PATCH FOREVER</div><h1>Find your <em>next best cast.</em></h1><p>Choose spells, set their priority and conditions, then run the encounter simulation.</p></div><button className="run-btn" disabled={!rotation.length} onClick={runSimulation}><span>▶</span> {rotation.length ? 'SIMULATE 1,000 RUNS ↗' : 'SELECT SPELLS FIRST'}</button></section>
        <section className="spec-manager" aria-label="Saved specs"><div className="spec-manager-title"><b>SAVED SPECS</b><span>Talent build · priority · stats</span></div><select aria-label="Load saved spec" value={selectedSpecId} onChange={event => { const spec = savedSpecs.find(item => item.id === event.target.value); if (spec) loadSpec(spec); else { setSelectedSpecId(''); setSpecName(''); } }}><option value="">Choose a saved spec…</option>{savedSpecs.map(spec => <option key={spec.id} value={spec.id}>{spec.name}</option>)}</select><input aria-label="Spec name" value={specName} onChange={event => setSpecName(event.target.value)} placeholder="Name this spec" maxLength={48}/><button className="spec-new" onClick={() => { setSelectedSpecId(''); setSpecName(''); }}>NEW</button><button onClick={saveSpec} disabled={!specName.trim()}>{savedSpecs.some(spec => spec.id === selectedSpecId) ? 'UPDATE SPEC' : 'SAVE SPEC'}</button><button className="spec-delete" onClick={deleteSpec} disabled={!selectedSpecId}>DELETE</button></section>
        <div className="grid-main">
          <section className="panel rotation-panel"><PanelTitle kicker="01 / ROTATION" title="Spell priority" right={<span className="loop-tag">READY CONDITIONALS FIRST · THEN PRIORITY ORDER</span>}/><p className="panel-desc">{selectedClass === 'mage' ? 'Add damage spells, set their priorities, and configure proc conditions. Ready conditional spells spend active buffs before the filler rotation.' : selectedClass === 'warlock' ? 'Add damage spells and order them by priority. Warlock uses the class specific talent model.' : 'Add damage spells and order them by priority. This class uses the neutral spell model; its talents are saved but do not modify results yet.'}</p>
            {selectedClass === 'warlock' && <section className="pet-planner" aria-label="Warlock active pet"><label htmlFor="active-pet">ACTIVE PET</label><select id="active-pet" value={activePetId} onChange={event => setActivePetId(event.target.value)}><option value="">No pet selected</option>{classPets.map(pet => <option key={pet.id} value={pet.id} disabled={talentLevel < pet.level}>{pet.name} · summon at level {pet.level}</option>)}</select>{build['Demonic Sacrifice'] > 0 && <label className="pet-sacrifice-toggle"><input type="checkbox" checked={sacrificePet} onChange={event => setSacrificePet(event.target.checked)}/> {build['Demonic Pact'] ? 'Enable Demonic Sacrifice bonus' : 'Sacrifice this demon for its talent effect'}</label>}{build['Demonic Sacrifice'] > 0 && build['Demonic Pact'] > 0 && sacrificePet && <><label htmlFor="sacrificed-pet">PET TO SACRIFICE</label><select id="sacrificed-pet" value={sacrificedPetId} onChange={event => setSacrificedPetId(event.target.value)}><option value="">No sacrifice selected</option>{classPets.map(pet => <option key={pet.id} value={pet.id} disabled={talentLevel < pet.level || pet.id === activePetId}>{pet.name}</option>)}</select><small>Demonic Pact keeps the bonus while a different demon is active. Summoning the sacrificed demon cancels it.</small></>}<small>{petState.sacrificedPetId ? `Sacrifice bonus: ${classPets.find(pet => pet.id === petState.sacrificedPetId)?.name}` : 'No sacrifice bonus'}{petState.activePetId ? ` · Active pet: ${activePet.name}` : ' · No active pet'}</small>{petAttackProfile && <small className="pet-attack-profile">{petAttackProfile.kind === 'melee' ? `MELEE AUTO · ${petAttackProfile.swingSpeed.toFixed(1)}s · ${Math.round(petAttackProfile.damageMin + petAttackProfile.attackPower / 14 * petAttackProfile.swingSpeed)}–${Math.round(petAttackProfile.damageMax + petAttackProfile.attackPower / 14 * petAttackProfile.swingSpeed)} base damage per swing before armor; Forever stat scaling not yet calibrated.` : `RANGED AUTO · ${petAttackProfile.ability} · ${petAttackProfile.baseInterval.toFixed(1)}s base cast; damage and spell power scaling use the Forever spell rank.`}</small>}<PetAbilityKit classData={classData} pet={activePet} level={talentLevel}/><p className="pet-planner-note">The shared pet attack model runs alongside damage abilities such as Firebolt and Lash of Pain. Utility pet abilities remain reference only.</p></section>}
            <div className="table-head"><span>PRIORITY / SPELL</span><span>DAMAGE</span><span>CAST TIME</span><span>COOLDOWN</span><span>MANA COST</span><span/></div>
            <div className="spell-list">{rotation.map((spell, i) => <div className={`spell-row priority-row ${spell.offGcd ? 'offgcd-priority-row' : ''} ${dragOverPriority === i && draggedPriority !== i ? 'drag-over' : ''} ${draggedPriority === i ? 'dragging' : ''}`} key={`${spell.name}-${i}`} draggable onDragStart={event => { setDraggedPriority(i); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(i)); }} onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverPriority(i); }} onDrop={event => { event.preventDefault(); movePriority(i); setDraggedPriority(null); setDragOverPriority(null); }} onDragEnd={() => { setDraggedPriority(null); setDragOverPriority(null); }}><div className="spell-select"><span className="drag-order"><span className="drag-grip" aria-hidden="true" title="Drag to reorder">⠿</span><span className="order">{String(i + 1).padStart(2, '0')}</span></span><span className={`school-icon ${spell.school.toLowerCase()}`}>{spellIcons[spell.name] ? <img src={`https://wow.zamimg.com/images/wow/icons/medium/${spellIcons[spell.name]}.jpg`} alt="" loading="lazy"/> : spell.school === 'Frost' ? '❄' : spell.school === 'Fire' ? '♨' : spell.school === 'Shadow' ? '☾' : '✧'}</span><span className="selected-spell"><b>{spell.name}</b><small>{spell.offGcd ? 'OFF GCD · Instant · 3 min cooldown' : `${spell.specialization} · ${spell.rank} · ${Math.round(spell.coefficient * 100)}% SP`}</small>{['mage','warlock'].includes(selectedClass) && debuffRefreshBehavior(selectedClass, spell, build).applies && <MultiConditionDropdown selected={spell.conditions || []} includeImmolate={selectedClass === 'warlock' && spell.name === 'Immolate'} refreshDisabled={!debuffRefreshBehavior(selectedClass, spell, build).enabled} refreshWindow={debuffRefreshWindow(selectedClass, spell, build)} onChange={conditions => setRotation(prev => prev.map((entry,index) => index === i ? { ...entry, conditions, conditional: conditions.length > 0 || (entry.conditional && conditionForSpell(entry) !== 'always') } : entry))}/>}{selectedClass === 'warlock' && spell.name === 'Searing Pain' && <span className="condition-control"><label><input type="checkbox" aria-label="Cast Searing Pain when Demonic Brand is absent" checked={Boolean(spell.conditional && (spell.conditions || [spell.condition]).some(condition => ['demonicBrand', 'demonicBrandBurst'].includes(condition)))} onChange={event => setRotation(prev => prev.map((entry, index) => index === i ? { ...entry, conditional: event.target.checked, conditions: event.target.checked ? ['demonicBrand'] : [], condition: event.target.checked ? 'demonicBrand' : 'always' } : entry))}/>Cast once, then wait for Demonic Brand</label><small>Requires Demonic Brand and an active pet.</small></span>}{selectedClass === 'warlock' && spell.name === 'Soul Fire' && <span className="condition-control"><label><input type="checkbox" aria-label="Only cast Soul Fire while Decimation is active" checked={spell.conditional && (spell.conditions || []).includes('decimation') || false} onChange={event => setRotation(prev => prev.map((entry, index) => index === i ? { ...entry, conditional: event.target.checked, conditions: event.target.checked ? ['decimation'] : [], condition: event.target.checked ? 'decimation' : 'always' } : entry))}/>Only while Decimation is active</label></span>}{['Arcane Missiles','Ice Lance','Pyroblast','Scorch'].includes(spell.name) && <span className="condition-control"><label><input type="checkbox" aria-label={`Enable conditional casting for ${spell.name}`} checked={spell.conditional ?? false} onChange={event => setRotation(prev => prev.map((entry,index) => index === i ? { ...entry, conditional: event.target.checked } : entry))}/><span>Enable conditional</span></label><select aria-label={`${spell.name} condition`} value={conditionForSpell(spell)} disabled={!spell.conditional} onChange={event => setRotation(prev => prev.map((entry,index) => index === i ? { ...entry, condition: event.target.value } : entry))}>{spell.name === 'Arcane Missiles' && <option value="missileBarrage">Missile Barrage active</option>}{spell.name === 'Ice Lance' && <option value="fingersOfFrost">Fingers of Frost active</option>}{spell.name === 'Pyroblast' && <option value="hotStreak">Hot Streak: 3 stacks, or 2 with &lt;4s</option>}{spell.name === 'Scorch' && <option value="improvedScorch">Build 5 stacks; refresh below 5s</option>}</select></span>}</span></div><SpellStat value={spell.offGcd ? '—' : spell.damage.toLocaleString()} suffix={spell.offGcd ? 'utility' : 'dmg'}/><SpellStat value={`${spell.cast}s`} suffix={spell.cast === 0 ? 'instant' : 'cast'}/><SpellStat value={spell.cooldown ? `${spell.cooldown}s` : '—'} suffix="cooldown"/><SpellStat value={spell.manaFraction ? `${spell.manaFraction * 100}%` : spell.mana.toLocaleString()} suffix={spell.manaFraction ? 'base mana' : 'mana'}/><button className="remove" draggable="false" onClick={() => setRotation(prev => prev.filter((_,n)=>n!==i))} aria-label={`Remove ${spell.name}`}>×</button></div>)}</div>
            <div className="add-spell-wrap"><button className="add-row" onClick={() => setAddMenuOpen(open => !open)}>＋ <span>ADD A SPELL</span></button>
              {addMenuOpen && <div className="spell-picker"><input aria-label={`Search ${classData.class} spells`} placeholder={`Search ${classData.class} spells…`} value={spellSearch} onChange={event => setSpellSearch(event.target.value)}/><div className="spell-picker-options">{selectedClass === 'mage' && !rotation.some(entry => entry.name === 'Combustion') && 'combustion'.includes(spellSearch.toLowerCase()) && <button key="Combustion" onClick={() => addSpell(combustionSpell)}><span className="school-icon fire">♨</span><span><b>Combustion</b><small>Fire · OFF GCD · Instant · 180 sec cooldown · Requires talent</small></span></button>}{damageSpellCatalog.filter(spell => !rotation.some(entry => entry.name === spell.name) && spell.name.toLowerCase().includes(spellSearch.toLowerCase())).map(spell => <button key={spell.name} onClick={() => addSpell(spell)}><span className={`school-icon ${spell.school.toLowerCase()}`}>{spellIcons[spell.name] ? <img src={`https://wow.zamimg.com/images/wow/icons/medium/${spellIcons[spell.name]}.jpg`} alt="" loading="lazy"/> : spell.school === 'Frost' ? '❄' : spell.school === 'Fire' ? '♨' : spell.school === 'Shadow' ? '☾' : '✧'}</span><span><b>{spell.name}</b><small>{spell.specialization} · {spell.school} · {spell.rank} · {spell.damage.toLocaleString()} dmg · {Math.round(spell.coefficient * 100)}% SP</small></span></button>)}{damageSpellCatalog.every(spell => rotation.some(entry => entry.name === spell.name) || !spell.name.toLowerCase().includes(spellSearch.toLowerCase())) && (selectedClass !== 'mage' || rotation.some(entry => entry.name === 'Combustion') || !'combustion'.includes(spellSearch.toLowerCase())) && <p>No matching {classData.class} spells.</p>}</div></div>}
            </div>
            <div className="rotation-foot"><span>GLOBAL COOLDOWN <b>1.5s</b></span><span>BUILD <b>{totalPoints} / 51 PTS</b></span><button onClick={()=>setRotation(selectedClass === 'mage' ? initialPriorityFor(classData, talentLevel) : [])}>CLEAR ROTATION ↺</button></div>
          </section>
          <section className="panel encounter-panel"><PanelTitle kicker="02 / ENCOUNTER" title="Fight parameters"/><p className="panel-desc">Tune the conditions for this single-target test.</p><div className="field"><label>CHARACTER LEVEL</label><NumInput value={talentLevel} suffix="level" min={1} max={60} onChange={setCharacterLevel}/><small className="field-hint">Controls talent points, summon availability, and each pet ability’s highest unlocked rank.</small></div><div className="field"><label>ENCOUNTER DURATION</label><NumInput value={duration} suffix="sec" onChange={setDuration}/><div className="range"><input type="range" min="30" max="600" step="15" value={duration} onChange={e=>setDuration(Number(e.target.value))}/><div><span>30 SEC</span><span>10 MIN</span></div></div></div><div className="field"><label>STARTING {resourceTypeForClass(selectedClass).toUpperCase()}</label><NumInput value={startingMana} suffix={resourceTypeForClass(selectedClass).toLowerCase()} onChange={setStartingMana}/></div><div className="field"><label>{resourceTypeForClass(selectedClass) === 'Energy' ? 'ENERGY REGENERATION' : `RESOURCE REGEN / 5 SEC`}</label><NumInput value={regen} suffix={resourceTypeForClass(selectedClass) === 'Energy' ? 'bonus / 5 sec' : `${resourceTypeForClass(selectedClass)} / 5 sec`} onChange={setRegen}/><small className="field-hint">{selectedClass === 'rogue' ? 'Energy also regenerates at 10 per second.' : 'This rate continues while the character casts.'}</small></div>{resourceTypeForClass(selectedClass) === 'Mana' && <div className="field"><label>SPIRIT</label><NumInput value={spirit} suffix="Spirit" onChange={setSpirit}/><small className="field-hint">Spirit regeneration follows the five second rule and uses this class’s standard mana formula.</small></div>}{selectedClass === 'mage' && <div className="field mana-tool-field"><label>MANA TOOLS</label><div className="mana-tool-options"><label className="mana-tool-option"><input type="checkbox" checked={useEvocation} disabled={talentLevel < 20} onChange={event=>setUseEvocation(event.target.checked)}/> Use Evocation{talentLevel < 20 ? ' · available at level 20' : ''}</label><label className="mana-tool-option"><input type="checkbox" checked={useManaGem} disabled={!manaGemForLevel(talentLevel)} onChange={event=>setUseManaGem(event.target.checked)}/> Use {manaGemForLevel(talentLevel)?.name || 'Mana Gem'}{manaGemForLevel(talentLevel) ? ` · ${manaGemForLevel(talentLevel).minRestore}–${manaGemForLevel(talentLevel).maxRestore} mana` : ' · available at level 28'}</label><label className="mana-tool-option unavailable"><input type="checkbox" disabled/> Use mana potion · not implemented</label></div><small className="field-hint">Auto-used at full value when mana-starved: Evocation first, then one gem. Potion support is coming later.</small></div>}<div className="field"><label>GEAR SPELL POWER</label><NumInput value={spellPower} suffix="spell power" onChange={setSpellPower}/><small className="field-hint">Added by cast-time coefficient; instant spells use a 1.5s base.</small></div><div className="field"><label>BASE SPELL HIT PER SCHOOL (BOSS)</label><NumInput value={baseHitChance} suffix="%" max={100} step={0.1} onChange={setBaseHitChance}/></div>{selectedClass === 'warlock' && <div className="field"><label>STARTING SOUL SHARDS</label><NumInput value={soulShards} suffix="shards" min={0} step={1} onChange={value => setSoulShards(Math.floor(value))}/><small className="field-hint">Soul Fire and Shadowburn cost 1 shard. Active Decimation makes Soul Fire free; 5/5 Shadow and Flame makes Shadowburn free.</small></div>}<div className="field"><label className="mana-tool-option"><input type="checkbox" checked={scaleTargetHealth} onChange={event => setScaleTargetHealth(event.target.checked)}/> Scale target health over time</label><small className="field-hint">Starts at 100% and loses 1 percentage point every {(Math.max(0, Number(duration)) / 100).toFixed(2)} seconds. Player and pet damage do not affect target health.</small></div>{selectedClass === 'warlock' && !scaleTargetHealth && <div className="field"><label>BOSS HEALTH FOR FULL FIGHT</label><NumInput value={targetHealthPercent} suffix="%" min={1} max={100} onChange={setTargetHealthPercent}/><small className="field-hint">Use below 35% to model Decimation execute effects for the full encounter.</small></div>}<div className="model-note"><span>i</span><p><b>SIMULATION MODEL</b> {selectedClass === 'mage' ? 'Mage uses the original simulator, saved at src/sim/mage-baseline.jsx. Its spell school and specialization tags are independent.' : selectedClass === 'warlock' ? 'Warlock models rank-available direct and periodic spells, coefficients, mana and Life Tap, hit/crit, supported Affliction and Destruction damage talents, execute health for Decimation, and pet melee auto attacks alongside selected damaging pet abilities. Melee damage uses Classic reference profiles; WoW Forever pet stat scaling is not yet calibrated. Threat, interruption, control, defense, pet survivability, summon cooldowns, and multi-target effects are outside the single-target model.' : `${classData.class} uses the neutral damage core with rank-available spells, specialization tags, damage school, spell power, hit/crit, periodic ticks, cooldowns and ${resourceTypeForClass(selectedClass)}. Class-specific talent effects are not modeled yet.`}</p></div></section>
        </div>
        <div className="lower-grid"><section className="panel talent-summary"><PanelTitle kicker="03 / BUILD CONTEXT" title="Talent allocation" right={<button className="text-action" onClick={()=>setActive(activeTalentPage)}>EDIT TALENTS ↗</button>}/><div className="tree-mini">{classData.talents.trees.map(t=><div key={t.name}><span>{t.name.toUpperCase()}</span><b>{Object.entries(build).filter(([name])=>t.talents.some(x=>x.name===name)).reduce((sum,[,v])=>sum+v,0)}</b></div>)}</div><div className="build-context"><span>Talent points allocated</span><strong>{totalPoints} <small>/ 51</small></strong></div></section><section className="panel chart-panel"><PanelTitle kicker="04 / DAMAGE PROFILE" title="Damage by priority" right={result && <div className="timeline-controls"><label className="log-toggle"><input type="checkbox" checked={showCastTimeline} onChange={event=>setShowCastTimeline(event.target.checked)}/> CAST TIMELINE</label>{showCastTimeline && <label className="log-toggle"><input type="checkbox" checked={showPetTimelineEvents} onChange={event=>setShowPetTimelineEvents(event.target.checked)}/> SHOW PET EVENTS</label>}</div>}/>{result ? <><div className="simulation-summary"><span><b>{Math.round(result.dps).toLocaleString()}</b> DPS</span><span><b>{Math.round(result.damage).toLocaleString()}</b> DAMAGE</span><span><b>{result.casts}</b> CASTS</span><span><b>{result.crits}</b> CRITS</span></div><div className="buff-uptime"><div className="buff-uptime-heading">PROC BUFF UPTIME</div>{result.buffs.map(buff=><div className="buff-uptime-row" key={buff.id}><div className="buff-uptime-name"><b>{buff.name}</b>{buff.rank ? <small>{buff.procs} procs · {buff.uses} used{buff.activeAtEnd ? ' · active at end' : ''}</small> : <button className="buff-talent-link" onClick={()=>setActive(activeTalentPage)}>Talent not selected · SELECT TALENT ↗</button>}</div><div className="buff-uptime-track"><i style={{width:`${Math.min(100,buff.uptimePct)}%`}}/></div><span>{formatTime(buff.uptime)} <small>{buff.uptimePct.toFixed(1)}%</small></span></div>)}</div>{showCastTimeline ? <div className="cast-timeline" aria-label="Cast timeline"><div className="cast-timeline-head"><span>TIME</span><span>CAST</span><span>DAMAGE</span><span>MANA</span><span>ACTIVE BUFFS</span><span>ENEMY DEBUFFS</span><span>BUFF CHANGES</span></div>{(showPetTimelineEvents ? result.castLog : result.castLog.filter(entry => entry.type !== 'pet')).map((entry,index)=><div className="cast-timeline-row" key={`${entry.time}-${entry.name}-${index}`}><time>{formatTime(entry.time)}</time><span className="cast-log-spell"><i className={`school-icon ${entry.school.toLowerCase()}`}>{entry.school === 'Frost' ? '❄' : entry.school === 'Fire' ? '♨' : '✧'}</i><b>{entry.name}</b>{entry.specialization && <small className="spell-specialization-tag">{entry.specialization}</small>}{entry.crit && <em>CRIT</em>}{!entry.hit && <em className="miss">MISS</em>}</span><span className="cast-log-damage">{Math.round(entry.damage ?? 0).toLocaleString()}</span><span className="cast-log-mana">{Math.round(entry.currentMana ?? 0).toLocaleString()}</span><span className="cast-log-buffs">{entry.activeBuffs.length ? entry.activeBuffs.map(buff => <EffectIcon key={buff.id} effect={buff}/>) : <small>—</small>}</span><span className="cast-log-debuffs">{entry.enemyDebuffs?.length ? entry.enemyDebuffs.map(debuff => <span className="debuff-effect" key={debuff.id}><EffectIcon effect={debuff}/><small>{debuff.remaining.toFixed(1)}s</small></span>) : <small>—</small>}</span><span className="cast-log-changes">{entry.procs.map((buff,procIndex)=><EffectChange key={`p${procIndex}`} label={buff} mode="proc"/>)}{entry.consumedBuffs.map((buff,useIndex)=><EffectChange key={`u${useIndex}`} label={buff} mode="used"/>)}{!entry.procs.length && !entry.consumedBuffs.length && <small>—</small>}</span></div>)}</div> : <div className="bars">{result.events.slice(0,7).map((spell,i)=>{const max=Math.max(1,...result.events.map(s=>s.damage));return <div className="bar-row" key={`${spell.name}-${i}`}><span>{spell.name} <small>{spell.ticks ? `${spell.ticks} ticks` : `${spell.crits}/${spell.casts}`}</small></span><div><i style={{width:`${Math.max(spell.damage ? 4 : 0,spell.damage/max*100)}%`}}/></div><b>{Math.round(spell.damage)}</b></div>})}</div>}</> : <p className="panel-desc">{rotation.length ? 'Ready when you are. Press Simulate Rotation to calculate this setup.' : 'Add spells to your priority list, then run a simulation to see results.'}</p>}</section></div>
        <footer>DATA FROM <a href="https://talentsforever.com/about" target="_blank" rel="noreferrer">TALENTS FOREVER</a> · CC BY 4.0 · BETA SNAPSHOT {classData.generated} · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">ATTRIBUTION</a></footer>
      </>}
      {active === activeTalentPage && <section className="talent-page">
        <TalentImport key={selectedClass} classData={classData} onImport={({ build: importedBuild, level }) => { setCharacterLevel(level); setBuild(importedBuild); setSelectedSpecId(''); setSpecName(''); setSimulation(null); }}/>
        <div className="talent-toolbar"><strong>Talents</strong><span className="talent-level-readout">CHARACTER LEVEL {talentLevel}</span><span className="talent-save-note">TALENTS AUTO-SAVED IN THIS BROWSER</span><div className="unspent-label">Unspent Talents <b>{Math.max(0, pointsAvailable - totalPoints)}</b></div></div>
        <div className="talent-trees">{classData.talents.trees.map(tree => <section className={`talent-tree tree-${tree.name.toLowerCase()}`} key={tree.name}>
          <header className="tree-heading"><div className="tree-emblem"><img src={`https://wow.zamimg.com/images/wow/icons/medium/${tree.icon}.jpg`} alt=""/><b>{treePoints(tree)}</b></div><h2>{tree.name}</h2><button className="tree-reset" aria-label={`Reset ${tree.name} talents`} title={`Reset ${tree.name}`} onClick={() => setBuild(prev => Object.fromEntries(Object.entries(prev).filter(([name]) => !tree.talents.some(talent => talent.name === name))))}>↻</button></header>
          <div className="talent-grid-visual">{tree.talents.map(talent => {
            const rank = build[talent.name] || 0;
            const rowRequirement = (talent.row - 1) * 5;
            const unlocked = rank > 0 || (treePoints(tree) >= rowRequirement && (!talent.req || build[talent.req] > 0));
            const rankText = talent.desc[rank > 0 ? rank - 1 : 0] || '';
            return <button key={talent.name} className={`talent-node ${rank ? 'learned' : ''} ${unlocked ? 'unlocked' : 'locked'}`} style={{'--row': talent.row, '--col': talent.col}} aria-label={`${talent.name}, rank ${rank} of ${talent.max}${unlocked ? '' : `, requires ${talent.req ? `${talent.req} and ` : ''}${rowRequirement} points in ${tree.name}`}`} onMouseEnter={event => showTalentTooltip(event, tree, talent)} onMouseMove={event => showTalentTooltip(event, tree, talent)} onMouseLeave={hideTalentTooltip} onFocus={event => showTalentTooltip(event, tree, talent)} onBlur={hideTalentTooltip} onClick={() => addTalent(tree, talent)} onContextMenu={event => { event.preventDefault(); removeTalent(talent.name); }}>
              <img src={`https://wow.zamimg.com/images/wow/icons/medium/${talent.icon}.jpg`} alt="" loading="lazy"/><span>{rank}/{talent.max}</span>
            </button>;
          })}</div>
          <div className="tree-foot">{treePoints(tree)} POINTS SPENT</div>
        </section>)}</div>
        <div className="talent-hint">Click a talent to spend a point · Right-click to remove one · deeper rows require 5 points per tier</div>
        {hoveredTalent && <div className="talent-tooltip" style={{ left: hoveredTalent.left, top: hoveredTalent.top }}>
          <strong>{hoveredTalent.talent.name}</strong>
          <span>Rank {build[hoveredTalent.talent.name] || 0} / {hoveredTalent.talent.max}</span>
          <span>{hoveredTalent.talent.passive ? 'Passive' : 'Active'}</span>
          <p>{hoveredTalent.talent.desc[Math.max(0, (build[hoveredTalent.talent.name] || 1) - 1)] || hoveredTalent.talent.desc[0]}</p>
        </div>}
        <footer>Talent and tooltip data: <a href="https://talentsforever.com/about" target="_blank" rel="noreferrer">Talents Forever</a> · CC BY 4.0</footer>
      </section>}
      {active === 'Spell library' && <section className="library-page"><div className="eyebrow">BETA SPELLBOOK · {classBookTabs.reduce((n,t)=>n+t.spells.length,0)} RANK ENTRIES</div><h1>{classData.class} <em>spellbook.</em></h1><p className="panel-desc">Spell names and rank tooltips from the Forever Beta export. This library is informational; select spells in Rotation Lab to set simulation values.</p>{classBookTabs.map(tab=><section className="panel library-tab" key={tab.name}><PanelTitle kicker="SPELLBOOK TAB" title={tab.name}/><div className="library-spells">{tab.spells.map(([name, rank], index)=>{const detail=spellRankText(classData, name, rank);return <article key={`${name}-${rank}-${index}`}><b>{name}</b><span>{rank || detail?.r || 'Spell'} · {tab.name}{detail?.lv ? ` · ${detail.lv}` : ''}</span><p>{detail?.d || 'Tooltip not available in this snapshot.'}</p></article>})}</div></section>)}<footer>Spellbook and tooltip data: <a href="https://talentsforever.com/about" target="_blank" rel="noreferrer">Talents Forever</a> · CC BY 4.0</footer></section>}
    </main>
  </div>;
}
function SpellStat({value,suffix}){return <div className="spell-stat"><b>{value}</b><span>{suffix}</span></div>}
function EffectIcon({effect}) {
  const icon = iconForEffect(effect);
  const count = effect.charges > 1 ? `×${effect.charges}` : effect.stacks > 1 ? `×${effect.stacks}` : effect.applications > 1 ? `×${effect.applications}` : '';
  const details = [effect.name, effect.charges ? `${effect.charges} charges` : '', effect.stacks ? `${effect.stacks} stacks` : '', effect.applications ? `${effect.applications} active applications` : '', effect.remaining !== undefined ? `${effect.remaining.toFixed(1)} seconds remaining` : ''].filter(Boolean).join(' · ');
  return <span className="effect-icon-wrap" title={details}>{icon ? <img src={`https://wow.zamimg.com/images/wow/icons/medium/${icon}.jpg`} alt={`${effect.name} talent icon`} loading="lazy"/> : <i>{effect.name.slice(0, 1)}</i>}{count && <small>{count}</small>}</span>;
}
function EffectChange({label, mode}) {
  const effectMatch = [
    ['Missile Barrage', 'missileBarrage'], ['Fingers of Frost', 'fingersOfFrost'], ['Clearcasting', 'clearcasting'],
    ["Winter's Chill", 'winterChill'], ['Scorch vulnerability', 'scorch'], ['Hot Streak', 'hotStreak'],
    ['Arcane Blast', 'arcaneBlast'], ['Frozen', 'frozen'], ['Ignite', 'ignite'],
    ['Presence of Mind', 'presenceOfMind'], ['Combustion', 'combustion'],
  ].find(([prefix]) => label.startsWith(prefix));
  if (!effectMatch) return <i className={`buff-chip ${mode}`}>{mode === 'proc' ? 'PROC' : 'USED'} · {label}</i>;
  const [talentName, id] = effectMatch;
  const number = label.match(/×(\d+)/)?.[1];
  const left = label.match(/\((\d+) left\)/)?.[1];
  const amount = label.match(/\+([\d,]+) damage/)?.[1];
  const effect = { id, name: talentName, charges: left ? Number(left) : id === 'fingersOfFrost' ? Number(number) : 0, stacks: number && id !== 'fingersOfFrost' ? Number(number) : 0 };
  return <span className={`effect-change ${mode}`} title={`${mode === 'proc' ? 'Procced' : 'Consumed'}: ${label}`}><b>{mode === 'proc' ? 'PROC' : 'USED'}</b><EffectIcon effect={effect}/>{amount && <small>+{amount}</small>}</span>;
}
function PanelTitle({kicker,title,right}){return <div className="panel-title"><div><div className="kicker">{kicker}</div><h2>{title}</h2></div>{right}</div>}
function NumInput({value,suffix,onChange,step=1,min=0,max}){return <div className="num-input"><input type="number" min={min} max={max} step={step} value={value} onChange={e=>{const next=Number(e.target.value);onChange(Math.min(max ?? Infinity,Math.max(min,next||min)))}}/><span>{suffix}</span></div>}
