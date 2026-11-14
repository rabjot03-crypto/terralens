// TerraLens — serverless analysis endpoint (Vercel: /api/analyze)
// The API key is read ONLY from server-side environment variables and is never
// sent to the browser. Works with an xAI Grok key ("xai-...") or a Groq key ("gsk_...").

const PROVIDERS = {
  xai: {
    name: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4.20-0309-non-reasoning', 'grok-4', 'grok-2-vision-1212'],
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['qwen/qwen3.8-27b', 'meta-models/muse-spark-open', 'qwen/qwen3.6-27b', 'meta-llama/llama-4-scout-17b-16e-instruct'],
  },
};

const MAX_IMAGE_CHARS = 4_200_000; // ~3 MB binary; frontend resizes well below this
const UPSTREAM_TIMEOUT_MS = 55_000;

// Best-effort per-instance rate limit (protects your API credits from abuse)
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000, max = 8;
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
  return { id, key, name: p.name, baseUrl: process.env.AI_BASE_URL || p.baseUrl, models: [...new Set(models)] };
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

Return 4 to 8 findings (fewer if the image genuinely shows less). Include at least one "opportunity" finding when one is visible.
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
  constructor(status, message, kind) { super(message); this.status = status; this.kind = kind; }
}

async function callModel(provider, model, imageDataUrl, { jsonMode, strictRetry }) {
  const userText = strictRetry
    ? 'Analyze this image. Your previous answer was not valid JSON. Reply with ONLY the JSON object described in the system prompt.'
    : 'Analyze this image for urban climate resilience and return the JSON object.';
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 6000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: imageDataUrl, detail: 'high' } },
        { type: 'text', text: userText },
      ] },
    ],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

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
    if (resp.status === 429) throw new UpstreamError(429, 'The AI provider rate limit was reached. Please wait a minute and try again.', 'rate');
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
    let jsonMode = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { content, usage } = await callModel(provider, model, imageDataUrl, { jsonMode, strictRetry: attempt > 0 });
        const parsed = extractJson(content);
        const analysis = normalizeAnalysis(parsed);
        return { analysis, model, usage };
      } catch (e) {
        lastErr = e;
        if (e instanceof UpstreamError) {
          if (e.kind === 'jsonmode' && jsonMode) { jsonMode = false; continue; }
          if (e.kind === 'model') break; // try next model
          throw e; // auth, rate, size, network: stop
        }
        // malformed JSON → retry once with stricter instruction
        if (attempt >= 1) break;
      }
    }
  }
  if (lastErr instanceof UpstreamError && lastErr.kind !== 'model') throw lastErr;
  if (lastErr instanceof UpstreamError) throw new UpstreamError(502, `No configured vision model is available for this key (${lastErr.message.slice(0, 160)}). Set AI_MODEL to a current vision model ID.`, 'model');
  throw new UpstreamError(502, 'The AI returned a response that could not be read as structured findings. Please try again.', 'parse');
}

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
  if (rateLimited(ip)) return send(res, 429, { ok: false, error: 'Too many analyses from this connection. Please wait a minute.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const image = body?.image;
  if (typeof image !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(image.slice(0, 60) + 'A')) {
    return send(res, 400, { ok: false, error: 'Request must include an image as a base64 data URL (JPEG, PNG or WEBP).' });
  }
  if (image.length > MAX_IMAGE_CHARS) return send(res, 413, { ok: false, error: 'Image is too large. Please upload a smaller image.' });

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
