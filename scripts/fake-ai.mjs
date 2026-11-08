// A stand-in for the official AI provider HTTP APIs (W12–W14 tests only; no real calls, no cost).
// One server answers the Anthropic, OpenAI (+ compatible) and Gemini paths the adapters use.
// Tests queue scripted replies per route (status, headers, body, delay) and read back every
// request (headers + body) to check keys, payloads and that no session data leaks out.
import http from 'node:http';

const ROUTES = [
  ['POST', /^\/v1\/messages$/, 'anthropic.messages'],
  ['GET', /^\/v1\/models$/, 'models'],
  ['POST', /^\/v1\/chat\/completions$/, 'openai.chat'],
  ['POST', /^\/v1\/audio\/transcriptions$/, 'openai.transcribe'],
  ['POST', /^\/v1beta\/models\/[^/]+:generateContent$/, 'gemini.generate'],
  ['GET', /^\/v1beta\/models$/, 'gemini.models'],
];

export async function startFakeAi() {
  const queues = new Map();
  const state = {
    requests: [],
    /** Default JSON the "model" answers for planner calls. */
    planJson: { operations: [{ op: 'add_clip', track_kind: 'text', text: 'Hook dari AI', start_ms: 0, duration_ms: 2000 }], rationale: 'Hook pendek di awal', warnings: [] },
    usage: { input: 1200, output: 300 },
    words: [
      { word: 'Halo', start: 0.2, end: 0.6 },
      { word: 'semua,', start: 0.6, end: 1.1 },
      { word: 'ini', start: 1.4, end: 1.6 },
      { word: 'promo', start: 1.6, end: 2.0 },
      { word: 'spesial.', start: 2.0, end: 2.6 },
    ],
    duration: 8,
  };

  const reply = (key, res) => {
    const text = JSON.stringify(state.planJson);
    switch (key) {
      case 'anthropic.messages':
        return { status: 200, headers: { 'request-id': `req_a${state.requests.length}` }, body: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: state.usage.input, output_tokens: state.usage.output } } };
      case 'models':
        return { status: 200, body: { data: [{ id: 'claude-opus-5-5' }, { id: 'gpt-test' }, { id: 'whisper-1' }] } };
      case 'openai.chat':
        return { status: 200, headers: { 'x-request-id': `req_o${state.requests.length}` }, body: { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: state.usage.input, completion_tokens: state.usage.output } } };
      case 'openai.transcribe':
        return { status: 200, headers: { 'x-request-id': `req_t${state.requests.length}` }, body: { text: state.words.map((w) => w.word).join(' '), language: 'indonesian', duration: state.duration, words: state.words } };
      case 'gemini.generate':
        return { status: 200, body: { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: state.usage.input, candidatesTokenCount: state.usage.output } } };
      case 'gemini.models':
        return { status: 200, body: { models: [{ name: 'models/gemini-test' }] } };
      default:
        void res;
        return { status: 404, body: {} };
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const hit = ROUTES.find(([m, re]) => m === req.method && re.test(url.pathname));
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const key = hit ? hit[2] : 'unknown';
    const ct = String(req.headers['content-type'] ?? '');
    state.requests.push({ key, path: url.pathname, headers: { ...req.headers }, body: ct.includes('json') ? JSON.parse(raw.toString('utf8') || 'null') : ct.includes('multipart') ? raw.toString('latin1') : null, size: raw.length });
    const q = queues.get(key);
    const r = q?.length ? q.shift() : reply(key, res);
    if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
    if (r.hang) return; // never answers (timeout test)
    res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {}));
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    /** Queue scripted replies for one route key; when the queue is empty the default answer is used. */
    queue: (key, ...replies) => queues.set(key, [...(queues.get(key) ?? []), ...replies]),
    count: (key) => state.requests.filter((r) => r.key === key).length,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections?.();
        server.close(() => ok());
      }),
  };
}
