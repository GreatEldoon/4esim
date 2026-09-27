// Shared pet catalog. Add future class companions under their class id without
// coupling pet availability to a class's damage-simulation implementation.
export const petsByClass = {
  warlock: [
    {
      id: 'imp', name: 'Imp', summonSpell: 'Summon Imp', level: 1,
      abilities: [
        { name: 'Firebolt', ranks: 7, type: 'Attack' },
        { name: 'Blood Pact', ranks: 5, type: 'Party buff' },
        { name: 'Fire Shield', ranks: 5, type: 'Buff' },
        { name: 'Phase Shift', ranks: 0, type: 'Defensive' },
      ],
    },
    {
      id: 'voidwalker', name: 'Voidwalker', summonSpell: 'Summon Voidwalker', level: 10,
      abilities: [
        { name: 'Torment', ranks: 6, type: 'Taunt' },
        { name: 'Suffering', ranks: 4, type: 'AoE taunt' },
        { name: 'Sacrifice', ranks: 6, type: 'Shield' },
        { name: 'Consume Shadows', ranks: 6, type: 'Heal' },
      ],
    },
    {
      id: 'succubus', name: 'Succubus', summonSpell: 'Summon Succubus', level: 20,
      abilities: [
        { name: 'Lash of Pain', ranks: 6, type: 'Attack' },
        { name: 'Soothing Kiss', ranks: 4, type: 'Threat reduction' },
        { name: 'Seduction', ranks: 0, type: 'Crowd control' },
        { name: 'Lesser Invisibility', ranks: 0, type: 'Stealth' },
      ],
    },
    {
      id: 'incubus', name: 'Incubus', summonSpell: 'Summon Incubus', level: 20,
      sharesAbilitiesWith: 'succubus',
      abilities: [
        { name: 'Lash of Pain', ranks: 6, type: 'Attack' },
        { name: 'Soothing Kiss', ranks: 4, type: 'Threat reduction' },
        { name: 'Seduction', ranks: 0, type: 'Crowd control' },
        { name: 'Lesser Invisibility', ranks: 0, type: 'Stealth' },
      ],
    },
    {
      id: 'felhunter', name: 'Felhunter', summonSpell: 'Summon Felhunter', level: 30,
      abilities: [
        { name: 'Devour Magic', ranks: 4, type: 'Dispel' },
        { name: 'Paranoia', ranks: 0, type: 'Party aura' },
        { name: 'Spell Lock', ranks: 2, type: 'Interrupt' },
        { name: 'Tainted Blood', ranks: 4, type: 'Debuff' },
      ],
    },
  ],
};

export const petsForClass = classId => petsByClass[classId] || [];
