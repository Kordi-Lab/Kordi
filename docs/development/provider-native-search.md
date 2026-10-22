# Provider-native web search

Kordi's host-admitted `web_search` tool attempts hosted search on the selected
provider before reading the DuckDuckGo fallback cache or making a fallback request.
OMP still owns the model loop; the host owns permission checks, tool lifecycle,
and search execution. A search does not discover credentials or select a different
account, provider, or model.

| Selected route | Native search | Domain filters |
| --- | --- | --- |
| OpenAI Codex OAuth | Responses hosted web search | Allowlist |
| OpenAI API, GPT-5 and GPT-6 at the standard endpoint | Responses hosted web search | Allowlist |
| Anthropic | Hosted web search | Allowlist or blocklist |
| Google API key | Google Search grounding | None |
| Other routes or unsupported filters | DuckDuckGo HTML fallback | Allowlist or blocklist |

The native request contains only the search query and a fixed search instruction,
not the conversation history. It preserves the selected route's endpoint, auth
method, account ID, headers, and model. Desktop, CLI, TUI, and the cloud runner
supply this resolved route to the same tool implementation.

Native searches have a 40-second deadline, propagate cancellation, and disable
transport retries. Authentication, provider, timeout, and empty-source errors are
reported without response bodies or credentials. They do not silently trigger
another provider request. Unsupported routes and filters use the existing bounded
DuckDuckGo path. Native results are not stored in its global fallback cache.

Official source metadata is retained from Responses search actions and citation
annotations, Anthropic search results, and Gemini grounding chunks. The collector
requires matching HTTP(S) source URLs, deduplicates them, and returns the summary
with explicit source links. Text without sources is not treated as a successful
search. Existing tool accounting remains in the host.

Tests use synthetic credentials and loopback HTTP fixtures; no signed-in account
or external search service is needed.

## References

- [OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [Codex web search modes](https://learn.chatgpt.com/docs/config-file/config-basic#web-search-mode)
- [oh-my-pi search orchestration](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/web/search/index.ts)
- [oh-my-pi Codex native search](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/web/search/providers/codex.ts)
