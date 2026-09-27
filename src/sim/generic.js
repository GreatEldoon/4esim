import { createEffectTracker } from './effect-uptime.js';
import { isDamageChannel, channelTickInterval } from './channels.js';
const num = value => Math.max(0, Number(value) || 0);
const durationFromTooltip = text => Number(text?.match(/(?:over|for|lasts)\s+(\d+)\s+sec/i)?.[1] || 0);
const isPeriodic = spell => (spell.periodicDamage || 0) > 0;

/** Neutral single-target engine used by classes without a dedicated talent adapter. */
export function simulateGeneric(priority, duration, startingResource, regenPer5, spirit, _build, seed, hitChance, spellPower, _manaOptions, options = {}) {
  const effects = createEffectTracker(duration);
  const resourceType = options.resourceType || 'Mana';
  const resourceCap = Number(options.resourceCap) || startingResource;
  const isEnergy = resourceType === 'Energy';
  let resource = Math.min(resourceCap, num(startingResource));
  let time = 0, damage = 0, casts = 0, crits = 0, spent = 0, lastCastAt = -Infinity;
  let randomState = seed >>> 0 || 1;
  const roll = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const cooldowns = new Map(), dots = new Map(), events = new Map(), castLog = [];
  const baseRegen = isEnergy ? 10 : num(regenPer5) / 5;
  const spiritPerSecond = resourceType === 'Mana' ? (num(spirit) / 4 + 13) / 2 : 0;
  const costFor = spell => spell.resourceType && spell.resourceType !== resourceType ? 0 : (spell.mana || 0) + (spell.manaFraction || 0) * resourceCap;
  const nextTick = () => Math.min(duration, ...[...dots.values()].flatMap(dot => dot.ticks.map(tick => tick.at).filter(at => at <= duration)));
  const addMana = (from, to) => {
    const spiritTime = resourceType === 'Mana' ? Math.max(0, to - Math.max(from, lastCastAt + 5)) : 0;
    resource = Math.min(resourceCap, resource + (to - from) * baseRegen + spiritTime * spiritPerSecond);
  };
  while (time < duration && casts < duration * 4) {
    const usable = priority.find(spell => (cooldowns.get(spell.name) || 0) <= time && costFor(spell) <= resource);
    if (!usable) {
      const next = nextTick();
      const readyAt = priority.map(spell => {
        const wait = costFor(spell) > resource && baseRegen + spiritPerSecond > 0 ? (costFor(spell) - resource) / (baseRegen + spiritPerSecond) : Infinity;
        return Math.max(cooldowns.get(spell.name) || 0, time + wait);
      }).filter(at => at > time && Number.isFinite(at));
      const wakeAt = Math.min(next, ...readyAt, duration);
      if (wakeAt <= time) break;
      addMana(time, wakeAt); time = wakeAt;
    } else {
      const debuffsAtCast = effects.active('debuff', time);
      const castTime = Math.max(0, Number(usable.cast) || 0);
      const channeled = isDamageChannel(usable);
      const completeAt = time + (channeled ? 0 : castTime);
      let nextActionAt = Math.min(duration, time + Math.max(1.5, castTime));
      if (completeAt > duration) break;
      const cost = costFor(usable);
      resource = Math.max(0, resource - cost); spent += cost; lastCastAt = time;
      const hit = roll() < Math.min(1, Math.max(0, Number(hitChance) / 100));
      if (channeled && !hit) nextActionAt = Math.min(duration, time + 1.5);
      const event = events.get(usable.name) || { name: usable.name, specialization: usable.specialization, damage: 0, casts: 0, crits: 0, ticks: 0 };
      const periodicFraction = usable.damage ? (usable.periodicDamage || 0) / usable.damage : 0;
      const tickInterval = channeled ? channelTickInterval(usable) : usable.periodicTickInterval || 3;
      const dotDuration = usable.periodicDuration || durationFromTooltip(usable.tooltip) || castTime || 1;
      const tickCount = Math.max(1, Math.ceil(dotDuration / tickInterval));
      const power = num(spellPower);
      const direct = (usable.directDamage ?? usable.damage) + power * (usable.directCoefficient ?? (usable.coefficient || 0) * (1 - periodicFraction));
      const periodic = (usable.periodicDamage || 0) + power * (usable.periodicCoefficient || 0) * tickCount;
      const crit = hit && !channeled && direct > 0 && roll() < 0.05;
      const critMultiplier = crit ? 1.5 : 1;
      const directDamage = hit && !channeled ? direct * critMultiplier : 0;
      const periodicDamage = hit ? (channeled ? direct + periodic : periodic) : 0;
      damage += directDamage; event.damage += directDamage; event.casts++; if (crit) { event.crits++; crits++; }
      if ((channeled || isPeriodic(usable)) && periodicDamage) {
        effects.apply(usable.name, 'debuff', completeAt, completeAt + dotDuration);
        dots.set(usable.name, { specialization: usable.specialization, school: usable.school, ticks: Array.from({ length: tickCount }, (_, index) => ({ at: completeAt + Math.min(dotDuration, (index + 1) * tickInterval), damage: periodicDamage / tickCount })) });
      }
      events.set(usable.name, event); casts++;
      cooldowns.set(usable.name, completeAt + (Number(usable.cooldown) || 0));
      castLog.push({ time, name: usable.name, school: usable.school, specialization: usable.specialization, hit, crit, activeBuffs: [], enemyDebuffs: debuffsAtCast, currentMana: resource, consumedBuffs: [], procs: channeled && !hit ? ['Channel cancelled · 1.5s recovery'] : [], damage: directDamage, type: 'cast' });
      addMana(time, nextActionAt); time = nextActionAt;
    }
    for (const [name, dot] of dots) {
      while (dot.ticks.length && dot.ticks[0].at <= time + 1e-7) {
        const tick = dot.ticks.shift();
        const crit = roll() < 0.05;
        if (crit) { tick.damage *= 1.5; crits++; }
        damage += tick.damage;
        const event = events.get(name); if (event) { event.damage += tick.damage; event.ticks++; if (crit) event.crits++; }
        castLog.push({ time: tick.at, name: `${name} tick`, school: dot.school, specialization: dot.specialization, hit: true, crit, activeBuffs: [], enemyDebuffs: effects.active('debuff', tick.at), currentMana: resource, consumedBuffs: [], procs: [], damage: tick.damage, type: 'tick' });
      }
      if (!dot.ticks.length) dots.delete(name);
    }
  }
  castLog.sort((a, b) => a.time - b.time);
  return { damage, casts, crits, dps: duration ? damage / duration : 0, manaSpent: spent, manaActions: {}, buffs: [], effectUptimes: effects.summary(), castLog, events: [...events.values()] };
}
