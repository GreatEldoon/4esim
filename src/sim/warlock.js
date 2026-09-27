import { petAttackProfileFor, petAttackProfiles, rollPetMeleeDamage } from '../data/pet-attack-profiles.js';

const rank = (build, name) => Number(build[name]) || 0;
const rankValue = (build, name, values) => values[Math.max(0, Math.min(values.length - 1, rank(build, name) - 1))] || 0;
const avg = range => range.reduce((sum, value) => sum + value, 0) / range.length;
const durationFromTooltip = text => Number(text.match(/(?:over|for)\s+(\d+)\s+sec/i)?.[1] || text.match(/lasts\s+(\d+)\s+sec/i)?.[1] || 0);
const periodicSpell = spell => /damage over \d+ sec|damage every \d+ sec|damage each second|damage per second/i.test(spell.tooltip || '') || ['Corruption', 'Bane of Agony', 'Bane of Doom', 'Drain Life', 'Drain Soul', 'Siphon Life', 'Wrack', 'Immolate', 'Rain of Fire', 'Hellfire'].includes(spell.name);

/** Warlock single-target rotation model. Spellbook specialization and damage school
 * are deliberately independent: e.g. Shadow Bolt is Shadow damage from Destruction. */
export function simulateWarlock(priority, duration, maxMana, mp5, spirit, build, seed, baseHitChance, spellPower, _manaOptions = {}, options = {}) {
  let time = 0, mana = maxMana, damage = 0, casts = 0, crits = 0, manaSpent = 0, lastCastAt = -Infinity, soulFireProcUntil = -1;
  const maxManaCap = maxMana * (1 + 0.05 * rank(build, 'Fel Vitality'));
  const gcd = 1.5, baseCritChance = 0.05, cooldowns = new Map(), castLog = [], events = new Map(), dots = new Map(), debuffs = new Map();
  let randomState = seed >>> 0 || 1, nightfallActive = false;
  let demonicBrandUntil = -1, demonicBrandAttacks = 0;
  const petSpell = options.petSpell || null;
  const summonedPet = Boolean(options.activePetId && !options.sacrificePet);
  const sacrificedPet = rank(build, 'Demonic Sacrifice') && options.sacrificePet ? options.activePetId : '';
  const sacrificeManaPerSecond = sacrificedPet === 'voidwalker' ? maxManaCap * 0.005 : 0;
  const petProfile = options.activePetId && !options.sacrificePet
    ? petAttackProfileFor(petAttackProfiles, options.activePetId, options.talentLevel, options.petProfileOverrides)
    : null;
  const petAbilityInterval = petSpell ? Math.max(1, petSpell.cast || petSpell.cooldown || 2) : Infinity;
  let nextPetAbilityAt = petSpell ? petAbilityInterval : Infinity;
  let nextPetSwingAt = petProfile?.kind === 'melee' ? petProfile.swingSpeed : Infinity;
  const roll = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 0x100000000);
  const spiritPerSecond = (Math.max(0, spirit) / 4 + 13) / 2;
  const passiveRegen = Math.max(0, mp5) / 5;
  const activeAfflictionEffects = at => [...dots.entries()].filter(([name, dot]) => dot.until > at && dot.specialization === 'Affliction' && !['Drain Life', 'Drain Soul'].includes(name)).length;
  const spellDamageMultiplier = (spell, at) => {
    let factor = 1;
    if (spell.school === 'Shadow') factor *= 1 + 0.01 * rank(build, 'Shadow Mastery');
    if (summonedPet && options.activePetId === 'imp' && spell.school === 'Fire') factor *= 1 + 0.02 * rank(build, 'Master Demonologist');
    if (summonedPet && ['succubus', 'incubus'].includes(options.activePetId) && spell.school === 'Shadow') factor *= 1 + 0.02 * rank(build, 'Master Demonologist');
    if (rank(build, 'Soul Link') && summonedPet) factor *= 1.03;
    if (sacrificedPet === 'imp' && spell.school === 'Shadow') factor *= 1.15;
    if (['succubus', 'incubus'].includes(sacrificedPet) && spell.school === 'Fire') factor *= 1.15;
    if (rank(build, 'Agonizing Flames') && spell.specialization === 'Destruction') factor *= 1 + rankValue(build, 'Agonizing Flames', [0.03, 0.07, 0.1]);
    if (periodicSpell(spell) && rank(build, 'Malediction')) factor *= 1 + 0.01 * rank(build, 'Malediction');
    if (spell.specialization === 'Affliction' && ['Drain Life', 'Drain Soul', 'Wrack'].includes(spell.name)) {
      factor *= 1 + rankValue(build, 'Improved Drains', [0.07, 0.13, 0.2]);
      factor *= 1 + Math.min(3, activeAfflictionEffects(at)) * rankValue(build, 'Soul Siphon', [0.04, 0.08, 0.12]);
    }
    if (spell.name === 'Bane of Agony') factor *= 1 + 0.05 * rank(build, 'Improved Bane of Agony');
    if (spell.name === 'Corruption') factor *= 1 + 0.02 * rank(build, 'Improved Corruption');
    if (spell.specialization === 'Destruction' && spell.name === 'Incinerate' && debuffs.get('Immolate') > at) factor *= 1.25;
    if (spell.school === 'Shadow' && !periodicSpell(spell) && debuffs.get('Improved Shadow Bolt') > at) factor *= 1 + 0.04 * rank(build, 'Improved Shadow Bolt');
    if (spell.school === 'Shadow' && !periodicSpell(spell) && debuffs.get('Shadow and Flame · Shadow') > at) factor *= 1 + 0.02 * rank(build, 'Shadow and Flame');
    if (spell.school === 'Fire' && !periodicSpell(spell) && debuffs.get('Shadow and Flame · Fire') > at) factor *= 1 + 0.02 * rank(build, 'Shadow and Flame');
    return factor;
  };
  const castTimeFor = spell => Math.max(0, spell.cast * (spell.name === 'Soul Fire' && soulFireProcUntil >= time ? 1 - rankValue(build, 'Decimation', [0.2, 0.4]) : 1) - (spell.name === 'Corruption' ? 0.4 * rank(build, 'Improved Corruption') : 0) - (spell.specialization === 'Destruction' && ['Shadow Bolt', 'Immolate', 'Incinerate'].includes(spell.name) ? 0.1 * rank(build, 'Bane') : 0) - (spell.name === 'Soul Fire' ? 0.4 * rank(build, 'Bane') : 0));
  const manaCostFor = spell => Math.max(0, ((spell.mana || 0) + (spell.manaFraction || 0) * maxManaCap) * (1 - (spell.specialization === 'Destruction' ? rankValue(build, 'Cataclysm', [0.03, 0.06, 0.1]) : 0)));
  const activeBuffs = () => [];
  const activeEnemyDebuffs = at => [...debuffs].filter(([, until]) => until > at).map(([name, until]) => ({ id: name.toLowerCase().replaceAll(' ', ''), name, remaining: until - at }));
  const conditionsMet = (spell, at) => {
    if (!spell.conditional) return true;
    const conditions = Array.isArray(spell.conditions) ? spell.conditions : (spell.condition ? [spell.condition] : []);
    if (!conditions.length) return false;
    const immolate = dots.get('Immolate');
    const immolateRemaining = immolate ? immolate.until - at : 0;
    return conditions.some(condition => {
      if (condition === 'immolateInactive') return !immolate || immolateRemaining <= 0;
      if (condition === 'immolateRefresh') return immolateRemaining > 0 && immolateRemaining < 5;
      return true;
    });
  };

  const nextTick = () => Math.min(duration, nextPetAbilityAt, nextPetSwingAt, ...[...dots.values()].flatMap(dot => dot.ticks.filter(tick => tick.at <= duration).map(tick => tick.at)), ...priority.flatMap(spell => spell.conditional && spell.conditions?.includes('immolateRefresh') && dots.has('Immolate') ? [dots.get('Immolate').until - 5].filter(at => at > time) : []));
  while (time < duration && casts < duration * 4) {
    const next = nextTick();
    const manaWait = (spell, now) => {
      const rate = passiveRegen + sacrificeManaPerSecond + (now >= lastCastAt + 5 ? spiritPerSecond : 0);
      return rate > 0 ? Math.max(0, manaCostFor(spell) - mana) / rate : Infinity;
    };
    const ready = priority.filter(spell => (cooldowns.get(spell.name) || 0) <= time && manaCostFor(spell) <= mana && (spell.name !== 'Conflagrate' || (debuffs.get('Immolate') || 0) > time));
    const conditionalReady = ready.find(spell => spell.conditional && conditionsMet(spell, time));
    const usable = (nightfallActive && ready.find(spell => spell.name === 'Shadow Bolt')) || conditionalReady || ready.find(spell => !spell.conditional);
    const unaffordable = priority.some(spell => (cooldowns.get(spell.name) || 0) <= time && manaCostFor(spell) > mana && manaCostFor(spell) <= maxManaCap);
    if (!usable && options.lifeTap && unaffordable && mana < maxManaCap) {
      const manaGained = Math.min(maxManaCap - mana, options.lifeTap.mana * (1 + 0.1 * rank(build, 'Improved Life Tap')));
      mana = Math.min(maxManaCap, mana + manaGained);
      lastCastAt = time;
      castLog.push({ time, name: 'Life Tap', school: 'Shadow', specialization: 'Affliction', hit: true, crit: false, activeBuffs: [], enemyDebuffs: activeEnemyDebuffs(time), currentMana: mana, consumedBuffs: [], procs: [`MANA · +${Math.round(manaGained)}`], damage: 0, type: 'mana' });
      casts++; time += gcd;
    } else if (!usable) {
      const future = priority.map(spell => Math.max(cooldowns.get(spell.name) || 0, time + manaWait(spell, time))).filter(at => at > time && Number.isFinite(at));
      const wakeAt = Math.min(next, ...future, duration);
      if (wakeAt <= time) break;
      const regenSeconds = Math.max(0, wakeAt - Math.max(time, lastCastAt + 5));
      mana = Math.min(maxManaCap, mana + (wakeAt - time) * (passiveRegen + sacrificeManaPerSecond) + regenSeconds * spiritPerSecond);
      time = wakeAt;
    } else {
      const usesNightfall = usable.name === 'Shadow Bolt' && nightfallActive;
      const castTime = usesNightfall ? 0 : castTimeFor(usable), completion = time + castTime, nextActionAt = time + Math.max(gcd, castTime);
      if (completion > duration) break;
      mana = Math.max(0, mana - manaCostFor(usable)); manaSpent += manaCostFor(usable); lastCastAt = time;
      const event = events.get(usable.name) || { name: usable.name, damage: 0, casts: 0, crits: 0, ticks: 0 };
      const hit = roll() < Math.min(1, Math.max(0, baseHitChance / 100 + 0.01 * rank(build, 'Suppression')));
      let critChance = baseCritChance + (usable.school === 'Shadow' ? 0.01 * rank(build, 'Malevolence') : 0) + (usable.name === 'Searing Pain' ? rankValue(build, 'Agonizing Flames', [0.0333, 0.0667, 0.1]) : 0);
      if (usable.name === 'Conflagrate') critChance += rankValue(build, 'Fire and Brimstone', [0.0833, 0.1667, 0.25]);
      const critical = hit && roll() < Math.min(1, critChance);
      let critBonus = 0.5 + (usable.specialization === 'Destruction' ? 0.1 * rank(build, 'Ruin') : 0);
      if (rank(build, 'Pandemic') && ['Corruption', 'Bane of Agony', 'Bane of Doom', 'Drain Soul', 'Drain Life', 'Siphon Life', 'Wrack'].includes(usable.name)) critBonus += 0.5 * rank(build, 'Pandemic') / 3;
      const periodicFraction = usable.damage ? usable.periodicDamage / usable.damage : 0;
      const demonicPower = summonedPet ? (Number(options.talentLevel) || 60) * rank(build, 'Demonic Knowledge') / 3 : 0;
      const execute = Number(options.targetHealthPercent) < 35 && rank(build, 'Decimation') > 0 && ['Shadow Bolt', 'Searing Pain'].includes(usable.name);
      const executeMultiplier = execute ? 1 + rankValue(build, 'Decimation', [0.03, 0.06]) : 1;
      const effectiveSpellPower = Math.max(0, spellPower) + demonicPower;
      const factor = spellDamageMultiplier(usable, completion);
      const tickInterval = usable.name === 'Wrack' ? 1 : (usable.name === 'Bane of Doom' ? 60 : (usable.periodicTickInterval || 3));
      const tickCount = Math.max(1, Math.ceil((usable.periodicDuration || durationFromTooltip(usable.tooltip) || usable.cast || 1) / tickInterval));
      const direct = (usable.directDamage ?? usable.damage) + effectiveSpellPower * (usable.directCoefficient ?? (usable.coefficient || 0) * (1 - periodicFraction));
      const periodic = (usable.periodicDamage || 0) + effectiveSpellPower * (usable.periodicCoefficient || 0) * tickCount;
      const critFactor = critical ? 1 + critBonus : 1;
      const directFactor = usable.name === 'Immolate' ? 1 + 0.1 * rank(build, 'Aftermath') : 1;
      const directAmount = hit ? direct * factor * directFactor * executeMultiplier * critFactor : 0;
      const periodicAmount = hit ? periodic * factor * executeMultiplier * critFactor : 0;
      const amount = directAmount + periodicAmount;
      if (amount) {
        if (periodicSpell(usable) && periodicAmount > 0) {
          const dotDuration = usable.periodicDuration || durationFromTooltip(usable.tooltip) || usable.cast || 1;
          const dotTickCount = Math.max(1, Math.ceil(dotDuration / tickInterval));
          const ticks = Array.from({ length: dotTickCount }, (_, i) => ({ at: completion + Math.min(dotDuration, (i + 1) * tickInterval), amount: periodicAmount / dotTickCount }));
          dots.set(usable.name, { until: completion + dotDuration, ticks, specialization: usable.specialization, school: usable.school });
          if (usable.name === 'Immolate') debuffs.set('Immolate', completion + dotDuration);
        }
        if (directAmount) { damage += directAmount; event.damage += directAmount; }
      }
      event.casts++; if (critical) event.crits++; events.set(usable.name, event); casts++;
      const procs = [];
      if (usable.name === 'Shadow Bolt' && critical && rank(build, 'Improved Shadow Bolt')) {
        debuffs.set('Improved Shadow Bolt', completion + 12); procs.push('Improved Shadow Bolt · 12s');
      }
      if (execute && hit) soulFireProcUntil = completion + 10;
      if (usesNightfall) { nightfallActive = false; procs.push('Shadow Trance consumed · instant Shadow Bolt'); }
      if (usable.name === 'Wrack' && hit) debuffs.set('Wrack', completion + 6);
      if (usable.name === 'Conflagrate' && hit && rank(build, 'Shadow and Flame')) debuffs.set('Shadow and Flame · Shadow', completion + 20);
      if (usable.name === 'Shadowburn' && hit && rank(build, 'Shadow and Flame')) debuffs.set('Shadow and Flame · Fire', completion + 20);
      if (usable.name === 'Searing Pain' && hit && rank(build, 'Demonic Brand') && options.activePetId) {
        demonicBrandUntil = completion + 10; demonicBrandAttacks = 2 * rank(build, 'Demonic Brand');
        procs.push(`Demonic Brand · ${demonicBrandAttacks} pet attacks`);
      }
      if (usable.name === 'Conflagrate' && hit && rank(build, 'Shadow and Flame') < 5) debuffs.delete('Immolate');
      const cooldown = usable.name === 'Soul Fire' ? (usable.cooldown || 0) * (1 - 0.45 * rank(build, 'Decimation')) : (usable.cooldown || 0);
      cooldowns.set(usable.name, completion + cooldown);
      castLog.push({ time, name: usable.name, school: usable.school, specialization: usable.specialization, hit, crit: critical, activeBuffs: activeBuffs(), enemyDebuffs: activeEnemyDebuffs(time), currentMana: mana, consumedBuffs: [], procs, damage: directAmount, type: 'cast' });
      mana = Math.min(maxManaCap, mana + (nextActionAt - time) * (passiveRegen + sacrificeManaPerSecond) + Math.max(0, nextActionAt - (time + 5)) * spiritPerSecond);
      time = nextActionAt;
    }
    for (const [name, dot] of dots) {
      while (dot.ticks.length && dot.ticks[0].at <= time + 1e-7) {
        const tick = dot.ticks.shift();
        let tickDamage = tick.amount;
        if (dot.school === 'Shadow' && debuffs.get('Improved Shadow Bolt') > tick.at) tickDamage *= 1 + 0.04 * rank(build, 'Improved Shadow Bolt');
        if (dot.school === 'Shadow' && name !== 'Wrack' && debuffs.get('Wrack') > tick.at) tickDamage *= 1.1;
        if (dot.school === 'Shadow' && debuffs.get('Shadow and Flame · Shadow') > tick.at) tickDamage *= 1 + 0.02 * rank(build, 'Shadow and Flame');
        if (dot.school === 'Fire' && debuffs.get('Shadow and Flame · Fire') > tick.at) tickDamage *= 1 + 0.02 * rank(build, 'Shadow and Flame');
        damage += tickDamage;
        const event = events.get(name); if (event) { event.damage += tickDamage; event.ticks++; }
        const procs = [];
        if (rank(build, 'Nightfall') && ['Corruption', 'Drain Soul', 'Drain Life', 'Wrack'].includes(name) && roll() < 0.02 * rank(build, 'Nightfall')) {
          nightfallActive = true; procs.push('Nightfall · Shadow Trance');
        }
        castLog.push({ time: tick.at, name: `${name} tick`, school: dot.school, specialization: dot.specialization, hit: true, crit: false, activeBuffs: [], enemyDebuffs: activeEnemyDebuffs(tick.at), currentMana: mana, consumedBuffs: [], procs, damage: tickDamage, type: 'tick' });
      }
      if (!dot.ticks.length) dots.delete(name);
    }
    while (petSpell && nextPetAbilityAt <= time + 1e-7 && nextPetAbilityAt <= duration) {
      let petMultiplier = 1 + 0.02 * rank(build, 'Unholy Power');
      if (options.activePetId === 'imp' && petSpell.name === 'Firebolt') petMultiplier *= 1 + 0.1 * rank(build, 'Improved Imp');
      if (['succubus', 'incubus'].includes(options.activePetId) && petSpell.name === 'Lash of Pain') petMultiplier *= 1 + 0.1 * rank(build, 'Improved Sayaad');
      if (rank(build, 'Master Demonologist')) {
        if (options.activePetId === 'imp' && petSpell.school === 'Fire') petMultiplier *= 1 + 0.02 * rank(build, 'Master Demonologist');
        if (['succubus', 'incubus'].includes(options.activePetId) && petSpell.school === 'Shadow') petMultiplier *= 1 + 0.02 * rank(build, 'Master Demonologist');
      }
      if (rank(build, 'Soul Link')) petMultiplier *= 1.03;
      const hit = roll() < Math.min(1, Math.max(0, baseHitChance / 100));
      const crit = hit && roll() < baseCritChance;
      const petPower = (Number(options.talentLevel) || 60) * rank(build, 'Demonic Knowledge') / 3 * (petSpell.coefficient || 0);
      const brandedDamage = demonicBrandAttacks > 0 && demonicBrandUntil >= nextPetAbilityAt ? 65 + roll() * 3 : 0;
      const petDamage = hit ? (petSpell.damage + petPower + brandedDamage) * petMultiplier * (crit ? 1.5 : 1) : 0;
      if (hit && brandedDamage) demonicBrandAttacks--;
      damage += petDamage; casts++; if (crit) crits++;
      const petEvent = events.get(`${options.activePetId} · ${petSpell.name}`) || { name: `${options.activePetId} · ${petSpell.name}`, damage: 0, casts: 0, crits: 0, ticks: 0 };
      petEvent.damage += petDamage; petEvent.casts++; if (crit) petEvent.crits++; events.set(petEvent.name, petEvent);
      castLog.push({ time: nextPetAbilityAt, name: petEvent.name, school: petSpell.school, specialization: petSpell.specialization, hit, crit, activeBuffs: [], enemyDebuffs: activeEnemyDebuffs(nextPetAbilityAt), currentMana: mana, consumedBuffs: [], procs: [], damage: petDamage, type: 'pet' });
      nextPetAbilityAt += petAbilityInterval;
    }
    while (petProfile?.kind === 'melee' && nextPetSwingAt <= time + 1e-7 && nextPetSwingAt <= duration) {
      let petMultiplier = 1 + 0.02 * rank(build, 'Unholy Power');
      if (rank(build, 'Soul Link')) petMultiplier *= 1.03;
      const hit = roll() < Math.min(1, Math.max(0, baseHitChance / 100));
      const critChance = Math.max(0, Number(options.petCritChance ?? baseCritChance * 100)) / 100;
      const crit = hit && roll() < Math.min(1, critChance);
      const branded = demonicBrandAttacks > 0 && demonicBrandUntil >= nextPetSwingAt;
      const brandedDamage = branded ? 65 + roll() * 3 : 0;
      const rawDamage = rollPetMeleeDamage(petProfile, roll) + brandedDamage;
      const petDamage = hit ? rawDamage * petMultiplier * (crit ? 1.5 : 1) : 0;
      if (hit && branded) demonicBrandAttacks--;
      damage += petDamage; casts++; if (crit) crits++;
      const petName = `${options.activePetId} · Melee`;
      const petEvent = events.get(petName) || { name: petName, specialization: 'Demons', damage: 0, casts: 0, crits: 0, ticks: 0 };
      petEvent.damage += petDamage; petEvent.casts++; if (crit) petEvent.crits++; events.set(petName, petEvent);
      castLog.push({ time: nextPetSwingAt, name: petName, school: petProfile.school, specialization: 'Demons', hit, crit, activeBuffs: [], enemyDebuffs: activeEnemyDebuffs(nextPetSwingAt), currentMana: mana, consumedBuffs: [], procs: branded ? ['Demonic Brand · bonus damage'] : [], damage: petDamage, type: 'pet' });
      nextPetSwingAt += petProfile.swingSpeed;
    }
  }
  castLog.sort((a, b) => a.time - b.time);
  return { damage, casts, crits, dps: duration ? damage / duration : 0, manaSpent, manaActions: {}, buffs: [], castLog, events: [...events.values()] };
}
