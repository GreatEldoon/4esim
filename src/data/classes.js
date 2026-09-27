import warriorIcon from '../assets/classes/warrior.jpg';
import paladinIcon from '../assets/classes/paladin.jpg';
import hunterIcon from '../assets/classes/hunter.jpg';
import rogueIcon from '../assets/classes/rogue.jpg';
import priestIcon from '../assets/classes/priest.jpg';
import shamanIcon from '../assets/classes/shaman.jpg';
import mageIcon from '../assets/classes/mage.jpg';
import warlockIcon from '../assets/classes/warlock.jpg';
import druidIcon from '../assets/classes/druid.jpg';

export const classRegistry = [
  { id: 'druid', icon: druidIcon, name: 'Druid', mark: 'D', accent: '#FFA04B', available: false },
  { id: 'hunter', icon: hunterIcon, name: 'Hunter', mark: 'H', accent: '#B4DB7A', available: false },
  { id: 'mage', icon: mageIcon, name: 'Mage', mark: 'M', accent: '#69CCF0', available: true },
  { id: 'paladin', icon: paladinIcon, name: 'Paladin', mark: 'P', accent: '#F58CBA', available: false },
  { id: 'priest', icon: priestIcon, name: 'Priest', mark: 'Pr', accent: '#F2F4F5', available: false },
  { id: 'rogue', icon: rogueIcon, name: 'Rogue', mark: 'R', accent: '#FFF080', available: false },
  { id: 'shaman', icon: shamanIcon, name: 'Shaman', mark: 'S', accent: '#55A4F0', available: false },
  { id: 'warlock', icon: warlockIcon, name: 'Warlock', mark: 'Wl', accent: '#B39AE8', available: true },
  { id: 'warrior', icon: warriorIcon, name: 'Warrior', mark: 'W', accent: '#D6A66F', available: false },
];
