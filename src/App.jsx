import { useMemo, useRef, useState } from 'react';
import mage from './data/mage.json';

const defaultNames = ['Frostbolt', 'Fireball', 'Arcane Blast'];
const numberFromText = value => Number(String(value || '').replace(/,/g, '').match(/[\d.]+/)?.[0] || 0);
function damageFromTooltip(text) {
  if (/absorbs?|damage taken|absorb(?:ed|ing)? damage/i.test(text)) return 0;
  const hits = [...text.matchAll(/([\d,]+)(?:\s+to\s+([\d,]+))?\s+(?:(?:Arcane|Fire|Frostfire|Frost)\s+)?damage(?:(?:\s+each second for\s+(\d+)\s+sec)|(?:\s+over\s+(\d+)\s+sec))?/gi)];
  return hits.reduce((sum, hit) => {
    const amount = (numberFromText(hit[1]) + numberFromText(hit[2] || hit[1])) / 2;
    return sum + amount * (Number(hit[3]) || 1);
  }, 0);
}
function buildDamageSpellCatalog() {
  return mage.spellbook.tabs.flatMap(tab => {
    const byName = new Map();
    tab.spells.forEach(([name, rank]) => {
      const rankNumber = numberFromText(rank);
      const detail = mage.spell_desc[`Mage|${name}|${rank}`];
      if (!detail || !damageFromTooltip(detail.d || '')) return;
      const ranks = byName.get(name) || [];
      ranks.push({ name, rank, rankNumber, detail, school: tab.name });
      byName.set(name, ranks);
    });
    return [...byName.values()].map(ranks => {
      const spell = ranks.sort((a, b) => a.rankNumber - b.rankNumber).at(-1);
      const tooltip = spell.detail.d || '';
      const metadata = spell.detail.l || [];
      const manaText = metadata[0]?.[0] || '';
      const castText = metadata[1]?.[0] || '';
      const cooldownText = metadata[1]?.[1] || '';
      const manaFraction = Number(manaText.match(/([\d.]+)%\s+of base mana/i)?.[1] || 0) / 100;
      const castMatch = castText.match(/([\d.]+)\s*sec\s+cast/i);
      const channelDuration = Number(tooltip.match(/for\s+(\d+)\s+sec/i)?.[1] || 0);
      const cooldownSeconds = numberFromText(cooldownText) * (/min/i.test(cooldownText) ? 60 : 1);
      const damage = damageFromTooltip(tooltip);
      return {
        name: spell.name,
        rank: spell.rank,
        damage: Math.round(damage),
        cast: castMatch ? Number(castMatch[1]) : /channeled/i.test(castText) ? channelDuration : 0,
        mana: manaFraction ? 0 : numberFromText(manaText),
        manaFraction,
        cooldown: cooldownSeconds,
        school: spell.school,
        tooltip,
      };
    });
  }).sort((a, b) => a.school.localeCompare(b.school) || a.name.localeCompare(b.name));
}
const damageSpellCatalog = buildDamageSpellCatalog();
const initialPriority = defaultNames.map(name => damageSpellCatalog.find(spell => spell.name === name)).filter(Boolean);
const spellRankText = name => Object.entries(mage.spell_desc).filter(([key]) => key.startsWith(`Mage|${name}|`)).map(([, detail]) => detail).at(-1);
const manaCost = (spell, maxMana) => Math.max(0, (Number(spell.mana) || 0) + (Number(spell.manaFraction) || 0) * maxMana);
function simulate(priority, duration, maxMana, regen) {
  const GCD = 1.5;
  let time = 0, mana = maxMana, gcdUntil = 0, castUntil = 0;
  let damage = 0, casts = 0, manaSpent = 0;
  const cooldowns = new Map();
  const castCounts = new Map();
  const maxEvents = Math.max(1000, Math.ceil(duration * 20));

  while (time < duration && casts < maxEvents) {
    const previousTime = time;
    time = Math.max(time, gcdUntil, castUntil);
    mana = Math.min(maxMana, mana + (time - previousTime) * Math.max(0, regen));
    if (time >= duration || !priority.length) break;

    const usable = priority.find(spell => {
      const readyAt = cooldowns.get(spell.name) || 0;
      return readyAt <= time && manaCost(spell, maxMana) <= mana;
    });

    if (usable) {
      const cost = manaCost(usable, maxMana);
      const castTime = Math.max(0, Number(usable.cast) || 0);
      const cooldown = Math.max(0, Number(usable.cooldown) || 0);
      mana = Math.max(0, mana - cost);
      manaSpent += cost;
      cooldowns.set(usable.name, time + cooldown);
      castUntil = time + castTime;
      gcdUntil = time + GCD;
      if (time + castTime <= duration) {
        damage += Math.max(0, Number(usable.damage) || 0);
        casts++;
        castCounts.set(usable, (castCounts.get(usable) || 0) + 1);
      }
      continue;
    }

    const wakeAt = priority.reduce((earliest, spell) => {
      const cost = manaCost(spell, maxMana);
      if (cost > maxMana) return earliest;
      const manaWait = mana >= cost ? 0 : regen > 0 ? (cost - mana) / regen : Infinity;
      const usableAt = Math.max(cooldowns.get(spell.name) || 0, time + manaWait);
      return Math.min(earliest, usableAt);
    }, Infinity);
    if (!Number.isFinite(wakeAt) || wakeAt <= time || wakeAt >= duration) break;
    mana = Math.min(maxMana, mana + (wakeAt - time) * regen);
    time = wakeAt;
  }

  return {
    damage,
    casts,
    dps: duration ? damage / duration : 0,
    manaSpent,
    events: priority.map(spell => ({ name: spell.name, damage: (castCounts.get(spell) || 0) * (Number(spell.damage) || 0), casts: castCounts.get(spell) || 0 })),
  };
}

export default function App() {
  const [duration, setDuration] = useState(180);
  const [startingMana, setStartingMana] = useState(5000);
  const [regen, setRegen] = useState(100);
  const [talentLevel, setTalentLevel] = useState(60);
  const [build, setBuild] = useState({});
  const [hoveredTalent, setHoveredTalent] = useState(null);
  const tooltipTimer = useRef(null);
  const [rotation, setRotation] = useState(initialPriority);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [spellSearch, setSpellSearch] = useState('');
  const [active, setActive] = useState('Rotation lab');
  const result = useMemo(() => simulate(rotation, Number(duration), Number(startingMana), Number(regen)), [rotation, duration, startingMana, regen]);
  const totalPoints = Object.values(build).reduce((a, b) => a + b, 0);
  const addSpell = spell => {
    setRotation(prev => prev.some(entry => entry.name === spell.name) ? prev : [...prev, spell]);
    setSpellSearch('');
    setAddMenuOpen(false);
  };
  const movePriority = (index, offset) => setRotation(prev => {
    const target = index + offset;
    if (target < 0 || target >= prev.length) return prev;
    const next = [...prev];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const pointsAvailable = Math.max(0, talentLevel - 9);
  const treePoints = tree => Object.entries(build).filter(([name]) => tree.talents.some(talent => talent.name === name)).reduce((sum, [, rank]) => sum + rank, 0);
  const addTalent = (tree, talent) => setBuild(prev => {
    const spent = Object.values(prev).reduce((sum, rank) => sum + rank, 0);
    const inTree = Object.entries(prev).filter(([name]) => tree.talents.some(entry => entry.name === name)).reduce((sum, [, rank]) => sum + rank, 0);
    if (spent >= pointsAvailable || (prev[talent.name] || 0) >= talent.max || inTree < (talent.row - 1) * 5) return prev;
    return { ...prev, [talent.name]: (prev[talent.name] || 0) + 1 };
  });
  const removeTalent = (name) => setBuild(prev => ({ ...prev, [name]: Math.max(0, (prev[name] || 0) - 1) }));
  const showTalentTooltip = (event, tree, talent) => {
    clearTimeout(tooltipTimer.current);
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = event.type === 'focus' ? rect.right : event.clientX;
    const pointerY = event.type === 'focus' ? rect.bottom : event.clientY;
    const left = Math.min(pointerX + 12, Math.max(8, window.innerWidth - 280));
    const top = Math.min(pointerY + 12, Math.max(8, window.innerHeight - 160));
    setHoveredTalent({ talent, tree, left, top });
  };
  const hideTalentTooltip = () => {
    clearTimeout(tooltipTimer.current);
    tooltipTimer.current = setTimeout(() => setHoveredTalent(null), 250);
  };

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">4e</div><div><strong>4esim</strong><span>FOREVER DPS LAB</span></div></div>
      <div className="side-label">WORKSPACE</div>
      {['Rotation lab', 'Mage talents', 'Spell library'].map(item => <button className={`nav-item ${active === item ? 'selected' : ''}`} key={item} onClick={() => setActive(item)}><span className="nav-icon">{item === 'Rotation lab' ? '◈' : item === 'Mage talents' ? '✳' : '▤'}</span>{item}</button>)}
      <div className="side-bottom"><div className="status-dot"/> DATA SNAPSHOT <b>{mage.generated}</b><p>Forever Beta · Mage</p></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><span className="crumb">SIMULATOR /</span> <b>{active.toUpperCase()}</b></div><div className="top-right"><span className="pill"><i/> MAGE</span><span className="build-label">BUILD 0.1</span></div></header>
      {active === 'Rotation lab' && <>
        <section className="page-head"><div><div className="eyebrow">THEORYCRAFT WORKSPACE <span>·</span> PATCH FOREVER</div><h1>Find your <em>next best cast.</em></h1><p>Shape a Mage rotation, tune the spell assumptions, and compare sustained damage over a fixed encounter.</p></div><button className="run-btn" onClick={() => setActive('Rotation lab')}><span>▶</span> SIMULATION LIVE</button></section>
        <section className="metrics"><Metric label="SUSTAINED DPS" value={Math.round(result.dps).toLocaleString()} unit="DAMAGE / SEC" color="lime"/><Metric label="TOTAL DAMAGE" value={Math.round(result.damage).toLocaleString()} unit={`${duration}s ENCOUNTER`} color="blue"/><Metric label="SPELL CASTS" value={result.casts} unit="COMPLETED CASTS" color="orange"/><Metric label="AVG. MANA / CAST" value={result.casts ? Math.round(result.manaSpent / result.casts) : '—'} unit="SIMULATED SPEND" color="purple"/></section>
        <div className="grid-main">
          <section className="panel rotation-panel"><PanelTitle kicker="01 / ROTATION" title="Spell priority" right={<span className="loop-tag">↑ CHECKED TOP TO BOTTOM</span>}/><p className="panel-desc">Add a damage spell from the Mage spellbook, then order priorities. Spell values use the highest rank recorded for level 60.</p>
            <div className="table-head"><span>PRIORITY / SPELL</span><span>DAMAGE</span><span>CAST TIME</span><span>COOLDOWN</span><span>MANA COST</span><span/></div>
            <div className="spell-list">{rotation.map((spell, i) => <div className="spell-row priority-row" key={`${spell.name}-${i}`}><div className="spell-select"><span className="order-controls"><span className="order">{String(i + 1).padStart(2, '0')}</span><span><button aria-label={`Raise ${spell.name} priority`} disabled={i === 0} onClick={() => movePriority(i, -1)}>▴</button><button aria-label={`Lower ${spell.name} priority`} disabled={i === rotation.length - 1} onClick={() => movePriority(i, 1)}>▾</button></span></span><span className={`school-icon ${spell.school.toLowerCase()}`}>{spell.school === 'Frost' ? '❄' : spell.school === 'Fire' ? '♨' : '✧'}</span><span className="selected-spell"><b>{spell.name}</b><small>{spell.rank}</small></span></div><SpellStat value={spell.damage.toLocaleString()} suffix="dmg"/><SpellStat value={`${spell.cast}s`} suffix={spell.cast === 0 ? 'instant' : 'cast'}/><SpellStat value={spell.cooldown ? `${spell.cooldown}s` : '—'} suffix="cooldown"/><SpellStat value={spell.manaFraction ? `${spell.manaFraction * 100}%` : spell.mana.toLocaleString()} suffix={spell.manaFraction ? 'base mana' : 'mana'}/><button className="remove" onClick={() => setRotation(prev => prev.filter((_,n)=>n!==i))} aria-label={`Remove ${spell.name}`}>×</button></div>)}</div>
            <div className="add-spell-wrap"><button className="add-row" onClick={() => setAddMenuOpen(open => !open)}>＋ <span>ADD A DAMAGE SPELL</span></button>
              {addMenuOpen && <div className="spell-picker"><input aria-label="Search damaging spells" placeholder="Search Mage damage spells…" value={spellSearch} onChange={event => setSpellSearch(event.target.value)}/><div className="spell-picker-options">{damageSpellCatalog.filter(spell => !rotation.some(entry => entry.name === spell.name) && spell.name.toLowerCase().includes(spellSearch.toLowerCase())).map(spell => <button key={spell.name} onClick={() => addSpell(spell)}><span className={`school-icon ${spell.school.toLowerCase()}`}>{spell.school === 'Frost' ? '❄' : spell.school === 'Fire' ? '♨' : '✧'}</span><span><b>{spell.name}</b><small>{spell.school} · {spell.rank} · {spell.damage.toLocaleString()} dmg</small></span></button>)}{damageSpellCatalog.every(spell => rotation.some(entry => entry.name === spell.name) || !spell.name.toLowerCase().includes(spellSearch.toLowerCase())) && <p>No matching damage spells.</p>}</div></div>}
            </div>
            <div className="rotation-foot"><span>GLOBAL COOLDOWN <b>1.5s</b></span><span>BUILD <b>{totalPoints} / 51 PTS</b></span><button onClick={()=>setRotation(initialPriority)}>RESET PRIORITY ↺</button></div>
          </section>
          <section className="panel encounter-panel"><PanelTitle kicker="02 / ENCOUNTER" title="Fight parameters"/><p className="panel-desc">Tune the conditions for this single-target test.</p><div className="field"><label>ENCOUNTER DURATION</label><NumInput value={duration} suffix="sec" onChange={setDuration}/><div className="range"><input type="range" min="30" max="600" step="15" value={duration} onChange={e=>setDuration(Number(e.target.value))}/><div><span>30 SEC</span><span>10 MIN</span></div></div></div><div className="field"><label>STARTING MANA</label><NumInput value={startingMana} suffix="mana" onChange={setStartingMana}/></div><div className="field"><label>MANA REGEN / SEC</label><NumInput value={regen} suffix="mp/s" onChange={setRegen}/></div><div className="model-note"><span>i</span><p><b>SIMULATION MODEL</b> Priority-based casts with cast times, individual cooldowns, a shared 1.5 sec global cooldown for all abilities, and passive mana regeneration. Crits, hit chance, buffs, debuffs and proc talents are not modeled yet.</p></div></section>
        </div>
        <div className="lower-grid"><section className="panel talent-summary"><PanelTitle kicker="03 / BUILD CONTEXT" title="Talent allocation" right={<button className="text-action" onClick={()=>setActive('Mage talents')}>EDIT TALENTS ↗</button>}/><div className="tree-mini">{mage.talents.trees.map(t=><div key={t.name}><span>{t.name.toUpperCase()}</span><b>{Object.entries(build).filter(([name])=>t.talents.some(x=>x.name===name)).reduce((sum,[,v])=>sum+v,0)}</b></div>)}</div><div className="build-context"><span>Talent points allocated</span><strong>{totalPoints} <small>/ 51</small></strong></div></section><section className="panel chart-panel"><PanelTitle kicker="04 / DAMAGE PROFILE" title="Damage by priority"/><div className="bars">{result.events.slice(0,7).map((spell,i)=>{const max=Math.max(1,...result.events.map(s=>s.damage));return <div className="bar-row" key={`${spell.name}-${i}`}><span>{spell.name}</span><div><i style={{width:`${Math.max(spell.damage ? 4 : 0,spell.damage/max*100)}%`}}/></div><b>{Math.round(spell.damage)}</b></div>})}</div></section></div>
        <footer>DATA FROM <a href="https://talentsforever.com/about" target="_blank" rel="noreferrer">TALENTS FOREVER</a> · CC BY 4.0 · BETA SNAPSHOT {mage.generated} · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">ATTRIBUTION</a></footer>
      </>}
      {active === 'Mage talents' && <section className="talent-page">
        <div className="talent-toolbar"><strong>Talents</strong><label>Level <button aria-label="Lower level" onClick={() => setTalentLevel(level => Math.max(10, level - 1))}>‹</button><input aria-label="Character level" type="number" min="10" max="60" value={talentLevel} onChange={event => setTalentLevel(Math.min(60, Math.max(10, Number(event.target.value) || 10)))}/><button aria-label="Raise level" onClick={() => setTalentLevel(level => Math.min(60, level + 1))}>›</button></label><div className="unspent-label">Unspent Talents <b>{Math.max(0, pointsAvailable - totalPoints)}</b></div></div>
        <div className="talent-trees">{mage.talents.trees.map(tree => <section className={`talent-tree tree-${tree.name.toLowerCase()}`} key={tree.name}>
          <header className="tree-heading"><div className="tree-emblem"><img src={`https://wow.zamimg.com/images/wow/icons/medium/${tree.icon}.jpg`} alt=""/><b>{treePoints(tree)}</b></div><h2>{tree.name}</h2><button className="tree-reset" aria-label={`Reset ${tree.name} talents`} title={`Reset ${tree.name}`} onClick={() => setBuild(prev => Object.fromEntries(Object.entries(prev).filter(([name]) => !tree.talents.some(talent => talent.name === name))))}>↻</button></header>
          <div className="talent-grid-visual">{tree.talents.map(talent => {
            const rank = build[talent.name] || 0;
            const rowRequirement = (talent.row - 1) * 5;
            const unlocked = rank > 0 || treePoints(tree) >= rowRequirement;
            const rankText = talent.desc[rank > 0 ? rank - 1 : 0] || '';
            return <button key={talent.name} className={`talent-node ${rank ? 'learned' : ''} ${unlocked ? 'unlocked' : 'locked'}`} style={{'--row': talent.row, '--col': talent.col}} aria-label={`${talent.name}, rank ${rank} of ${talent.max}${unlocked ? '' : `, requires ${rowRequirement} points in ${tree.name}`}`} onMouseEnter={event => showTalentTooltip(event, tree, talent)} onMouseMove={event => showTalentTooltip(event, tree, talent)} onMouseLeave={hideTalentTooltip} onFocus={event => showTalentTooltip(event, tree, talent)} onBlur={hideTalentTooltip} onClick={() => addTalent(tree, talent)} onContextMenu={event => { event.preventDefault(); removeTalent(talent.name); }}>
              <img src={`https://wow.zamimg.com/images/wow/icons/medium/${talent.icon}.jpg`} alt="" loading="lazy"/><span>{rank}/{talent.max}</span>
            </button>;
          })}</div>
          <div className="tree-foot">{treePoints(tree)} POINTS SPENT</div>
        </section>)}</div>
        <div className="talent-hint">Click a talent to spend a point · Right-click to remove one · deeper rows require 5 points per tier</div>
        {hoveredTalent && <div className="talent-tooltip" style={{ left: hoveredTalent.left, top: hoveredTalent.top }} onMouseEnter={() => clearTimeout(tooltipTimer.current)} onMouseLeave={hideTalentTooltip}>
          <strong>{hoveredTalent.talent.name}</strong>
          <span>Rank {build[hoveredTalent.talent.name] || 0} / {hoveredTalent.talent.max}</span>
          <span>{hoveredTalent.talent.passive ? 'Passive' : 'Active'}</span>
          <p>{hoveredTalent.talent.desc[Math.max(0, (build[hoveredTalent.talent.name] || 1) - 1)] || hoveredTalent.talent.desc[0]}</p>
        </div>}
        <footer>Talent and tooltip data: <a href="https://talentsforever.com/about" target="_blank" rel="noreferrer">Talents Forever</a> · CC BY 4.0</footer>
      </section>}
      {active === 'Spell library' && <section className="library-page"><div className="eyebrow">BETA SPELLBOOK · {mage.spellbook.tabs.reduce((n,t)=>n+t.spells.length,0)} RANK ENTRIES</div><h1>Mage <em>spellbook.</em></h1><p className="panel-desc">Spell names and rank tooltips from the Forever Beta export. This library is informational; select spells in Rotation Lab to set simulation values.</p>{mage.spellbook.tabs.map(tab=><section className="panel library-tab" key={tab.name}><PanelTitle kicker="SPELL SCHOOL" title={tab.name}/><div className="library-spells">{[...new Set(tab.spells.map(s=>s[0]))].map(name=>{const detail=spellRankText(name);return <article key={name}><b>{name}</b><span>{detail?.r || 'Spell'}</span><p>{detail?.d || 'Tooltip not available in this snapshot.'}</p></article>})}</div></section>)}<footer>Spellbook and tooltip data: <a href="https://talentsforever.com/about" target="_blank" rel="noreferrer">Talents Forever</a> · CC BY 4.0</footer></section>}
    </main>
  </div>;
}
function Metric({label,value,unit,color}){return <div className={`metric ${color}`}><span>{label}</span><strong>{value}</strong><small>{unit}</small></div>}
function SpellStat({value,suffix}){return <div className="spell-stat"><b>{value}</b><span>{suffix}</span></div>}
function PanelTitle({kicker,title,right}){return <div className="panel-title"><div><div className="kicker">{kicker}</div><h2>{title}</h2></div>{right}</div>}
function NumInput({value,suffix,onChange,step=1}){return <div className="num-input"><input type="number" min="0" step={step} value={value} onChange={e=>onChange(Number(e.target.value))}/><span>{suffix}</span></div>}
