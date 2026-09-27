// Auto-attack reference profiles, separated from summon/ability data so new
// pets can use the same attack engine. Melee damage anchors are Classic
// WoWSims values; Forever's owner-stat scaling still needs in-game calibration.
const meleeAnchors = {
  voidwalker: [
    { level: 25, min: 2, max: 7, strength: 50 },
    { level: 40, min: 5, max: 15, strength: 74 },
    { level: 60, min: 31, max: 46, strength: 129 },
  ],
  succubus: [
    { level: 25, min: 23, max: 38, strength: 50 },
    { level: 40, min: 41, max: 61, strength: 74 },
    { level: 60, min: 95, max: 131, strength: 129 },
  ],
  felhunter: [
    { level: 25, min: 24, max: 40, strength: 50 },
    { level: 40, min: 24, max: 40, strength: 74 },
    { level: 60, min: 70, max: 97, strength: 129 },
  ],
};

export const petAttackProfiles = {
  imp: { kind: 'spell', ability: 'Firebolt', mode: 'ranged', school: 'Fire', baseInterval: 2 },
  voidwalker: { kind: 'melee', mode: 'melee', school: 'Physical', swingSpeed: 2, anchors: meleeAnchors.voidwalker },
  succubus: { kind: 'melee', mode: 'melee', school: 'Physical', swingSpeed: 2, anchors: meleeAnchors.succubus },
  incubus: { kind: 'melee', mode: 'melee', school: 'Physical', swingSpeed: 2, anchors: meleeAnchors.succubus },
  felhunter: { kind: 'melee', mode: 'melee', school: 'Physical', swingSpeed: 2, anchors: meleeAnchors.felhunter },
};

export const petAttackProfileFor = (profiles, petId, level, overrides = {}) => {
  const base = profiles[petId];
  if (!base) return null;
  if (base.kind !== 'melee') return { ...base, ...overrides };

  const anchors = base.anchors;
  const petLevel = Math.max(1, Math.min(60, Number(level) || 60));
  let lower = anchors[0], upper = anchors.at(-1);
  for (let index = 0; index < anchors.length - 1; index++) {
    if (petLevel <= anchors[index + 1].level) {
      lower = anchors[index]; upper = anchors[index + 1]; break;
    }
  }
  const fraction = lower === upper ? 0 : (petLevel - lower.level) / (upper.level - lower.level);
  const interpolate = key => lower[key] + (upper[key] - lower[key]) * fraction;
  return {
    ...base,
    ...overrides,
    level: petLevel,
    damageMin: interpolate('min'),
    damageMax: interpolate('max'),
    strength: interpolate('strength'),
    attackPower: Math.max(0, 2 * interpolate('strength') - 20) + (Number(overrides.attackPower) || 0),
  };
};

export const rollPetMeleeDamage = (profile, random = Math.random) => {
  if (!profile || profile.kind !== 'melee') return 0;
  return profile.damageMin + random() * (profile.damageMax - profile.damageMin)
    + profile.attackPower / 14 * profile.swingSpeed;
};
