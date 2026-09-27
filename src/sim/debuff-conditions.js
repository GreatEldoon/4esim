const hasStackingTooltip = spell => Number(spell.debuffMaxStacks) > 1
  || Number(spell.tooltip?.match(/stack(?:s|ing) up to\s+(\d+)/i)?.[1] || 0) > 1;

export function debuffRefreshBehavior(classId, spell, build = {}) {
  if (classId === 'warlock') {
    const periodic = Number(spell.periodicDamage) > 0 && Number(spell.periodicDuration) > 0
      || /damage (?:over|every|each second|per second)/i.test(spell.tooltip || '');
    const talented = (spell.name === 'Shadow Bolt' && build['Improved Shadow Bolt'])
      || (['Conflagrate', 'Shadowburn'].includes(spell.name) && build['Shadow and Flame']);
    const applies = periodic || ['Shadow Bolt', 'Conflagrate', 'Shadowburn'].includes(spell.name);
    return { applies, enabled: periodic || Boolean(talented), stacks: hasStackingTooltip(spell) };
  }

  if (classId === 'mage') {
    const fire = spell.school === 'Fire' || spell.name === 'Frostfire Bolt';
    const frost = spell.school === 'Frost' || spell.name === 'Frostfire Bolt';
    const natural = /slow(?:s|ed|ing)?|freez(?:e|es|ed|ing)|chill/i.test(spell.tooltip || '');
    const chills = natural || spell.name === 'Blizzard';
    const applies = natural || fire || frost || spell.name === 'Scorch';
    const enabled = natural || (fire && build.Ignite) || (frost && build["Winter's Chill"])
      || (chills && build.Frostbite) || (spell.name === 'Blizzard' && build['Improved Blizzard'])
      || (spell.name === 'Scorch' && build['Improved Scorch']);
    const stacks = hasStackingTooltip(spell)
      || (spell.name === 'Scorch' && Boolean(build['Improved Scorch']))
      || (frost && Number(build["Winter's Chill"]) > 1)
      || (fire && Boolean(build.Ignite));
    return { applies, enabled: Boolean(enabled), stacks };
  }

  return { applies: false, enabled: false, stacks: false };
}

export function debuffRefreshWindow(classId, spell, build = {}, castTime = spell.cast) {
  const behavior = debuffRefreshBehavior(classId, spell, build);
  return Number(castTime) > 3 || behavior.stacks ? 5 : 3;
}
