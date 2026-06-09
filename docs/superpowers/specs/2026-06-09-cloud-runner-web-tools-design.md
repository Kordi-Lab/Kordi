# Cloud Runner Web Tools Design

## Goal

Make scheduled Cloud jobs able to perform ordinary public web research from the Cloud sandbox by exposing the same first-party `web_search` and `web_fetch` tools that local agents already use.

## Scope

In scope for this first pass:

- Add `web_search` to the Cloud runner model tool catalog.
- Add `web_fetch` to the Cloud runner model tool catalog.
- Execute both tools through the existing `kordi-tools` implementations:
  - `WebSearchTool` DuckDuckGo HTML fallback.
  - `WebFetchTool` public URL fetch and content extraction.
- Keep Cloud runner safety policy in front of the calls so localhost, private network, file URLs, and owner-local resources remain blocked.
- Format tool outputs as model-readable text.
- Add regression tests proving Cloud runner executes real web tools instead of returning only the policy placeholder.

Out of scope:

- `browser_fetch` / headless browser support.
- Authenticated web, local browser cookies, owner laptop files, or private-network access.
- New hosted-search provider plumbing beyond the existing `kordi-tools` fallback behavior.

## Architecture

The Cloud runner already has three relevant pieces:

1. `prompt::tool_catalog()` advertises tools to the model.
2. `tool_policy::decide_runner_tool()` allows `web_search` and `web_fetch` for public web targets.
3. `CloudToolExecutor::execute()` dispatches actual tool calls.

The current bug is that (1) omits web tools and (3) returns `RemoteWebAllowed` as a placeholder instead of executing them.

The fix is to extend the executor with a minimal non-interactive `ToolContext` rooted in the sandbox workspace and call the first-party tools directly. This avoids duplicating DuckDuckGo/fetch code and keeps behavior consistent with local agent runs.

## Data Flow

For `web_search`:

1. Model calls `web_search({ query, allowed_domains?, blocked_domains? })`.
2. Cloud runner policy allows it because it has no private URL target.
3. Executor invokes `kordi_tools::WebSearchTool.execute(...)` with the original JSON arguments.
4. Executor returns the text result to the model.

For `web_fetch`:

1. Model calls `web_fetch({ url, max_chars?, timeout? })`.
2. Executor extracts the URL into `RunnerToolRequest.url_args`.
3. Policy blocks private/local URLs before execution.
4. Executor invokes `kordi_tools::WebFetchTool.execute(...)` with the original JSON arguments.
5. Executor returns the extracted page text and citation information to the model.

## Error Handling

- Invalid tool arguments return the underlying `kordi-tools` tool error text.
- Policy-blocked private URLs remain blocked before HTTP requests are attempted.
- Network/search failures are returned to the model as tool output, allowing the model to explain the limitation or try another public source.
- The Cloud model loop still has finite caps to prevent runaway tool usage.

## Testing

Add Cloud runner tests for:

- `tool_catalog()` includes `web_search` and `web_fetch` schemas.
- `web_fetch` executes a local test HTTP server through `CloudToolExecutor` and returns fetched content.
- `web_fetch` private URLs remain blocked.
- `web_search` is routed to the real first-party tool path rather than `RemoteWebAllowed` placeholder; use a controlled test path where possible and avoid brittle live-web assertions.

## Deployment / Dogfood

After implementation:

1. Run Cloud runner unit/integration tests.
2. Deploy `kordi-cloud-agent-runner` to `takotako` with a new image tag.
3. Replay the failed scheduled OpenAI-news task.
4. Verify the new Cloud fallback run completes and its response includes current-source links or a concrete search/fetch result.
