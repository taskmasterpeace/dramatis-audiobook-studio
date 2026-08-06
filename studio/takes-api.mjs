// HTTP surface for surgical line regeneration — mounted by the Studio server
// (and mountable by the hub later: handlers here know nothing about either).
// Directors Desktop is the caller: see directors-desktop
// docs/plans/2026-08-06-production-pipeline-manifest-takes.md.
import path from 'node:path';
import { loadTakes, renderLineTake, selectTake } from '../src/takes.mjs';

const ERR_CODES = { STALE: 409, NOT_PRODUCED: 409 };

/** Returns true when the request was handled. `deps` = { root, json,
 *  readBody, isBusy } from the mounting server — isBusy guards the GPU: a
 *  chapter render child and an in-process qwen3 take would contend for the
 *  same 24 GB card. */
export async function handleTakesRoute(req, res, p, deps) {
  const { root, json, readBody, isBusy } = deps;

  const list = p.match(/^\/api\/takes\/([a-z0-9-]+)\/(\d+)$/);
  if (req.method === 'GET' && list) {
    json(res, 200, loadTakes(path.join(root, 'out'), list[1], Number(list[2])));
    return true;
  }

  if (req.method === 'POST' && p === '/api/takes/render') {
    if (isBusy?.()) {
      json(res, 409, { error: 'a chapter render is in progress — takes share the same GPU, try again when it finishes' });
      return true;
    }
    let body;
    try { body = await readBody(req); } catch (e) { json(res, 400, { error: String(e.message || e) }); return true; }
    const { book, chapter, line, note, engine } = body || {};
    if (!book || !chapter || !line) { json(res, 400, { error: 'book, chapter and line are required' }); return true; }
    try {
      const record = await renderLineTake({ root, bookId: String(book), chapter, lineId: String(line), note, engine });
      json(res, 200, { status: 'ok', record });
    } catch (e) {
      json(res, ERR_CODES[e.code] || 400, { error: String(e.message || e), code: e.code || null });
    }
    return true;
  }

  if (req.method === 'POST' && p === '/api/takes/select') {
    let body;
    try { body = await readBody(req); } catch (e) { json(res, 400, { error: String(e.message || e) }); return true; }
    const { book, chapter, line, key } = body || {};
    if (!book || !chapter || !line) { json(res, 400, { error: 'book, chapter and line are required' }); return true; }
    try {
      json(res, 200, { status: 'ok', ...selectTake({ root, bookId: String(book), chapter, lineId: String(line), key: key ?? null }) });
    } catch (e) {
      json(res, 400, { error: String(e.message || e) });
    }
    return true;
  }

  return false;
}
