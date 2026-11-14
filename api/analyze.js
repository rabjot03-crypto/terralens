// TerraLens — serverless analysis endpoint (Vercel: /api/analyze)
// The API key is read ONLY from server-side environment variables and is never
// sent to the browser. Works with an xAI Grok key ("xai-...") or a Groq key ("gsk_...").

const PROVIDERS = {
  xai: {
    name: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4.20-0309-non-reasoning', 'grok-4', 'grok-2-vision-1212'],
    textModels: ['grok-4.20-0309-non-reasoning', 'grok-4'],
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['qwen/qwen3.8-27b', 'meta-models/muse-spark-open', 'qwen/qwen3.6-27b', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    textModels: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'meta-models/muse-spark-open', 'qwen/qwen3.6-27b'],
  },
};

const MAX_IMAGE_CHARS = 4_200_000; // ~3 MB binary; frontend resizes well below this
const UPSTREAM_TIMEOUT_MS = 55_000;

// Best-effort per-instance rate limit (protects your API credits from abuse)
const hits = new Map();
function rateLimited(ip, max = 8) {
  const now = Date.now();
  const windowMs = 60_000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}

function resolveProvider() {
  const key = (process.env.XAI_API_KEY || process.env.GROQ_API_KEY || '').trim();
  if (!key) return null;
  let id = (process.env.AI_PROVIDER || '').toLowerCase();
  if (!PROVIDERS[id]) id = key.startsWith('gsk_') ? 'groq' : 'xai';
  const p = PROVIDERS[id];
  const models = process.env.AI_MODEL ? [process.env.AI_MODEL, ...p.models] : p.models;
  return { id, key, name: p.name, baseUrl: process.env.AI_BASE_URL || p.baseUrl, models: [...new Set(models)], textModels: [...new Set([...(process.env.AI_TEXT_MODEL ? [process.env.AI_TEXT_MODEL] : []), ...p.textModels])] };
}

const SYSTEM_PROMPT = `You are TerraLens, an urban climate-resilience analyst who inspects photographs (street views, aerial or satellite images, parking lots, parks, neighbourhoods).
Identify VISIBLE environmental vulnerabilities and improvement opportunities in four categories:
- "heat": urban heat island factors (asphalt, concrete, dark roofs, little tree canopy, exposed pavement) and cooling opportunities.
- "stormwater": large impermeable surfaces, places where water could plausibly collect given visible slopes/low points/curbs, visible drainage concerns, opportunities for bioswales, rain gardens, permeable paving.
- "green": missing or disconnected vegetation, tree-planting spots, green corridors, green roof candidates, biodiversity opportunities.
- "infrastructure": roads/structures plausibly stressed by heat or water, excessive paved coverage, redesign opportunities.

STRICT HONESTY RULES
- Describe only what is actually in this image. Never invent objects. If the image is not an outdoor/urban/landscape scene, return an empty findings array and explain in overall_assessment.
- Mark each finding "observation_basis": "visible" (directly seen) or "inferred" (a reasonable inference from visible evidence).
- Never claim exact flood probabilities, temperatures, soil types, underground drainage conditions or numeric impact estimates. Describe benefits qualitatively.
- Only recommend an intervention where the image shows plausible space/suitability; list what must be verified in "requires_verification".
- Confidence (0-100) must be calibrated: lower it for small, blurry, ambiguous or inferred features.

COORDINATES: all coordinates are normalized to the image: x from 0 (left edge) to 1 (right edge), y from 0 (top edge) to 1 (bottom edge).
- "region": the bounding box of the area the finding refers to {x, y, w, h} where (x, y) is the TOP-LEFT corner. Make boxes tight around the actual feature.
- "point": the single most representative point inside that region.
Look carefully at where each feature really is before giving coordinates.

Return 4 to 6 findings (fewer if the image genuinely shows less). Keep every text field short: 1-2 sentences, and at most 3 short items per list. Include at least one "opportunity" finding when one is visible.
"type" is "concern" for a problem or "opportunity" for a place where an improvement could be made.

Respond with ONLY a JSON object, no markdown, matching exactly:
{
 "scene_type": "short label e.g. 'Aerial view of a retail parking lot'",
 "scene_description": "2-3 sentences describing what the image shows",
 "overall_assessment": "3-5 sentences: what was observed, why it matters for climate resilience, what actions would help most",
 "resilience_rating": "Low" | "Moderate" | "Good",
 "surface_profile": {"impervious_cover": "High"|"Moderate"|"Low", "vegetation_cover": "High"|"Moderate"|"Low", "tree_canopy": "High"|"Moderate"|"Low"},
 "findings": [
  {
   "title": "short problem title (max 7 words)",
   "short_label": "2-4 word label for the map",
   "category": "heat"|"stormwater"|"green"|"infrastructure",
   "type": "concern"|"opportunity",
   "severity": "high"|"medium"|"low",
   "confidence": 0-100,
   "observation_basis": "visible"|"inferred",
   "location_description": "where in the image, e.g. 'lower-left quadrant, the open asphalt between the two rows of cars'",
   "region": {"x":0-1,"y":0-1,"w":0-1,"h":0-1},
   "point": {"x":0-1,"y":0-1},
   "what_identified": "clear explanation of the issue",
   "visual_evidence": ["specific thing seen", "..."],
   "why_it_matters": "impact on urban climate resilience",
   "environmental_implications": "consequences if unaddressed",
   "recommendation": {
     "title": "specific intervention",
     "description": "what to do and where, tied to this location",
     "how_it_works": "plain-language explanation",
     "benefits": ["qualitative benefit", "..."],
     "difficulty": "low"|"medium"|"high",
     "priority": "immediate"|"short-term"|"long-term",
     "priority_reason": "why this urgency",
     "requires_verification": ["e.g. soil infiltration testing", "..."]
   }
  }
 ],
 "key_recommendations": ["top 3 actions in priority order"],
 "key_areas": ["areas of the image needing most attention"],
 "conclusion": "2-4 sentences on how the improvements could strengthen climate resilience",
 "limitations": ["what this image-only analysis cannot verify", "..."]
}`;

// ---------- response parsing & validation ----------
function extractJson(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty model response');
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const start = t.indexOf('{'), end = t.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in model response');
  let slice = t.slice(start, end + 1);
  try { return JSON.parse(slice); } catch (_) { /* try light repair */ }
  slice = slice.replace(/,\s*([}\]])/g, '$1'); // trailing commas
  return JSON.parse(slice);
}

const clamp01 = (n, d = 0.5) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return d;
  const scaled = v > 1 && v <= 100 ? v / 100 : v; // tolerate 0-100 coordinates
  return Math.min(1, Math.max(0, scaled));
};
const oneOf = (v, list, d) => {
  const s = String(v || '').toLowerCase().trim();
  return list.includes(s) ? s : d;
};
const str = (v, d = '') => (typeof v === 'string' ? v.trim() : v == null ? d : String(v)).slice(0, 1500);
const arr = (v) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean).slice(0, 10) : typeof v === 'string' && v ? [v] : []);
const titleCase = (v, list, d) => {
  const s = String(v || '').trim().toLowerCase();
  const hit = list.find((x) => x.toLowerCase() === s);
  return hit || d;
};

function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Model returned a non-object');
  const findingsIn = Array.isArray(raw.findings) ? raw.findings : [];
  const findings = [];
  for (const f of findingsIn.slice(0, 12)) {
    if (!f || typeof f !== 'object' || !f.title) continue;
    const r = f.region || f.bbox || {};
    let x = clamp01(r.x ?? r.left, 0.4), y = clamp01(r.y ?? r.top, 0.4);
    let w = clamp01(r.w ?? r.width, 0.2), h = clamp01(r.h ?? r.height, 0.2);
    // Support {x1,y1,x2,y2}
    if (r.x2 != null && r.y2 != null) {
      x = clamp01(r.x1 ?? r.x); y = clamp01(r.y1 ?? r.y);
      w = Math.abs(clamp01(r.x2) - x); h = Math.abs(clamp01(r.y2) - y);
    }
    w = Math.max(0.03, Math.min(w, 1 - x)); h = Math.max(0.03, Math.min(h, 1 - y));
    if (x > 0.97) x = 0.97 - w; if (y > 0.97) y = 0.97 - h;
    const p = f.point || f.marker || {};
    let px = clamp01(p.x, x + w / 2), py = clamp01(p.y, y + h / 2);
    if (px < x || px > x + w || py < y || py > y + h) { px = x + w / 2; py = y + h / 2; }
    const rec = f.recommendation && typeof f.recommendation === 'object' ? f.recommendation : {};
    let conf = Number(f.confidence);
    if (Number.isFinite(conf) && conf <= 1) conf *= 100;
    findings.push({
      id: findings.length + 1,
      title: str(f.title).slice(0, 90),
      short_label: str(f.short_label || f.title).slice(0, 32),
      category: oneOf(f.category, ['heat', 'stormwater', 'green', 'infrastructure'], 'infrastructure'),
      type: oneOf(f.type, ['concern', 'opportunity'], 'concern'),
      severity: oneOf(f.severity, ['high', 'medium', 'low'], 'medium'),
      confidence: Math.round(Math.min(100, Math.max(5, Number.isFinite(conf) ? conf : 60))),
      observation_basis: oneOf(f.observation_basis, ['visible', 'inferred'], 'inferred'),
      location_description: str(f.location_description, 'See marked region'),
      region: { x: +x.toFixed(4), y: +y.toFixed(4), w: +w.toFixed(4), h: +h.toFixed(4) },
      point: { x: +px.toFixed(4), y: +py.toFixed(4) },
      what_identified: str(f.what_identified),
      visual_evidence: arr(f.visual_evidence),
      why_it_matters: str(f.why_it_matters),
      environmental_implications: str(f.environmental_implications),
      recommendation: {
        title: str(rec.title, 'Further assessment recommended'),
        description: str(rec.description),
        how_it_works: str(rec.how_it_works),
        benefits: arr(rec.benefits),
        difficulty: oneOf(rec.difficulty, ['low', 'medium', 'high'], 'medium'),
        priority: oneOf(rec.priority, ['immediate', 'short-term', 'long-term'], 'short-term'),
        priority_reason: str(rec.priority_reason),
        requires_verification: arr(rec.requires_verification),
      },
    });
  }
  const sp = raw.surface_profile || {};
  const lvl = ['High', 'Moderate', 'Low'];
  return {
    scene_type: str(raw.scene_type, 'Urban scene'),
    scene_description: str(raw.scene_description),
    overall_assessment: str(raw.overall_assessment),
    resilience_rating: titleCase(raw.resilience_rating, ['Low', 'Moderate', 'Good'], 'Moderate'),
    surface_profile: {
      impervious_cover: titleCase(sp.impervious_cover, lvl, 'Moderate'),
      vegetation_cover: titleCase(sp.vegetation_cover, lvl, 'Moderate'),
      tree_canopy: titleCase(sp.tree_canopy, lvl, 'Moderate'),
    },
    findings,
    key_recommendations: arr(raw.key_recommendations),
    key_areas: arr(raw.key_areas),
    conclusion: str(raw.conclusion),
    limitations: arr(raw.limitations),
  };
}

// ---------- upstream call ----------
class UpstreamError extends Error {
  constructor(status, message, kind, raw) { super(message); this.status = status; this.kind = kind; this.raw = raw || ''; }
}

async function callModel(provider, model, imageDataUrl, { jsonMode, strictRetry, maxTokens }) {
  const userText = strictRetry
    ? 'Analyze this image. Your previous answer was not valid JSON. Reply with ONLY the JSON object described in the system prompt.'
    : 'Analyze this image for urban climate resilience and return the JSON object.';
  return chatOnce(provider, model, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: [
      { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
      { type: 'text', text: userText },
    ] },
  ], { jsonMode, maxTokens, temperature: 0.2 });
}

// One chat-completions call (shared by analysis, Ask and Financial analysis)
async function chatOnce(provider, model, messages, { jsonMode, maxTokens, temperature = 0.2 }) {
  const body = { model, temperature, max_tokens: maxTokens, messages };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (/^openai\/gpt-oss/.test(model)) body.reasoning_effort = 'low';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new UpstreamError(504, e.name === 'AbortError' ? 'The AI service took too long to respond. Please try again.' : 'Could not reach the AI service.', 'network');
  } finally { clearTimeout(timer); }

  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* non-JSON error page */ }
  if (!resp.ok) {
    const msg = (data && (data.error?.message || data.error || data.message)) || text.slice(0, 300) || `HTTP ${resp.status}`;
    const m = String(msg).toLowerCase();
    if (resp.status === 401 || resp.status === 403) throw new UpstreamError(502, 'The AI provider rejected the API key. Check the XAI_API_KEY environment variable.', 'auth');
    if (resp.status === 429 || /tokens per minute|rate.?limit|request too large/.test(m)) throw new UpstreamError(429, 'The AI provider rate limit was reached. Please wait a minute and try again.', 'rate', String(msg));
    if (/response_format|json_object|json mode/.test(m)) throw new UpstreamError(400, msg, 'jsonmode');
    if (resp.status === 404 || /model.*(not found|does not exist|decommission|not available|deprecat|access)|(not|doesn.t) support.*image|image.*not supported|vision/.test(m)) throw new UpstreamError(400, msg, 'model');
    if (resp.status === 413 || /too large|payload/.test(m)) throw new UpstreamError(413, 'The image is too large for the AI service. Try a smaller image.', 'size');
    throw new UpstreamError(502, `AI service error: ${String(msg).slice(0, 200)}`, 'other');
  }
  const content = data?.choices?.[0]?.message?.content;
  const contentText = Array.isArray(content) ? content.map((c) => c.text || '').join('') : content;
  return { content: contentText, usage: data?.usage || null };
}

async function analyzeImage(provider, imageDataUrl) {
  let lastErr;
  for (const model of provider.models) {
    let jsonMode = true, maxTokens = provider.id === 'groq' ? 3000 : 6000, parseFails = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { content, usage } = await callModel(provider, model, imageDataUrl, { jsonMode, strictRetry: parseFails > 0, maxTokens });
        const parsed = extractJson(content);
        const analysis = normalizeAnalysis(parsed);
        return { analysis, model, usage };
      } catch (e) {
        lastErr = e;
        if (e instanceof UpstreamError) {
          if (e.kind === 'jsonmode' && jsonMode) { jsonMode = false; continue; }
          if (e.kind === 'rate') {
            // Free-tier "request too large for tokens-per-minute": shrink the answer budget to fit and retry.
            const mm = e.raw.match(/Limit:?\s*(\d+)[^\d]+Requested:?\s*(\d+)/i);
            if (mm) { const fit = maxTokens - (Number(mm[2]) - Number(mm[1])) - 150; if (fit >= 1200 && fit < maxTokens) { maxTokens = fit; continue; } }
            break; // genuinely busy: try the next model (separate limits)
          }
          if (e.kind === 'model') break; // try next model
          throw e; // auth, size, network: stop
        }
        // malformed/truncated JSON → retry once with a stricter instruction
        if (++parseFails >= 2) break;
      }
    }
  }
  if (lastErr instanceof UpstreamError && lastErr.kind === 'rate') throw new UpstreamError(429, `The AI provider's rate limit was reached. Wait a minute and try again. (Provider message: ${lastErr.raw.slice(0, 220)})`, 'rate');
  if (lastErr instanceof UpstreamError && lastErr.kind !== 'model') throw lastErr;
  if (lastErr instanceof UpstreamError) throw new UpstreamError(502, `No configured vision model is available for this key (${lastErr.message.slice(0, 160)}). Set AI_MODEL to a current vision model ID.`, 'model');
  throw new UpstreamError(502, 'The AI returned a response that could not be read as structured findings. Please try again.', 'parse');
}


// ---------- generic call with model fallback (Ask + Financial) ----------
async function chatWithFallback(provider, models, messages, { json = false, maxTokens = 800, parse }) {
  let lastErr;
  for (const model of models) {
    let jsonMode = json, budget = maxTokens, parseFails = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { content, usage } = await chatOnce(provider, model, messages, { jsonMode, maxTokens: budget, temperature: 0.3 });
        const text = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        if (!text) throw new Error('Empty model response');
        return { result: parse ? parse(text) : text, model, usage };
      } catch (e) {
        lastErr = e;
        if (e instanceof UpstreamError) {
          if (e.kind === 'jsonmode' && jsonMode) { jsonMode = false; continue; }
          if (e.kind === 'rate') {
            const mm = e.raw.match(/Limit:?\s*(\d+)[^\d]+Requested:?\s*(\d+)/i);
            if (mm) { const fit = budget - (Number(mm[2]) - Number(mm[1])) - 150; if (fit >= 400 && fit < budget) { budget = fit; continue; } }
            break;
          }
          if (e.kind === 'model') break;
          throw e;
        }
        if (++parseFails >= 2) break;
      }
    }
  }
  if (lastErr instanceof UpstreamError && lastErr.kind === 'rate') throw new UpstreamError(429, `The AI provider's rate limit was reached. Wait a minute and try again. (Provider message: ${lastErr.raw.slice(0, 220)})`, 'rate');
  if (lastErr instanceof UpstreamError) throw lastErr;
  throw new UpstreamError(502, 'The AI returned a response that could not be read. Please try again.', 'parse');
}

// ---------- Click to ask ----------
const ASK_PROMPT = `You are TerraLens, an urban climate-resilience assistant. The user is looking at the attached image and asks a question about it.
Rules:
- Answer from what is actually visible in this image, plus general climate-resilience knowledge clearly marked as general.
- If the image cannot answer the question (temperatures, flood frequency, soil, underground pipes, costs, ownership...), say so plainly and name the data that would answer it.
- If a point is given, it is a normalized image position (x from 0 left to 1 right, y from 0 top to 1 bottom); focus on what is at that spot.
- Refer to existing findings by their number (#1, #2...) when relevant.
- Be concise: at most 150 words, plain text, short paragraphs or a short list. No markdown headings.`;

async function askImage(provider, imageDataUrl, { question, point, context, history }) {
  const ctx = [];
  if (context) ctx.push(`Existing TerraLens findings for this image:\n${context}`);
  if (point) ctx.push(`The user clicked the point x=${point.x.toFixed(2)}, y=${point.y.toFixed(2)} (about ${Math.round(point.x * 100)}% from the left and ${Math.round(point.y * 100)}% from the top).`);
  const messages = [{ role: 'system', content: ASK_PROMPT }];
  messages.push({ role: 'user', content: [
    { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
    { type: 'text', text: (ctx.join('\n\n') || 'Here is the image.') },
  ] });
  messages.push({ role: 'assistant', content: 'Understood. What would you like to know about this image?' });
  for (const h of history) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content: question });
  const { result, model } = await chatWithFallback(provider, provider.models, messages, { maxTokens: 700 });
  return { answer: result.slice(0, 2500), model };
}

// ---------- Financial analysis ----------
const FIN_PROMPT = `You are a municipal green-infrastructure cost estimator. You receive interventions recommended from ONE photograph (no site survey).
For each intervention give an INDICATIVE, order-of-magnitude capital cost range for the whole intervention at the described location, using typical published North American unit costs, converted to the requested currency.
Honesty rules:
- Quantities are guesses from a photo: state the quantity and unit-cost assumption in "basis" (e.g. "about 12 trees x $800-$1,500 installed").
- Use wide, realistic ranges. Never claim precision. Do not invent numeric savings, payback periods or ROI; describe financial benefits qualitatively.
- "confidence" is "low" or "medium" (never "high": no site data).
Respond with ONLY JSON:
{"currency":"CAD","summary":"2-3 sentences","items":[{"id":1,"cost_tier":"Low"|"Medium"|"High","low":number,"high":number,"basis":"quantity x unit cost assumption","cost_drivers":["..."],"maintenance":"ongoing upkeep in one sentence","financial_benefits":["qualitative"],"funding_options":["types of programs/grants that commonly fund this"],"confidence":"low"|"medium"}],"caveats":["..."]}`;

function normalizeFinancial(raw, ids, currency) {
  if (!raw || typeof raw !== 'object') throw new Error('bad financial JSON');
  const items = [];
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    const id = Number(it?.id); if (!ids.includes(id) || items.some((x) => x.id === id)) continue;
    let low = Math.max(0, Number(it.low) || 0), high = Math.max(0, Number(it.high) || 0);
    if (high < low) [low, high] = [high, low];
    items.push({
      id,
      cost_tier: titleCase(it.cost_tier, ['Low', 'Medium', 'High'], 'Medium'),
      low: Math.round(low), high: Math.round(high),
      basis: str(it.basis), cost_drivers: arr(it.cost_drivers), maintenance: str(it.maintenance),
      financial_benefits: arr(it.financial_benefits), funding_options: arr(it.funding_options),
      confidence: oneOf(it.confidence, ['low', 'medium'], 'low'),
    });
  }
  if (!items.length) throw new Error('no financial items');
  return {
    currency, summary: str(raw.summary), items,
    total: { low: items.reduce((a, b) => a + b.low, 0), high: items.reduce((a, b) => a + b.high, 0) },
    caveats: arr(raw.caveats),
  };
}

async function financialAnalysis(provider, { scene, currency, region, interventions }) {
  const ids = interventions.map((x) => x.id);
  const user = `Currency: ${currency}\nRegion: ${region || 'not specified (assume a typical North American city)'}\nScene: ${scene}\nInterventions:\n` +
    interventions.map((x) => `#${x.id} ${x.title} — ${x.description} | Location: ${x.location} | Problem: ${x.problem} | Category: ${x.category} | Difficulty: ${x.difficulty} | Area covers about ${x.area_pct}% of the image`).join('\n');
  const { result, model } = await chatWithFallback(provider, provider.textModels || provider.models, [
    { role: 'system', content: FIN_PROMPT }, { role: 'user', content: user },
  ], { json: true, maxTokens: 2200, parse: (t) => normalizeFinancial(extractJson(t), ids, currency) });
  return { financial: result, model };
}

function cleanText(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

// ---------- handler ----------
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  const provider = resolveProvider();

  if (req.method === 'GET') {
    return send(res, 200, { ok: true, configured: !!provider, provider: provider?.name || null, models: provider?.models || [] });
  }
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method not allowed' });
  if (!provider) return send(res, 500, { ok: false, error: 'Server is missing the XAI_API_KEY environment variable.' });

  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const action = ['ask', 'financial'].includes(body?.action) ? body.action : 'analyze';
  const limits = { analyze: 8, ask: 15, financial: 6 };
  if (rateLimited(ip + ':' + action, limits[action])) return send(res, 429, { ok: false, error: action === 'analyze' ? 'Too many analyses from this connection. Please wait a minute.' : 'Too many requests from this connection. Please wait a minute.' });

  // Financial analysis (text only, no image)
  if (action === 'financial') {
    const list = Array.isArray(body.interventions) ? body.interventions.slice(0, 12) : [];
    if (!list.length) return send(res, 400, { ok: false, error: 'No interventions to analyze.' });
    const interventions = list.map((x, i) => ({ id: Number(x.id) || i + 1, title: cleanText(x.title, 160), description: cleanText(x.description, 400), location: cleanText(x.location, 200), problem: cleanText(x.problem, 160), category: cleanText(x.category, 30), difficulty: cleanText(x.difficulty, 10), area_pct: Math.min(100, Math.max(0, Math.round(Number(x.area_pct) || 0))) }));
    const currency = ['CAD', 'USD'].includes(body.currency) ? body.currency : 'CAD';
    try {
      const { financial, model } = await financialAnalysis(provider, { scene: cleanText(body.scene, 200), currency, region: cleanText(body.region, 80), interventions });
      return send(res, 200, { ok: true, provider: provider.name, model, financial });
    } catch (e) { return send(res, e instanceof UpstreamError ? e.status : 500, { ok: false, error: e.message || 'Unexpected server error' }); }
  }

  const image = body?.image;
  if (typeof image !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image.slice(0, 60) + 'A')) {
    return send(res, 400, { ok: false, error: 'Request must include an image as a base64 data URL (JPEG, PNG or WEBP).' });
  }
  if (image.length > MAX_IMAGE_CHARS) return send(res, 413, { ok: false, error: 'Image is too large. Please upload a smaller image.' });

  // Click to ask
  if (action === 'ask') {
    const question = cleanText(body.question, 500);
    if (!question) return send(res, 400, { ok: false, error: 'Please type a question.' });
    const pt = body.point && Number.isFinite(+body.point.x) && Number.isFinite(+body.point.y) ? { x: Math.min(1, Math.max(0, +body.point.x)), y: Math.min(1, Math.max(0, +body.point.y)) } : null;
    const history = (Array.isArray(body.history) ? body.history : []).slice(-6).filter((h) => h && ['user', 'assistant'].includes(h.role)).map((h) => ({ role: h.role, content: cleanText(h.content, 1200) })).filter((h) => h.content);
    try {
      const { answer, model } = await askImage(provider, image, { question, point: pt, context: cleanText(body.context, 2500), history });
      return send(res, 200, { ok: true, provider: provider.name, model, answer });
    } catch (e) { return send(res, e instanceof UpstreamError ? e.status : 500, { ok: false, error: e.message || 'Unexpected server error' }); }
  }

  try {
    const started = Date.now();
    const { analysis, model, usage } = await analyzeImage(provider, image);
    return send(res, 200, {
      ok: true,
      provider: provider.name,
      model,
      duration_ms: Date.now() - started,
      usage,
      analysis,
    });
  } catch (e) {
    const status = e instanceof UpstreamError ? e.status : 500;
    return send(res, status, { ok: false, error: e.message || 'Unexpected server error' });
  }
}
