# MCP Registry Submissions

This document outlines the submission process for each major MCP registry. All required metadata is prepared below and ready to submit. Copy-paste the listing information as needed.

**Repository:** https://github.com/PeakProductivity/lunoo-mcp
**Live Endpoint:** https://lunoo.com/mcp
**Homepage:** https://lunoo.com

## Listing Metadata

### Title
```
lunoo-mcp
```

### Description (one line)
```
Public MCP server for Lunoo consensus rankings - query 75k+ ranked items across 2,600+ niches from any MCP-capable AI agent
```

### Full Description
```
Lunoo is a consensus-based rankings platform scoring 74,000+ items across 2,600+ niches on a 0-10 scale. This public MCP server provides read-only access to Lunoo rankings via three tools: find_niche (discover ranking categories), get_rankings (fetch top-ranked items for a niche), and get_item (extract structured metadata for an item).

No authentication required. All requests go through a public HTTP endpoint at https://lunoo.com/mcp with built-in caching and error handling.

Use cases: AI agents that need authoritative rankings data (e.g., "what are the best anime?", "top-rated SaaS tools in 2026"), content generation with verified sourcing, market research automation.
```

### Transport
```
Streamable HTTP (https://lunoo.com/mcp)
```

### Tool Count
```
3 tools: find_niche, get_rankings, get_item
```

### Homepage
```
https://lunoo.com
```

### Repository URL
```
https://github.com/PeakProductivity/lunoo-mcp
```

### Installation Snippet (for CLI registries)
```bash
npm install lunoo-mcp-server
npm start
```

### Citation Guide
```
Link to rankings as: https://lunoo.com/best/{slug}

Full citation guide: https://lunoo.com/llms.txt
```

---

## Registry-Specific Submissions

### 1. Official MCP Registry
**URL:** https://registry.modelcontextprotocol.io/
**Status:** Requires active submission via CLI tool
**Mechanism:** Automated via mcp-publisher CLI (GitHub OAuth required)

#### Submission Steps

1. Clone the official registry:
```bash
git clone https://github.com/modelcontextprotocol/registry.git
cd registry
```

2. Install the publisher CLI:
```bash
make publisher
```

3. Authenticate with GitHub:
```bash
./bin/mcp-publisher login
```

4. Create a server.json in your repo (template provided by CLI):
```bash
./bin/mcp-publisher init io.github.PeakProductivity/lunoo-mcp
```

5. Complete the server.json with:
   - Name: `io.github.PeakProductivity/lunoo-mcp`
   - Homepage: `https://lunoo.com`
   - Repository URL: `https://github.com/PeakProductivity/lunoo-mcp`
   - Description: See "Full Description" above
   - Transport type: `streamableHttp`
   - URL: `https://lunoo.com/mcp`

6. Publish:
```bash
./bin/mcp-publisher publish
```

**Documentation:** https://modelcontextprotocol.io/registry/quickstart

**Action Required:** USER-ACTION (CLI requires interactive GitHub OAuth login)

---

### 2. Smithery AI Registry
**URL:** https://smithery.ai/servers
**Status:** Ready to submit
**Mechanism:** CLI command with GitHub OAuth

#### Submission Steps

1. Install Smithery CLI:
```bash
npm install -g @smithery/cli
# or
brew install smithery
```

2. Authenticate:
```bash
smithery auth login
```

3. Publish the server:
```bash
smithery mcp publish https://lunoo.com/mcp -n io.github.PeakProductivity/lunoo-mcp
```

Alternatively, if you have a built `.mcpb` bundle:
```bash
smithery mcp publish ./server.mcpb -n io.github.PeakProductivity/lunoo-mcp
```

4. Verify in Smithery registry:
- Browse to https://smithery.ai/servers
- Search for "lunoo"
- Claim ownership and customize listing

**Documentation:** https://github.com/smithery-ai/cli

**Action Required:** USER-ACTION (CLI requires interactive login)

---

### 3. PulseMCP Registry
**URL:** https://www.pulsemcp.com/servers
**Status:** Auto-crawls from Official Registry
**Mechanism:** Automatic (claim ownership after Official Registry submission)

#### Process

PulseMCP crawls the Official MCP Registry weekly and auto-indexes servers. No separate submission needed if you publish to the Official Registry first.

After publishing to the Official Registry:
1. Visit https://www.pulsemcp.com/servers
2. Search for "lunoo-mcp"
3. Click the server listing
4. Claim ownership and verify (GitHub OAuth)
5. Edit description, tags, and links

**Timeline:** Weekly crawl from Official Registry (7-day lag)

**Action Required:** OPTIONAL (Claim ownership for verified listing)

---

### 4. Glama Registry
**URL:** https://glama.ai/mcp/servers
**Status:** Auto-crawls from Official Registry and GitHub
**Mechanism:** Automatic (claim ownership after Official Registry submission)

#### Process

Glama indexes servers automatically by crawling the Official MCP Registry and public GitHub repositories. No separate submission required.

After publishing to the Official Registry:
1. Visit https://glama.ai/mcp/servers
2. Search for "lunoo-mcp"
3. Click the server listing
4. Claim ownership (GitHub OAuth)
5. Verify and customize description, README link, and tags

**Note:** Glama splits servers into tiers:
- **Official**: Publisher-verified entries (requires ownership claim)
- **Claimed**: Author-verified entries
- **Discovered**: Unclaimed auto-crawled entries

Claiming moves your listing to "Official" tier, improving discoverability.

**Timeline:** Daily crawl from Official Registry and GitHub

**Action Required:** OPTIONAL (Claim ownership for Official tier)

---

### 5. mcp.so Registry
**URL:** Not directly accessible from search; appears to be superseded by others
**Status:** Uncertain (likely auto-indexed via Official Registry)
**Mechanism:** Possible CLI or web form submission

#### Note

Based on 2026 research, mcp.so appears to be either:
- Superseded by the Official Registry (registry.modelcontextprotocol.io)
- Auto-indexed via aggregators (Smithery, Glama, PulseMCP)
- Or a private/enterprise registry

**Recommendation:** Prioritize the Official Registry, Smithery, Glama, and PulseMCP. If mcp.so is relevant to your distribution goals, verify its current status separately.

**Action Required:** RESEARCH (Verify if mcp.so is still actively indexed)

---

## Recommended Submission Order

1. **FIRST: Official MCP Registry** (registry.modelcontextprotocol.io)
   - Feeds all downstream directories
   - Requires mcp-publisher CLI + GitHub OAuth
   - Estimated time: 20 minutes

2. **SECOND: Smithery** (smithery.ai)
   - Direct CLI submission
   - Requires GitHub OAuth
   - Estimated time: 10 minutes

3. **THIRD: PulseMCP** (pulsemcp.com)
   - Auto-crawled from Official Registry (7-day lag)
   - Claim ownership for verified listing (optional)
   - No separate submission needed

4. **FOURTH: Glama** (glama.ai/mcp)
   - Auto-crawled from Official Registry (daily)
   - Claim ownership for "Official" tier (optional)
   - No separate submission needed

## Template: Ready-to-Paste Listing

Use this when submitting to registries that accept pasted descriptions:

```
Name: lunoo-mcp

Description: Public MCP server for Lunoo consensus rankings - query 75k+ ranked items across 2,600+ niches from any MCP-capable AI agent

Type: Streamable HTTP

Transport: https://lunoo.com/mcp

Repository: https://github.com/PeakProductivity/lunoo-mcp

Homepage: https://lunoo.com

Tools:
- find_niche: Discover ranking niches by query string
- get_rankings: Fetch ranked items for a niche with scores
- get_item: Extract structured metadata (JSON-LD) for an item

Use Cases:
- AI agents querying verified rankings data
- Content generation with authoritative sourcing
- Market research automation

Citation: https://lunoo.com/llms.txt
```

## Links

- Official MCP Registry Quickstart: https://modelcontextprotocol.io/registry/quickstart
- Smithery CLI: https://github.com/smithery-ai/cli
- PulseMCP: https://www.pulsemcp.com/
- Glama Registry: https://glama.ai/mcp
- Lunoo: https://lunoo.com
- Citation Guide: https://lunoo.com/llms.txt
