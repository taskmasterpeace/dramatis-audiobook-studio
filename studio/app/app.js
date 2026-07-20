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
// NO PURPLE — every hue here is warm/green/blue-teal by rule. (A prior
// '#C9A0DA00' slot survived the 7-char slice below as lavender; replaced.)
const CHIP_COLORS = ['#E08A97', '#7FB3D5', '#92C97F', '#D9B36B', '#8FB3A8', '#D98F6B', '#E0A84E', '#7FC9C9', '#B5C97F', '#C97F7F'];
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
  const prev = S.job?.status;
  S.job = JSON.parse(e.data);
  // a reload lands here with an empty client log — backfill from the tail the
  // server already ships, so refreshing mid-render doesn't look like a crash
  if (!jobLog.length && S.job?.tail?.length) jobLog.push(...S.job.tail);
  paintJob();
  if (S.job && S.job.status !== 'running' && prev === 'running') {
    const done = S.job.status === 'done';
    toast(done ? `Render finished: ${S.job.book}` : `Render ${S.job.status}: ${S.job.book}${S.job.error ? ' — ' + S.job.error : ''}`, !done);
    await refresh();
    if (done) showWrap(S.job.book);
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
  if (st) {
    const pr = S.job?.progress;
    const pct = pr && pr.total ? Math.round(100 * pr.done / pr.total) : null;
    st.textContent = busy
      ? `● rendering — ${S.job.elapsedSec}s${pr ? ` · ${pr.done}/${pr.total} (${pct}%)` : ''}`
      : (S.job ? `last render: ${S.job.status}` : 'no render this session');
  }
  const cancel = $('#r-cancel');
  if (cancel) cancel.style.display = busy ? '' : 'none';
  const vu = $('#vu');
  if (vu && busy) {
    // real progress when the pipeline reports n/total; elapsed-time fallback otherwise
    const pr = S.job?.progress;
    const lit = pr && pr.total ? Math.min(24, Math.round(24 * pr.done / pr.total))
      : Math.min(23, Math.floor((S.job.elapsedSec || 0) / 25));
    vu.innerHTML = Array.from({ length: 24 }, (_, i) => `<i class="${i < lit ? 'lit' : i === lit ? 'hot' : ''}"></i>`).join('');
  }
}
setInterval(async () => {
  if (S.job && S.job.status === 'running') {
    try { const { job } = await api('/api/render/status'); S.job = job; paintJob(); } catch { /* server gone */ }
  }
}, 3000);

// ── persistent transport + script playhead ─────────────────────────────────
// The player lives OUTSIDE #main, which render() replaces wholesale — so
// clicking a line, opening a cue, or saving a hint never cuts the audio.
let transport = null;
function ensureTransport() {
  if (transport) return transport;
  const el = document.createElement('div');
  el.className = 'transport';
  el.innerHTML = `<span class="tp-label"></span><audio controls preload="auto"></audio>
    <label class="mini tp-follow"><input type="checkbox" checked> follow</label>
    <button class="tp-x" title="close">✕</button>`;
  document.body.appendChild(el);
  const audio = el.querySelector('audio');
  audio.addEventListener('timeupdate', paintPlayhead);
  el.querySelector('.tp-x').addEventListener('click', () => { audio.pause(); el.classList.remove('on'); clearPlayhead(); });
  transport = { el, audio, timing: [], cues: [], book: null, chapter: null };
  return transport;
}
async function playChapter(bookId, n, seekTo) {
  const t = ensureTransport();
  const pad = String(n).padStart(2, '0');
  if (t.book !== bookId || t.chapter !== n) {
    try { t.timing = await (await fetch(`/media/${bookId}/ch-${pad}/timing.json`)).json(); } catch { t.timing = []; }
    t.cues = (S.book?.chapters?.[n - 1]?.cues) || [];
    t.audio.src = `/media/${bookId}/ch-${pad}/immersive.m4a`;
    t.book = bookId; t.chapter = n;
    t.el.querySelector('.tp-label').textContent = `${bookId} · ch ${n}`;
  }
  t.el.classList.add('on');
  if (seekTo != null) t.audio.currentTime = Math.max(0, seekTo);
  t.audio.play().catch(() => toast('click the player once to allow audio', true));
}
const timingLines = () => (Array.isArray(transport?.timing) ? transport.timing : (transport?.timing?.lines || []));
function clearPlayhead() {
  document.querySelectorAll('.sline.playing').forEach((e) => e.classList.remove('playing'));
  document.querySelectorAll('.cue-pin.firing').forEach((e) => e.classList.remove('firing'));
}
function paintPlayhead() {
  const t = transport;
  if (!t || !t.el.classList.contains('on')) return;
  const now = t.audio.currentTime;
  const cur = timingLines().find((l) => now >= l.start && now < l.start + l.dur);
  const prev = document.querySelector('.sline.playing');
  if (prev && prev.dataset.line !== cur?.id) prev.classList.remove('playing');
  if (cur) {
    const el = document.querySelector(`.sline[data-line="${cur.id}"]`);
    if (el && !el.classList.contains('playing')) {
      el.classList.add('playing');
      if (t.el.querySelector('.tp-follow input').checked) {
        const r = el.getBoundingClientRect();
        if (r.top < 80 || r.bottom > window.innerHeight - 140) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }
  // a cue "fires" for ~1.2s around its placed time
  for (const c of t.cues) {
    const pin = document.querySelector(`.cue-pin[data-cue="${c.id}"]`);
    if (!pin) continue;
    pin.classList.toggle('firing', c.at != null && now >= c.at && now < c.at + 1.2);
  }
}

// ── the wrap report: a production wrap card when a render lands ─────────────
async function showWrap(bookId) {
  let d;
  try { d = await api(`/api/wrap/${bookId}`); } catch { return; }
  const cast = d.cast.slice(0, 8);
  const max = Math.max(1, ...cast.map((c) => c.lines));
  const el = document.createElement('div');
  el.className = 'wrap-overlay';
  el.innerHTML = `<div class="wrap-card">
    <div class="wrap-head"><span>🎬 THAT'S A WRAP</span><button class="wrap-x" title="close">✕</button></div>
    <h2 style="margin:2px 0 4px">${esc(d.title)}</h2>
    <div class="wrap-stats">
      <div><b class="num">${d.minutes}</b><small>minutes</small></div>
      <div><b class="num">${d.chapters}</b><small>chapters</small></div>
      <div><b class="num">${d.lines}</b><small>lines</small></div>
      <div><b class="num">${d.cuesOnWord}/${d.cues}</b><small>cues on-word</small></div>
      <div><b class="num">${d.lufs}</b><small>LUFS</small></div>
      <div class="wrap-money"><b class="num">$${d.usd.toFixed(2)}</b><small>API spend</small></div>
    </div>
    <div class="wrap-cast">${cast.map((c, i) => `
      <div class="wrap-row"><span class="wrap-name" style="color:${entColor(c.entity, i)}">${esc(c.entity.replace(/_/g, ' '))}</span>
      <span class="wrap-bar"><i style="width:${Math.round(100 * c.lines / max)}%;background:${entColor(c.entity, i)}"></i></span>
      <span class="num" style="font-size:11px;color:var(--muted)">${c.lines}</span></div>`).join('')}</div>
    ${d.flags === 0 ? '<div class="chip ok" style="margin-top:10px">0 QA flags — clean take</div>' : `<div class="chip warn" style="margin-top:10px">${d.flags} QA flag(s)</div>`}
  </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector('.wrap-x').addEventListener('click', close);
  el.addEventListener('click', (ev) => { if (ev.target === el) close(); });
}

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

// ── cue queue helpers ───────────────────────────────────────────────────────
function currentCues() { return (S.book?.book?.chapters?.[S.chapterN - 1]?.cues) || []; }
async function loadCue(i) {
  const cue = currentCues()[i];
  if (!cue) return;
  S.cuePanel = { cueId: cue.id, data: null };
  try {
    S.cuePanel.data = await api('/api/cue-preview', { method: 'POST', body: { book: S.bookId, cueId: cue.id } });
    if (S.scriptMode === 'cues') render();
    // prefetch the next one so the CLAP round-trip is hidden
    const next = currentCues()[i + 1];
    if (next) api('/api/cue-preview', { method: 'POST', body: { book: S.bookId, cueId: next.id } }).catch(() => {});
  } catch (e) { toast(e.message, true); }
}
async function setCueApproval(approval) {
  const cue = currentCues()[S.cueIdx ?? 0];
  if (!cue) return;
  try {
    await api(`/api/books/${S.bookId}/cues/${cue.id}`, { method: 'POST', body: { approval } });
    await loadBook(S.bookId);
    // advance to the next still-pending cue — triage should flow
    const cues = currentCues();
    const nextPending = cues.findIndex((c, idx) => idx > (S.cueIdx ?? 0) && !c.approval);
    S.cueIdx = nextPending >= 0 ? nextPending : Math.min((S.cueIdx ?? 0) + 1, cues.length - 1);
    S.cuePanel = null;
    render();
    loadCue(S.cueIdx);
  } catch (e) { toast(e.message, true); }
}
// keyboard triage — bound once, active only in the cue queue
document.addEventListener('keydown', (e) => {
  if (S.view !== 'book' || S.tab !== 'script' || S.scriptMode !== 'cues') return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
  const cues = currentCues();
  const move = (d) => { S.cueIdx = Math.max(0, Math.min(cues.length - 1, (S.cueIdx ?? 0) + d)); S.cuePanel = null; render(); loadCue(S.cueIdx); };
  if (e.key === 'j') { e.preventDefault(); move(1); }
  else if (e.key === 'k') { e.preventDefault(); move(-1); }
  else if (e.key === 'a') { e.preventDefault(); setCueApproval('approved'); }
  else if (e.key === 'r') { e.preventDefault(); setCueApproval('rejected'); }
  else if (e.key === 'u') { e.preventDefault(); setCueApproval(null); }
  else if (e.key === ' ') { e.preventDefault(); $('#cq-player audio')?.play(); }
});

// ── navigation ──────────────────────────────────────────────────────────────
async function go(view, bookId, tab) {
  S.view = view;
  if (view === 'shelf') await loadShelf();
  if ((view === 'casting' || view === 'say') && !S.roster) { try { S.roster = await api('/api/casting/roster'); } catch (e) { toast(e.message, true); } }
  if (view === 'casting') { try { S.actors = (await api('/api/actors')).actors; } catch { S.actors = []; } }
  if (view === 'say') { try { S.sayStats = await api('/api/say/history'); } catch { /* first run */ } }
  if (view === 'models') { try { S.models = (await api('/api/models')).models; } catch (e) { toast(e.message, true); } }
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
  else if (S.view === 'models') m.innerHTML = viewModels();
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
    navBtn('models', '⚖ Models', S.view === 'models'),
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
      <div class="bstats"><span><b>${b.done}/${b.chapters}</b> chapters</span><span><b class="num">${b.minutes.toFixed(1)}</b> min</span>${
        // sub-penny LLM spend on every card was noise — show it only once it is
        // a number someone would actually act on
        (b.spend?.llmUsd || 0) >= 0.01 ? `<span>LLM <b class="num">$${b.spend.llmUsd.toFixed(2)}</b></span>` : ''}</div>
      <div class="leftline">${b.warnings.length
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
  const { chapters, preflight, book, bound = {}, validation } = S.book;
  const boundRow = (bound.immersive || bound.clean) ? `
    <div class="card" style="padding:14px 16px;margin-bottom:12px;border-color:var(--cy-dim)">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-weight:600">📕 Finished book</span>
        ${bound.immersive ? `<span class="chip cy">immersive ${bound.immersive.mb} MB</span>` : ''}
        ${bound.clean ? `<span class="chip">clean ${bound.clean.mb} MB</span>` : ''}
        ${bound.immersive ? `<a class="btn sm" href="${bound.immersive.media}" download>⬇ download .m4b</a>` : ''}
      </div>
      ${bound.immersive ? `<audio controls preload="none" src="${bound.immersive.media}" style="width:100%;margin-top:9px"></audio>` : ''}
    </div>` : '';
  const validRow = validation && !validation.ok ? `
    <div class="card" style="padding:11px 14px;margin-bottom:12px;border-color:var(--crit)">
      <b style="color:var(--crit)">⚠ ${validation.errors.length} casting/config problem(s) — render will refuse:</b>
      <ul style="margin:6px 0 0;padding-left:18px;font-size:12px;color:var(--muted)">
        ${validation.errors.slice(0, 6).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
    </div>` : '';
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
      <div class="cell">${c.flags == null ? '—'
        : c.flags === 0 ? '<span class="chip ok">0 flags</span>'
        : `<button class="chip warn" data-flags="${c.n}" title="show the flagged lines">${c.flags} flag(s) ▾</button>`}</div>
      ${S.openFlags === c.n && c.flagged?.length ? `<div class="chplayer" style="font-family:var(--mono);font-size:11px;color:var(--muted);background:var(--sunk);border-radius:6px;padding:8px 10px">
        ${c.flagged.map((f) => `<div>${esc(f.id)} · ${esc(f.reason)} · ${f.dur}s</div>`).join('')}</div>` : ''}
      ${c.media ? `<div class="chplayer"><audio controls preload="none" src="${c.media}"></audio></div>` : ''}
    </div>`).join('');
  const scopeOpts = ['<option value="">Whole book</option>']
    .concat(chapters.map((c) => `<option value="${c.n}">${esc(c.heading)}</option>`)).join('');
  const engines = Object.keys(book.voices).filter((k) => k !== 'hybrid');
  const engOpts = ['hybrid'].concat(engines).map((e) => `<option ${e === 'hybrid' ? 'selected' : ''}>${e}</option>`).join('');
  const busy = S.job && S.job.status === 'running';
  return `${validRow}${boundRow}${rows}
    <div class="board-split">
      <div><p class="panel-h">Render</p>
        <div class="card preflight">
          <div class="rowline"><span class="l">Scope</span><select id="r-scope">${scopeOpts}</select></div>
          <div class="rowline"><span class="l">Engine</span><select id="r-tts">${engOpts}</select></div>
          <div class="rowline"><span class="l">Narration → Kokoro</span><span class="v num" id="pf-narr">${preflight.narration} lines · $0</span></div>
          <div class="rowline"><span class="l">Dialogue → Qwen3</span><span class="v num" id="pf-dial">${preflight.dialogue} lines · $0</span></div>
          <div class="rowline"><span class="l">Hero → ElevenLabs</span><span class="v num" id="pf-hero">${preflight.hero} lines · ${preflight.heroChars} chars</span></div>
          <div class="total"><span class="l">Estimated API spend</span><span class="amt num" id="pf-usd">≈ $${preflight.heroUsdEstimate.toFixed(2)} <small>rest is your GPU</small></span></div>
          <button class="btn" id="r-go" ${busy ? 'disabled' : ''}>● Render</button>
          <button class="btn danger sm" id="r-cancel" style="margin-left:8px;${busy ? '' : 'display:none'}">■ Cancel</button>
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
  // the four voice engines, in the order they appear on the Cast screen
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
    const sug = S.book.suggestions?.[ent.id];
    const sugStrip = sug ? `
      <div class="suggest">
        <div class="f-label" style="margin:0 0 3px">Suggested casting — read from the description</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center">
          <span class="chip">${esc(sug.determined.gender)}</span>
          <span class="chip">${esc(sug.determined.ageBand)}</span>
          ${sug.determined.accent !== 'none' ? `<span class="chip cy">${esc(sug.determined.accent.split(',')[0])}</span>` : ''}
          <span class="chip">→ ${esc(sug.recipe.engine)}</span>
          <button class="btn sm" data-apply-suggest="${ent.id}">Apply</button>
        </div>
        <div style="font-size:10px;color:var(--dim);margin-top:4px">${esc(sug.recipe.note)}</div>
      </div>` : '';
    const actorNote = (S.actors || []).find((a) => a.name === ent.id || a.name === (ent.actor || ''))?.notes;
    return `<div class="actor card" data-ent="${ent.id}">
      <div class="actor-h"><span class="swatch" style="background:${entColor(ent.id, i)}"></span>
        <span class="nm">${esc(ent.id.replace(/_/g, ' ').toUpperCase())}</span>
        <span class="roleeng"><select data-roleeng title="Force every one of this role's lines to one engine">
          <option value="">route: auto (hybrid)</option>
          ${['kokoro', 'qwen3', 'elevenlabs', 'gemini'].map((e) => `<option ${casting?.engine === e ? 'selected' : ''}>${e}</option>`).join('')}
        </select></span></div>
      ${ent.names?.length ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${ent.names.map((n) => `<span class="chip">${esc(n)}</span>`).join('')}</div>` : ''}
      <div class="sheet">
        <div class="f-label" style="margin:0 0 5px">Casting sheet — what YOU say overrides everything inferred</div>
        <div style="display:flex;gap:7px;flex-wrap:wrap;align-items:center">
          <label class="mini">Gender <select data-sheet="gender">
            <option value="" ${!ent.gender ? 'selected' : ''}>infer</option>
            <option ${ent.gender === 'female' ? 'selected' : ''}>female</option>
            <option ${ent.gender === 'male' ? 'selected' : ''}>male</option>
          </select></label>
          <label class="mini">Age <input class="tiny" data-sheet="age" value="${esc(ent.age || '')}" placeholder="72"></label>
          <label class="mini">Race/ethnicity <input data-sheet="ethnicity" value="${esc(ent.ethnicity || '')}" placeholder="Black, from New Orleans" style="width:150px"></label>
          <label class="mini">Accent <input data-sheet="accent" value="${esc(ent.accent || '')}" placeholder="auto from ethnicity" style="width:130px"></label>
        </div>
      </div>
      <div class="portrait-zone book-portrait" data-ent-portrait tabindex="0" title="Click, then paste an image (Ctrl+V) — how this character looks">
        ${ent.portrait ? `<img src="/bookart/${S.bookId}/${esc(ent.portrait.split('/').pop())}?t=${Date.now()}" alt="${esc(ent.id)}">`
          : `<div class="portrait-empty">🖼 click + paste this character's image</div>`}
      </div>
      ${sugStrip}
      <div class="screentest">
        <button class="btn ghost sm" data-screentest="${ent.id}">🎧 Screen Test — hear every engine on the same line</button>
        <div data-st-results></div>
      </div>
      <div><div class="f-label">Visual brief — feeds character art (manual generation only)</div>
        <textarea data-visual>${esc(ent.visual || '')}</textarea></div>
      <div><div class="f-label">Voice DNA</div><div class="dna">${rows}</div></div>
      ${actorNote ? `<div class="actor-note-ro"><b>Actor notes</b> (from the company — apply to every book)<br>${esc(actorNote).replace(/\n/g, '<br>')}</div>` : ''}
      <div><div class="f-label">Role notes — this book only (direction for this performance)</div>
        <textarea data-rolenote placeholder="e.g. she's grieving from ch3 on — play her warmer, slower">${esc(ent.notes || '')}</textarea></div>
      <div class="savenote" data-savenote></div>
    </div>`;
  }).join('');
  return `<div class="cast-grid">${cards}</div>`;
}

function viewScript() {
  const { book } = S.book;
  const chapters = book.chapters.map((c, i) => `<option value="${i + 1}" ${S.chapterN === i + 1 ? 'selected' : ''}>${esc(c.heading)}</option>`).join('');
  const bookCues = (book.chapters[S.chapterN - 1]?.cues) || [];
  const pending = bookCues.filter((c) => !c.approval).length;
  const modeBar = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
    <select id="sc-ch">${chapters}</select>
    <button class="btn ghost sm" id="sc-play">▶ Play chapter</button>
    <span style="flex:1"></span>
    <button class="btn ${S.scriptMode !== 'cues' ? '' : 'ghost'} sm" data-scriptmode="script">¶ Script</button>
    <button class="btn ${S.scriptMode === 'cues' ? '' : 'ghost'} sm" data-scriptmode="cues">⟟ Cues ${pending ? `(${pending} pending)` : '✓'}</button>
  </div>`;
  if (S.scriptMode === 'cues') return modeBar + viewCueQueue(bookCues);
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
          <div class="txt"><button class="sline-play" title="play from here">▶</button>${pins}${esc(l.text)}</div>
        </div>${S.selLine === l.id ? linePopover(l) : ''}${S.cuePanel && (cuesByLine[l.id] || []).some((c) => c.id === S.cuePanel.cueId) ? cuePopover() : ''}`;
      }).join('');
      return head + lines;
    }).join('');
  }
  return modeBar + body;
}

// Cue triage queue — the analyzer over-cues by design, and approving them one
// pin at a time in a scrolling script was the biggest manual grind in the app.
function viewCueQueue(bookCues) {
  if (!bookCues.length) return `<div class="empty">This chapter has no SFX cues.</div>`;
  const qa = Object.fromEntries(((S.book.chapters[S.chapterN - 1]?.cues) || []).map((c) => [c.id, c]));
  const sel = S.cueIdx ?? 0;
  const state = (c) => (c.approval === 'rejected' ? 'rejected'
    : c.approval === 'approved' ? 'approved'
    : (c.approval && c.approval.swap) ? 'swapped' : 'pending');
  const rows = bookCues.map((c, i) => {
    const q = qa[c.id] || {};
    const st = state(c);
    return `<div class="cq-row ${i === sel ? 'sel' : ''} st-${st}" data-cueidx="${i}" data-cueid="${c.id}">
      <span class="cq-state">${st === 'approved' ? '✓' : st === 'rejected' ? '✕' : st === 'swapped' ? '⇄' : '•'}</span>
      <span class="cq-spec">${esc(c.sfx)}</span>
      <span class="cq-cap">${esc((q.caption || '').slice(0, 58))}</span>
      <span class="cq-meta num">${q.sim != null ? `sim ${q.sim}` : ''} ${q.at != null ? `@${Math.floor(q.at / 60)}:${String(Math.floor(q.at % 60)).padStart(2, '0')}` : ''}</span>
    </div>`;
  }).join('');
  const cur = bookCues[sel];
  const curQa = qa[cur?.id] || {};
  return `
    <p style="font-size:11.5px;color:var(--muted);margin:0 0 8px">
      <b>j</b>/<b>k</b> move · <b>space</b> play · <b>a</b> approve · <b>r</b> reject · <b>u</b> auto — decisions save instantly.
    </p>
    <div class="cq-wrap">
      <div class="cq-list">${rows}</div>
      <div class="cq-detail card">
        <div class="f-label">Cue ${sel + 1} of ${bookCues.length}</div>
        <div style="font-family:var(--mono);font-size:13px;margin-bottom:4px">${esc(cur?.sfx || '')}</div>
        <div style="font-size:11.5px;color:var(--muted);margin-bottom:8px">
          anchor: “${esc((cur?.anchor || '').slice(0, 70))}”<br>
          ${curQa.caption ? `source: ${esc(curQa.caption.slice(0, 70))}` : 'not rendered yet'}
          ${curQa.confidence != null ? ` · conf ${curQa.confidence}` : ''}
        </div>
        <div id="cq-player">${S.cuePanel?.data?.current
          ? `<audio controls autoplay src="${S.cuePanel.data.current}" style="width:100%"></audio>`
          : '<span style="font-size:11.5px;color:var(--dim)">press space to hear it</span>'}</div>
        <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
          <button class="btn sm" data-cq="approved">✓ Approve</button>
          <button class="btn ghost sm" data-cq="null">Auto</button>
          <button class="btn danger sm" data-cq="rejected">✕ Reject</button>
        </div>
        ${S.cuePanel?.data?.alternatives?.length ? `
          <div class="f-label" style="margin-top:12px">Swap for a library alternative</div>
          ${S.cuePanel.data.alternatives.map((a) => `<div class="alt">
            <audio controls preload="none" src="${a.media}"></audio>
            <span class="cap">${esc(a.caption)} <span class="num">(${a.score})</span></span>
            <button class="btn ghost sm" data-cq-swap="${esc(a.file)}">Use</button></div>`).join('')}` : ''}
      </div>
    </div>`;
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

// Voice Designer: describe a person -> we infer gender/age/accent, pick the best
// candidate on every engine, you hear them side by side and hire one. The approved
// take is saved as the actor's seed clip, so they can be re-hired free forever.
function viewDesigner() {
  const d = S.design || (S.design = { form: {}, slate: null, takes: {} });
  const f = d.form;
  const sel = (v, o) => (v === o ? 'selected' : '');
  const form = `
    <div class="card" style="padding:16px;margin-bottom:14px">
      <div style="font-size:12.5px;color:var(--muted);line-height:1.6;margin-bottom:13px">
        <b style="color:var(--text)">Describe the person. We work out the rest.</b>
        DRAMATIS reads your description, decides gender, age band and accent, then picks the best
        candidate on <b>every engine</b> — a directed Gemini take, the closest voice on your own
        ElevenLabs roster, a free local design, and a free preset. Hear them side by side, hire one.
        The take you approve becomes that actor's <b>seed clip</b>, so they can be re-hired in any
        book for free, forever.
      </div>
      <div class="f-label">Character name</div>
      <input id="vd-name" placeholder="e.g. Marcus Kane" value="${esc(f.name || '')}">
      <div class="f-label" style="margin-top:10px">Describe them — the way you would to a casting director</div>
      <textarea id="vd-desc" rows="3" placeholder="a gruff Irish dockworker in his fifties, been shouting over machinery his whole life — warm underneath it">${esc(f.description || '')}</textarea>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:11px;align-items:flex-end">
        <div><div class="f-label">Gender</div><select id="vd-gender" style="width:110px">
          <option value="">infer it</option>
          <option value="female" ${sel(f.gender, 'female')}>female</option>
          <option value="male" ${sel(f.gender, 'male')}>male</option></select></div>
        <div><div class="f-label">Age</div><input id="vd-age" style="width:74px" placeholder="55" value="${esc(f.age || '')}"></div>
        <div><div class="f-label">Ethnicity / accent</div><input id="vd-acc" style="width:190px" placeholder="Irish" value="${esc(f.accent || '')}"></div>
        <button class="go" id="vd-find">${d.slate ? 'Re-cast' : 'Find candidates'} →</button>
      </div>
    </div>`;

  if (!d.slate) return form;

  const det = d.slate.determined || {};
  const chips = [
    ['gender', det.gender], ['age', det.ageBand],
    ['accent', det.accent || 'none — no accent direction needed'],
  ].map(([k, v]) => `<span class="chip" style="margin-right:6px">${esc(k)}: <b>${esc(String(v))}</b></span>`).join('');

  const cards = d.slate.candidates.map((c, i) => {
    const take = d.takes[i];
    return `
    <div class="card" data-cand="${i}" style="padding:12px 14px;display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="chip ${c.tier === 'free' ? '' : 'cy'}">${esc(c.engine)}</span>
        <b style="font-size:13px">${esc(c.voice)}</b>
        <span style="font-size:10.5px;color:var(--dim)">${c.tier === 'free' ? 'free' : 'paid'}</span>
        ${c.best ? '<span class="chip cy" title="best fit for this character">★ best fit</span>' : ''}
        ${c.weak ? '<span class="chip warn" title="known limitation">⚠ can\'t do accents</span>' : ''}
      </div>
      <div style="font-size:11.5px;color:var(--muted);line-height:1.5">${esc(c.why)}</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button class="aud" data-vd-play="${i}">${take ? '↻ again' : '▶ audition'}</button>
        ${take ? `<audio controls src="${take.media}" style="width:210px;height:30px"></audio>
          <span style="font-size:10.5px;color:var(--dim)">${(take.ms / 1000).toFixed(1)}s</span>` : ''}
        ${take ? `<button class="go" data-vd-hire="${i}">Hire ${esc(f.name || 'them')} →</button>` : ''}
      </div>
    </div>`;
  }).join('');

  return `${form}
    <div class="card" style="padding:12px 14px;margin-bottom:12px;border-color:var(--cy-dim)">
      <div style="font-size:11px;color:var(--dim);margin-bottom:7px">WHAT WE WORKED OUT FROM YOUR DESCRIPTION</div>
      ${chips}
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
      <button class="go" id="vd-all">🎧 Audition all ${d.slate.candidates.length}</button>
      <span style="font-size:11px;color:var(--dim)">they all speak the same line, so it's a fair comparison — and it's long enough to be a clone seed</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:9px">${cards}</div>
    <div class="card" style="padding:11px 14px;margin-top:12px;font-size:11.5px;color:var(--muted)">
      <b style="color:var(--text)">The line they're reading:</b> <em>${esc(d.slate.line)}</em>
    </div>`;
}

function viewCasting() {
  if (!S.roster) return `<p class="crumb">Talent</p><h1>Casting Room</h1><div class="empty">loading roster…</div>`;
  const ENGLABEL = { company: '🎭 The Company', design: '✨ Design a Voice', kokoro: 'Kokoro — free', gemini: 'Gemini — directed', elevenlabs: 'ElevenLabs — your roster' };
  const tabs = ['company', 'design', 'kokoro', 'gemini', 'elevenlabs'];
  S.castTab = S.castTab || 'company';
  const counts = { company: (S.actors || []).length, ...Object.fromEntries(Object.entries(S.roster).map(([k, v]) => [k, v.length])) };
  delete counts.design;
  const tabBar = `<div class="tabs">${tabs.map((t) => `<button data-casttab="${t}" class="${S.castTab === t ? 'on' : ''}">${esc(ENGLABEL[t])} <span style="opacity:.6">${counts[t] ?? 0}</span></button>`).join('')}</div>`;

  let body;
  if (S.castTab === 'company') {
    const actors = S.actors || [];
    const explainer = `
      <div class="card" style="padding:13px 16px;margin-bottom:14px;border-color:var(--cy-dim);font-size:12.5px;color:var(--muted);line-height:1.6">
        <b style="color:var(--text)">What is the Company?</b> Your permanent stable of voice actors — like a
        repertory theater troupe. When a voice comes out perfect (usually seeded on Gemini or ElevenLabs),
        we save it here: a <b>seed clip</b>, its transcript, and the recipe that made it. From then on that
        actor can be <b>re-hired in any book for free</b>, cloned locally into Qwen3. Pay once for the
        perfect voice, use them forever — that's the whole trick.
        Their <b>notes</b> travel with them to every production; their <b>portrait</b> is pasted by you.
      </div>`;
    body = explainer + (actors.length ? `<div class="cast-grid">${actors.map((a) => `
      <div class="actor card" data-actor="${esc(a.name)}">
        <div class="actor-h"><span class="nm">${esc(a.name.replace(/-/g, ' ').toUpperCase())}</span>
          <span class="roleeng chip cy">${esc(a.origin.seed_engine || 'seeded')}</span></div>
        <div class="portrait-zone" data-portrait tabindex="0" title="Click here and paste an image (Ctrl+V)">
          ${a.portrait ? `<img src="${a.portrait}?t=${Date.now()}" alt="${esc(a.name)}">`
            : `<div class="portrait-empty">🖼<br><span>click + paste an image</span></div>`}
        </div>
        <div style="font-size:12px;color:var(--muted)">${esc(a.origin.character || '')}</div>
        ${a.seed ? `<audio controls preload="none" src="${a.seed}"></audio>` : ''}
        <div><div class="f-label">Actor notes — travel to every book she's in</div>
          <textarea data-actornote placeholder="e.g. rolls her R's if you over-direct the accent; keep reference clips under 15s">${esc(a.notes || '')}</textarea></div>
        <div class="savenote" data-savenote></div>
        <div style="font-size:10.5px;color:var(--dim)">
          voice: ${esc(a.origin.seed_voice || '—')} · gate: ${esc(a.origin.gate || '—')}<br>
          <em>${esc((a.transcript || '').slice(0, 90))}${(a.transcript || '').length > 90 ? '…' : ''}</em>
        </div>
      </div>`).join('')}</div>`
      : `<div class="empty">No company members yet — use <b>✨ Design a Voice</b> to make your first one.</div>`);
  } else if (S.castTab === 'design') {
    body = viewDesigner();
  } else {
    let voices = S.roster[S.castTab] || [];
    // filters: find an actor by gender / age / accent / name (Robert's ask)
    const f = S.castFilter || {};
    const ages = [...new Set(voices.map((v) => v.age).filter(Boolean))];
    const accents = [...new Set(voices.map((v) => v.accent).filter(Boolean))].sort();
    if (f.gender) voices = voices.filter((v) => v.gender === f.gender);
    if (f.age) voices = voices.filter((v) => v.age === f.age);
    if (f.accent) voices = voices.filter((v) => v.accent === f.accent);
    if (f.q) voices = voices.filter((v) => (v.voice + ' ' + (v.note || '')).toLowerCase().includes(f.q.toLowerCase()));
    const filterBar = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
        <input id="cf-q" placeholder="search name…" value="${esc(f.q || '')}" style="width:150px">
        <select id="cf-gender"><option value="">any gender</option>
          <option value="female" ${f.gender === 'female' ? 'selected' : ''}>female</option>
          <option value="male" ${f.gender === 'male' ? 'selected' : ''}>male</option></select>
        ${ages.length ? `<select id="cf-age"><option value="">any age</option>${ages.map((a) => `<option ${f.age === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>` : ''}
        ${accents.length ? `<select id="cf-accent"><option value="">any accent</option>${accents.map((a) => `<option ${f.accent === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select>` : ''}
        <span style="font-size:11px;color:var(--dim)">${voices.length} match${voices.length === 1 ? '' : 'es'}</span>
      </div>`;
    body = filterBar + `<div style="display:flex;flex-wrap:wrap;gap:7px">
      ${voices.map((v) => `
        <div class="card" style="padding:8px 11px;display:flex;align-items:center;gap:8px" data-cast-voice="${esc(v.voice)}" data-cast-eng="${S.castTab}">
          <span style="font-size:12.5px;font-weight:600">${esc(v.label || v.voice)}</span>
          <span style="font-size:10.5px;color:var(--dim)">${esc(v.note)}</span>
          <button class="aud" data-cast-play title="hear this voice">▶</button>
          <span data-cast-slot></span>
        </div>`).join('')}</div>`;
  }
  return `
    <p class="crumb">Talent</p><h1>Casting Room</h1>
    <p class="sub">Your company plus every hireable voice. In a voice tab, ▶ speaks the same line so they compare fairly. In The Company, click a portrait box and paste an image — it saves itself.</p>
    ${tabBar}${body}`;
}

// ── Models: the interactive report card ─────────────────────────────────────
// Every model we run, tested, or rejected — grade, measured speed, capabilities,
// and the evidence. Sortable columns, kind filters, click a row for the full
// dossier. Data: /api/models = src/model-facts.mjs + live Quick Narrate speeds
// + benchmark artifacts.
const KIND_LABEL = { voice: '🎙 Voice', music: '♪ Music', 'sfx-retrieval': '⚡ SFX', alignment: '⏱ Align', 'set-piece': '🎬 Set-piece' };
const STATUS_CHIP = { active: ['ok', 'active'], gated: ['warn', 'gated'], rejected: ['crit', 'rejected'], research: ['cy', 'researching'] };

function viewModels() {
  if (!S.models) return `<p class="crumb">Reference</p><h1>Models</h1><div class="empty">loading…</div>`;
  const f = S.modelFilter || {};
  const sort = S.modelSort || { key: 'gradeRank', dir: -1 };
  let rows = S.models.slice();
  if (f.kind) rows = rows.filter((m) => m.kind === f.kind);
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((m) => JSON.stringify(m).toLowerCase().includes(q));
  }
  rows.sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    const r = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av ?? '').localeCompare(String(bv ?? ''));
    return r * sort.dir;
  });

  const kinds = [...new Set(S.models.map((m) => m.kind))];
  const chips = [`<button class="chip ${!f.kind ? 'cy' : ''}" data-mf-kind="">all ${S.models.length}</button>`]
    .concat(kinds.map((k) => `<button class="chip ${f.kind === k ? 'cy' : ''}" data-mf-kind="${k}">${KIND_LABEL[k] || k} ${S.models.filter((m) => m.kind === k).length}</button>`)).join(' ');

  const th = (key, label) => `<th data-msort="${key}" style="cursor:pointer;white-space:nowrap">${label}${sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const gradeChip = (g) => {
    const cls = /^A/.test(g) ? 'ok' : /^B/.test(g) ? 'cy' : g === 'F' ? 'crit' : g === '—' ? '' : 'warn';
    return `<span class="chip ${cls}" style="font-weight:700;min-width:30px;text-align:center">${g}</span>`;
  };
  const speedCell = (m) => m.live
    ? `<b class="num">${m.live.charsPerSec}</b> chars/s <span style="color:var(--dim);font-size:10px">measured ×${m.live.samples}</span>`
    : m.bench
      ? `<b class="num">${m.bench['R@1']}%</b> R@1 <span style="color:var(--dim);font-size:10px">bench</span>`
      : `<span style="font-size:11px">${esc(m.speedStatic || '—')}</span>`;

  const body = rows.map((m) => {
    const [scls, slabel] = STATUS_CHIP[m.status] || ['', m.status];
    const open = S.modelOpen === m.id;
    const detail = !open ? '' : `
      <tr class="mdetail"><td colspan="7" style="padding:14px 18px;background:var(--panel2)">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:12px;line-height:1.6">
          <div>
            <div class="f-label">Why this grade</div><div>${esc(m.gradeWhy)}</div>
            <div class="f-label" style="margin-top:9px">Role</div><div>${esc(m.role)}</div>
            <div class="f-label" style="margin-top:9px">Licence</div><div>${esc(m.licence)}</div>
            <div class="f-label" style="margin-top:9px">Limits</div><div>${esc(m.caps)}</div>
            ${m.earRuling ? `<div class="f-label" style="margin-top:9px">Ear ruling</div><div>“${esc(m.earRuling)}”</div>` : ''}
          </div>
          <div>
            ${m.capabilities?.length ? `<div class="f-label">Can do</div><ul style="margin:2px 0 0 16px">${m.capabilities.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
            ${m.limitations?.length ? `<div class="f-label" style="margin-top:9px">Can't / won't</div><ul style="margin:2px 0 0 16px">${m.limitations.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
            ${m.measured?.length ? `<div class="f-label" style="margin-top:9px">Measured here</div><ul style="margin:2px 0 0 16px">${m.measured.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
            ${m.bench ? `<div class="f-label" style="margin-top:9px">Benchmark</div><div>R@1 ${m.bench['R@1']}% · R@3 ${m.bench['R@3']}% · R@10 ${m.bench['R@10']}% · MRR ${m.bench.MRR} (${m.bench.classes} classes, our corpus)</div>` : ''}
          </div>
        </div>
      </td></tr>`;
    return `
      <tr data-mrow="${m.id}" style="cursor:pointer${m.status === 'rejected' ? ';opacity:.55' : ''}">
        <td style="font-weight:600;white-space:nowrap">${esc(m.name)}</td>
        <td style="white-space:nowrap">${KIND_LABEL[m.kind] || esc(m.kind)}</td>
        <td style="font-size:11px">${esc(m.tier)}</td>
        <td>${gradeChip(m.grade)}</td>
        <td>${speedCell(m)}</td>
        <td style="font-size:11px">${esc(m.cost)}</td>
        <td><span class="chip ${scls}">${slabel}</span></td>
      </tr>${detail}`;
  }).join('');

  return `
    <p class="crumb">Reference</p><h1>Models</h1>
    <p class="sub">Every model we run, tested, or rejected — and the evidence. Grades trace to a measurement,
    a licence file that was read, or one of Robert's ear rulings. Click a row for the dossier; click a column to sort.
    Speeds marked <b>measured</b> come live from this machine's Quick Narrate history.</p>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      ${chips}
      <input id="mf-q" placeholder="search anything…" value="${esc(f.q || '')}" style="width:170px;margin-left:auto">
    </div>
    <div class="card" style="padding:0;overflow-x:auto">
      <table class="mtable" style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;font-size:11px;color:var(--muted)">
          ${th('name', 'Model')}${th('kind', 'Kind')}${th('tier', 'Tier')}${th('gradeRank', 'Grade')}<th>Speed</th><th>Cost</th>${th('status', 'Status')}
        </tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p style="font-size:11px;color:var(--dim);margin-top:8px">Full dossiers with sources: <code>docs/MODELS.md</code> ·
    re-run the batteries with <code>scripts/retrieval-bench.py</code> and <code>scripts/candidate-tts-battery.py</code></p>`;
}

function viewSay() {
  S.sayEngine = S.sayEngine || 'kokoro';
  const eng = S.sayEngine;
  const kok = (S.roster?.kokoro || []).map((v) => v.voice);
  const gem = (S.roster?.gemini || []).map((v) => v.voice);
  const el11 = (S.roster?.elevenlabs || []).map((v) => v.voice);
  const opt = (list, sel) => list.map((v) => `<option ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const ENGINE_META = {
    kokoro: { label: 'Kokoro — free local', cost: () => '$0.00', limit: null }, // chunks any length
    qwen3: { label: 'Qwen3 — free local (designed voice)', cost: () => '$0.00', limit: 1500 },
    elevenlabs: { label: 'ElevenLabs — premium', cost: (c) => `≈ $${(c * 0.00022).toFixed(2)}`, limit: 5000 },
    gemini: { label: 'Gemini — directed', cost: (c) => `≈ $${Math.max(0.001, c * 0.000012).toFixed(3)}`, limit: null }, // chunks any length
  };
  const voiceField =
    eng === 'kokoro' ? `<label class="mini">Voice <select id="say-voice">${opt(kok.length ? kok : ['bm_george', 'af_sarah', 'am_onyx'], 'bm_george')}</select></label>`
    : eng === 'elevenlabs' ? `<label class="mini">Voice <select id="say-voice">${opt(el11.length ? el11 : ['Battlerap Algorithm', 'George'], 'Battlerap Algorithm')}</select></label>`
    : eng === 'gemini' ? `<label class="mini">Voice <select id="say-voice">${opt(gem.length ? gem : ['Charon'], 'Charon')}</select></label>
        <input id="say-prompt" class="wide" style="min-width:260px" placeholder="optional director's note — who's speaking, accent, pace">`
    : `<input id="say-design" class="wide" style="min-width:300px" placeholder="describe the voice — age, gender, accent, texture">`;
  const speed = S.sayStats?.speed?.[eng];
  const hist = (S.sayStats?.history || []).slice(0, 12);
  const histRows = hist.map((h) => `
    <tr><td>${esc((h.ts || '').slice(5, 16).replace('T', ' '))}</td><td>${esc(h.engine)}</td>
    <td class="num">${h.chars}</td><td class="num">${h.ms ? (h.ms / 1000).toFixed(1) + 's' : '—'}</td>
    <td class="num">${h.audioSec ? h.audioSec + 's' : '—'}</td>
    <td style="color:var(--dim)">${esc(h.preview || '')}</td>
    <td>${h.media ? `<audio controls preload="none" src="${h.media}" style="width:130px;height:24px"></audio>` : ''}</td></tr>`).join('');
  return `
    <p class="crumb">Tool</p><h1>⚡ Quick Narrate</h1>
    <p class="sub">Drop text, pick any engine, get an mp3. Every run is logged below so the time estimates keep getting smarter.</p>
    <div class="field"><label>Text</label><textarea id="say-text" placeholder="Paste anything you want read aloud…" style="min-height:160px">${esc(S.sayText || '')}</textarea></div>
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
      <label class="mini">Engine <select id="say-engine">${['kokoro', 'qwen3', 'elevenlabs', 'gemini'].map((e) => `<option value="${e}" ${e === eng ? 'selected' : ''}>${ENGINE_META[e].label}</option>`).join('')}</select></label>
      ${voiceField}
      <button class="btn" id="say-go">🎙 Narrate</button>
      <span id="say-status" style="font-size:12.5px;color:var(--muted)"></span>
    </div>
    <div id="say-estimate" style="font-size:11.5px;color:var(--dim);margin-bottom:12px">${speed ? `this engine averages ${speed} chars/sec — estimate updates as you type` : 'no history for this engine yet — first run measures it'}</div>
    <div id="say-result"></div>
    ${hist.length ? `<p class="panel-h" style="margin-top:22px">History — length vs time (last ${hist.length})</p>
    <div class="card" style="padding:8px 12px;overflow-x:auto"><table class="say-hist">
      <tr><th>when</th><th>engine</th><th>chars</th><th>render</th><th>audio</th><th>text</th><th></th></tr>${histRows}</table></div>` : ''}`;
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
    if (S.tab === 'cast') {
      if (!S.roster) { try { S.roster = await api('/api/casting/roster'); } catch { /* offline */ } }
      if (!S.actors) { try { S.actors = (await api('/api/actors')).actors; } catch { S.actors = []; } }
    }
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

  $('#r-cancel', m)?.addEventListener('click', async () => {
    try { await api('/api/render/cancel', { method: 'POST' }); toast('Render cancelled — cached work kept'); }
    catch (e) { toast(e.message, true); }
  });

  // cost preflight follows the Scope dropdown (perChapter was computed and discarded)
  $('#r-scope', m)?.addEventListener('change', (e) => {
    const pf = S.book.preflight;
    const n = e.target.value;
    const src = n ? [pf.perChapter[+n - 1]].filter(Boolean) : pf.perChapter;
    const sum = (k) => src.reduce((a, c) => a + (c[k] || 0), 0);
    const chars = sum('heroChars');
    $('#pf-narr').textContent = `${sum('narration')} lines · $0`;
    $('#pf-dial').textContent = `${sum('dialogue')} lines · $0`;
    $('#pf-hero').textContent = `${sum('hero')} lines · ${chars} chars`;
    $('#pf-usd').innerHTML = `≈ $${(chars * 0.00022).toFixed(2)} <small>rest is your GPU</small>`;
  });

  m.querySelectorAll('[data-flags]').forEach((b) => b.addEventListener('click', () => {
    S.openFlags = S.openFlags === +b.dataset.flags ? null : +b.dataset.flags;
    render();
  }));

  // cast editing
  m.querySelectorAll('.actor').forEach((card) => {
    const eid = card.dataset.ent;
    const note = card.querySelector('[data-savenote]');
    const saved = () => { note.textContent = 'saved ✓'; setTimeout(() => (note.textContent = ''), 1800); };
    card.querySelector('[data-visual]')?.addEventListener('change', async (e) => {
      try { await api(`/api/books/${S.bookId}/entity/${eid}`, { method: 'PUT', body: { visual: e.target.value } }); saved(); } catch (err) { toast(err.message, true); }
    });
    // casting sheet — explicit fields beat inference; saving refreshes the suggestion
    card.querySelectorAll('[data-sheet]').forEach((inp) => inp.addEventListener('change', async () => {
      const body = {};
      card.querySelectorAll('[data-sheet]').forEach((i) => { body[i.dataset.sheet] = i.value; });
      try {
        await api(`/api/books/${S.bookId}/entity/${eid}`, { method: 'PUT', body });
        saved();
        await loadBook(S.bookId); render();
      } catch (err) { toast(err.message, true); }
    }));
    // per-character portrait: click + paste
    const pz = card.querySelector('[data-ent-portrait]');
    if (pz) {
      pz.addEventListener('click', () => { pz.classList.add('armed'); pz.focus(); toast(`paste an image for ${eid} (Ctrl+V)`); });
      pz.addEventListener('paste', async (ev) => {
        const item = [...(ev.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
        if (!item) { toast('no image in the clipboard', true); return; }
        ev.preventDefault();
        const blob = item.getAsFile();
        const dataUrl = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
        try {
          await api(`/api/books/${S.bookId}/entity/${eid}`, { method: 'PUT', body: { portraitDataUrl: dataUrl } });
          toast(`portrait saved for ${eid}`);
          await loadBook(S.bookId); render();
        } catch (e2) { toast(e2.message, true); }
      });
    }

    // role notes — this book only
    card.querySelector('[data-rolenote]')?.addEventListener('change', async (e) => {
      try { await api(`/api/books/${S.bookId}/entity/${eid}`, { method: 'PUT', body: { notes: e.target.value } }); saved(); }
      catch (err) { toast(err.message, true); }
    });
    // SCREEN TEST — the narrator matrix, in-app: same line through every
    // available engine, side by side, with a one-click "Cast this one"
    card.querySelector('[data-screentest]')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      const slot = card.querySelector('[data-st-results]');
      const keys = S.book.keys || {};
      const engines = ['kokoro', 'qwen3', 'elevenlabs', 'gemini']
        .filter((e) => S.book.book.voices[e]?.[eid] && keys[e] !== false);
      if (!engines.length) { toast('no engines configured for this role — Apply a suggestion first', true); return; }
      btn.disabled = true;
      slot.innerHTML = engines.map((e) => `<div class="st-row" data-st="${e}"><span class="st-eng">${e}</span><span class="st-slot">queued…</span></div>`).join('');
      for (const eng of engines) {
        const row = slot.querySelector(`[data-st="${eng}"] .st-slot`);
        row.textContent = 'rendering…';
        try {
          const r = await api('/api/audition', { method: 'POST', body: { book: S.bookId, entity: eid, engine: eng } });
          row.innerHTML = `<audio controls src="${r.media}" style="width:190px;vertical-align:middle"></audio>
            <button class="btn sm" data-cast-eng="${eng}">Cast this</button>
            <span style="font-size:10px;color:var(--dim)">${(r.ms / 1000).toFixed(1)}s</span>`;
          row.querySelector('[data-cast-eng]').addEventListener('click', async () => {
            try {
              await api(`/api/books/${S.bookId}/entity/${eid}`, { method: 'PUT', body: { engine: eng, locked: true } });
              toast(`${eid} cast on ${eng} — locked`);
              await loadBook(S.bookId); render();
            } catch (e2) { toast(e2.message, true); }
          });
        } catch (e2) { row.innerHTML = `<span style="color:var(--crit);font-size:11px">${esc(e2.message)}</span>`; }
      }
      btn.disabled = false;
    });

    // apply the computed casting recipe into the voice fields
    card.querySelector('[data-apply-suggest]')?.addEventListener('click', async () => {
      const sug = S.book.suggestions?.[eid];
      if (!sug) return;
      const body = { voices: {} };
      if (sug.recipe.engine === 'gemini') body.voices.gemini = { voice: sug.recipe.voice, prompt: sug.recipe.prompt };
      else body.voices.qwen3 = { design: sug.recipe.design };
      body.engine = sug.recipe.engine;
      try {
        await api(`/api/books/${S.bookId}/entity/${eid}`, { method: 'PUT', body });
        toast(`${eid}: cast on ${sug.recipe.engine} — audition it`);
        await loadBook(S.bookId); render();
      } catch (err) { toast(err.message, true); }
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
  $('#sc-play', m)?.addEventListener('click', () => playChapter(S.bookId, S.chapterN));
  m.querySelectorAll('[data-scriptmode]').forEach((b) => b.addEventListener('click', async () => {
    S.scriptMode = b.dataset.scriptmode;
    S.cueIdx = S.cueIdx ?? 0; S.cuePanel = null;
    render();
    if (S.scriptMode === 'cues') loadCue(S.cueIdx);
  }));
  m.querySelectorAll('[data-cueidx]').forEach((r) => r.addEventListener('click', () => {
    S.cueIdx = +r.dataset.cueidx; S.cuePanel = null; render(); loadCue(S.cueIdx);
  }));
  m.querySelectorAll('[data-cq]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.cq === 'null' ? null : b.dataset.cq;
    setCueApproval(v);
  }));
  m.querySelectorAll('[data-cq-swap]').forEach((b) => b.addEventListener('click', () => setCueApproval({ swap: b.dataset.cqSwap })));
  m.querySelectorAll('.sline').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.cue-pin') || ev.target.closest('.sline-play')) return;
      S.selLine = S.selLine === el.dataset.line ? null : el.dataset.line;
      S.cuePanel = null;
      render();
    });
    // ▶ on a line seeks the transport straight to it
    el.querySelector('.sline-play')?.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = el.dataset.line;
      if (!transport || transport.book !== S.bookId || transport.chapter !== S.chapterN) await playChapter(S.bookId, S.chapterN);
      const l = timingLines().find((x) => x.id === id);
      if (l) { transport.audio.currentTime = l.start; transport.audio.play(); }
      else toast('this chapter has no timing yet — render it first', true);
    });
  });
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

  // quick narrate — any engine, live estimate, persisted history
  $('#say-engine', m)?.addEventListener('change', (e) => { S.sayEngine = e.target.value; S.sayText = $('#say-text')?.value || ''; render(); });
  const SAY_LIMITS = { qwen3: 1500, elevenlabs: 5000 }; // chunked engines have no cap
  const sayEst = () => {
    const el = $('#say-estimate'); if (!el) return;
    const speed = S.sayStats?.speed?.[S.sayEngine];
    const chars = ($('#say-text')?.value || '').trim().length;
    const cap = SAY_LIMITS[S.sayEngine];
    const parts = [];
    if (cap) parts.push(chars > cap
      ? `⚠ ${chars}/${cap} chars — OVER this engine's per-request cap; kokoro & gemini chunk any length`
      : `${chars}/${cap} chars`);
    else if (chars) parts.push(`${chars} chars — no cap (this engine chunks long text automatically)`);
    if (speed && chars) parts.push(`~${Math.max(1, Math.round(chars / speed))}s estimated (${speed} chars/sec measured)`);
    else if (speed) parts.push(`engine averages ${speed} chars/sec`);
    el.innerHTML = parts.join(' · ');
    el.style.color = cap && chars > cap ? 'var(--warn)' : 'var(--dim)';
  };
  $('#say-text', m)?.addEventListener('input', sayEst);
  sayEst();
  $('#say-go', m)?.addEventListener('click', async () => {
    const text = $('#say-text').value.trim();
    if (!text) { toast('type or paste some text first', true); return; }
    const btn = $('#say-go'); const st = $('#say-status');
    btn.disabled = true; st.textContent = '⏱ rendering…';
    try {
      const r = await api('/api/say', {
        method: 'POST',
        body: {
          text, engine: S.sayEngine,
          voice: $('#say-voice')?.value, design: $('#say-design')?.value, prompt: $('#say-prompt')?.value,
        },
      });
      $('#say-result').innerHTML = `<audio controls autoplay src="${r.media}" style="width:100%;max-width:520px"></audio>
        <div style="font-size:12px;color:var(--muted);margin-top:6px">⏱ ${(r.ms / 1000).toFixed(1)}s render · 🔊 ${r.audioSec ?? '?'}s audio · ${r.chars} chars ·
        <a href="${r.media}" download style="color:var(--cy)">download mp3</a></div>`;
      st.textContent = `done in ${(r.ms / 1000).toFixed(1)}s`;
      S.sayText = text;
      try { S.sayStats = await api('/api/say/history'); } catch { /* keep old */ }
    } catch (e) { toast(e.message, true); st.textContent = 'failed'; }
    btn.disabled = false;
  });

  // models report card: sort, filter, expand
  m.querySelectorAll('[data-msort]').forEach((h) => h.addEventListener('click', () => {
    const key = h.dataset.msort;
    const cur = S.modelSort || { key: 'gradeRank', dir: -1 };
    S.modelSort = cur.key === key ? { key, dir: -cur.dir } : { key, dir: key === 'name' || key === 'kind' ? 1 : -1 };
    render();
  }));
  m.querySelectorAll('[data-mf-kind]').forEach((b) => b.addEventListener('click', () => {
    S.modelFilter = { ...(S.modelFilter || {}), kind: b.dataset.mfKind || null };
    render();
  }));
  $('#mf-q', m)?.addEventListener('input', (e) => {
    S.modelFilter = { ...(S.modelFilter || {}), q: e.target.value };
    clearTimeout(S._mfT); S._mfT = setTimeout(render, 250);
  });
  m.querySelectorAll('[data-mrow]').forEach((tr) => tr.addEventListener('click', () => {
    S.modelOpen = S.modelOpen === tr.dataset.mrow ? null : tr.dataset.mrow;
    render();
  }));

  // casting room tabs + attribute filters
  m.querySelectorAll('[data-casttab]').forEach((b) => b.addEventListener('click', () => { S.castTab = b.dataset.casttab; S.castFilter = {}; render(); }));
  const setFilter = (k, v) => { S.castFilter = { ...(S.castFilter || {}), [k]: v }; render(); };
  $('#cf-q', m)?.addEventListener('input', (e) => { S.castFilter = { ...(S.castFilter || {}), q: e.target.value }; clearTimeout(S._cfT); S._cfT = setTimeout(render, 250); });
  $('#cf-gender', m)?.addEventListener('change', (e) => setFilter('gender', e.target.value));
  $('#cf-age', m)?.addEventListener('change', (e) => setFilter('age', e.target.value));
  $('#cf-accent', m)?.addEventListener('change', (e) => setFilter('accent', e.target.value));

  // actor notes — global craft knowledge, saved to actors/<name>/notes.md
  m.querySelectorAll('[data-actornote]').forEach((ta) => {
    const card = ta.closest('[data-actor]');
    ta.addEventListener('change', async () => {
      try {
        await api(`/api/actors/${card.dataset.actor}/notes`, { method: 'POST', body: { notes: ta.value } });
        const n = card.querySelector('[data-savenote]');
        if (n) { n.textContent = 'saved ✓ — applies to every book'; setTimeout(() => (n.textContent = ''), 2200); }
        S.actors = (await api('/api/actors')).actors;
      } catch (e) { toast(e.message, true); }
    });
  });

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

  // ---- Voice Designer: describe -> slate -> audition -> hire ----
  const vdForm = () => ({
    name: $('#vd-name', m)?.value.trim() || '',
    description: $('#vd-desc', m)?.value.trim() || '',
    gender: $('#vd-gender', m)?.value || '',
    age: $('#vd-age', m)?.value.trim() || '',
    accent: $('#vd-acc', m)?.value.trim() || '',
  });
  $('#vd-find', m)?.addEventListener('click', async () => {
    const btn = $('#vd-find', m);
    const f = vdForm();
    if (!f.description && !f.gender && !f.accent) return toast('describe them first — even one line helps', true);
    S.design = { form: f, slate: null, takes: {} };
    btn.disabled = true; btn.textContent = 'Working it out…';
    try {
      // the server infers gender/age/accent, then picks the best voice per engine
      S.design.slate = await api('/api/casting/design', {
        method: 'POST',
        body: { visual: f.description, gender: f.gender || undefined, age: f.age || undefined, ethnicity: f.accent || undefined, id: f.name || 'character' },
      });
      render();
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Find candidates →'; }
  });

  const auditionCand = async (i, btn) => {
    const d = S.design; const c = d.slate.candidates[i];
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      const r = await api('/api/casting/audition', {
        method: 'POST',
        body: { engine: c.engine, voice: c.voice, params: c.params, line: d.slate.line },
      });
      d.takes[i] = r;
      return r;
    } catch (e) {
      toast(`${c.engine}: ${e.message}`, true);
      if (btn) { btn.disabled = false; btn.textContent = '▶ audition'; }
      return null;
    }
  };
  m.querySelectorAll('[data-vd-play]').forEach((btn) => btn.addEventListener('click', async () => {
    await auditionCand(+btn.dataset.vdPlay, btn); render();
  }));
  $('#vd-all', m)?.addEventListener('click', async () => {
    const btn = $('#vd-all', m);
    btn.disabled = true;
    const cands = S.design.slate.candidates;
    // network engines run together; qwen3 is local GPU, so it goes last, alone
    const net = cands.map((c, i) => [c, i]).filter(([c]) => c.engine !== 'qwen3');
    const gpu = cands.map((c, i) => [c, i]).filter(([c]) => c.engine === 'qwen3');
    btn.textContent = `auditioning ${net.length}…`;
    await Promise.all(net.map(([, i]) => auditionCand(i)));
    render();
    for (const [, i] of gpu) {
      const b2 = $('#vd-all', m);
      if (b2) { b2.disabled = true; b2.textContent = 'designing the local voice (~1 min)…'; }
      await auditionCand(i);
      render();
    }
  });
  m.querySelectorAll('[data-vd-hire]').forEach((btn) => btn.addEventListener('click', async () => {
    const i = +btn.dataset.vdHire;
    const d = S.design; const c = d.slate.candidates[i]; const take = d.takes[i];
    const name = d.form.name || prompt('Name this actor:');
    if (!name) return;
    btn.disabled = true; btn.textContent = 'Hiring…';
    try {
      const r = await api('/api/casting/hire', {
        method: 'POST',
        body: { name, engine: c.engine, voice: c.voice, params: c.params, media: take.media, character: d.form.description },
      });
      S.actors = (await api('/api/actors')).actors;
      S.castTab = 'company'; S.design = null;
      toast(`${r.name} joined the company — their seed clip is saved, they can be re-hired free forever`);
      render();
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Hire →'; }
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
      if (r.analyzeError) toast(`Created ${r.id} — but the analyzer failed (${r.analyzeError}). The book is saved; cast it by hand.`, true);
      else toast(`Created ${r.id} (${r.chapters} chapter(s)${r.analyzed ? ', analyzed' : ''})`);
      await go('book', r.id, 'cast');
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Create book'; }
  });
}

// ── boot ────────────────────────────────────────────────────────────────────
go('shelf');
