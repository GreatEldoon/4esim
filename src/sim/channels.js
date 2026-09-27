// Fallback names keep older saved spell configurations usable.
const channelIntervals = { 'Arcane Missiles': 1, Blizzard: 1, Wrack: 1, 'Drain Life': 1, 'Drain Soul': 3, 'Rain of Fire': 2, Hellfire: 1, 'Mind Flay': 1, Hurricane: 1, Volley: 1 };
export const isDamageChannel = spell => spell.channeled ?? Object.hasOwn(channelIntervals, spell.name);
export const channelTickInterval = spell => spell.channelTickInterval || channelIntervals[spell.name] || spell.periodicTickInterval || 1;
