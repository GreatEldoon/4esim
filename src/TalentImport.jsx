import { useState } from 'react';
import { parseWowheadTalents } from './data/talent-import.js';

export function TalentImport({ classData, onImport }) {
  const [source, setSource] = useState('wowhead');
  const [text, setText] = useState('');
  const [message, setMessage] = useState(null);
  const importTalents = event => {
    event.preventDefault();
    try {
      const imported = parseWowheadTalents(text, classData);
      onImport(imported);
      setMessage({ text: `Imported ${imported.totals.join('/')} ${classData.class} talents at level ${imported.level}.`, error: false });
    } catch (error) {
      setMessage({ text: error.message, error: true });
    }
  };
  return <details className="talent-import">
    <summary>Import talents</summary>
    <form onSubmit={importTalents}>
      <label htmlFor="talent-import-source">Source</label>
      <select id="talent-import-source" value={source} onChange={event => setSource(event.target.value)}><option value="wowhead">Wowhead</option></select>
      <label htmlFor="talent-import-text">Copied talent export</label>
      <textarea id="talent-import-text" rows={7} value={text} onChange={event => { setText(event.target.value); setMessage(null); }} placeholder={`${classData.class} Talents (31/20/0)\nRequired level: 60\n…`} required/>
      <p>Paste the full text copied from Wowhead’s Forever talent calculator. Importing replaces your current {classData.class} talents and sets the character level from the export.</p>
      <button type="submit" disabled={!text.trim()}>Import talents</button>
      {message && <p role={message.error ? 'alert' : 'status'} className={message.error ? 'import-error' : 'import-success'}>{message.text}</p>}
    </form>
  </details>;
}
