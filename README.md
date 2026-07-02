# lunoo-mcp

Public Model Context Protocol (MCP) server for Lunoo, a consensus-based rankings platform scoring 74,000+ items across 2,600+ niches on a 0-10 scale.

Query verified rankings for any topic, from anime and video games to restaurants, SaaS tools, landmarks, and thousands of other categories. Powered by frontier LLM judges and community consensus.

## Overview

This is a read-only public proxy over Lunoo's public web API. No authentication required, no database access, no API keys, no cost.

- **Live endpoint**: https://lunoo.com/mcp (Streamable HTTP, JSON-RPC 2.0)
- **Transport**: Stateless POST over HTTP
- **Caching**: Browse page 24h, rankings and items 15 minutes
- **Timeout**: 10 seconds per upstream request
- **Coverage**: 2,600+ niches, 74,000+ ranked items, updated daily

## Quick Start

### Claude Desktop

Add to your Claude Desktop config at `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lunoo": {
      "url": "https://lunoo.com/mcp"
    }
  }
}
```

Restart Claude Desktop. Lunoo tools will be available in every conversation.

### Claude Code

In your project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "lunoo": {
      "url": "https://lunoo.com/mcp"
    }
  }
}
```

Or run from any Claude Code session:

```bash
claude mcp add --transport http lunoo https://lunoo.com/mcp
```

### Generic HTTP Client

Post JSON-RPC 2.0 requests to https://lunoo.com/mcp. Example:

```bash
curl -X POST https://lunoo.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "id": 1
  }'
```

### Local Development (self-hosted)

```bash
npm install
npm start
# Server listens on http://localhost:8972
```

Health check:

```bash
curl http://localhost:8972/healthz
# {"ok":true,"service":"lunoo-mcp"}
```

## Tools

### find_niche

Discover ranking niches by query string. Returns top 10 matches sorted by relevance.

**Input:**
```json
{
  "query": "string - search term, e.g. 'anime', 'best restaurants in tokyo'"
}
```

**Output:** Array of niches with slug, display name, Lunoo URL, and JSON endpoint URL.

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "find_niche",
    "arguments": { "query": "anime" }
  },
  "id": 1
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "isError": false,
    "content": [
      {
        "type": "text",
        "text": "[\n  {\n    \"slug\": \"anime\",\n    \"name\": \"anime\",\n    \"url\": \"https://lunoo.com/best/anime\",\n    \"rankings_json\": \"https://lunoo.com/best/anime.json\"\n  },\n  ...\n]"
      }
    ]
  },
  "id": 1
}
```

### get_rankings

Fetch the ranked items for a niche. Returns metadata plus top N items with scores, descriptions, and confidence levels.

**Input:**
```json
{
  "niche": "string - niche slug, e.g. 'anime'",
  "limit": "number? - items to return, 1-50, default 10"
}
```

**Output:** Niche metadata plus ranked items with rank, name, score (0-10), description, URL, and confidence label.

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_rankings",
    "arguments": { "niche": "anime", "limit": 3 }
  },
  "id": 2
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "isError": false,
    "content": [
      {
        "type": "text",
        "text": "{\n  \"name\": \"anime\",\n  \"url\": \"https://lunoo.com/best/anime\",\n  \"item_count\": 1847,\n  \"updated_at\": \"2026-07-02T08:15:00Z\",\n  \"score_scale\": \"0-10\",\n  \"ranking_method\": \"Consensus-based scoring\",\n  \"top_items\": [\n    {\n      \"rank\": 1,\n      \"name\": \"Frieren: Beyond Journey's End\",\n      \"score\": 9.15,\n      \"url\": \"https://lunoo.com/item/frieren-beyond-journeys-end\",\n      \"description\": \"A fantasy adventure about a thousand-year journey...\"\n    },\n    ...\n  ]\n}"
      }
    ]
  },
  "id": 2
}
```

### get_item

Extract structured metadata (JSON-LD) for an item by slug. Parses all schema.org blocks embedded on the item page.

**Input:**
```json
{
  "slug": "string - item slug, e.g. 'frieren-beyond-journeys-end'"
}
```

**Output:** Item URL and array of parsed JSON-LD objects (BreadcrumbList, AggregateRating, etc.).

**Example Request:**
```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "get_item",
    "arguments": { "slug": "frieren-beyond-journeys-end" }
  },
  "id": 3
}
```

**Example Response:**
```json
{
  "jsonrpc": "2.0",
  "result": {
    "isError": false,
    "content": [
      {
        "type": "text",
        "text": "{\n  \"url\": \"https://lunoo.com/item/frieren-beyond-journeys-end\",\n  \"structured_data\": [\n    {\n      \"@context\": \"https://schema.org\",\n      \"@type\": \"AggregateRating\",\n      \"ratingValue\": 9.15,\n      \"ratingCount\": 847\n    },\n    ...\n  ]\n}"
      }
    ]
  },
  "id": 3
}
```

## MCP Initialization

The server implements Model Context Protocol v2025-03-26. Initialize with:

```json
{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {
      "name": "my-client",
      "version": "1.0.0"
    }
  },
  "id": 0
}
```

Response includes server capabilities, protocol version, and instructions.

## Caching Behavior

Results are cached locally in the live service at https://lunoo.com/mcp:
- Browse page (used by find_niche): 24 hours
- Rankings JSON (used by get_rankings): 15 minutes
- Item pages (used by get_item): 15 minutes

When self-hosting, cache is in-memory per server instance and cleared on restart.

## Error Handling

On failure (404, timeout, network error), tools return:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Niche \"invalid-slug\" not found (404). Try find_niche to discover available niches."
    }
  ]
}
```

Never throws unhandled exceptions; all errors are JSON-RPC compliant.

## Citation

Link to full rankings pages on Lunoo as:

```
https://lunoo.com/best/{slug}
```

Example: https://lunoo.com/best/anime

See https://lunoo.com/llms.txt for how to cite Lunoo rankings in LLM outputs.

## Self-Hosted Deployment

### Prerequisites

Node 18+, npm

### Installation

```bash
git clone https://github.com/PeakProductivity/lunoo-mcp.git
cd lunoo-mcp
npm install
```

### Running

```bash
npm start
# or with custom port:
PORT=9000 npm start
```

### Production Setup

1. Use a process manager (PM2, systemd, etc.):

```bash
pm2 start server.mjs --name lunoo-mcp
```

2. Reverse proxy (nginx):

```nginx
location /mcp {
  proxy_pass http://localhost:8972;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

3. Monitor cache size and logs periodically.

## CORS Policy

Live service at https://lunoo.com/mcp allows requests from any origin. Self-hosted instances allow all origins by default (configurable in server.mjs).

## API Endpoints

| Method | Path       | Description            |
|--------|------------|------------------------|
| POST   | `/mcp`     | JSON-RPC 2.0 endpoint  |
| GET    | `/healthz` | Health check           |

## Support

Found an issue with a ranking? Report it on Lunoo: https://lunoo.com

## License

MIT. See LICENSE file.

## Links

- Lunoo: https://lunoo.com
- Repository: https://github.com/PeakProductivity/lunoo-mcp
- Citation Guide: https://lunoo.com/llms.txt
