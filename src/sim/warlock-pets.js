import { petsForClass } from '../data/pets.js';

export function warlockPetState(build, options) {
  const unlocked = petsForClass('warlock').filter(pet => pet.level <= (options.talentLevel ?? 60));
  const valid = id => unlocked.some(pet => pet.id === id) ? id : '';
  const selected = valid(options.activePetId);
  if (!build['Demonic Sacrifice'] || !options.sacrificePet) return { activePetId: selected, sacrificedPetId: '' };
  if (!build['Demonic Pact']) return { activePetId: '', sacrificedPetId: selected };
  const sacrificed = valid(options.sacrificedPetId);
  return { activePetId: selected, sacrificedPetId: sacrificed !== selected ? sacrificed : '' };
}
