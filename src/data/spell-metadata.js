const schoolPattern = /\b(Arcane|Fire|Frostfire|Frost|Shadow|Nature|Holy|Physical)\s+damage\b/i;
const defaultSchoolBySpecialization = {
  Affliction: 'Shadow', Demonology: 'Shadow', Destruction: 'Fire', Demons: 'Shadow',
  Arcane: 'Arcane', Fire: 'Fire', Frost: 'Frost', Balance: 'Nature', Feral: 'Physical',
  Restoration: 'Nature', Elemental: 'Nature', Enhancement: 'Physical', Holy: 'Holy',
  Discipline: 'Holy', Shadow: 'Shadow', Combat: 'Physical', Assassination: 'Physical',
  Subtlety: 'Physical', BeastMastery: 'Physical', Marksmanship: 'Physical', Survival: 'Physical',
};

/** Attach specialization and damage-school tags to every spell rank, including
 * non-damaging spells and pet abilities. The spellbook tab supplies the tree. */
export function addSpellMetadata(classData) {
  const spell_metadata = {};
  const tabs = [
    ...(classData.spellbook.general?.length ? [{ name: 'General', spells: classData.spellbook.general }] : []),
    ...classData.spellbook.tabs,
  ];
  for (const tab of tabs) {
    for (const [name, rank] of tab.spells) {
      const detail = classData.spell_desc[`${classData.class}|${name}|${rank}`];
      const tooltipSchool = detail?.d?.match(schoolPattern)?.[1];
      const school = detail?.sc || tooltipSchool || defaultSchoolBySpecialization[tab.name] || 'Utility';
      spell_metadata[`${tab.name}|${name}|${rank}`] = { name, rank, specialization: tab.name, school };
    }
  }
  return { ...classData, spellbook: { ...classData.spellbook, spell_metadata } };
}
