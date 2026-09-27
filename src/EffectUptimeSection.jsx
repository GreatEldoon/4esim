export function EffectUptimeSection({ effects }) {
  const visible = (effects || []).filter(effect => effect.name !== 'Wrack');
  return <section className="effect-uptime-section" aria-label="Buff and debuff uptime">
    <h3>Buff / debuff uptime</h3>
    <p>Time active during the median encounter.</p>
    {!effects ? <p>Run a new simulation to calculate effect uptime.</p> : visible.length === 0 ? <p>No tracked buffs or debuffs were active.</p> :
      <div className="effect-uptime-list">{visible.map(effect => <div className="effect-uptime-row" key={effect.id}>
        <div><b>{effect.name}</b><small>{effect.type === 'buff' ? 'Buff' : 'Debuff'}</small></div>
        <div className="buff-uptime-track"><i style={{ width: `${Math.min(100, effect.uptimePct)}%` }}/></div>
        <span>{effect.uptime.toFixed(1)}s <small>{effect.uptimePct.toFixed(1)}%</small></span>
      </div>)}</div>}
  </section>;
}
