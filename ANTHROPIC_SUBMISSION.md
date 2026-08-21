# Anthropic Connector Submission

## Listing

**Name:** Lunoo Rankings

**Remote MCP URL:** https://lunoo.com/mcp

**Short description:** Find ranked products, entertainment, software, travel options, and more through Lunoo's read-only ranking tools.

**Full description:** Lunoo Rankings helps Claude resolve normal-language discovery requests to live Lunoo categories, fetch scored results, and retrieve public item details. It covers more than 231,000 ranked items across more than 2,600 categories. The connector has no write actions and requires no login.

**Homepage:** https://lunoo.com

**Privacy policy:** https://lunoo.com/privacy

**Source repository:** https://github.com/PeakProductivity/lunoo-mcp

**Authentication:** None

**Transport:** Streamable HTTP

## Tools

- `find_niche` resolves a normal-language request to matching live categories and explains the match.
- `get_rankings` returns scored results for a category slug or normal-language request.
- `get_item` returns public structured data for a ranked item.

All tools declare read-only behavior. They do not create, change, or delete user data.

## Data handling

Lunoo stores aggregate connector usage fields such as tool name, success, latency, result count, client surface, and a coarse first-landing source. It does not store raw prompts, tool arguments, or tool results. Connector telemetry is retained for 90 days. Returned Lunoo links include connector attribution parameters. Full details and deletion contact information are in the privacy policy.

## Reviewer tests

1. Ask: `Use Lunoo to find the best laptop for video editing.` Expected: Claude resolves the laptop category and returns ranked results with Lunoo links.
2. Ask: `Use Lunoo to show the top three anime.` Expected: Claude calls `get_rankings` and preserves the scores returned by Lunoo.
3. Ask: `Use Lunoo to tell me about the top ranked laptop.` Expected: Claude calls `get_item` for a returned item and cites its Lunoo page.
4. Ask: `Use Lunoo to rank zzzzqxxv nonentity.` Expected: the tool reports that no confident live ranking exists and does not invent a category.

## Verified review checklist

- The public endpoint initializes with MCP protocol version `2025-03-26`.
- All three tools expose read-only annotations.
- Requests from approved Claude origins receive an exact matching CORS origin.
- Arbitrary browser origins receive HTTP 403.
- Server clients without an Origin header are accepted.
- Natural-language requests, tracked links, unsupported requests, and all three tools have automated regression coverage.
- The public privacy policy describes connector telemetry, 90-day retention, attribution, and deletion requests.
- The live server records aggregate usage without raw prompts, arguments, or result text.
