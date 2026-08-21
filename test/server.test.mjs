import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';

const upstreamRequests = [];
const upstreamServer = createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  upstreamRequests.push({
    host: request.headers.host,
    method: request.method,
    path: requestUrl.pathname,
    query: requestUrl.search,
  });

  response.setHeader('access-control-allow-origin', '*');

  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: 'The test upstream is read-only.' }));
    return;
  }

  if (requestUrl.pathname === '/api/v1/niches') {
    response.setHeader('content-type', 'application/json');
    const query = requestUrl.searchParams.get('q');
    // Keep the fixture honest: the production API may return noisy substring
    // matches for compound requests, so the MCP resolver must also exercise
    // its public ranking-index fallback below.
    const results = query === 'anime'
      ? [{
        slug: 'anime',
        name: 'Anime',
        item_count: 4,
        url: 'https://lunoo.com/best/anime',
        json_url: 'https://lunoo.com/best/anime.json',
      }]
      : [];
    response.end(JSON.stringify({
      query,
      results,
    }));
    return;
  }

  if (requestUrl.pathname === '/sitemap-tags.xml') {
    response.setHeader('content-type', 'application/xml');
    response.end(`<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://lunoo.com/best/anime</loc></url>
        <url><loc>https://lunoo.com/best/laptop</loc></url>
        <url><loc>https://lunoo.com/best/video-editing</loc></url>
        <url><loc>https://lunoo.com/best/video-game</loc></url>
        <url><loc>https://lunoo.com/best/headphone</loc></url>
        <url><loc>https://lunoo.com/best/running-shoes</loc></url>
        <url><loc>https://lunoo.com/best/software</loc></url>
        <url><loc>https://lunoo.com/best/service</loc></url>
        <url><loc>https://lunoo.com/best/book</loc></url>
        <url><loc>https://lunoo.com/best/movie</loc></url>
        <url><loc>https://lunoo.com/best/music</loc></url>
        <url><loc>https://lunoo.com/best/game</loc></url>
        <url><loc>https://lunoo.com/best/travel</loc></url>
        <url><loc>https://lunoo.com/best/food</loc></url>
        <url><loc>https://lunoo.com/best/restaurant</loc></url>
      </urlset>`);
    return;
  }

  if (requestUrl.pathname === '/best/anime.json') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({
      name: 'Best Anime Rankings',
      item_count: 2,
      updated_at: '2026-08-12T12:00:00Z',
      average_score: 8.8,
      score_scale: '0-10',
      top_items: [
        {
          name: 'Frieren: Beyond Journey\'s End',
          slug: 'frieren-beyond-journeys-end',
          score: 9.2,
          description: 'A thoughtful fantasy adventure.',
          confidence: 'high',
        },
        {
          name: 'Princess Mononoke',
          slug: 'princess-mononoke',
          rating: 8.4,
          description: 'An ecological fantasy film.',
        },
      ],
    }));
    return;
  }

  const genericRanking = requestUrl.pathname.match(/^\/best\/([a-z0-9-]+)\.json$/i);
  if (genericRanking) {
    const slug = genericRanking[1].toLowerCase();
    const names = {
      laptop: 'Best Laptop Rankings',
      'video-editing': 'Best Video Editing Rankings',
      'video-game': 'Best Video Game Rankings',
      headphone: 'Best Headphone Rankings',
      'running-shoes': 'Best Running Shoes Rankings',
      software: 'Best Software Rankings',
      service: 'Best Service Rankings',
      book: 'Best Book Rankings',
      movie: 'Best Movie Rankings',
      music: 'Best Music Rankings',
      game: 'Best Game Rankings',
      travel: 'Best Travel Rankings',
      food: 'Best Food Rankings',
      restaurant: 'Best Restaurant Rankings',
    };
    if (names[slug]) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        name: names[slug],
        item_count: 12,
        updated_at: '2026-08-19T12:00:00Z',
        average_score: 8.4,
        score_scale: '0-10',
        top_items: [{
          name: `${slug} pick`,
          slug: `${slug}-pick`,
          score: 8.4,
          description: `A verified ${slug} ranking fixture.`,
          confidence: 'medium',
        }],
      }));
      return;
    }
  }

  if (requestUrl.pathname === '/item/frieren-beyond-journeys-end') {
    response.setHeader('content-type', 'text/html');
    response.end('<script type="application/ld+json">{"@context":"https://schema.org","@type":"Movie","name":"Frieren: Beyond Journey\'s End"}</script>');
    return;
  }

  response.statusCode = 404;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ error: 'Not found' }));
});

let mcpServer;
let mcpBaseUrl;
let serverModule;
const previousUpstreamBaseUrl = process.env.LUNOO_UPSTREAM_BASE_URL;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const listener = server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(listener);
    });
  });
}

function close(server) {
  if (!server?.listening) return Promise.resolve();

  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function callRpc(method, params, id) {
  const response = await fetch(`${mcpBaseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
  });

  assert.equal(response.status, 200);
  return response.json();
}

before(async () => {
  await listen(upstreamServer);
  const upstreamAddress = upstreamServer.address();
  process.env.LUNOO_UPSTREAM_BASE_URL = `http://127.0.0.1:${upstreamAddress.port}`;

  serverModule = await import('../server.mjs');
  mcpServer = await listen(serverModule.app);
  const mcpAddress = mcpServer.address();
  mcpBaseUrl = `http://127.0.0.1:${mcpAddress.port}`;
});

after(async () => {
  serverModule?.clearCache();
  if (mcpServer) await close(mcpServer);
  await close(upstreamServer);

  if (previousUpstreamBaseUrl === undefined) {
    delete process.env.LUNOO_UPSTREAM_BASE_URL;
  } else {
    process.env.LUNOO_UPSTREAM_BASE_URL = previousUpstreamBaseUrl;
  }
});

test('initialize returns the supported protocol and read-only workflow', async () => {
  const response = await callRpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'focused-test', version: '1.0.0' },
  }, 1);

  assert.equal(response.result.protocolVersion, '2025-03-26');
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(response.result.serverInfo.name, 'lunoo-rankings');
  assert.match(response.result.instructions, /find_niche first/);
  assert.match(response.result.instructions, /get_rankings/);
  assert.match(response.result.instructions, /Lunoo URLs/);
});

test('tools/list exposes read-only safety annotations for every tool', async () => {
  const response = await callRpc('tools/list', {}, 2);
  const tools = response.result.tools;

  assert.deepEqual(tools.map((tool) => tool.name), ['find_niche', 'get_rankings', 'get_item']);

  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.annotations.openWorldHint, true);
    assert.match(tool.description, /Lunoo URL/);
  }
});

test('tool calls resolve, rank, and describe items through a read-only upstream', async () => {
  serverModule.clearCache();
  upstreamRequests.length = 0;

  const nicheResponse = await callRpc('tools/call', {
    name: 'find_niche',
    arguments: { query: 'anime' },
  }, 3);
  const niches = JSON.parse(nicheResponse.result.content[0].text);
  assert.equal(nicheResponse.result.isError, false);
  assert.equal(niches[0].slug, 'anime');
  assert.equal(new URL(niches[0].url).pathname, '/best/anime');
  assert.equal(new URL(niches[0].rankings_json).pathname, '/best/anime.json');

  const rankingsResponse = await callRpc('tools/call', {
    name: 'get_rankings',
    arguments: { niche: niches[0].slug, limit: 2 },
  }, 4);
  const rankings = JSON.parse(rankingsResponse.result.content[0].text);
  assert.equal(rankingsResponse.result.isError, false);
  assert.equal(rankings.top_items.length, 2);
  assert.equal(rankings.top_items[0].rank, 1);
  assert.equal(new URL(rankings.top_items[0].url).pathname, '/item/frieren-beyond-journeys-end');
  assert.equal(new URL(rankings.top_items[1].url).pathname, '/item/princess-mononoke');
  assert.equal(new URL(rankings.url).pathname, '/best/anime');

  const itemResponse = await callRpc('tools/call', {
    name: 'get_item',
    arguments: { slug: 'frieren-beyond-journeys-end' },
  }, 5);
  const item = JSON.parse(itemResponse.result.content[0].text);
  assert.equal(itemResponse.result.isError, false);
  assert.equal(new URL(item.url).pathname, '/item/frieren-beyond-journeys-end');
  assert.equal(item.structured_data[0].name, 'Frieren: Beyond Journey\'s End');

  assert.ok(upstreamRequests.length >= 3);
  assert.ok(upstreamRequests.every((request) => request.method === 'GET'));
  assert.ok(upstreamRequests.every((request) => request.host.startsWith('127.0.0.1:')));
});

test('find_niche resolves compound use-case requests without substring noise', async () => {
  serverModule.clearCache();

  const response = await callRpc('tools/call', {
    name: 'find_niche',
    arguments: { query: 'best laptop for video editing' },
  }, 6);
  const niches = JSON.parse(response.result.content[0].text);

  assert.equal(response.result.isError, false);
  assert.equal(niches[0].slug, 'laptop');
  assert.equal(niches[1].slug, 'video-editing');
  assert.equal(niches.slice(0, 3).find((item) => item.slug === 'video-game'), undefined);
  assert.ok(niches[0].match_reason.includes('laptop'));
  assert.ok(['high', 'medium'].includes(niches[0].confidence));
  assert.ok(Array.isArray(niches[1].matched_terms));
});

test('find_niche repairs common misspellings through the public ranking index', async () => {
  serverModule.clearCache();

  const response = await callRpc('tools/call', {
    name: 'find_niche',
    arguments: { query: 'lptop vidio editng' },
  }, 7);
  const niches = JSON.parse(response.result.content[0].text);

  assert.equal(response.result.isError, false);
  assert.equal(niches[0].slug, 'laptop');
  assert.equal(niches[1].slug, 'video-editing');
  assert.ok(niches.every((item) => item.url.startsWith('https://lunoo.com/best/')));
});

test('find_niche keeps the product noun ahead of an audience or use-case term', async () => {
  serverModule.clearCache();

  const response = await callRpc('tools/call', {
    name: 'find_niche',
    arguments: { query: 'best headphones for running' },
  }, 10);
  const niches = JSON.parse(response.result.content[0].text);

  assert.equal(response.result.isError, false);
  assert.equal(niches[0].slug, 'headphone');
  assert.equal(niches[1].slug, 'running-shoes');
  assert.ok(niches[0].matched_terms.includes('headphone'));
});

test('find_niche rejects empty, gibberish, and unsupported input', async () => {
  serverModule.clearCache();

  for (const query of ['', 'xyzzy qqqq', '!@#$']) {
    const response = await callRpc('tools/call', {
      name: 'find_niche',
      arguments: { query },
    }, 8);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /No confident live Lunoo ranking/);
  }
});

test('get_rankings rejects a nonexistent niche instead of selecting a broad fallback', async () => {
  serverModule.clearCache();

  const response = await callRpc('tools/call', {
    name: 'get_rankings',
    arguments: { niche: 'definitely-not-a-real-niche', limit: 3 },
  }, 81);

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /No live Lunoo ranking could be resolved/);
});

test('tracked connector URLs preserve canonical paths and add attribution', async () => {
  const response = await callRpc('tools/call', {
    name: 'get_rankings',
    arguments: { niche: 'anime', limit: 1 },
  }, 82);
  const rankings = JSON.parse(response.result.content[0].text);
  const rankingUrl = new URL(rankings.url);
  const itemUrl = new URL(rankings.top_items[0].url);

  assert.equal(rankingUrl.pathname, '/best/anime');
  assert.equal(rankingUrl.searchParams.get('utm_source'), 'claude');
  assert.equal(rankingUrl.searchParams.get('utm_medium'), 'connector');
  assert.equal(rankingUrl.searchParams.get('utm_campaign'), 'lunoo_mcp');
  assert.equal(rankingUrl.searchParams.get('src'), 'claude_connector');
  assert.equal(itemUrl.searchParams.get('src'), 'claude_connector');
  assert.equal(rankings.citation_hint, 'Cite the ranking URL returned in this response.');
  assert.equal(rankings.citation_hint.includes('%20'), false);
});

test('CORS permits configured Claude origins, rejects arbitrary origins, and permits server clients without Origin', async () => {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'ping',
    params: {},
    id: 83,
  });
  const allowed = await fetch(`${mcpBaseUrl}/mcp`, {
    method: 'POST',
    headers: { origin: 'https://claude.ai', 'content-type': 'application/json' },
    body,
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://claude.ai');

  const rejected = await fetch(`${mcpBaseUrl}/mcp`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    body,
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);

  const serverClient = await fetch(`${mcpBaseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(serverClient.status, 200);
});

test('get_rankings resolves natural-language input and reports the selected live niche', async () => {
  serverModule.clearCache();

  const response = await callRpc('tools/call', {
    name: 'get_rankings',
    arguments: { niche: 'best laptop for video editing', limit: 1 },
  }, 9);
  const rankings = JSON.parse(response.result.content[0].text);

  assert.equal(response.result.isError, false);
  assert.equal(rankings.resolved_niche, 'laptop');
  assert.equal(rankings.resolution.matched_slug, 'laptop');
  assert.equal(new URL(rankings.url).pathname, '/best/laptop');
  assert.equal(rankings.top_items.length, 1);
});

test('MCP usage event contains counters but no prompt or result text', () => {
  const response = {
    jsonrpc: '2.0',
    result: {
      isError: false,
      content: [{
        type: 'text',
        text: JSON.stringify({ top_items: [{ name: 'One' }, { name: 'Two' }] }),
      }],
    },
    id: 12,
  };
  const event = serverModule.buildUsageEvent('tools/call', {
    name: 'get_rankings',
    arguments: { niche: 'private natural language request', limit: 2 },
  }, response);

  assert.deepEqual(event, {
    method: 'tools/call',
    tool_name: 'get_rankings',
    query_count: 1,
    tool_count: 1,
    result_count: 2,
    ok: true,
    error_code: null,
    client_name: null,
    client_version: null,
  });
  assert.equal(JSON.stringify(event).includes('private natural language request'), false);
  assert.equal(JSON.stringify(event).includes('One'), false);
});

test('initialize usage keeps bounded client metadata without request details', () => {
  const event = serverModule.buildUsageEvent('initialize', {
    clientInfo: { name: 'test-client', version: '1.2.3' },
  }, { jsonrpc: '2.0', result: {}, id: 13 });

  assert.equal(event.method, 'initialize');
  assert.equal(event.client_name, 'test-client');
  assert.equal(event.client_version, '1.2.3');
  assert.equal(event.query_count, 0);
  assert.equal(event.result_count, 0);
});

test('PM2 wrapper launches the HTTP server even when argv points at its process container', () => {
  assert.equal(serverModule.shouldStartServer('/usr/lib/node_modules/pm2/ProcessContainerFork.js', '3'), true);
  assert.equal(serverModule.shouldStartServer('/usr/lib/node_modules/pm2/ProcessContainerFork.js', undefined), false);
});
