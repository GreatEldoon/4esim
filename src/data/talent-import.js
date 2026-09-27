export function parseWowheadTalents(text, classData) {
  const header = text.match(/\b([A-Za-z]+) Talents\s*\((\d+)\/(\d+)\/(\d+)\)/i);
  if (!header) throw new Error('Paste the full Wowhead talent export, including the class and talent totals.');
  if (header[1].toLowerCase() !== classData.class.toLowerCase()) throw new Error(`Select ${header[1]} before importing this build.`);
  const level = Number(text.match(/Required level:\s*(\d+)/i)?.[1]);
  if (!Number.isInteger(level) || level < 1 || level > 60) throw new Error('The export must include a required level between 1 and 60.');
  const talents = new Map(classData.talents.trees.flatMap(tree => tree.talents.map(talent => [talent.name, talent])));
  const build = {};
  for (const line of text.split(/\r?\n/)) {
    const entry = line.match(/^\s*(?:[-*•]\s*)?(.+?)\s+(\d+)\/(\d+)\s*:/);
    if (!entry || entry[1] === 'Talented') continue;
    const [, name, rawRank, rawMax] = entry;
    const talent = talents.get(name);
    if (!talent) throw new Error(`Unknown talent: ${name}. The export may use a different talent version.`);
    const rank = Number(rawRank);
    if (Number(rawMax) !== talent.max || rank > talent.max) throw new Error(`Invalid rank for ${name}; this version supports ${talent.max} points.`);
    if (Object.hasOwn(build, name)) throw new Error(`Duplicate talent: ${name}.`);
    build[name] = rank;
  }
  const totals = classData.talents.trees.map(tree => tree.talents.reduce((sum, talent) => sum + (build[talent.name] || 0), 0));
  if (totals.some((total, index) => total !== Number(header[index + 2]))) throw new Error('Talent ranks do not match the export totals. Paste the complete export.');
  const points = totals.reduce((sum, total) => sum + total, 0);
  if (points > Math.max(0, level - 9)) throw new Error('This build spends more talent points than its level allows.');
  return { build, level, points, totals };
}
