import express from 'express';
import cors from 'cors';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';

const app = express();
const PORT = process.env.PORT || 8972;
const HOST = process.env.MCP_HOST || '127.0.0.1';
const MAX_CACHE_ENTRIES = 256;
const MAX_BATCH_SIZE = 20;
const MAX_CONCURRENT_MCP_REQUESTS = 20;
const MAX_CONCURRENT_UPSTREAM_REQUESTS = 12;
const MAX_QUERY_LENGTH = 240;
const MAX_SLUG_LENGTH = 160;
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const MAX_RATE_LIMIT_CLIENTS = 10000;
const LUNOO_ORIGIN = 'https://lunoo.com';
const UPSTREAM_BASE_URL = process.env.LUNOO_UPSTREAM_BASE_URL || LUNOO_ORIGIN;
const MCP_USAGE_ENDPOINT = process.env.MCP_USAGE_ENDPOINT || `${LUNOO_ORIGIN}/api/mcp-usage`;
const MCP_USAGE_INGEST_TOKEN = process.env.MCP_USAGE_INGEST_TOKEN || '';
const MCP_USAGE_TLS_SERVERNAME = process.env.MCP_USAGE_TLS_SERVERNAME || '';
const DEFAULT_ALLOWED_ORIGINS = [
  'https://claude.ai',
  'https://www.claude.ai',
  'https://claude.com',
  'https://www.claude.com',
];
const MCP_ALLOWED_ORIGINS = new Set(
  String(process.env.MCP_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean),
);

function upstreamUrl(path) {
  return new URL(path, `${UPSTREAM_BASE_URL.replace(/\/+$/, '')}/`).toString();
}

function lunooUrl(path) {
  const url = new URL(path, `${LUNOO_ORIGIN}/`);
  url.searchParams.set('utm_source', 'claude');
  url.searchParams.set('utm_medium', 'connector');
  url.searchParams.set('utm_campaign', 'lunoo_mcp');
  url.searchParams.set('src', 'claude_connector');
  return url.toString();
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || MCP_ALLOWED_ORIGINS.has(origin.replace(/\/+$/, ''))) {
      callback(null, true);
      return;
    }

    const error = new Error('Origin is not allowed');
    error.code = 'MCP_ORIGIN_DENIED';
    callback(error);
  },
  credentials: false,
  exposedHeaders: ['mcp-session-id', 'mcp-protocol-version', 'content-type'],
  allowedHeaders: ['authorization', 'mcp-session-id', 'mcp-protocol-version', 'content-type'],
}));
app.use((error, request, response, next) => {
  if (error?.code === 'MCP_ORIGIN_DENIED') {
    response.status(403).json({ error: 'Origin is not allowed' });
    return;
  }

  next(error);
});

const rateLimitClients = new Map();
let activeMcpRequests = 0;
let activeUpstreamRequests = 0;
const upstreamWaiters = [];

function acquireUpstreamSlot() {
  if (activeUpstreamRequests < MAX_CONCURRENT_UPSTREAM_REQUESTS) {
    activeUpstreamRequests += 1;
    return Promise.resolve();
  }

  return new Promise((resolve) => upstreamWaiters.push(resolve));
}

function releaseUpstreamSlot() {
  const next = upstreamWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeUpstreamRequests = Math.max(0, activeUpstreamRequests - 1);
}

function clientKey(request) {
  const remoteAddress = String(request.socket?.remoteAddress || 'unknown').slice(0, 64);
  const isLoopback = remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1';
  if (!isLoopback) return remoteAddress;

  return String(request.headers['x-real-ip'] || remoteAddress).split(',')[0].trim().slice(0, 64);
}

function allowClientRequest(request, now = Date.now()) {
  const key = clientKey(request);
  let bucket = rateLimitClients.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  }
  bucket.count += 1;
  rateLimitClients.delete(key);
  rateLimitClients.set(key, bucket);

  while (rateLimitClients.size > MAX_RATE_LIMIT_CLIENTS) {
    rateLimitClients.delete(rateLimitClients.keys().next().value);
  }

  return bucket.count <= RATE_LIMIT_MAX;
}

app.use('/mcp', (request, response, next) => {
  if (!allowClientRequest(request)) {
    response.setHeader('retry-after', '60');
    response.status(429).json({ error: 'Too many requests' });
    return;
  }

  if (activeMcpRequests >= MAX_CONCURRENT_MCP_REQUESTS) {
    response.setHeader('retry-after', '1');
    response.status(503).json({ error: 'MCP server is busy' });
    return;
  }

  activeMcpRequests += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeMcpRequests = Math.max(0, activeMcpRequests - 1);
  };
  response.once('finish', release);
  response.once('close', release);
  next();
});

app.use(express.json({ limit: '32kb', strict: true }));

// ============================================================
// Cache layer with TTL
// ============================================================
const cache = new Map();

function getCached(key, ttlMs) {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiresAt) {
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
  }
  if (entry) {
    cache.delete(key);
  }
  return null;
}

function setCached(key, value, ttlMs) {
  cache.delete(key);
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });

  while (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

function clearCache() {
  cache.clear();
}

function cacheEntryCount() {
  return cache.size;
}

function countToolResults(response) {
  const text = response?.result?.content?.find?.((entry) => entry?.type === 'text')?.text;
  if (typeof text !== 'string' || text.length === 0) return 0;

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length;
    if (Array.isArray(parsed?.top_items)) return parsed.top_items.length;
    if (Array.isArray(parsed?.structured_data)) return parsed.structured_data.length;
  } catch {
    // A future tool may return plain text while remaining a valid result.
  }

  return 0;
}

function buildUsageEvent(method, params, response) {
  const toolName = method === 'tools/call' ? String(params?.name || '').slice(0, 64) : null;
  const args = params?.arguments;
  const queryCount = method === 'tools/call' && args && typeof args === 'object'
    && ['query', 'niche', 'slug'].some((key) => typeof args[key] === 'string' && args[key].trim() !== '')
    ? 1
    : 0;
  const errorCode = response?.error?.code === undefined ? null : String(response.error.code).slice(0, 32);

  return {
    method,
    tool_name: toolName || null,
    query_count: queryCount,
    tool_count: method === 'tools/list' ? TOOLS.length : (method === 'tools/call' ? 1 : 0),
    result_count: method === 'tools/call' ? countToolResults(response) : 0,
    ok: !response?.error && !response?.result?.isError,
    error_code: errorCode,
    client_name: method === 'initialize' ? String(params?.clientInfo?.name || '').slice(0, 100) || null : null,
    client_version: method === 'initialize' ? String(params?.clientInfo?.version || '').slice(0, 50) || null : null,
  };
}

async function recordMcpUsage(event) {
  if (!MCP_USAGE_INGEST_TOKEN) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const body = JSON.stringify(event);
    let status;

    if (MCP_USAGE_TLS_SERVERNAME) {
      status = await postUsageToLocalTls(body, controller.signal);
    } else {
      const response = await fetch(MCP_USAGE_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lunoo-mcp-usage-key': MCP_USAGE_INGEST_TOKEN,
        },
        body,
        signal: controller.signal,
      });
      status = response.status;
    }

    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status}`);
    }
  } catch (error) {
    console.error('MCP usage telemetry failed:', error?.name || 'unknown');
  } finally {
    clearTimeout(timeout);
  }
}

function postUsageToLocalTls(body, signal) {
  const endpoint = new URL(MCP_USAGE_ENDPOINT);
  if (endpoint.protocol !== 'https:') {
    return Promise.reject(new Error('Pinned MCP usage endpoint must use HTTPS'));
  }

  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: endpoint.hostname,
      port: endpoint.port || 443,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: 'POST',
      servername: MCP_USAGE_TLS_SERVERNAME,
      headers: {
        host: MCP_USAGE_TLS_SERVERNAME,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-lunoo-mcp-usage-key': MCP_USAGE_INGEST_TOKEN,
      },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode || 0));
    });

    request.on('error', reject);
    signal.addEventListener('abort', () => request.destroy(new Error('Telemetry timeout')), { once: true });
    request.end(body);
  });
}

// ============================================================
// Deterministic query intent and ranking-index helpers
// ============================================================

// The public niche endpoint intentionally does substring matching. That is
// useful for a small type-ahead search, but it is not sufficient for an MCP
// request such as "best laptop for video editing": the upstream endpoint can
// put video-game ahead of laptop simply because it sees the word "video".
// Keep the MCP resolver deterministic and conservative. It can only return a
// category that was returned by the public API or that exists in the public
// ranking sitemap and has a readable JSON ranking payload.
const QUERY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'best', 'can', 'do', 'for', 'find', 'from', 'give',
  'good', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'options', 'please',
  'recommend', 'recommendation', 'recommendations', 'show', 'some', 'suggest',
  'the', 'to', 'top', 'what', 'which', 'with', 'you', 'your', 'looking',
  'need', 'want', 'buy', 'get', 'use', 'using', 'suitable', 'ideal', 'right',
]);

const QUERY_ALIASES = Object.freeze({
  // Product-type aliases
  notebook: 'laptop',
  notebooks: 'laptop',
  computers: 'computer',
  pcs: 'pc',
  pc: 'computer',
  mobile: 'smartphone',
  mobiles: 'smartphone',
  cellphone: 'smartphone',
  cellphones: 'smartphone',
  phones: 'smartphone',
  earphone: 'headphone',
  earphones: 'headphone',
  earbuds: 'earbud',
  'true-wireless': 'wireless',
  cans: 'headphone',
  spectacles: 'eyewear',
  shades: 'sunglasses',
  trainers: 'running-shoes',
  sneakers: 'running-shoes',
  // Frequent typo aliases. The fuzzy matcher handles the rest.
  lptop: 'laptop',
  lapotp: 'laptop',
  vidio: 'video',
  vido: 'video',
  editng: 'editing',
  editting: 'editing',
  softwere: 'software',
  softwear: 'software',
  heaphones: 'headphone',
  headphons: 'headphone',
  camra: 'camera',
  gamming: 'gaming',
  gamng: 'gaming',
  runing: 'running',
  studnts: 'students',
});

const QUERY_PHRASES = Object.freeze({
  'video editing': 'video-editing',
  'video production': 'video-production',
  'photo editing': 'photo-editing',
  'music production': 'music-production',
  'graphic design': 'graphic-design',
  'web hosting': 'web-hosting',
  'project management': 'project-management',
  'running shoes': 'running-shoes',
  'coffee maker': 'coffee-maker',
  'coffee makers': 'coffee-maker',
  'board games': 'board-game',
  'video games': 'video-game',
  'role playing': 'role-playing',
  'small business': 'small-business',
  'home security': 'home-security',
  'social media': 'social-media',
});

const AUDIENCE_TERMS = new Set([
  'beginner', 'beginners', 'child', 'children', 'family', 'families', 'kids',
  'professional', 'professionals', 'senior', 'seniors', 'student', 'students',
  'teacher', 'teachers', 'creator', 'creators', 'developer', 'developers',
  'business', 'businesses', 'small-business', 'small-businesses',
]);

const USE_CASE_TERMS = new Set([
  'editing', 'gaming', 'running', 'travel', 'travelling', 'work', 'office',
  'home', 'streaming', 'stream', 'photography', 'photo', 'music', 'study',
  'studying', 'productivity', 'programming', 'coding', 'design', 'outdoor',
  'outdoors', 'security', 'budget', 'cheap', 'affordable', 'premium', 'portable',
  'lightweight', 'wireless', 'small', 'large', 'quiet', 'durable', 'fast', 'ear',
]);

const BROAD_FALLBACK_SLUGS = Object.freeze([
  'software', 'service', 'product', 'tool', 'app', 'book', 'movie', 'music',
  'game', 'anime', 'travel', 'food', 'restaurant', 'laptop', 'camera',
]);

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function singularizeToken(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('sses')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function canonicalToken(token) {
  const value = String(token || '').toLowerCase();
  return QUERY_ALIASES[value] || singularizeToken(value);
}

function phraseTokens(normalized) {
  return Object.entries(QUERY_PHRASES)
    .filter(([phrase]) => ` ${normalized} `.includes(` ${phrase} `))
    .map(([phrase, canonical]) => ({
      phrase,
      canonical,
      parts: phrase.split(' ').map(canonicalToken),
    }));
}

function extractIntent(query) {
  const normalized = normalizeText(query);
  const rawTokens = normalized ? normalized.split(/\s+/) : [];
  const canonicalRawTokens = rawTokens.map(canonicalToken);
  const tokens = canonicalRawTokens
    .filter((token) => token && !QUERY_STOP_WORDS.has(token));
  const phrases = [...new Map([
    ...phraseTokens(normalized),
    ...phraseTokens(canonicalRawTokens.join(' ')),
  ].map((phrase) => [phrase.canonical, phrase])).values()];
  const phraseParts = new Set(phrases.flatMap((phrase) => phrase.parts));
  const phraseConcepts = phrases.map((phrase) => phrase.canonical);
  const meaningful = [...new Set(tokens)];

  let primary = meaningful.filter((token) => !phraseParts.has(token) && !USE_CASE_TERMS.has(token) && !AUDIENCE_TERMS.has(token));
  if (primary.length === 0) {
    // A query such as "best for gaming" has no product noun. Treat the
    // remaining concept as primary so that /best/gaming can still resolve.
    primary = meaningful.filter((token) => !phraseParts.has(token));
  }

  const context = [...new Set([
    ...phraseConcepts,
    ...meaningful.filter((token) => USE_CASE_TERMS.has(token) || AUDIENCE_TERMS.has(token)),
  ])];

  const variants = [];
  const pushVariant = (value) => {
    const variant = String(value || '').trim();
    if (variant && !variants.includes(variant)) variants.push(variant);
  };

  if (normalized) pushVariant(normalized.replace(/\s+/g, '-'));
  if (meaningful.length) pushVariant(meaningful.join('-'));
  for (const phrase of phraseConcepts) pushVariant(phrase);
  for (const token of meaningful) pushVariant(token);

  return {
    original: String(query ?? ''),
    normalized,
    tokens: meaningful,
    primary,
    context,
    concepts: [...new Set([...meaningful, ...phraseConcepts])],
    variants: variants.slice(0, 8),
  };
}

function levenshteinDistance(left, right) {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const insertion = current[j - 1] + 1;
      const deletion = previous[j] + 1;
      const substitution = previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1);
      current.push(Math.min(insertion, deletion, substitution));
    }
    previous = current;
  }
  return previous[right.length];
}

function tokenSimilarity(queryToken, candidateToken) {
  const queryValue = canonicalToken(queryToken);
  const candidateValue = canonicalToken(candidateToken);
  if (!queryValue || !candidateValue) return 0;
  if (queryValue === candidateValue) return 1;
  if (queryValue.length >= 4 && candidateValue.length >= 4
    && (candidateValue.startsWith(queryValue) || queryValue.startsWith(candidateValue))) return 0.86;

  const distance = levenshteinDistance(queryValue, candidateValue);
  const maxLength = Math.max(queryValue.length, candidateValue.length);
  const similarity = 1 - distance / maxLength;
  // One-character typos are useful, but do not let short words turn an
  // unrelated ranking into a match.
  if (maxLength >= 6 && distance <= 2 && similarity >= 0.6) return similarity;
  if (maxLength === 5 && distance <= 1 && similarity >= 0.8) return similarity;
  return 0;
}

function candidateTokenSet(slug, name = '') {
  return [...new Set(normalizeText(`${slug} ${name}`).split(/\s+/).filter(Boolean).map(canonicalToken))];
}

function scoreCandidate(candidate, intent) {
  const slug = normalizeText(candidate.slug).replace(/\s+/g, '-');
  const slugTokens = candidateTokenSet(slug, candidate.name);
  const primaryScores = intent.primary.map((token) => Math.max(...slugTokens.map((candidateToken) => tokenSimilarity(token, candidateToken)), 0));
  const contextScores = intent.context.map((token) => {
    const phraseScore = token.includes('-') && slug === token ? 1 : 0;
    return Math.max(phraseScore, ...slugTokens.map((candidateToken) => tokenSimilarity(token, candidateToken)), 0);
  });
  const allScores = intent.concepts.map((token) => Math.max(...slugTokens.map((candidateToken) => tokenSimilarity(token, candidateToken)), 0));
  const primaryCoverage = primaryScores.length ? primaryScores.reduce((sum, value) => sum + value, 0) / primaryScores.length : 0;
  const contextCoverage = contextScores.length ? contextScores.reduce((sum, value) => sum + value, 0) / contextScores.length : 0;
  const allCoverage = allScores.length ? allScores.reduce((sum, value) => sum + value, 0) / allScores.length : 0;
  const exactSlug = intent.normalized.replace(/\s+/g, '-') === slug || intent.tokens.join('-') === slug;
  const primaryExact = primaryScores.filter((value) => value >= 0.99).length;
  const itemCount = Number(candidate.item_count || 0);
  const exactContext = intent.context.some((token) => token.includes('-') && slug === token);

  // Primary product/type matches carry more weight than audience and use-case
  // words. This prevents "video-game" from outranking "laptop" for a video
  // editing laptop request.
  let score = primaryCoverage * 0.66 + contextCoverage * 0.22 + allCoverage * 0.12;
  if (exactSlug) score += 0.35;
  if (primaryScores.length && primaryExact === primaryScores.length) score += 0.22;
  if (slug === intent.primary.join('-')) score += 0.2;
  // Prefer a clean exact noun over a longer accessory niche when the user's
  // primary intent is exactly that noun.
  if (intent.primary.length === 1 && slug === intent.primary[0]) score += 0.08;
  // An exact multi-word use-case is a useful secondary category. Keep it
  // visible beside the primary noun instead of letting a long list of
  // accessories hide it (for example laptop + video-editing).
  if (exactContext) score += 0.75;
  score += Math.min(Math.log10(Math.max(itemCount, 1)) / 100, 0.04);

  const matchedTerms = intent.concepts.filter((term) => {
    const best = Math.max(...slugTokens.map((candidateToken) => tokenSimilarity(term, candidateToken)), 0);
    return best >= 0.72 || (term.includes('-') && slug === term);
  });

  let confidence = 'low';
  if (score >= 1.05 && primaryCoverage >= 0.95) confidence = 'high';
  else if (exactContext && score >= 0.9) confidence = 'medium';
  else if (score >= 0.68 && (primaryCoverage >= 0.65 || contextCoverage >= 0.8)) confidence = 'medium';

  return {
    ...candidate,
    slug,
    _score: score,
    _primaryCoverage: primaryCoverage,
    _contextCoverage: contextCoverage,
    _exactContext: exactContext,
    _matchedTerms: matchedTerms,
    _confidence: confidence,
  };
}

function explainCandidate(candidate, intent, usedFallback = false) {
  const matched = candidate._matchedTerms || [];
  const primary = intent.primary || [];
  if (usedFallback) {
    return {
      match_reason: 'Broad live ranking fallback. The request did not identify a supported category with enough confidence.',
      confidence: 'low',
      matched_terms: matched,
    };
  }
  if (candidate._confidence === 'high' && primary.length) {
    return {
      match_reason: `Exact or near-exact match for ${primary.join(', ')}${matched.length > primary.length ? `; also matched ${matched.filter((term) => !primary.includes(term)).join(', ')}` : ''}.`,
      confidence: candidate._confidence,
      matched_terms: matched,
    };
  }
  if (matched.length) {
    return {
      match_reason: `Closest live ranking match for ${matched.join(', ')}; use-case and audience words were treated as context.`,
      confidence: candidate._confidence,
      matched_terms: matched,
    };
  }
  return {
    match_reason: 'Closest live ranking category found in the public index.',
    confidence: candidate._confidence,
    matched_terms: [],
  };
}

function parseJsonPayload(data) {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function parseRankingIndex(xml) {
  if (typeof xml !== 'string') return [];
  const candidates = [];
  const seen = new Set();
  const locationPattern = /<loc>\s*(?:https?:\/\/[^/]+)?\/best\/([^<\s]+)\s*<\/loc>/gi;
  let match;
  while ((match = locationPattern.exec(xml)) !== null) {
    let slug;
    try {
      slug = decodeURIComponent(match[1]).replace(/\/$/, '').trim().toLowerCase();
    } catch {
      slug = match[1].replace(/\/$/, '').trim().toLowerCase();
    }
    if (!slug || slug.includes('.') || seen.has(slug)) continue;
    seen.add(slug);
    candidates.push({ slug, name: slug.replace(/-/g, ' ') });
  }
  return candidates;
}

async function fetchRankingIndex() {
  const cacheKey = 'ranking_index_v1';
  const cached = getCached(cacheKey, 60 * 60 * 1000);
  if (cached) return cached;

  const result = await fetchWithTimeout(upstreamUrl('/sitemap-tags.xml'), 6000);
  if (!result.ok) return [];
  const parsed = parseRankingIndex(result.data);
  if (parsed.length) setCached(cacheKey, parsed, 60 * 60 * 1000);
  return parsed;
}

async function hydrateCandidates(candidates, maxToHydrate = 8) {
  const pending = candidates
    .filter((candidate) => !Number.isFinite(Number(candidate.item_count)) || Number(candidate.item_count) < 1)
    .slice(0, maxToHydrate);
  if (!pending.length) return candidates;

  const hydrated = await Promise.all(pending.map(async (candidate) => {
    const result = await fetchWithTimeout(upstreamUrl(`/best/${encodeURIComponent(candidate.slug)}.json`), 5000);
    if (!result.ok) return null;
    const payload = parseJsonPayload(result.data);
    if (!payload || typeof payload !== 'object') return null;
    const items = payload.top_items || payload.ranking || payload.items || [];
    const itemCount = Number(payload.item_count || payload.total_items || items.length || 0);
    if (itemCount < 3) return null;
    return {
      ...candidate,
      name: payload.name || payload.title || candidate.name,
      item_count: itemCount,
    };
  }));
  const hydratedBySlug = new Map(hydrated.filter(Boolean).map((candidate) => [candidate.slug, candidate]));
  return candidates
    .map((candidate) => hydratedBySlug.get(candidate.slug) || candidate)
    .filter((candidate) => Number(candidate.item_count || 0) >= 3);
}

async function broadFallbackCandidates() {
  const index = await fetchRankingIndex();
  const bySlug = new Map(index.map((candidate) => [candidate.slug, candidate]));
  const selected = BROAD_FALLBACK_SLUGS
    .map((slug) => bySlug.get(slug) || { slug, name: slug.replace(/-/g, ' ') });
  return hydrateCandidates(selected, selected.length);
}

// ============================================================
// Fetch wrapper with timeout, User-Agent, error handling
// ============================================================
async function fetchWithTimeout(url, timeoutMs = 10000) {
  await acquireUpstreamSlot();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LunooMCP/1.0 (+https://lunoo.com)',
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return { ok: true, status: 200, data };
  } catch (err) {
    if (err.name === 'AbortError') {
      return {
        ok: false,
        status: 0,
        error: `Request timeout (${Math.round(timeoutMs / 1000)}s)`,
      };
    }
    return {
      ok: false,
      status: 0,
      error: err.message || String(err),
    };
  } finally {
    clearTimeout(timeoutId);
    releaseUpstreamSlot();
  }
}

// ============================================================
// Tool implementations
// ============================================================

/**
 * Search the public niche API with a small bounded set of deterministic
 * variants. The API is a substring search, so scoring still happens locally.
 */
async function fetchApiCandidates(intent) {
  if (!intent.variants.length) return [];

  const responses = await Promise.all(intent.variants.slice(0, 6).map(async (variant) => (
    fetchWithTimeout(upstreamUrl(`/api/v1/niches?q=${encodeURIComponent(variant)}`), 6000)
  )));
  const bySlug = new Map();
  for (const response of responses) {
    if (!response.ok) continue;
    const parsed = parseJsonPayload(response.data);
    for (const candidate of parsed?.results || []) {
      const slug = normalizeText(candidate.slug).replace(/\s+/g, '-');
      if (!slug || Number(candidate.item_count || 0) < 3) continue;
      const previous = bySlug.get(slug);
      // Keep the largest count and the most descriptive name if variants
      // returned the same category more than once.
      if (!previous || Number(candidate.item_count || 0) > Number(previous.item_count || 0)) {
        bySlug.set(slug, { ...candidate, slug });
      }
    }
  }
  return [...bySlug.values()];
}

function rankAndFilterCandidates(candidates, intent) {
  const ranked = candidates
    .map((candidate) => scoreCandidate(candidate, intent))
    .filter((candidate) => {
      if (!intent.concepts.length) return false;
      // A candidate must match a primary noun or an entire context phrase. A
      // single shared word such as "video" is not enough.
      return candidate._primaryCoverage >= 0.45
        || candidate._contextCoverage >= 0.8
        || candidate._exactContext
        || candidate._score >= 1.05;
    })
    .sort((left, right) => (
      right._score - left._score
      || Number(right.item_count || 0) - Number(left.item_count || 0)
      || left.slug.localeCompare(right.slug)
    ));
  return ranked;
}

async function resolveNicheCandidates(query) {
  const intent = extractIntent(query);
  const cacheKey = `find_niche_v3_${intent.normalized}`;
  const cacheTTL = 60 * 60 * 1000;
  let merged = getCached(cacheKey, cacheTTL);

  if (merged === null) {
    merged = await fetchApiCandidates(intent);
    setCached(cacheKey, merged, cacheTTL);
  }

  let ranked = rankAndFilterCandidates(merged, intent);
  const usedFallback = false;

  // Compound and misspelled requests need the full public ranking index. The
  // sitemap is cached for one hour, so this is one bounded fetch per process,
  // not one fetch per tool call.
  if (ranked.length === 0 || (intent.concepts.length > 1 && ranked[0]._score < 1.05)) {
    const index = await fetchRankingIndex();
    const bySlug = new Map([...merged, ...index].map((candidate) => [candidate.slug, candidate]));
    const indexRanked = rankAndFilterCandidates([...bySlug.values()], intent);
    const topToHydrate = indexRanked.slice(0, 10);
    const hydrated = await hydrateCandidates(topToHydrate, 10);
    ranked = rankAndFilterCandidates(hydrated, intent);
  }

  return {
    intent,
    usedFallback,
    candidates: ranked.slice(0, 10),
  };
}

/**
 * find_niche: natural-language query -> closest live ranking categories.
 *
 * The return shape remains an array for compatibility with existing MCP
 * clients. Each result now explains why it matched and how confident the
 * resolver is. No slug is emitted unless it came from a public endpoint.
 */
async function toolFindNiche(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY_LENGTH) {
    return {
      isError: true,
      content: [{ type: 'text', text: `query must be a non-empty string of at most ${MAX_QUERY_LENGTH} characters` }],
    };
  }

  const boundedQuery = query.trim();
  const resolution = await resolveNicheCandidates(boundedQuery);
  const result = resolution.candidates.map((item) => ({
    slug: item.slug,
    name: item.name || item.slug.replace(/-/g, ' '),
    item_count: Number(item.item_count || 0),
    url: lunooUrl(`/best/${encodeURIComponent(item.slug)}`),
    rankings_json: lunooUrl(`/best/${encodeURIComponent(item.slug)}.json`),
    ...explainCandidate(item, resolution.intent, resolution.usedFallback),
  }));

  if (result.length === 0) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `No confident live Lunoo ranking matches "${boundedQuery}". Try a clear category such as anime, laptop, book, or ski resort.`,
      }],
    };
  }

  return {
    isError: false,
    content: [{
      type: 'text',
      text: JSON.stringify(result, null, 2),
    }],
  };
}

/**
 * get_rankings: Fetch rankings for a niche
 * Returns top N items with score, description, etc.
 */
async function fetchRankingPayload(slug) {
  const cacheKey = `rankings_${slug}`;
  const cacheTTL = 15 * 60 * 1000;
  let rankings = getCached(cacheKey, cacheTTL);
  if (rankings !== null) return rankings;

  const result = await fetchWithTimeout(upstreamUrl(`/best/${encodeURIComponent(slug)}.json`), 7000);
  if (!result.ok) return null;
  rankings = parseJsonPayload(result.data);
  if (!rankings || typeof rankings !== 'object') return null;
  setCached(cacheKey, rankings, cacheTTL);
  return rankings;
}

function slugFromNicheInput(niche) {
  const raw = String(niche || '').trim();
  const urlMatch = raw.match(/\/best\/([^/?#]+)(?:[?#].*)?$/i);
  const value = urlMatch ? urlMatch[1] : raw;
  const normalized = normalizeText(value).replace(/\s+/g, '-');
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : null;
}

/**
 * get_rankings accepts either an exact returned slug or a natural-language
 * request. Natural-language requests are resolved through the same bounded
 * resolver as find_niche, then fetched only from the selected live JSON URL.
 */
async function toolGetRankings(niche, limit = 10) {
  if (typeof niche !== 'string' || !niche.trim() || niche.length > MAX_QUERY_LENGTH) {
    return {
      isError: true,
      content: [{ type: 'text', text: `niche must be a non-empty string of at most ${MAX_QUERY_LENGTH} characters` }],
    };
  }

  limit = Math.min(Math.max(Number.isFinite(Number(limit)) ? Number(limit) : 10, 1), 50);

  const rawNicheInput = niche.trim();
  const hasNaturalLanguage = /\s/.test(rawNicheInput);
  // Do not spend a full upstream request probing a hyphenated version of a
  // sentence. Natural-language requests go directly through the resolver;
  // slug-shaped inputs still use the fast exact JSON path.
  let resolvedSlug = hasNaturalLanguage ? null : slugFromNicheInput(niche);
  let resolution = {
    requested_query: niche,
    matched_slug: resolvedSlug,
    match_reason: 'Exact niche slug supplied.',
    confidence: 'high',
    matched_terms: [resolvedSlug].filter(Boolean),
  };
  let rankings = resolvedSlug ? await fetchRankingPayload(resolvedSlug) : null;

  // A slug-shaped input can still be a stale or nonexistent slug. Resolve it
  // through the public index before reporting a failure.
  if (!rankings || !resolvedSlug || hasNaturalLanguage) {
    const resolved = await resolveNicheCandidates(niche);
    const selected = resolved.candidates[0];
    if (selected) {
      resolvedSlug = selected.slug;
      resolution = {
        requested_query: niche,
        matched_slug: selected.slug,
        ...explainCandidate(selected, resolved.intent, resolved.usedFallback),
      };
      rankings = await fetchRankingPayload(resolvedSlug);
    }
  }

  if (!rankings || !resolvedSlug) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: `No live Lunoo ranking could be resolved for "${niche}". Try a broader topic.`,
      }],
    };
  }

  // Process response (live payload uses top_items)
  const items = rankings.top_items || rankings.ranking || rankings.items || [];
  const topItems = items.slice(0, limit).map((item, idx) => ({
    rank: idx + 1,
    name: item.name || item.title || 'Unknown',
    url: lunooUrl(item.url || `/item/${encodeURIComponent(item.slug || '')}`),
    score: item.score !== undefined ? item.score : item.rating,
    description: (item.description || '')
      .split(/\s+/)
      .slice(0, 30)
      .join(' ')
      .substring(0, 200),
    ranking_confidence: item.confidence || item.ranking_confidence || 'unknown',
  }));

  const output = {
    name: rankings.name || rankings.title || resolvedSlug,
    requested_query: niche,
    resolved_niche: resolvedSlug,
    resolution,
    url: lunooUrl(`/best/${encodeURIComponent(resolvedSlug)}`),
    item_count: rankings.item_count || rankings.total_items || items.length,
    updated_at: rankings.updated_at || rankings.lastUpdated || 'unknown',
    average_score: rankings.average_score || 'N/A',
    score_scale: rankings.score_scale || '0-10',
    citation_hint: rankings.citation_hint || 'Cite the ranking URL returned in this response.',
    ranking_method: rankings.ranking_method || 'Consensus-based scoring',
    top_items: topItems,
  };

  return {
    isError: false,
    content: [
      {
        type: 'text',
        text: JSON.stringify(output, null, 2),
      },
    ],
  };
}

/**
 * get_item: Fetch structured data for an item
 * Extracts JSON-LD blocks from the item page
 */
async function toolGetItem(slug) {
  if (typeof slug !== 'string' || !slug.trim() || slug.length > MAX_SLUG_LENGTH) {
    return {
      isError: true,
      content: [{ type: 'text', text: `slug must be a non-empty string of at most ${MAX_SLUG_LENGTH} characters` }],
    };
  }

  const boundedSlug = slug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(boundedSlug)) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'slug must contain only lowercase letters, numbers, and hyphens' }],
    };
  }

  const cacheKey = `item_${boundedSlug}`;
  const cacheTTL = 15 * 60 * 1000; // 15 minutes

  let html = getCached(cacheKey, cacheTTL);

  if (!html) {
    const result = await fetchWithTimeout(upstreamUrl(`/item/${encodeURIComponent(boundedSlug)}`));

    if (!result.ok) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Item "${boundedSlug}" not found (404). Verify the slug and try again.`,
          },
        ],
      };
    }

    html = result.data;
    setCached(cacheKey, html, cacheTTL);
  }

  // Extract all <script type="application/ld+json"> blocks
  const scriptRegex = /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  const structuredData = [];

  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      structuredData.push(parsed);
    } catch (e) {
      // Silently skip unparseable blocks
    }
  }

  const output = {
    url: lunooUrl(`/item/${encodeURIComponent(boundedSlug)}`),
    structured_data: structuredData,
  };

  return {
    isError: false,
    content: [
      {
        type: 'text',
        text: JSON.stringify(output, null, 2),
      },
    ],
  };
}

// ============================================================
// MCP Tools metadata and handlers
// ============================================================

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

const TOOLS = [
  {
    name: 'find_niche',
    description: 'Resolve a natural-language ranking request to one or more verified Lunoo niche slugs. Pass the user\'s request instead of guessing a slug. It handles common aliases, typos, and use-case terms, and returns item counts, match explanations, confidence, and tracked Lunoo URLs. Unsupported or unclear requests return an error instead of an unrelated fallback. Choose the closest returned slug, then call get_rankings with that exact slug. Never invent a niche slug or ranking.',
    annotations: {
      title: 'Resolve a Lunoo niche',
      ...READ_ONLY_ANNOTATIONS,
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_QUERY_LENGTH,
          description: 'Natural-language ranking request, for example "anime", "coffee makers", or "best laptop for video editing". Use the user\'s request rather than a guessed slug.',
        },
      },
      required: ['query'],
    },
    handler: (args) => toolFindNiche(args.query),
  },
  {
    name: 'get_rankings',
    description: 'Fetch ranked Lunoo results for a verified niche slug or natural-language request. It returns rank, score, description, confidence, and a canonical Lunoo URL for every item, plus the selected niche and resolution explanation. Prefer calling find_niche first, but this tool can resolve natural language itself. Cite the returned ranking URL and do not invent items, scores, or slugs.',
    annotations: {
      title: 'Get ranked Lunoo results',
      ...READ_ONLY_ANNOTATIONS,
    },
    inputSchema: {
      type: 'object',
      properties: {
        niche: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_QUERY_LENGTH,
          description: 'Exact niche slug returned by find_niche, or a natural-language request such as "best laptop for video editing". Examples: "anime" or "japanese-city".',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Number of ranked items to return, from 1 to 50. Defaults to 10.',
          default: 10,
        },
      },
      required: ['niche'],
    },
    handler: (args) => toolGetRankings(args.niche, args.limit || 10),
  },
  {
    name: 'get_item',
    description: 'Use this after a ranking result when the user wants details about one item. Pass the exact item slug from a Lunoo result or URL. It returns the canonical Lunoo URL for the item and public structured metadata. This is read-only and must not be used to invent rankings that were not returned by get_rankings.',
    annotations: {
      title: 'Get Lunoo item details',
      ...READ_ONLY_ANNOTATIONS,
    },
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_SLUG_LENGTH,
          pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
          description: 'Exact item slug from a Lunoo ranking result or item URL, for example "frieren-beyond-journeys-end".',
        },
      },
      required: ['slug'],
    },
    handler: (args) => toolGetItem(args.slug),
  },
];

// ============================================================
// JSON-RPC handlers
// ============================================================

async function handleJsonRpc(message, req) {
  const { jsonrpc, method, params, id } = message;

  // Validate JSON-RPC structure
  if (jsonrpc !== '2.0') {
    return {
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Invalid Request: jsonrpc must be 2.0' },
      id: id || null,
    };
  }

  // JSON-RPC notifications (no id) must not receive a response body.
  // Clients send notifications/initialized after the initialize handshake.
  if (id === undefined || id === null) {
    return null;
  }

  try {
    let response;
    switch (method) {
      case 'initialize':
        response = handleInitialize(params, id);
        break;

      case 'ping':
        response = { jsonrpc: '2.0', result: {}, id };
        break;

      case 'tools/list':
        response = handleToolsList(id);
        break;

      case 'tools/call':
        response = await handleToolCall(params, id, req);
        break;

      default:
        response = {
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${method}` },
          id,
        };
        break;
    }

    if (['initialize', 'ping', 'tools/list', 'tools/call'].includes(method)) {
      void recordMcpUsage(buildUsageEvent(method, params, response));
    }
    return response;
  } catch (err) {
    console.error('Handler error:', err);
    const response = {
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error',
        data: { error: err.message },
      },
      id,
    };
    if (['initialize', 'ping', 'tools/list', 'tools/call'].includes(method)) {
      void recordMcpUsage(buildUsageEvent(method, params, response));
    }
    return response;
  }
}

function handleInitialize(params, id) {
  const { protocolVersion, capabilities, clientInfo } = params || {};

  if (!protocolVersion) {
    return {
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Missing protocolVersion' },
      id,
    };
  }

  return {
    jsonrpc: '2.0',
    result: {
      protocolVersion: '2025-03-26',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'lunoo-rankings',
        version: '1.0.0',
      },
      instructions: 'Lunoo is a public, read-only rankings service. Resolve a natural-language request with find_niche first when possible, select the closest verified niche slug using its match explanation and confidence, then call get_rankings with that slug. get_rankings can resolve natural language itself when needed. Return ranked results using only the scores and descriptions from the tool response, include the returned Lunoo URLs, and never invent items, scores, slugs, or citations. Use get_item only when the user asks for details about a ranked item.',
    },
    id,
  };
}

function handleToolsList(id) {
  return {
    jsonrpc: '2.0',
    result: {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: tool.inputSchema,
      })),
    },
    id,
  };
}

async function handleToolCall(params, id, req) {
  const { name, arguments: args } = params || {};

  if (!name) {
    return {
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Missing tool name' },
      id,
    };
  }

  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return {
      jsonrpc: '2.0',
      error: { code: -32601, message: `Tool not found: ${name}` },
      id,
    };
  }

  let isError = false;
  try {
    const result = await tool.handler(args || {});
    isError = result.isError || false;

    // Keep operational logs aggregate-only. Raw prompts, arguments, and user
    // agents are neither logged here nor sent to the durable usage store.
    const logLine = JSON.stringify({
      ts: new Date().toISOString(),
      tool: name,
      ok: !isError,
    });
    console.log(logLine);

    return {
      jsonrpc: '2.0',
      result,
      id,
    };
  } catch (err) {
    isError = true;

    // Log tool call error
    const logLine = JSON.stringify({
      ts: new Date().toISOString(),
      tool: name,
      ok: false,
      error: 'tool_execution_failed',
    });
    console.log(logLine);

    return {
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Tool execution failed: ' + err.message },
      id,
    };
  }
}

// ============================================================
// HTTP endpoints
// ============================================================

/**
 * POST /mcp - Stateless JSON-RPC endpoint
 * Handle requests and return responses
 */
app.post('/mcp', async (req, res) => {
  try {
    const body = req.body;

    if (Array.isArray(body) && body.length > MAX_BATCH_SIZE) {
      return res.status(413).json({
        jsonrpc: '2.0',
        error: { code: -32600, message: `Batch size exceeds the ${MAX_BATCH_SIZE}-request limit` },
        id: null,
      });
    }

    if (!Array.isArray(body)) {
      // Single request; notifications get 202 with no body
      const response = await handleJsonRpc(body, req);
      if (response === null) return res.status(202).end();
      return res.json(response);
    } else {
      // Batch (spec-compliant); drop notification slots
      const responses = [];
      for (const msg of body) {
        const response = await handleJsonRpc(msg, req);
        if (response !== null) responses.push(response);
      }
      if (responses.length === 0) return res.status(202).end();
      return res.json(responses);
    }
  } catch (err) {
    console.error('MCP error:', err);
    res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null,
    });
  }
});

/**
 * GET /mcp - Method not allowed (standard MCP behavior)
 */
app.get('/mcp', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'Method not allowed' },
    id: null,
  });
});

/**
 * DELETE /mcp - Method not allowed
 */
app.delete('/mcp', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'Method not allowed' },
    id: null,
  });
});

/**
 * GET /healthz - Health check
 */
app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'lunoo-mcp' });
});

/**
 * Graceful error handling
 */
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large' });
    return;
  }

  if (err instanceof SyntaxError && err?.status === 400) {
    res.status(400).json({ error: 'Invalid JSON request body' });
    return;
  }

  console.error(err?.name || 'Unhandled MCP error');
  res.status(500).json({
    error: 'Internal server error',
  });
});

// ============================================================
// Start server
// ============================================================

function startServer() {
  return app.listen(PORT, HOST, () => {
    console.log(`LunooMCP server listening on ${HOST}:${PORT}`);
    console.log(`POST http://${HOST}:${PORT}/mcp - MCP endpoint`);
    console.log(`GET http://${HOST}:${PORT}/healthz - Health check`);
  });
}

function shouldStartServer(argvPath = process.argv[1], pmId = process.env.pm_id) {
  if (pmId !== undefined) {
    return true;
  }

  return Boolean(argvPath && import.meta.url === pathToFileURL(argvPath).href);
}

if (shouldStartServer()) {
  startServer();
}

export {
  app,
  allowClientRequest,
  buildUsageEvent,
  cacheEntryCount,
  clearCache,
  countToolResults,
  HOST,
  handleJsonRpc,
  handleInitialize,
  handleToolCall,
  handleToolsList,
  shouldStartServer,
  startServer,
  toolFindNiche,
  toolGetItem,
  toolGetRankings,
  TOOLS,
};
