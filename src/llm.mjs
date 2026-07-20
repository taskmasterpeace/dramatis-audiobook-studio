// Provider-agnostic LLM client for the analyzer.
// Default: local Ollama (free, offline). Fallback: OpenRouter (per-response
// usage.cost). Every call is content-addressed — identical prompt+schema hits
// the cache and never re-spends — and logged one JSONL row per call to
// out/<book>/llm-ledger.jsonl: who we called, for what purpose, and the cost.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { contentKey, log } from './util.mjs';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export const PROVIDERS = {
  ollama: { model: process.env.DRAMATIS_OLLAMA_MODEL || 'qwen3:14b' },
  openrouter: { model: process.env.DRAMATIS_OPENROUTER_MODEL || 'google/gemini-2.5-flash-lite' },
};

// POST JSON with a long socket timeout — local models under GPU contention can
// take minutes before the first byte (undici's 300 s headers timeout killed us).
export function postJson(urlString, headers, body, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('timeout', () => req.destroy(new Error(`request timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function parseJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(cleaned);
}

async function callOllama(model, system, prompt, schema) {
  const res = await postJson(`${OLLAMA_URL}/api/chat`, {}, {
    model, stream: false,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    format: schema,
    options: { temperature: 0.2, num_ctx: 32768 },
  });
  if (res.status !== 200) throw new Error(`ollama ${res.status}: ${res.text.slice(0, 200)}`);
  const d = JSON.parse(res.text);
  return {
    content: d.message?.content ?? '',
    tokensIn: d.prompt_eval_count ?? null,
    tokensOut: d.eval_count ?? null,
    costUsd: null, // local: free
  };
}

async function callOpenRouter(model, system, prompt, schema) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');
  const res = await postJson(OPENROUTER_URL, { authorization: `Bearer ${key}` }, {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    response_format: { type: 'json_schema', json_schema: { name: 'dramatis', strict: true, schema } },
    usage: { include: true },
  });
  if (res.status !== 200) throw new Error(`openrouter ${res.status}: ${res.text.slice(0, 200)}`);
  const d = JSON.parse(res.text);
  return {
    content: d.choices?.[0]?.message?.content ?? '',
    tokensIn: d.usage?.prompt_tokens ?? null,
    tokensOut: d.usage?.completion_tokens ?? null,
    costUsd: d.usage?.cost ?? null,
  };
}

// One analyzed call: cache-first, ledger-always.
// scope: { book, chapter? }. Returns { data, cached }.
export async function analyze({ cacheRoot, scope, purpose, schema, system, prompt, provider }) {
  provider = provider || process.env.DRAMATIS_LLM || 'ollama';
  const model = PROVIDERS[provider]?.model;
  if (!model) throw new Error(`unknown llm provider: ${provider}`);

  const key = contentKey(['llm@1', provider, model, purpose, JSON.stringify(schema), prompt]);
  const cacheDir = path.join(cacheRoot, 'cache', 'llm');
  const cacheFile = path.join(cacheDir, `${key}.json`);
  if (existsSync(cacheFile)) {
    log('llm', `${purpose} [cache hit] ${provider}/${model}`);
    return { data: JSON.parse(readFileSync(cacheFile, 'utf8')).response, cached: true };
  }

  const t0 = Date.now();
  const call = provider === 'ollama' ? callOllama : callOpenRouter;
  let r = await call(model, system, prompt, schema);
  let status = 'ok';
  let data;
  try {
    data = parseJson(r.content);
  } catch {
    status = 'json-repair';
    r = await call(model, system,
      `${prompt}\n\n---\nYour previous reply was not valid JSON. Return ONLY valid JSON matching the schema.`, schema);
    data = parseJson(r.content); // throws -> caller sees failure
  }

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify({ response: data }));
  const ledgerFile = path.join(cacheRoot, scope.book, 'llm-ledger.jsonl');
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  appendFileSync(ledgerFile, JSON.stringify({
    ts: new Date().toISOString(), provider, model, purpose, scope,
    cache_key: `sha1:${key}`,
    tokens_in: r.tokensIn, tokens_out: r.tokensOut, cost_usd: r.costUsd,
    latency_ms: Date.now() - t0, status,
  }) + '\n');
  log('llm', `${purpose} ${provider}/${model} ${r.tokensIn ?? '?'}->${r.tokensOut ?? '?'} tok` +
    `${r.costUsd != null ? ` $${r.costUsd.toFixed(4)}` : ''} [${status}]`);
  return { data, cached: false };
}
