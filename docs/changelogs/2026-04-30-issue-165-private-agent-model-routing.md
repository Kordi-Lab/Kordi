# Issue #165 – Private Bridge agent model routing

- Added per-owned-Bridge-agent default model, fallback model, auth source/account, and thinking settings.
- Exposed private model controls in shared/Bridge chat composers without syncing model-change notices into shared history.
- Routed inbound Bridge agent asks through the selected agent route, including its private auth source/account, retrying the fallback route when the default fails or returns no text.
- Preserved local-only owned-agent thinking/tool details when Bridge relay history catches up after completion, including shared-chat local-agent turns that finish outside the normal chat-state refresh path.
- Reconciled stale shared-chat `processing...` Bridge placeholders into the completed local-agent response instead of rendering them as extra turns.
- Added an Agents-page Model routing section for owned Bridge agents and surfaced it at the top of the inspector so default/backbone, fallback, and thinking settings are immediately visible.
- Matched the Agent inspector routing controls to the app popover style and let long auth/provider/model names wrap instead of truncating with ellipses.
- Distinguished account-backed routes such as ChatGPT subscription, OpenAI API key, Claude subscription, and Anthropic API key instead of collapsing them to a generic provider label.
- Made Agent inspector route selection instant and local-draft based, with an explicit Save routing button so slow persistence only happens once the user commits changes.
- Fixed a #146/#162 unread conflict where canonical Bridge sessions with both Bridge transport and local runtime sources could hide real unread badges, then keep stale local unread after the conversation was opened.
- Made private chat routing confirmation banners auto-dismiss after two seconds with a short fade-out that respects reduced motion.
- Fixed the owner-side duplicate local-agent response regression where Bridge relay text collapsed whitespace (`it.Today`) and bypassed the existing rich-runtime duplicate suppression.
