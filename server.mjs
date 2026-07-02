import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 8972;

app.use(cors({
  origin: '*',
  credentials: false,
  exposedHeaders: ['mcp-session-id', 'mcp-protocol-version', 'content-type'],
  allowedHeaders: ['mcp-session-id', 'mcp-protocol-version', 'content-type'],
}));
app.use(express.json());

// ============================================================
// Cache layer with TTL
// ============================================================
const cache = new Map();

function getCached(key, ttlMs) {
  const entry = cache.get(key);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.value;
  }
  if (entry) {
    cache.delete(key);
  }
  return null;
}

function setCached(key, value, ttlMs) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

// ============================================================
// Fetch wrapper with timeout, User-Agent, error handling
// ============================================================
async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'LunooMCP/1.0 (+https://lunoo.com)',
      },
    });

    clearTimeout(timeoutId);

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
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      return {
        ok: false,
        status: 0,
        error: 'Request timeout (10s)',
      };
    }
    return {
      ok: false,
      status: 0,
      error: err.message || String(err),
    };
  }
}

// ============================================================
// Tool implementations
// ============================================================

/**
 * find_niche: Query string -> resolve to best-matching niche slug(s)
 * Fetches /browse, extracts links, scores by match quality
 */
async function toolFindNiche(query) {
  const cacheKey = 'browse_page';
  const cacheTTL = 24 * 60 * 60 * 1000; // 24 hours

  let browseHtml = getCached(cacheKey, cacheTTL);

  if (!browseHtml) {
    const result = await fetchWithTimeout('https://lunoo.com/browse');
    if (!result.ok) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Failed to fetch /browse: ${result.error}`,
          },
        ],
      };
    }
    browseHtml = result.data;
    setCached(cacheKey, browseHtml, cacheTTL);
  }

  // Extract all links matching /best/{slug}
  const linkRegex = /href="(https?:\/\/lunoo\.com)?\/best\/([^"?#\s]+)"/g;
  const matches = [];
  let match;
  while ((match = linkRegex.exec(browseHtml)) !== null) {
    const slug = decodeURIComponent(match[2]);
    matches.push(slug);
  }

  // Deduplicate
  const uniqueSlugs = [...new Set(matches)];

  // Tokenize query
  const queryTokens = query.toLowerCase().trim().split(/\s+/);

  // Score each niche
  const scored = uniqueSlugs.map((slug) => {
    let score = 0;

    // Exact match
    if (slug.toLowerCase() === query.toLowerCase()) {
      score += 1000;
    }

    // Exact slug match (case-insensitive)
    if (slug.toLowerCase() === query.toLowerCase()) {
      score += 500;
    }

    // Substring match
    if (slug.toLowerCase().includes(query.toLowerCase())) {
      score += 100;
    }

    // Token overlap
    const slugTokens = slug.toLowerCase().split(/[-_\s]+/);
    const overlap = queryTokens.filter((t) =>
      slugTokens.some((s) => s.includes(t) || t.includes(s))
    ).length;
    score += overlap * 10;

    return { slug, score, name: slug };
  });

  scored.sort((a, b) => b.score - a.score);
  const top10 = scored.filter((s) => s.score > 0).slice(0, 10);

  if (top10.length === 0) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `No niches found matching "${query}". Try a broader term like "anime", "game", or "restaurant".`,
        },
      ],
    };
  }

  const result = top10.map((item) => ({
    slug: item.slug,
    name: item.name,
    url: `https://lunoo.com/best/${encodeURIComponent(item.slug)}`,
    rankings_json: `https://lunoo.com/best/${encodeURIComponent(item.slug)}.json`,
  }));

  return {
    isError: false,
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

/**
 * get_rankings: Fetch rankings for a niche
 * Returns top N items with score, description, etc.
 */
async function toolGetRankings(niche, limit = 10) {
  if (!niche || typeof niche !== 'string') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'niche parameter is required and must be a string' }],
    };
  }

  limit = Math.min(Math.max(limit || 10, 1), 50);
  const cacheKey = `rankings_${niche}`;
  const cacheTTL = 15 * 60 * 1000; // 15 minutes

  let rankings = getCached(cacheKey, cacheTTL);

  if (!rankings) {
    const url = `https://lunoo.com/best/${encodeURIComponent(niche)}.json`;
    const result = await fetchWithTimeout(url);

    if (!result.ok) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Niche "${niche}" not found (404). Try find_niche to discover available niches.`,
          },
        ],
      };
    }

    rankings = result.data;
    setCached(cacheKey, rankings, cacheTTL);
  }

  // Process response (live payload uses top_items)
  const items = rankings.top_items || rankings.ranking || rankings.items || [];
  const topItems = items.slice(0, limit).map((item, idx) => ({
    rank: idx + 1,
    name: item.name || item.title || 'Unknown',
    url: item.url || `https://lunoo.com/item/${encodeURIComponent(item.slug || '')}`,
    score: item.score !== undefined ? item.score : item.rating,
    description: (item.description || '')
      .split(/\s+/)
      .slice(0, 30)
      .join(' ')
      .substring(0, 200),
    ranking_confidence: item.confidence || item.ranking_confidence || 'unknown',
  }));

  const output = {
    name: rankings.name || rankings.title || niche,
    url: `https://lunoo.com/best/${encodeURIComponent(niche)}`,
    item_count: rankings.item_count || rankings.total_items || items.length,
    updated_at: rankings.updated_at || rankings.lastUpdated || 'unknown',
    average_score: rankings.average_score || 'N/A',
    score_scale: rankings.score_scale || '0-10',
    citation_hint: rankings.citation_hint || `https://lunoo.com/best/${encodeURIComponent(niche)}`,
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
  if (!slug || typeof slug !== 'string') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'slug parameter is required and must be a string' }],
    };
  }

  const cacheKey = `item_${slug}`;
  const cacheTTL = 15 * 60 * 1000; // 15 minutes

  let html = getCached(cacheKey, cacheTTL);

  if (!html) {
    const url = `https://lunoo.com/item/${encodeURIComponent(slug)}`;
    const result = await fetchWithTimeout(url);

    if (!result.ok) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Item "${slug}" not found (404). Verify the slug and try again.`,
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
    url: `https://lunoo.com/item/${encodeURIComponent(slug)}`,
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

const TOOLS = [
  {
    name: 'find_niche',
    description: 'Find a niche by query string. Returns top 10 matching niches with slugs and URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (e.g., "anime", "restaurants in Paris")',
        },
      },
      required: ['query'],
    },
    handler: (args) => toolFindNiche(args.query),
  },
  {
    name: 'get_rankings',
    description: 'Fetch rankings for a niche. Returns top N items with scores, descriptions, and URLs.',
    inputSchema: {
      type: 'object',
      properties: {
        niche: {
          type: 'string',
          description: 'Niche slug (e.g., "anime", "japanese-city")',
        },
        limit: {
          type: 'number',
          description: 'Number of items to return (1-50, default 10)',
          default: 10,
        },
      },
      required: ['niche'],
    },
    handler: (args) => toolGetRankings(args.niche, args.limit || 10),
  },
  {
    name: 'get_item',
    description: 'Fetch structured data (JSON-LD) for an item by slug. Useful for extracting metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'Item slug (e.g., "frieren-beyond-journeys-end")',
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

async function handleJsonRpc(message) {
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
    switch (method) {
      case 'initialize':
        return handleInitialize(params, id);

      case 'ping':
        return { jsonrpc: '2.0', result: {}, id };

      case 'tools/list':
        return handleToolsList(id);

      case 'tools/call':
        return await handleToolCall(params, id);

      default:
        return {
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${method}` },
          id,
        };
    }
  } catch (err) {
    console.error('Handler error:', err);
    return {
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Internal server error',
        data: { error: err.message },
      },
      id,
    };
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
      instructions: `Lunoo is a consensus rankings platform scoring 74,000+ items across 2,600+ niches on a 0-10 scale. Typical usage: call find_niche to resolve a query string to a niche slug, then get_rankings to fetch top items. Cite pages as https://lunoo.com/best/{slug}.`,
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
        inputSchema: tool.inputSchema,
      })),
    },
    id,
  };
}

async function handleToolCall(params, id) {
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

  const result = await tool.handler(args || {});

  return {
    jsonrpc: '2.0',
    result,
    id,
  };
}

// ============================================================
// HTTP endpoints
// ============================================================

/**
 * POST /mcp — Stateless JSON-RPC endpoint
 * Handle requests and return responses
 */
app.post('/mcp', async (req, res) => {
  try {
    const body = req.body;

    if (!Array.isArray(body)) {
      // Single request; notifications get 202 with no body
      const response = await handleJsonRpc(body);
      if (response === null) return res.status(202).end();
      return res.json(response);
    } else {
      // Batch (spec-compliant); drop notification slots
      const responses = [];
      for (const msg of body) {
        const response = await handleJsonRpc(msg);
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
 * GET /mcp — Method not allowed (standard MCP behavior)
 */
app.get('/mcp', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'Method not allowed' },
    id: null,
  });
});

/**
 * DELETE /mcp — Method not allowed
 */
app.delete('/mcp', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'Method not allowed' },
    id: null,
  });
});

/**
 * GET /healthz — Health check
 */
app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'lunoo-mcp' });
});

/**
 * Graceful error handling
 */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// ============================================================
// Start server
// ============================================================
app.listen(PORT, () => {
  console.log(`LunooMCP server listening on port ${PORT}`);
  console.log(`POST http://localhost:${PORT}/mcp — MCP endpoint`);
  console.log(`GET http://localhost:${PORT}/healthz — Health check`);
});
