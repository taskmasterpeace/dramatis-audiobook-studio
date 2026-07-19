/* DRAMATIS Studio — vanilla app. Filesystem truth via the local API. */
'use strict';

// ── tiny helpers ────────────────────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMin = (m) => (m == null ? '—' : `${m.toFixed(1)} min`);
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}
let toastTimer;
function toast(msg, err = false) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), err ? 7000 : 3500);
}
const CHIP_COLORS = ['#E08A97', '#7FB3D5', '#92C97F', '#D9B36B', '#8FB3A8', '#C9A0DA00', '#E0A84E', '#7FC9C9', '#B5C97F', '#C97F7F'];
const entColor = (id, i) => id === 'narrator' ? '#7E8CA0' : CHIP_COLORS[i % CHIP_COLORS.length].slice(0, 7);

// ── state ───────────────────────────────────────────────────────────────────
const S = {
  view: 'shelf', bookId: null, tab: 'board', shelf: null, book: null,
  chapterN: 1, script: null, selLine: null, cuePanel: null, job: null,
};

// ── SSE: render progress ────────────────────────────────────────────────────
const jobLog = [];
const es = new EventSource('/api/render/stream');
es.addEventListener('log', (e) => {
  const { line } = JSON.parse(e.data);
  jobLog.push(line);
  if (jobLog.length > 400) jobLog.shift();
  const el = $('#livelog');
  if (el) { el.innerHTML = renderLogLines(); el.scrollTop = el.scrollHeight; }
});
es.addEventListener('status', async (e) => {
  S.job = JSON.parse(e.data);
  paintJob();
  if (S.job && S.job.status !== 'running') {
    toast(S.job.status === 'done' ? `Render finished: ${S.job.book}` : `Render FAILED: ${S.job.book}`, S.job.status !== 'done');
    await refresh();
  }
});
function renderLogLines() {
  return jobLog.slice(-200).map((l) => {
    const cls = /error|failed|Error/i.test(l) ? 'err' : /cache hits|0 QA flags|complete|bound/.test(l) ? 'ok' : /elevenlabs|hero|retrieved/.test(l) ? 'hi' : '';
    return `<span class="${cls}">${esc(l)}</span>`;
  }).join('\n');
}
function paintJob() {
  const busy = S.job && S.job.status === 'running';
  $('#lamp').className = 'lamp' + (busy ? ' busy' : '');
  $('#gputxt').textContent = busy ? `rendering ${S.job.book}${S.job.chapter ? ' ch ' + S.job.chapter : ''} · ${S.job.tts} · ${S.job.elapsedSec}s` : 'idle — RTX 4090';
  $('#rec').className = 'rec' + (busy ? ' live' : '');
  const st = $('#jobstate');
  if (st) st.textContent = busy ? `● rendering — ${S.job.elapsedSec}s elapsed` : (S.job ? `last render: ${S.job.status}` : 'no render this session');
  const vu = $('#vu');
  if (vu && busy) {
    const lit = Math.min(23, Math.floor((S.job.elapsedSec || 0) / 25));
    vu.innerHTML = Array.from({ length: 24 }, (_, i) => `<i class="${i < lit ? 'lit' : i === lit ? 'hot' : ''}"></i>`).join('');
  }
}
setInterval(async () => {
  if (S.job && S.job.status === 'running') {
    try { const { job } = await api('/api/render/status'); S.job = job; paintJob(); } catch { /* server gone */ }
  }
}, 3000);

// ── data ────────────────────────────────────────────────────────────────────
async function loadShelf() { S.shelf = await api('/api/books'); S.job = S.shelf.job || S.job; }
async function loadBook(id) { S.book = await api(`/api/books/${id}`); S.bookId = id; }
async function loadScript(n) {
  S.chapterN = n;
  S.script = null;
  S.selLine = null; S.cuePanel = null;
  try { S.script = await (await fetch(`/media/${S.bookId}/ch-${String(n).padStart(2, '0')}/production-script.json`)).json(); } catch { /* not compiled */ }
}
async function refresh() {
  if (S.view === 'shelf') await loadShelf();
  if (S.view === 'book') { await loadBook(S.bookId); if (S.tab === 'script') await loadScript(S.chapterN); }
  render();
}

// ── navigation ──────────────────────────────────────────────────────────────
async function go(view, bookId, tab) {
  S.view = view;
  if (view === 'shelf') await loadShelf();
  if ((view === 'casting' || view === 'say') && !S.roster) { try { S.roster = await api('/api/casting/roster'); } catch (e) { toast(e.message, true); } }
  if (view === 'casting') { try { S.actors = (await api('/api/actors')).actors; } catch { S.actors = []; } }
  if (view === 'book') {
    await loadBook(bookId || S.bookId);
    S.tab = tab || 'board';
    if (S.tab === 'script') await loadScript(S.chapterN);
    if (S.tab === 'cast' && !S.roster) { try { S.roster = await api('/api/casting/roster'); } catch { /* offline */ } }
  }
  render();
}

// ── render root ─────────────────────────────────────────────────────────────
function render() {
  paintNav();
  const m = $('#main');
  if (S.view === 'shelf') m.innerHTML = viewShelf();
  else if (S.view === 'new') m.innerHTML = viewNew();
  else if (S.view === 'casting') m.innerHTML = viewCasting();
  else if (S.view === 'say') m.innerHTML = viewSay();
  else if (S.view === 'book') m.innerHTML = viewBook();
  bind(m);
  paintJob();
  paintTicker();
}
function paintNav() {
  const items = [
    `<div class="nav-label">Library</div>`,
    navBtn('shelf', '▤ Bookshelf', S.view === 'shelf'),
    navBtn('new', '＋ New Book', S.view === 'new'),
    navBtn('casting', '🎭 Casting Room', S.view === 'casting'),
    navBtn('say', '⚡ Quick Narrate', S.view === 'say'),
  ];
  if (S.book) {
    items.push(`<div class="nav-label">${esc(S.book.book.title)}</div>`);
    items.push(navBtn('tab:board', '◉ Production', S.view === 'book' && S.tab === 'board'));
    items.push(navBtn('tab:cast', '☰ Cast & Voices', S.view === 'book' && S.tab === 'cast'));
    items.push(navBtn('tab:script', '¶ Script', S.view === 'book' && S.tab === 'script'));
  }
  $('#nav').innerHTML = items.join('');
  $('#nav').querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    const t = b.dataset.go;
    if (t.startsWith('tab:')) { S.tab = t.slice(4); if (S.tab === 'script') await loadScript(S.chapterN); S.view = 'book'; render(); }
    else go(t);
  }));
}
const navBtn = (go_, label, on) => `<button data-go="${go_}" class="${on ? 'on' : ''}">${label}</button>`;
function paintTicker() {
  if (!S.shelf) return;
  const min = S.shelf.books.reduce((a, b) => a + b.minutes, 0);
  const usd = S.shelf.books.reduce((a, b) => a + (b.spend?.llmUsd || 0), 0);
  $('#ticker').innerHTML = `Catalog: <b class="num">${min.toFixed(0)} min</b> rendered · LLM <b class="num">$${usd.toFixed(3)}</b>`;
}

// ── views ───────────────────────────────────────────────────────────────────
function viewShelf() {
  const cards = (S.shelf?.books || []).map((b) => `
    <div class="book card" data-open="${b.id}" role="button" tabindex="0">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:start">
        <div><h2>${esc(b.title)}</h2><div class="author">${esc(b.author)}</div></div>
        ${b.style ? `<span class="chip cy">${esc(b.style.split(' ')[0])}</span>` : ''}
      </div>
      <div class="meter"><i style="width:${b.chapters ? (100 * b.done / b.chapters) : 0}%"></i></div>
      <div class="bstats"><span><b>${b.done}/${b.chapters}</b> chapters</span><span><b class="num">${b.minutes.toFixed(1)}</b> min</span><span>LLM <b class="num">$${(b.spend?.llmUsd || 0).toFixed(3)}</b></span></div>
      <div class="leftline"><span class="k">LEFT</span>${b.warnings.length
        ? b.warnings.map((w) => `<span class="chip ${/stale/.test(w) ? 'warn' : 'crit'}">${esc(w)}</span>`).join('')
        : `<span class="chip ok">Up to date${b.flags ? ` · ${b.flags} flag(s)` : ' · 0 flags'}</span>`}</div>
    </div>`).join('');
  return `
    <p class="crumb">Library</p><h1>Bookshelf</h1>
    <p class="sub">Every book is a folder on disk — this screen reads <code>books/</code> and <code>out/</code> live.</p>
    <div class="shelf">${cards}
      <div class="book card new" data-open-new role="button" tabindex="0"><div style="font-size:24px">＋</div><div>New Book — paste a manuscript</div></div>
    </div>`;
}

function viewBook() {
  const { book } = S.book;
  const tabs = `
    <div class="tabs">
      <button data-tab="board" class="${S.tab === 'board' ? 'on' : ''}">Production</button>
      <button data-tab="cast" class="${S.tab === 'cast' ? 'on' : ''}">Cast &amp; Voices</button>
      <button data-tab="script" class="${S.tab === 'script' ? 'on' : ''}">Script</button>
    </div>`;
  const head = `<p class="crumb">${esc(book.title)}${book.author ? ' · ' + esc(book.author) : ''}</p>`;
  if (S.tab === 'board') return head + `<h1>Production</h1><p class="sub">Status from <code>book-report.json</code> + <code>qa-report.json</code>. Stale = book.json edited after last render.</p>` + tabs + viewBoard();
  if (S.tab === 'cast') return head + `<h1>Cast &amp; Voices</h1><p class="sub">Cards edit <code>book.json</code> directly. Audition before you commit — nothing is final until you've heard it.</p>` + tabs + viewCast();
  return head + `<h1>Script</h1><p class="sub">Click a line to fix its speaker or emotion (writes a hint — never touches the manuscript). Click a cue pin to hear and approve its sound.</p>` + tabs + viewScript();
}

function viewBoard() {
  const { chapters, preflight, book } = S.book;
  const rows = chapters.map((c) => `
    <div class="chrow card">
      <div class="t">${esc(c.heading)}<small>chapter ${c.n}</small></div>
      <div class="stages">
        <span class="stg ${c.compiled ? '' : 'off'}">COMPILED</span>
        <span class="stg ${c.mastered ? '' : 'off'}">MASTERED</span>
        ${c.stale ? '<span class="stg stale">STALE</span>' : ''}
        ${c.beds?.some((b) => /retrieval/.test(b.source || '')) ? '<span class="stg">REAL AMBIENCE</span>' : ''}
      </div>
      <div class="cell num"><b>${c.minutes ?? '—'}</b> min</div>
      <div class="cell num"><b>${c.lufs ?? '—'}</b> LUFS</div>
      <div class="cell">${c.flags == null ? '—' : c.flags === 0 ? '<span class="chip ok">0 flags</span>' : `<span class="chip warn">${c.flags} flag(s)</span>`}</div>
      ${c.media ? `<div class="chplayer"><audio controls preload="none" src="${c.media}"></audio></div>` : ''}
    </div>`).join('');
  const scopeOpts = ['<option value="">Whole book</option>']
    .concat(chapters.map((c) => `<option value="${c.n}">${esc(c.heading)}</option>`)).join('');
  const engines = Object.keys(book.voices).filter((k) => k !== 'hybrid');
  const engOpts = ['hybrid'].concat(engines).map((e) => `<option ${e === 'hybrid' ? 'selected' : ''}>${e}</option>`).join('');
  const busy = S.job && S.job.status === 'running';
  return `${rows}
    <div class="board-split">
      <div><p class="panel-h">Render</p>
        <div class="card preflight">
          <div class="rowline"><span class="l">Scope</span><select id="r-scope">${scopeOpts}</select></div>
          <div class="rowline"><span class="l">Engine</span><select id="r-tts">${engOpts}</select></div>
          <div class="rowline"><span class="l">Narration → Kokoro</span><span class="v num">${preflight.narration} lines · $0</span></div>
          <div class="rowline"><span class="l">Dialogue → Qwen3</span><span class="v num">${preflight.dialogue} lines · $0</span></div>
          <div class="rowline"><span class="l">Hero → ElevenLabs</span><span class="v num">${preflight.hero} lines · ${preflight.heroChars} chars</span></div>
          <div class="total"><span class="l">Estimated API spend</span><span class="amt num">≈ $${preflight.heroUsdEstimate.toFixed(2)} <small>rest is your GPU</small></span></div>
          <button class="btn" id="r-go" ${busy ? 'disabled' : ''}>● Render</button>
          ${busy ? '<span class="chip cy" style="margin-left:9px">GPU busy — one render at a time</span>' : '<span class="chip" style="margin-left:9px">cache makes re-runs surgical</span>'}
        </div>
      </div>
      <div><p class="panel-h">Console</p>
        <div class="console">
          <div class="head"><span class="st" id="jobstate"></span></div>
          <div class="vu" id="vu">${'<i></i>'.repeat(24)}</div>
          <div class="log" id="livelog">${renderLogLines() || '<span style="color:var(--dim)">render log streams here</span>'}</div>
        </div>
      </div>
    </div>`;
}

function viewCast() {
  const { book } = S.book;
  // only the four real voice engines — legacy maps (sapi) stay in book.json but
  // never render (Robert: no Windows voices, and "undefined" rows are noise)
  const ENGINES = ['kokoro', 'qwen3', 'elevenlabs', 'gemini'];
  const ELEVEN_MODELS = ['eleven_v3', 'eleven_multilingual_v2', 'eleven_turbo_v2', 'eleven_turbo_v2_5', 'eleven_flash_v2_5'];
  const roster11 = (S.roster?.elevenlabs || []).map((r) => r.voice);
  const rosterGem = (S.roster?.gemini || []).map((r) => r.voice);
  const rosterKok = (S.roster?.kokoro || []).map((r) => r.voice);
  const sel = (opts, current, dataF, extra = '') => `<select data-f="${dataF}" ${extra}>${opts.map((o) => `<option ${o === current ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const HINTS = {
    kokoro: 'Free local narrator voices. Pick a preset; speed 0.9–1.1.',
    qwen3: 'Type a description — the words BUILD the voice (age, accent, timbre, attitude). Edit it, audition, repeat.',
    elevenlabs: 'Your account roster by name. Model: v3 = emotion tags, v2 family = the classic sound.',
    gemini: 'Pick a voice, then direct it — the prompt is the director’s note (persona, scene, accent, pace).',
  };
  const cards = book.entities.map((ent, i) => {
    const casting = book.casting?.[ent.id];
    const rows = ENGINES.map((eng) => {
      const v = book.voices[eng]?.[ent.id];
      let val;
      if (eng === 'kokoro') val = `${rosterKok.length ? sel(rosterKok, v?.voice || 'bm_george', 'voice') : `<input class="tiny" data-f="voice" value="${esc(v?.voice || '')}">`}<label class="mini">speed <input class="tiny" data-f="speed" value="${v?.speed ?? 1}"></label>`;
      else if (eng === 'qwen3') val = `<input class="wide" data-f="design" value="${esc(v?.design || '')}" placeholder="e.g. Elderly Chinese man; thin weathered voice; light Mandarin accent">`;
      else if (eng === 'elevenlabs') val = `${roster11.length ? sel(roster11, (v?.candidates || [])[0] || 'George', 'primary') : `<input class="tiny" data-f="primary" value="${esc((v?.candidates || [])[0] || '')}">`}
        ${sel(ELEVEN_MODELS, v?.model || 'eleven_v3', 'model')}
        <label class="mini">fallbacks <input data-f="fallbacks" value="${esc((v?.candidates || []).slice(1).join(', '))}" style="width:110px"></label>
        <label class="mini">stability <input class="tiny" data-f="stability" value="${v?.stability ?? 0.5}"></label>`;
      else if (eng === 'gemini') val = `${rosterGem.length ? sel(rosterGem, v?.voice || 'Charon', 'voice') : `<input class="tiny" data-f="voice" value="${esc(v?.voice || 'Charon')}">`}<input class="wide" data-f="prompt" value="${esc(v?.prompt || '')}" placeholder="Director's note: who they are, the scene, accent, pace">`;
      return `<div class="dna-row" data-eng="${eng}">
        <span class="eng">${eng}</span>
        <span class="val">${val}</span>
        <button class="aud" data-audition="${eng}" title="hear this candidate">▶ audition</button>
        <div class="f-hint">${HINTS[eng]}</div>
        <span class="aud-player" data-player hidden></span>
      </div>`;
    }).join('');
    return `<div class="actor card" data-ent="${ent.id}">
      <div class="actor-h"><span class="swatch" style="background:${entColor(ent.id, i)}"></span>
        <span class="nm">${esc(ent.id.replace(/_/g, ' ').toUpperCase())}</span>
        <span class="roleeng"><select data-roleeng title="Force every one of this role's lines to one engine">
          <option value="">route: auto (hybrid)</option>
          ${['kokoro', 'qwen3', 'elevenlabs', 'gemini'].map((e) => `<option ${casting?.engine === e ? 'selected' : ''}>${e}</option>`).join('')}
        </select></span></div>
      ${ent.names?.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${ent.names.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</div>` : ''}
      <div><div class="f-label">Visual brief — feeds character art (manual generation only)</div>
        <textarea data-visual>${esc(ent.visual || '')}</textarea></div>
      <div><div class="f-label">Voice DNA</div><div class="dna">${rows}</div></div>
      <div class="savenote" data-savenote></div>
    </div>`;
  }).join('');
  return `<div class="cast-grid">${cards}</div>`;
}

function viewScript() {
  const { book } = S.book;
  const chapters = book.chapters.map((c, i) => `<option value="${i + 1}" ${S.chapterN === i + 1 ? 'selected' : ''}>${esc(c.heading)}</option>`).join('');
  let body;
  if (!S.script) body = `<div class="empty">Chapter not compiled yet — render it once from the Production tab.</div>`;
  else {
    const cuesByLine = {};
    for (const c of S.script.cues || []) (cuesByLine[c.at_line] ??= []).push(c);
    const bookCues = {};
    for (const ch of book.chapters) for (const c of ch.cues || []) bookCues[c.id] = c;
    const entIdx = Object.fromEntries(book.entities.map((e, i) => [e.id, i]));
    body = S.script.scenes.map((sc) => {
      const head = `<div class="scene-head"><span class="id">${esc(sc.id.toUpperCase())}</span><span class="env">${esc(sc.ambience?.type || '')} ${sc.ambience?.intensity ?? ''}</span></div>`;
      const lines = sc.lines.map((l) => {
        const pins = (cuesByLine[l.id] || []).map((c) => {
          const st = bookCues[c.id]?.approval;
          const cls = st === 'rejected' ? 'rej' : (st === 'approved' || (st && st.swap)) ? 'appr' : '';
          return `<span class="cue-pin ${cls}" data-cue="${c.id}">⟟ ${esc(c.sfx)}</span>`;
        }).join('');
        const emo = l.emotion ? Object.entries(l.emotion).sort((a, b) => b[1] - a[1])[0] : null;
        const isNarr = l.kind !== 'dialogue';
        return `<div class="sline ${isNarr ? 'narr' : ''} ${S.selLine === l.id ? 'sel' : ''}" data-line="${l.id}">
          <div class="who" style="color:${isNarr ? '#7E8CA0' : entColor(l.entity, entIdx[l.entity] ?? 0)}">${isNarr ? 'NARRATION' : esc((l.entity || '?').replace(/_/g, ' ').toUpperCase())}
            ${emo ? `<span class="badge">${emo[0]} ${emo[1]} → 11L</span>` : ''}</div>
          <div class="txt">${pins}${esc(l.text)}</div>
        </div>${S.selLine === l.id ? linePopover(l) : ''}${S.cuePanel && (cuesByLine[l.id] || []).some((c) => c.id === S.cuePanel.cueId) ? cuePopover() : ''}`;
      }).join('');
      return head + lines;
    }).join('');
  }
  return `<div style="margin-bottom:10px"><select id="sc-ch">${chapters}</select></div>${body}`;
}

function linePopover(l) {
  const { book } = S.book;
  const emo = l.emotion ? Object.entries(l.emotion).sort((a, b) => b[1] - a[1])[0] : null;
  return `<div class="popover" data-pop-line="${l.id}">
    <div class="row"><label>Speaker</label><select data-p-entity>
      ${book.entities.map((e) => `<option ${e.id === l.entity ? 'selected' : ''}>${e.id}</option>`).join('')}</select></div>
    <div class="row"><label>Emotion</label><select data-p-emo>
      <option value="">none — keep it local</option>
      ${['fear', 'anger', 'sadness', 'surprise', 'joy', 'tenderness', 'curiosity'].map((e) => `<option ${emo?.[0] === e ? 'selected' : ''}>${e}</option>`).join('')}</select>
      <input type="range" min="1" max="10" value="${emo ? Math.round(emo[1] * 10) : 6}" data-p-str style="flex:1"></div>
    <p class="note">Saves a hint in book.json · marks the chapter stale · next render re-synthesizes only this line</p>
    <button class="btn sm" data-p-save>Save hint</button> <button class="btn ghost sm" data-p-cancel>Cancel</button>
  </div>`;
}
function cuePopover() {
  const cp = S.cuePanel;
  if (!cp.data) return `<div class="popover">loading cue…</div>`;
  const d = cp.data;
  return `<div class="popover" data-pop-cue="${cp.cueId}">
    <div class="row"><label>Cue</label><span style="font-family:var(--mono);font-size:12px">${esc(d.cue.sfx)}</span></div>
    ${d.current ? `<div class="row"><label>Current</label><audio controls src="${d.current}"></audio></div>` : '<p class="note">not yet rendered — alternatives below come straight from the library</p>'}
    <div class="row" style="gap:6px">
      <button class="btn sm" data-cue-approve>✓ Approve</button>
      <button class="btn ghost sm" data-cue-reset>Auto</button>
      <button class="btn danger sm" data-cue-reject>✕ Reject</button>
    </div>
    ${d.alternatives.length ? `<div class="f-label" style="margin-top:6px">Library alternatives — click Use to swap</div>` : ''}
    ${d.alternatives.map((a) => `<div class="alt"><audio controls preload="none" src="${a.media}"></audio>
      <span class="cap">${esc(a.caption)} <span class="num">(sim ${a.score})</span></span>
      <button class="btn ghost sm" data-cue-swap="${esc(a.file)}">Use</button></div>`).join('')}
  </div>`;
}

function viewCasting() {
  if (!S.roster) return `<p class="crumb">Talent</p><h1>Casting Room</h1><div class="empty">loading roster…</div>`;
  const ENGLABEL = { company: '🎭 The Company', kokoro: 'Kokoro — free', gemini: 'Gemini — directed', elevenlabs: 'ElevenLabs — your roster', qwen3: 'Qwen3 — designed' };
  const tabs = ['company', 'kokoro', 'gemini', 'elevenlabs', 'qwen3'];
  S.castTab = S.castTab || 'company';
  const counts = { company: (S.actors || []).length, ...Object.fromEntries(Object.entries(S.roster).map(([k, v]) => [k, v.length])) };
  const tabBar = `<div class="tabs">${tabs.map((t) => `<button data-casttab="${t}" class="${S.castTab === t ? 'on' : ''}">${esc(ENGLABEL[t])} <span style="opacity:.6">${counts[t] ?? 0}</span></button>`).join('')}</div>`;

  let body;
  if (S.castTab === 'company') {
    const actors = S.actors || [];
    body = actors.length ? `<div class="cast-grid">${actors.map((a) => `
      <div class="actor card" data-actor="${esc(a.name)}">
        <div class="actor-h"><span class="nm">${esc(a.name.replace(/-/g, ' ').toUpperCase())}</span>
          <span class="roleeng chip cy">${esc(a.origin.seed_engine || 'seeded')}</span></div>
        <div class="portrait-zone" data-portrait tabindex="0" title="Click here and paste an image (Ctrl+V)">
          ${a.portrait ? `<img src="${a.portrait}?t=${Date.now()}" alt="${esc(a.name)}">`
            : `<div class="portrait-empty">🖼<br><span>click + paste an image</span></div>`}
        </div>
        <div style="font-size:12px;color:var(--muted)">${esc(a.origin.character || '')}</div>
        ${a.seed ? `<audio controls preload="none" src="${a.seed}"></audio>` : ''}
        <div style="font-size:10.5px;color:var(--dim)">
          voice: ${esc(a.origin.seed_voice || '—')} · gate: ${esc(a.origin.gate || '—')}<br>
          <em>${esc((a.transcript || '').slice(0, 90))}${(a.transcript || '').length > 90 ? '…' : ''}</em>
        </div>
      </div>`).join('')}</div>`
      : `<div class="empty">No company members yet. Seed a voice you love (Gemini/ElevenLabs), then save it to <code>actors/</code>.</div>`;
  } else {
    const voices = S.roster[S.castTab] || [];
    body = `<div style="display:flex;flex-wrap:wrap;gap:7px">
      ${voices.map((v) => `
        <div class="card" style="padding:8px 11px;display:flex;align-items:center;gap:8px" data-cast-voice="${esc(v.voice)}" data-cast-eng="${S.castTab}">
          <span style="font-size:12.5px;font-weight:600">${esc(v.voice)}</span>
          <span style="font-size:10.5px;color:var(--dim)">${esc(v.note)}</span>
          ${S.castTab === 'qwen3' ? '' : `<button class="aud" data-cast-play title="hear this voice">▶</button>`}
          <span data-cast-slot></span>
        </div>`).join('')}</div>`;
  }
  return `
    <p class="crumb">Talent</p><h1>Casting Room</h1>
    <p class="sub">Your company plus every hireable voice. In a voice tab, ▶ speaks the same line so they compare fairly. In The Company, click a portrait box and paste an image — it saves itself.</p>
    ${tabBar}${body}`;
}

function viewSay() {
  const kok = (S.roster?.kokoro || []).map((v) => v.voice);
  const opts = (kok.length ? kok : ['bm_george', 'af_sarah', 'am_onyx', 'af_nicole', 'am_michael']).map((v) => `<option ${v === 'bm_george' ? 'selected' : ''}>${esc(v)}</option>`).join('');
  return `
    <p class="crumb">Free tool</p><h1>⚡ Quick Narrate</h1>
    <p class="sub">Drop any text, pick a free local voice, get an mp3. No API, no cost, with a timer.</p>
    <div class="field"><label>Text</label><textarea id="say-text" placeholder="Paste anything you want read aloud…" style="min-height:180px"></textarea></div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
      <label class="mini">Voice <select id="say-voice">${opts}</select></label>
      <button class="btn" id="say-go">🎙 Narrate — free</button>
      <span id="say-status" style="font-size:12.5px;color:var(--muted)"></span>
    </div>
    <div id="say-result"></div>`;
}

function viewNew() {
  return `
    <p class="crumb">Library</p><h1>New Book</h1>
    <p class="sub">Paste a manuscript — <code>##</code> headings become chapters (added automatically if missing). Curly quotes are normalized for the dialogue detector.</p>
    <div class="steps">
      <span class="step on"><span class="n">1</span>Paste</span><span>→</span>
      <span class="step"><span class="n">2</span>Analyze (~$0.01, optional)</span><span>→</span>
      <span class="step"><span class="n">3</span>Tune cast</span><span>→</span>
      <span class="step"><span class="n">4</span>Render</span>
    </div>
    <div class="intake">
      <div>
        <div class="field"><label>Title</label><input id="nb-title" placeholder="The Signal-Man"></div>
        <div class="field"><label>Author</label><input id="nb-author" placeholder="Charles Dickens · public domain"></div>
        <div class="field"><label>Manuscript</label><textarea id="nb-text" placeholder="## Chapter One&#10;&#10;Paste the story here…"></textarea></div>
        <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;color:var(--muted);margin-bottom:12px">
          <input type="checkbox" id="nb-analyze" checked style="width:auto"> Run the analyzer (drafts cast, scenes, SFX cues — ledgered)</label>
        <button class="btn" id="nb-create">Create book</button>
      </div>
      <div class="draft card"><p class="panel-h">What you get</p><ul>
        <li><b>Cast</b> — speakers with aliases for attribution</li>
        <li><b>Scenes</b> — ambience type + intensity each</li>
        <li><b>SFX cues</b> — anchored to their exact words</li>
        <li><b>House voices</b> — a starting cast you audition &amp; replace</li>
        <li>Then: Cast screen to tune → Production to render</li>
      </ul></div>
    </div>`;
}

// ── event wiring ────────────────────────────────────────────────────────────
function bind(m) {
  m.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => go('book', el.dataset.open)));
  m.querySelectorAll('[data-open-new]').forEach((el) => el.addEventListener('click', () => go('new')));
  m.querySelectorAll('[data-tab]').forEach((el) => el.addEventListener('click', async () => {
    S.tab = el.dataset.tab;
    if (S.tab === 'script') await loadScript(S.chapterN);
    if (S.tab === 'cast' && !S.roster) { try { S.roster = await api('/api/casting/roster'); } catch { /* offline */ } }
    render();
  }));

  // render controls
  $('#r-go', m)?.addEventListener('click', async () => {
    const chapter = $('#r-scope').value || undefined;
    const tts = $('#r-tts').value;
    try {
      await api('/api/render', { method: 'POST', body: { book: S.bookId, chapter, tts } });
      jobLog.length = 0;
      toast(`Render started (${tts})`);
      render();
    } catch (e) { toast(e.message, true); }
  });

  // cast editing
  m.querySelectorAll('.actor').forEach((card) => {
    const eid = card.dataset.ent;
    const note = card.querySelector('[data-savenote]');
    const saved = () => { note.textContent = 'saved ✓'; setTimeout(() => (note.textContent = ''), 1800); };
    card.querySelector('[data-visual]')?.addEventListener('change', async (e) => {
      try { await api(`/api/books/${S.bookId}/entity/${eid}`, { method: 'PUT', body: { visual: e.target.value } }); saved(); } catch (err) { toast(err.message, true); }
    });
    card.querySelector('[data-roleeng]')?.addEventListener('change', async (e) => {
      try {
        await api(`/api/books/${S.bookId}/entity/${eid}`, { method: 'PUT', body: { engine: e.target.value || null, locked: !!e.target.value } });
        saved(); await loadBook(S.bookId);
      } catch (err) { toast(err.message, true); }
    });
    card.querySelectorAll('.dna-row').forEach((row) => {
      const eng = row.dataset.eng;
      const collect = () => {
        const raw = {};
        row.querySelectorAll('input, select').forEach((inp) => { if (inp.dataset.f) raw[inp.dataset.f] = inp.value; });
        if (eng === 'elevenlabs') {
          const fallbacks = (raw.fallbacks || '').split(',').map((s) => s.trim()).filter(Boolean);
          return { candidates: [...new Set([raw.primary, ...fallbacks].filter(Boolean))], model: raw.model, stability: +raw.stability || 0.5, style: 0.3 };
        }
        const v = {};
        for (const [k, val] of Object.entries(raw)) v[k] = ['speed', 'stability', 'style'].includes(k) ? +val : val;
        return v;
      };
      row.querySelectorAll('input, select').forEach((inp) => inp.addEventListener('change', async () => {
        try { await api(`/api/books/${S.bookId}/entity/${eid}`, { method: 'PUT', body: { voices: { [eng]: collect() } } }); saved(); } catch (err) { toast(err.message, true); }
      }));
      row.querySelector('[data-audition]')?.addEventListener('click', async (btn) => {
        const b = btn.currentTarget;
        b.disabled = true; b.textContent = '… rendering';
        try {
          const r = await api('/api/audition', { method: 'POST', body: { book: S.bookId, entity: eid, engine: eng } });
          const player = row.querySelector('[data-player]');
          player.hidden = false;
          player.innerHTML = `<audio controls autoplay src="${r.media}"></audio><span style="font-size:10.5px;color:var(--dim)">${r.chars} chars · ${(r.ms / 1000).toFixed(1)}s</span>`;
        } catch (e) { toast(`${eng} audition: ${e.message}`, true); }
        b.disabled = false; b.textContent = '▶ audition';
      });
    });
  });

  // script interactions
  $('#sc-ch', m)?.addEventListener('change', async (e) => { await loadScript(+e.target.value); render(); });
  m.querySelectorAll('.sline').forEach((el) => el.addEventListener('click', (ev) => {
    if (ev.target.closest('.cue-pin')) return;
    S.selLine = S.selLine === el.dataset.line ? null : el.dataset.line;
    S.cuePanel = null;
    render();
  }));
  m.querySelectorAll('.cue-pin').forEach((el) => el.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    const cueId = el.dataset.cue;
    S.selLine = null;
    S.cuePanel = { cueId, data: null };
    render();
    try { S.cuePanel.data = await api('/api/cue-preview', { method: 'POST', body: { book: S.bookId, cueId } }); } catch (e) { toast(e.message, true); S.cuePanel = null; }
    render();
  }));
  const pop = m.querySelector('[data-pop-line]');
  if (pop) {
    pop.querySelector('[data-p-cancel]').addEventListener('click', () => { S.selLine = null; render(); });
    pop.querySelector('[data-p-save]').addEventListener('click', async () => {
      const lineId = pop.dataset.popLine;
      let line = null;
      for (const sc of S.script.scenes) for (const l of sc.lines) if (l.id === lineId) line = l;
      const entity = pop.querySelector('[data-p-entity]').value;
      const emoName = pop.querySelector('[data-p-emo]').value;
      const strength = +pop.querySelector('[data-p-str]').value / 10;
      const body = { match: line.text, entity };
      if (emoName) body.emotion = { [emoName]: strength };
      try {
        await api(`/api/books/${S.bookId}/hints`, { method: 'POST', body });
        toast('Hint saved — chapter marked stale; re-render to apply');
        S.selLine = null;
        await loadBook(S.bookId);
        render();
      } catch (e) { toast(e.message, true); }
    });
  }
  const cpop = m.querySelector('[data-pop-cue]');
  if (cpop) {
    const cueId = cpop.dataset.popCue;
    const setApproval = async (approval) => {
      try {
        await api(`/api/books/${S.bookId}/cues/${cueId}`, { method: 'POST', body: { approval } });
        toast(approval === null ? 'Cue back to auto' : 'Cue updated — re-render to apply');
        S.cuePanel = null;
        await loadBook(S.bookId);
        render();
      } catch (e) { toast(e.message, true); }
    };
    cpop.querySelector('[data-cue-approve]')?.addEventListener('click', () => setApproval('approved'));
    cpop.querySelector('[data-cue-reject]')?.addEventListener('click', () => setApproval('rejected'));
    cpop.querySelector('[data-cue-reset]')?.addEventListener('click', () => setApproval(null));
    cpop.querySelectorAll('[data-cue-swap]').forEach((b) => b.addEventListener('click', () => setApproval({ swap: b.dataset.cueSwap })));
  }

  // quick narrate (free tool)
  $('#say-go', m)?.addEventListener('click', async () => {
    const text = $('#say-text').value.trim();
    if (!text) { toast('type or paste some text first', true); return; }
    const btn = $('#say-go'); const st = $('#say-status');
    btn.disabled = true; st.textContent = '⏱ rendering…';
    const t0 = Date.now();
    try {
      const r = await api('/api/say', { method: 'POST', body: { text, engine: 'kokoro', voice: $('#say-voice').value } });
      $('#say-result').innerHTML = `<audio controls autoplay src="${r.media}" style="width:100%;max-width:520px"></audio>
        <div style="font-size:12px;color:var(--muted);margin-top:6px">⏱ ${(r.ms / 1000).toFixed(1)}s · ${r.chars} chars · 💵 $0.00 free ·
        <a href="${r.media}" download style="color:var(--cy)">download mp3</a></div>`;
      st.textContent = `done in ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    } catch (e) { toast(e.message, true); st.textContent = 'failed'; }
    btn.disabled = false;
  });

  // casting room tabs
  m.querySelectorAll('[data-casttab]').forEach((b) => b.addEventListener('click', () => { S.castTab = b.dataset.casttab; render(); }));

  // portrait paste-to-save (click the box, Ctrl+V an image)
  m.querySelectorAll('[data-portrait]').forEach((zone) => {
    const card = zone.closest('[data-actor]');
    const name = card.dataset.actor;
    zone.addEventListener('click', () => { zone.classList.add('armed'); zone.focus(); toast(`paste an image for ${name} (Ctrl+V)`); });
    zone.addEventListener('paste', async (ev) => {
      const item = [...(ev.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (!item) { toast('no image in the clipboard', true); return; }
      ev.preventDefault();
      const blob = item.getAsFile();
      const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      try {
        await api(`/api/actors/${name}/portrait`, { method: 'POST', body: { dataUrl } });
        toast(`portrait saved for ${name}`);
        S.actors = (await api('/api/actors')).actors;
        render();
      } catch (e) { toast(e.message, true); }
    });
  });

  // casting room auditions
  m.querySelectorAll('[data-cast-play]').forEach((btn) => btn.addEventListener('click', async () => {
    const card = btn.closest('[data-cast-voice]');
    btn.disabled = true; btn.textContent = '…';
    try {
      const r = await api('/api/casting/audition', { method: 'POST', body: { engine: card.dataset.castEng, voice: card.dataset.castVoice } });
      card.querySelector('[data-cast-slot]').innerHTML = `<audio controls autoplay src="${r.media}" style="width:150px"></audio>`;
    } catch (e) { toast(`${card.dataset.castVoice}: ${e.message}`, true); }
    btn.disabled = false; btn.textContent = '▶';
  }));

  // new book
  $('#nb-create', m)?.addEventListener('click', async () => {
    const btn = $('#nb-create');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const r = await api('/api/books', {
        method: 'POST',
        body: { title: $('#nb-title').value, author: $('#nb-author').value, text: $('#nb-text').value, analyze: $('#nb-analyze').checked },
      });
      toast(`Created ${r.id} (${r.chapters} chapter(s)${r.analyzed ? ', analyzed' : ''})`);
      await go('book', r.id, 'cast');
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Create book'; }
  });
}

// ── boot ────────────────────────────────────────────────────────────────────
go('shelf');
