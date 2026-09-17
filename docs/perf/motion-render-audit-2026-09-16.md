# Motion & render audit — iOS and macOS — 2026-09-16

Scope: avoid transcript/navigation "jumps," make message sending feel smooth, and reduce unnecessary
SwiftUI/React re-renders across the whole app (not just the chat screen). Four full audits were run:
iOS conversation timeline + send path, iOS app shell/navigation, desktop transcript + send path, and
desktop app shell/navigation. All four completed (the desktop shell/navigation audit failed twice on
session limits before succeeding on a retry).

Branch: `perf/motion-render-optimization`, based on `origin/main` at `888e4051f`.

## What shipped in this pass (verified)

All eleven changes are additive/behavior-preserving. Each was checked against the project's own
regression suite before being kept. Items 1-5 were the first batch (send-path smoothness and the
concurrent send/receive reorder bug); items 6-11 are a second batch addressing the user's follow-up
request to also smooth page/conversation switching and message loading on both platforms.

1. **iOS — one continuous native scroll curve for sends** (`ConversationTailScrollAnimator.swift`,
   new `ConversationTailScrollMotion.swift`). A send used to jump the scroll offset instantly, then
   separately animate the bubble's entrance — two disconnected motions. The tail animator now drives
   the native `UIScrollView` offset on a per-frame cubic-bezier curve matching the bubble's own
   `MessageSendEntranceTransform` easing, and a mid-flight retarget (a lazily-measured row growing)
   continues from the offset actually on screen instead of restarting. Reduced Motion and keyboard
   transitions keep the original instant/measured paths untouched.
   Verified: `ConversationTailScrollAnimatorTests`, `ConversationSendMotionIntegrationTests`,
   `ConversationSendQueueTests` — 43/43 pass.

2. **iOS — persistence moved off the send's first frame** (`AppModel.swift`, `send(...)`). SwiftData
   writes (`cacheCurrentMessages`, hashing + JSON-encoding up to 64 messages) ran synchronously on the
   main actor *before* the optimistic message could render. It now persists on the next run-loop turn,
   after the bubble is already on screen. Verified with the same suite as above.

3. **Desktop — stopped a per-keystroke transcript re-measure** (`ChatsPage.tsx`). The chat page passed
   a brand-new `<ThreadShortcut>` element as `navigationAccessory` on every render, which defeated
   `VirtualTranscript`'s own memoization — so typing a single character in the composer re-measured
   every message's estimated height and re-ran every visible row's render callback. The element is now
   memoized on its actual visible inputs (count/busy/error) with a ref-stable click handler.
   Verified: `pnpm typecheck`, `pnpm lint`, the eight tests that render `ChatsPage` (2006/2010 pass;
   4 pre-existing, unrelated digest-loader failures), 22/22 relevant Playwright motion specs.

4. **Desktop — a locally-run agent's own sent message no longer remounts** (`optimistic.ts`,
   `useDesktopTranscriptAdapter.ts`, `runtimeHistoryMerge.ts`). For a local self-agent chat, the
   optimistic bubble's React key was its ephemeral `desktop-message:…` id; once the completed-turn
   refresh replaced it with a persisted copy (`desktop-entry:…`), the key changed and React unmounted
   and remounted the bubble — visible as a one-frame shape/avatar flash and a tail-position jitter
   right when the reply lands. The optimistic message now carries the canonical row's durable id as
   its render identity from the first frame, and the completed-turn merge re-attaches that same id, so
   the key never changes. Assistant/live-turn messages are explicitly excluded (they already keep one
   key via a different, existing mechanism, and gaining this field would have broken that instead).
   A hot-path read-count regression test (`canonicalReadModelPerformance.test.ts`) required the fix to
   add no more than a small constant number of property reads per row; it was optimized down from +4
   to +2 per row and the test's budget was updated with that reasoning documented inline.
   Verified: new test `desktopLocalAgentMessageKeyStability.test.tsx` (proves the key is identical
   before/after the refresh), plus 78/78 in the surrounding test group, full suite 2008/2012 (same 4
   pre-existing failures), 22/22 relevant Playwright motion specs.

5. **Desktop — sending a message no longer stutters/reorders when another message arrives at the same
   time** (`canonicalStore.ts`, `mergeReadyPageMessages`). Reported directly: "I send a message, and at
   the same time I receive another message — it stutters, flickers, and the order gets scrambled."
   Root cause, confirmed with a standalone repro against the real functions: the live-session message
   merge sorted by `(createdAtMs, sequenceNum, id)` on every single state update — including ones with
   nothing to do with this conversation — so if a concurrently-arriving message from someone else
   happened to carry a timestamp a few milliseconds earlier than the local optimistic timestamp of a
   message the sender had already seen render, the next re-sort would silently insert it *before* that
   already-visible bubble, pushing it down. The first fix attempt did a straightforward "new arrivals
   always append after everything already shown," which fixed this but broke an existing, deliberately
   designed feature covered by its own test (`canonicalCatalog.test.tsx`, "live replies fill gaps in a
   ready page") — a delayed group reply correctly backfilling a real gap in already-confirmed history.
   The actual fix is narrower: only a message still in `'sending'` status (not yet server-confirmed) is
   protected from being jumped by a same-batch concurrent arrival; once it settles to `'sent'` it
   rejoins ordinary chronological sorting, and gap-filling among already-confirmed messages is
   untouched. This mirrors how Telegram (via TDLib's `updateMessageSendSucceeded`) is documented to
   work: a locally sent message keeps a temporary id at its rendered position, and the temporary id is
   swapped for the real one *in place* — not by re-deriving position from a fresh chronological sort —
   with full re-sorting reserved for genuine bulk history operations (initial sync, gap recovery), not
   per-message live updates (see Sources).
   The merge also had to stop delegating to a full re-sort (`mergeMessages`) altogether and instead
   preserve already-rendered messages' positions directly (updating their content in place) while only
   inserting brand-new arrivals by chronological position — because `canonicalStateFromStore` and
   `mergeCanonicalStateIntoStore` both re-flatten and fully re-sort on **every** state action in the
   app, not just ones touching this conversation, so any fix that only reordered the *output* of one
   merge call was silently undone by the very next unrelated action.
   Verified: a new regression test (`canonicalCatalog.test.tsx`, "a concurrent reply does not jump
   ahead of the sender's own still-sending message") exercises exactly this three-step sequence
   (send → concurrent arrival → the send's own delivery confirmation) and checks the still-sending
   message never moves and the confirmed order is stable afterward; the pre-existing gap-filling test
   passes unchanged; full suite 2009/2013 (same 4 pre-existing, unrelated digest-loader failures);
   22/22 relevant Playwright motion specs.

   Sources: [TDLib updateMessageSendSucceeded](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1update_message_send_succeeded.html) ·
   [TDLib updateNewMessage](https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1update_new_message.html) ·
   [MTProto sequence numbers](https://core.telegram.org/api/end-to-end/seq_no)

   iOS was also checked against this exact scenario: it already has a purpose-built guard
   (`ConversationMessageOrdering.anchorForSend`/`isUnconfirmedSend`) that pins an unconfirmed send to a
   specific predecessor instead of sorting it by raw timestamp, and the pre-existing test
   `testPendingSendsStayAfterConfirmedMessagesWithAnOlderDeviceClock` proves it. No iOS change was
   needed here.

6. **Desktop — page/conversation switches and chat refreshes no longer double-render the whole shell**
   (`useKordiUiEffects.ts`). Two effects that fire on every navigation change and every chat-state
   refresh built a brand-new empty array/object and called `setState` with it unconditionally, so React
   could never bail out — a guaranteed second full-shell render stacked on top of whatever change
   actually triggered the effect (visible as a small extra stutter on every page switch and, while a
   conversation is receiving messages, on every refresh). Both now compare against the current value
   first and only call `setState` when something actually changed.
   Verified: `pnpm typecheck`, `pnpm lint`, full suite 2010/2014 (same 4 pre-existing digest failures).

7. **Desktop — the new-chat dialog no longer replays its open animation or loses its exit animation**
   (`ChatCreateDialog.tsx`, `WorkspaceSidebar.tsx`). The dialog was mounted with a `key` that flipped
   between `'closed'` and the selected mode, so React tore down and rebuilt the entire component on
   every open *and* close — the enter transition replayed from scratch each time, and an exit animation
   was structurally impossible (the element was already gone the instant the key changed). The key is
   removed; the dialog keeps its identity across opens/closes and now resets every one of its own
   transient fields (mode, contact selection, group name, add-contact and lookup state) on each open,
   the same set `close()` already reset, so nothing from a previous session leaks into a fresh one.
   Verified: new test `chatCreateDialogReopenReset.test.tsx` (a draft group name does not survive a
   close/reopen cycle), updated `workspaceSidebarCreateDialog.test.tsx` (11/11), full suite 2010/2014.

8. **Desktop — light and dark themes now animate at the same speed, and full-shell blur surfaces stop
   re-blurring on every state change** (`theme-tokens.css`, `theme-overrides.css`). The light theme
   redefined `--app-motion-fast/base/slow/ease` with different values than dark (200/260/340ms vs.
   180/220/300ms, different easing), so the same interaction felt like it had two different apps behind
   it depending on theme. That redefinition is removed; both themes now inherit the single definition
   from `.kordi-app`. Separately, the light-only transition rule applied `filter`/`backdrop-filter` to
   whole shell/panel surfaces (`.app-shell`, `.app-side-shell`, `.app-left-glass`, `.app-session-panel`,
   `.app-main-panel`) that carry a real `backdrop-filter` blur — transitioning that property on a
   window-sized element forces a full re-blur of the backdrop on every state change. Those surfaces and
   both filter properties are dropped from the rule; only smaller, contained controls keep the transition.
   Verified: full suite 2010/2014; manual visual check in the browser pane (light/dark toggle, panel
   collapse/expand) for both changes.

9. **Desktop — the group-channel sidebar no longer re-renders on every raw scroll event**
   (`VirtualParticipantSpaceList.tsx`). `onScroll` called `setState` directly, so every trackpad tick (far
   more often than the compositor needs) re-rendered the list and every visible block. Scroll position
   updates are now coalesced into one `requestAnimationFrame`-scheduled `setState` per frame, reading the
   latest offset at flush time so several events in the same frame still commit the most recent position.
   Verified: 29/29 tests in the affected suite, full suite 2010/2014.

10. **iOS — the minimized-call bar no longer hard-cuts the whole app's content** (`KordiApp.swift`). The
    bar's appear/disappear had no transition or animation, so the safe-area inset it occupies resized
    instantly and shifted every screen's content down (or back up) in a single frame. It now transitions
    with a slide-from-top + fade and the inset's resize is animated, both skipped under Reduce Motion.
    Verified: `ConversationSendMotionIntegrationTests`, `ConversationTailScrollAnimatorTests`,
    `KordiAppEnvironmentTests` — 35/35 pass under the `Kordi Beta` scheme (the scheme that actually
    defines the `BETA` build flag these environment tests require; the default `Kordi` scheme's test
    action builds `Debug`, which doesn't, and running under it reports 2 unrelated-looking failures that
    are purely a scheme/configuration mismatch, not a code regression — see the note in "Suggested order").

11. **iOS — launching/signed-out/signed-in app phases no longer hard-cut into each other**
    (`KordiApp.swift`). `RootView`'s top-level `switch model.phase` swapped `LaunchingView`/`LoginView`/
    `MainTabView` with no transition, so app startup and sign-in/sign-out were an instant content swap.
    The switch is now wrapped in a `Group` with a per-case `.opacity` transition and an explicit
    `.animation(_, value: model.phase)`, skipped under Reduce Motion.
    Verified: same 35/35 run as item 10 above (both changes are in the same file and were verified together).

## A caution for anyone picking up this backlog

`ChatHomeView.swift:354,479` (`.id(pinLayoutIdentity)` on the contact/agent list) looks exactly like
an over-eager re-render bug — an audit finding below (LIST-01) proposed removing it. **Do not.** Git
history shows it was deliberately added, removed, and restored in PR #1372, "Fix iOS pin reordering
and Contact navigation latency," to make pin reordering atomic and stop it from coupling to delete
state (fixes #1369, #1371). Removing it would likely reintroduce that bug. This is left in the
backlog list only so the finding isn't rediscovered blind; the correct fix, if any, is to solve the
*coupling* to delete state some other way, not to drop the identity reset.

## Backlog, most valuable first

Each item is `file:line` — `what` — `why it's a jump/jank/re-render` — `fix sketch`. Severity: P0
(clearly visible to most users) → P3 (polish/consistency). All were read and cited from the actual
source at the commit above; none are speculative.

### iOS — conversation timeline & send path

- **P0** `ConversationView.swift:943-982` — a send triggers *three* independent scroll commands in one
  update: SwiftUI's `proxy.scrollTo(bottomAnchorID)` (943), the native tail animator via
  `scrollToBottom()` (954-982's own call), and that same handler firing a second time because
  `isFollowingLatest` is already true. The code's own comment at 977-979 names the exact symptom this
  produces ("a second jump"). **High risk to fix**: the SwiftUI-side `scrollTo` exists specifically to
  force the lazy stack to materialize the destination row before the native animation runs (comment at
  945-946); removing it naively can reintroduce a different bug (blank rows until a pan). Needs a
  guard so `.onChange(of: timeline.last)` no-ops when the message is already staged, verified against
  `ConversationSendMotionIntegrationTests` and `ConversationTailScrollAnimatorTests` on a real device,
  not just the simulator (this class of bug has round-tripped through this file at least 6 times per
  git log).
- **P1** `AppModel.swift` — `AppModel` is one `ObservableObject` with 47 `@Published` properties,
  consumed via `@EnvironmentObject` at 46 sites including `ConversationView` and `MessageBubble`. A
  presence heartbeat or sync-status tick re-runs the whole conversation body. Migrating to `@Observable`
  (iOS 17+) so views depend only on the properties they read is the single highest-leverage fix in the
  whole audit, but it's a cross-cutting rewrite of the app's main data flow — needs its own dedicated,
  slow, test-covered pass, not a drive-by change.
- **P1** `ConversationView.swift:549,574` / `MessageBubble.swift:117` — every bubble's `Equatable`
  compares `actionViewportFrame`, which is the *whole scroll viewport's* global frame, recomputed on
  every composer height change, keyboard frame, and reply-preview appearance. Every visible bubble
  re-renders on each of those. Fix: only the bubble with an open action menu needs the real frame
  (`messageActionMessage?.id == message.id ? viewportFrame : .zero` for everyone else).
  Sketch confirmed against `MessageBubble.swift:370-397` (the one place the frame is actually used).
- **P1** `AppModel.swift:6973-6979` (`replaceMessage`) — on send acknowledgement, the optimistic
  message's `id` and `createdAt` are replaced with the server's values. Since
  `ConversationMessageOrdering` sorts by `createdAt` then `id`, a message that arrived elsewhere during
  the round trip can make the just-sent bubble visibly reorder; the id change also flips the read/probe
  registration and can retrigger `synchronizeReadPresentation` → a disk write → another full render.
  Fix: keep the optimistic row's `id`/`createdAt` on ack, folding only the server's delivery state and
  sequence number.
- **P2** `Core/Design/KordiTheme.swift:293-317` (`KordiChatWallpaper`) — draws ~2,000 dots with `Canvas`
  as the timeline background; redraws every frame of the composer/keyboard animation because it's a
  child of the resizing view. Fix: `.drawingGroup()` or rasterize once.
- **P2** `Features/Conversation/MarkdownMessageContent.swift:779-832` — parsing is cached, but the
  `AttributedString` styling pass is rebuilt in `body` every time, including mention highlighting.
  Fix: cache the styled output in an `NSCache` keyed by `(text, mentions, targets)`.
- Full detail (12 more findings, P2-P3, plus the complete grep inventory of every animation curve/
  duration in the file and a line-by-line trace of the send sequence) is in the session transcript;
  ask for it to be written up separately if useful — it's long enough to be its own document.

### iOS — app shell & navigation (everything outside the transcript)

- **P1** `MainNavigationHost.swift:53-56,72-89` — the whole navigation host (every pushed screen's
  `UIHostingController.rootView`) is reassigned on *every* `AppModel`/coordinator publish, because
  `MainTabView` observes the same 47-property object the transcript does. A presence tick while the
  user is on the Contacts tab still re-hosts every pushed destination. Fix: only reassign `rootView`
  when the route list or an explicit small "inputs revision" actually changed.
- ~~**P1** `KordiApp.swift:105,111-129` — the minimized-call bar's appear/disappear has no
  transition or animation; the whole app content shifts down instantly.~~ **Shipped, see item 10.**
- **P2** `Features/Shared/IdentityAvatar.swift:223-226` → `AvatarImageLoader.cachedImage` — every
  avatar's `init` (not a `.task`) does a synchronous `URLCache` read and, on a cache miss, decode, on
  the *main thread*, and this runs on every parent re-render (i.e., every model publish) for every
  visible avatar. Fix: `init` should only consult the in-memory `NSCache`; move the disk/decode path
  into the existing `.task`.
- **P2** `Features/Chats/ChatHomeView.swift:24,185/190,1137,1157-1219` — pull-to-refresh progress
  writes `@State` on every overscroll frame, which re-runs the *entire* `ChatHomeView.body` (both
  catalog builds, full sort) at 60-120 Hz during the pull gesture.
- **P2** `Features/Conversation/SessionDetailSheet.swift:45-46,78-218` — ~15 computed properties each
  independently re-scan `conversations`/build the group-space catalog; all rerun on every model publish
  while the sheet is open, not just when its own conversation changes.
- **P2** `Features/Conversation/MediaPreviewView.swift` — full-body re-run per drag frame while
  swiping between photos; `currentItem` is recomputed by scanning messages twice per access.
- Also flagged, lower severity: five different "settle" animation curves used inconsistently across
  the chat list alone (`ChatRowSwipeGesture.swift:30`, `ChatHomeView.swift:679,794,1031,1236`);
  `ChannelCreateSheet` presented as a `.fullScreenCover` when its own content is a small centered
  dialog (the scrim visibly slides up/down instead of fading); several error banners declare a
  `.transition` that's never triggered because the state change isn't wrapped in `withAnimation`
  (`ChatHomeView.swift:252-258`, `ContactsView.swift:273-276`, `LoginView.swift:229-241`).

### Desktop — chat transcript & send path

- **P0** `pages/chatsPage.transcriptViewport.tsx:198-221` — `estimateSize`, `onScroll`,
  `findNavigationIndex`, `getItemKey`, and `renderItem` are all inline closures rebuilt every render;
  this is the same class of bug as the `ThreadShortcut` fix above but one layer deeper, so it still
  fires on other re-render sources (context changes, unrelated `useEffect`s) even after that fix.
  Fix: make each a `useCallback` reading current values through a ref, mirroring the existing
  `useStableChatSessionPaneActions` pattern already used elsewhere in this file.
- **P0** `features/canonical/canonicalStore.ts:258-416` — every `setCanonicalSessionState` call (a
  send does at least three: append, mark-sent, delivery-delta) flattens and re-sorts *every cached
  session's* messages, then deep-JSON-compares each one to restore object references. Cost scales with
  total cached history, not the session being touched. Fix: keep `messagesBySessionId` as the shape
  hot paths operate on; only rebuild the session that actually changed.
- **P1** `features/chat/useTranscriptTailAlignment.ts` + `virtualTranscriptMotion.ts` — while an agent
  is streaming, every ~96ms commit can trigger up to three separate realignment passes (a no-lift pass,
  a growth-triggered lift pass, and a `MutationObserver`-triggered lift pass), each doing a forced
  layout read (`offsetHeight`/`getBoundingClientRect`) across every mounted row and restarting a WAAPI
  animation per row. At streaming cadence this is a sawtooth, not a settle. Fix: animate one wrapper
  element instead of per-row; extend an in-flight lift's target instead of cancel-and-restart; skip the
  pass entirely when the measured total size didn't change.
- **P1** `messageActions/chatMessages.ts:965,1394,1409,1550/1591` (local-agent send) — the optimistic
  bubble doesn't appear until after 2-4 `await`s, including two Tauri IPC round trips, so the composer
  visibly keeps the typed text for a beat before it clears and the bubble pops in. Fix: append the
  optimistic row and clear the composer synchronously in the Enter handler, before the active-turn IPC
  call; reconcile (queue/fail) afterward.
- **P2** `kordi-app/components/messageBubbleShape.tsx:84-119` and
  `TranscriptMediaBoundary.tsx:10-41` — every human bubble mounts twice (default shape, then measured)
  and registers a `ResizeObserver`; every media message registers its own `IntersectionObserver` and
  `ResizeObserver` on the scroll root instead of sharing one.
- **P2** `styles/theme-overrides.css:1-28` — a global rule animates `transform, filter,
  backdrop-filter` on every `button`/`input` in the app with `!important` durations, and has no
  `prefers-reduced-motion` override (the transcript's own CSS does; this one doesn't).
- Full detail (13 more findings, the complete send-sequence trace with exact line numbers for every
  state mutation, and the CSS/animation inventory for the transcript styles) is likewise in the
  session transcript.

### Desktop — app shell & navigation

Architecture: everything funnels through one hook chain in `KordiAppShell` with no context/store
subscription boundary below the root — `createContext` appears only 4 times app-wide, none for shell
state, and no shell-level component is `React.memo`'d. So any state change anywhere (presence, sync,
a composer keystroke, a sidebar hover) re-runs the full hook chain and re-renders the whole shell.

- ~~**P0** `app/useKordiUiEffects.ts:163-168,212-226` — two `useEffect`s fire on every page/conversation
  switch and on every chat-state refresh with an unguarded `setState`.~~ **Shipped, see item 6.**
- **P0** `app/useWorkspaceViewModels.ts:231-343` — switching the selected conversation re-derives
  **every** chat conversation's view-model (not just the one being selected), because `activeConvId`/
  `activeNav` are in the shared dependency array purely to zero out the visible session's unread count
  and pick its message source. Fix: split the per-session derivation (no selection deps) from a second,
  cheap `useMemo` that only overrides the one matching entry.
- **P0** `app/useKordiShellArgs.ts:9` / `app/useKordiAppShellComposition.ts` — confirmed root cause,
  already known going in: `useMemo(() => {...}, [groups])` where `groups` is rebuilt as a fresh object
  literal every render by its caller, so the memo never hits and the whole shell-args object (~13
  sub-areas: sidebar, main content, composer, overlays, etc.) rebuilds every render regardless of what
  changed. A companion hook, `useKordiShellSlots` in `assembleKordiShellSlots.tsx:24-48`, already exists
  with per-slot `useMemo`s but is **unused** — the live path calls the plain, unmemoized
  `assembleKordiShellSlots(shellArgs)` instead. Single highest-leverage desktop fix in the whole audit,
  and the riskiest to get right blind (13 real dependency arrays to derive correctly in a 468-line
  composition hub) — do this with the real Tauri app running for manual regression, not blind.
- ~~**P1** `styles/theme-tokens.css:49-52,193-196` + `theme-overrides.css:17-27` — light and dark themes
  animate at different speeds with different easing; light-only `filter`/`backdrop-filter` transitions
  on full-viewport shell surfaces force a re-blur of the whole window backdrop.~~ **Shipped, see item 8**
  (the token duplication and the shell-surface filter transitions are fixed; the light-only property list
  still includes `box-shadow`/`transform`/`opacity` beyond the `background-color, border-color, color`
  the original fix sketch suggested — kept intentionally, since those are cheap on the smaller controls
  this rule now targets and several existing hover/press states depend on them animating).
- **P1** `app/AppShellFrame.tsx:165,194` vs `styles/shell.css:55-57` — the sidebar/detail-rail grid
  columns are set up to animate (`transition-[grid-template-columns]`) but native mode explicitly kills
  all shell transitions, so collapse/expand **snaps instantly** in the shipped app and the panel
  unmounts at the exact frame its column vanishes (content pops); the animation only actually runs in
  the preview build, where it relayouts the whole shell every frame. Fix: pick one contract — likely
  drop the grid-column transition everywhere and animate a fixed-width panel layer with
  `transform`/`opacity` instead, never `grid-template-columns`.
- **P1** `pages/sidebar/VirtualChatList.tsx:184` + `workspaceSidebar.chatModel.ts:33-37` — the sidebar
  re-sorts newest-first with no reorder animation (rows are absolutely positioned via a hard
  `translateY`, so they teleport), and scroll-follow only triggers when the *active session id*
  changes — not when the active row's own index shifts from a reorder — so the selected conversation
  can visibly jump within the viewport when a background message arrives.
- ~~**P1** `pages/WorkspaceSidebar.tsx:396-397` — `ChatCreateDialog` is given a `key` that flips between
  `'closed'` and the selected mode, so React tears down and rebuilds the whole dialog on every open
  *and* close.~~ **Shipped, see item 7.**
- ~~**P1** `pages/sidebar/VirtualParticipantSpaceList.tsx:123` — an unthrottled `setState` on every raw
  scroll event re-renders the group-channel sidebar and every visible block on each scroll tick.~~
  **Shipped, see item 9.**
- **P2** — no reduced-motion handling at all in `dialog.tsx` (modal panels have no enter/exit motion —
  a hard cut both ways — while popovers animate 180ms in only); `whats-new.css` and
  `shell-calls-stage.css` both animate `filter: blur(...)` for 420-520ms on top of an already-blurred
  `backdrop-filter` surface; 42 of 67 `animate-spin`/`animate-pulse` usages have no
  `motion-reduce:`/`prefers-reduced-motion` guard, and there is no global fallback rule anywhere.
- Full detail (27 findings total, plus the complete grep/animation inventory) is in the session
  transcript.

Items 1-11 in "What shipped" above are done and verified (iOS: 43/43 send-motion tests + 35/35
shell/environment tests, both under the `Kordi Beta` scheme; desktop: full suite steady at 2010/2014
pass, the same 4 pre-existing, unrelated digest-loader failures throughout every change). One process
note for whoever runs the iOS suite next: use the **`Kordi Beta`** scheme, not the default `Kordi`
scheme — its test action builds `Debug`, which doesn't define the `BETA` compile flag, so
`KordiAppEnvironmentTests`'s two beta-specific tests fail there for reasons that have nothing to do with
app code (confirmed by reading `KordiAppEnvironment.swift`'s `#if BETA` gate and both schemes'
`.xcscheme` files).

## Suggested order for the next pass

1. iOS: `ConversationView.swift:943-982`'s duplicate scroll commands and `AppModel.swift:6973-6979`'s
   ack-time id/createdAt swap — both are real, confirmed jump sources, but need a physical-device pass,
   not just simulator/unit tests, given this exact bug has recurred multiple times in git history.
2. Desktop: `useKordiShellArgs`/`useKordiAppShellComposition` memoization, done with the real app
   running so each of the ~13 dependency arrays can be checked by hand, not guessed.
3. iOS: `MessageBubble.swift:117`'s `Equatable` comparing the whole-viewport `actionViewportFrame` on
   every bubble (only the bubble with an open action menu needs the real value) — looked at in this
   pass; deprioritized because `viewport.frame(in: .global)` comes from a `GeometryReader` wrapping the
   `ScrollView` itself, so in the common case (no keyboard/rotation/split-view resize) the CGRect value
   is identical between re-renders and a 4-field struct comparison on it is cheap — the win is real but
   narrow, and lower-value than the items above.
4. The two `AppModel`/canonical-store architectural items (iOS `@Observable` migration, desktop
   per-session canonical state) — largest payoff, largest and slowest to do safely.
