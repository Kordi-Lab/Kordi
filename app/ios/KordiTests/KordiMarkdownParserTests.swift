import CallKit
import LinkPresentation
import XCTest
@testable import Kordi

final class KordiMarkdownParserTests: XCTestCase {
    func testCallAvatarResolverPrefersTheCallParticipantProfileImage() {
        let participant = CloudCallParticipant(
            accountId: "acct_peer",
            displayName: "Current peer name",
            avatarUrl: "data:image/png;base64,cGVlcg==",
            state: "joined",
            joinedAt: nil,
            leftAt: nil
        )

        XCTAssertEqual(
            KordiCallAvatarResolver.identity(
                accountID: "acct_peer",
                fallbackName: "Old peer name",
                fallbackImageSource: nil,
                participants: [participant]
            ),
            KordiCallAvatarIdentity(
                name: "Current peer name",
                imageSource: "data:image/png;base64,cGVlcg==",
                seed: "acct_peer"
            )
        )
    }

    func testParsesTheMacDesktopBlockVocabulary() {
        let markdown = """
        # Release plan

        Read **carefully** and visit https://kordi.ai.

        - [x] Sync avatars
          1. Load profile image
          2. Keep a fallback
        - [ ] Ship the build

        > Shared with the whole group.

        | Surface | State |
        | --- | --- |
        | iPhone | Ready |

        ```swift
        let ready = true
        ```
        """

        let blocks = KordiMarkdownParser.parse(markdown)

        XCTAssertEqual(blocks.count, 6)
        XCTAssertEqual(blocks[0], .heading(level: 1, text: "Release plan"))
        XCTAssertEqual(blocks[1], .paragraph("Read **carefully** and visit https://kordi.ai."))
        XCTAssertEqual(blocks[3], .blockquote("Shared with the whole group."))
        XCTAssertEqual(blocks[4], .table(headers: ["Surface", "State"], rows: [["iPhone", "Ready"]]))
        XCTAssertEqual(blocks[5], .code(language: "swift", source: "let ready = true"))

        guard case let .list(items) = blocks[2] else {
            return XCTFail("Expected a list block")
        }
        XCTAssertEqual(items.map(\.depth), [0, 1, 1, 0])
        XCTAssertEqual(items.map(\.checked), [true, nil, nil, false])
        XCTAssertEqual(items.filter(\.ordered).map(\.ordinal), [1, 2])
    }

    func testParsesInlineFormattingAndKeepsBareURLPunctuationOutsideTheLink() throws {
        let parts = KordiMarkdownParser.parseInline(
            "Use `sync`, **now**, *please*: [Kordi](https://kordi.ai/docs) or https://kordi.ai."
        )

        XCTAssertTrue(parts.contains(.code("sync")))
        XCTAssertTrue(parts.contains(.strong("now")))
        XCTAssertTrue(parts.contains(.emphasis("please")))
        XCTAssertTrue(parts.contains(.link(label: "Kordi", url: try XCTUnwrap(URL(string: "https://kordi.ai/docs")))))
        XCTAssertTrue(parts.contains(.link(label: "https://kordi.ai", url: try XCTUnwrap(URL(string: "https://kordi.ai")))))
        XCTAssertEqual(parts.last, .text("."))
    }

    func testParsesKnownBlobEmojiAndLeavesUnknownShortcodesAsText() throws {
        let emoji = try XCTUnwrap(BlobEmojiCatalog.byID["blobwave"])

        XCTAssertTrue(
            KordiMarkdownParser.parseInline("Hello :blob:blobwave:")
                .contains(.blobEmoji(emoji))
        )
        XCTAssertFalse(
            KordiMarkdownParser.parseInline(":blob:not-in-the-catalog:")
                .contains(where: { if case .blobEmoji = $0 { true } else { false } })
        )
    }

    func testBlobEmojiComposerRenderingRoundTripsTokensAndSelection() throws {
        let token = ":blob:blobwave:"
        let raw = "Hi \(token) there"
        let attributed = BlobEmojiComposerText.attributedString(
            raw,
            font: .preferredFont(forTextStyle: .body)
        )

        XCTAssertEqual(BlobEmojiComposerText.rawText(attributed), raw)
        XCTAssertFalse(BlobEmojiComposerText.containsUnrenderedToken(attributed))
        XCTAssertEqual(BlobEmojiComposerText.plainText(raw), "Hi Emoji there")
        XCTAssertEqual(
            BlobEmojiComposerText.plainText(":blob:not-in-the-catalog:"),
            ":blob:not-in-the-catalog:"
        )

        let rawSelection = NSRange(
            location: 3,
            length: (token as NSString).length
        )
        let rendered = BlobEmojiComposerText.renderedSelection(
            forRaw: rawSelection,
            in: raw
        )
        XCTAssertEqual(rendered, NSRange(location: 3, length: 1))
        XCTAssertEqual(
            BlobEmojiComposerText.rawSelection(forRendered: rendered, in: raw),
            rawSelection
        )
    }

    func testLongEmojiMarkdownLinkRendersOneDestinationAndCompactsItsLabel() throws {
        let url = "https://www.xiaohongshu.com/discovery/item/redacted?app_platform=ios&xsec_token=redacted&share_id=redacted"
        let markdown = "[:blob:blobwave: \(url)]\n(\(url))"
        let blocks = KordiMarkdownParser.parse(markdown)
        guard case let .paragraph(paragraph) = try XCTUnwrap(blocks.first) else {
            return XCTFail("Expected a paragraph")
        }
        let parts = KordiMarkdownParser.parseInline(paragraph)
        let links = parts.compactMap { part -> (String, URL)? in
            if case let .link(label, destination) = part { return (label, destination) }
            return nil
        }

        XCTAssertEqual(links.count, 1)
        XCTAssertEqual(links.first?.1.absoluteString, url)
        XCTAssertFalse(parts.contains { part in
            if case let .text(value) = part { return value.contains("](") }
            return false
        })
        XCTAssertFalse(
            KordiMarkdownParser.compactLinkLabel(url, url: try XCTUnwrap(URL(string: url)))
                .contains("xsec_token")
        )
    }

    func testFirstExternalURLSkipsCodeBlocks() throws {
        let text = """
        ```text
        https://ignored.example/private
        ```

        [Open report](https://example.com/report?token=redacted)
        """

        XCTAssertEqual(
            KordiMarkdownParser.firstExternalURL(in: text)?.absoluteString,
            "https://example.com/report?token=redacted"
        )
    }

    @MainActor
    func testLinkPreviewMetadataCacheDeduplicatesAndCachesFailures() async throws {
        let metadata = LPLinkMetadata()
        metadata.title = "Example"
        var calls = 0
        let cache = LinkPreviewMetadataCache(
            countLimit: 2,
            successTTL: 60,
            failureTTL: 10
        ) { url in
            calls += 1
            try? await Task.sleep(for: .milliseconds(10))
            return LinkPreviewMetadataValue(
                metadata: url.host == "example.com" ? metadata : nil
            )
        }
        let successURL = try XCTUnwrap(URL(string: "https://example.com/page"))
        async let first = cache.metadata(for: successURL)
        async let second = cache.metadata(for: successURL)

        _ = await (first, second)
        XCTAssertEqual(calls, 1)
        _ = await cache.metadata(for: successURL)
        XCTAssertEqual(calls, 1)

        let failedURL = try XCTUnwrap(URL(string: "https://invalid.example/page"))
        let now = Date()
        _ = await cache.metadata(for: failedURL, now: now)
        _ = await cache.metadata(for: failedURL, now: now.addingTimeInterval(5))
        XCTAssertEqual(calls, 2)
        _ = await cache.metadata(for: failedURL, now: now.addingTimeInterval(11))
        XCTAssertEqual(calls, 3)
    }

    func testMarkdownParserPerformance() {
        let markdown = Array(repeating: """
        ## Release status

        Review **the latest build** at https://kordi.ai/docs and run `xcodebuild`.

        - [x] Sync messages
        - [ ] Verify delivery receipts
        - [ ] Scroll the full transcript

        | Surface | State |
        | --- | --- |
        | iPhone | Ready |

        > This paragraph mirrors a typical agent response with formatting.
        """, count: 5).joined(separator: "\n\n")

        measure {
            for _ in 0..<40 {
                let blocks = KordiMarkdownParser.parse(markdown)
                for block in blocks {
                    switch block {
                    case let .heading(_, text), let .paragraph(text), let .blockquote(text):
                        _ = KordiMarkdownParser.parseInline(text)
                    case let .list(items):
                        for item in items { _ = KordiMarkdownParser.parseInline(item.text) }
                    case let .table(headers, rows):
                        for cell in headers + rows.flatMap({ $0 }) {
                            _ = KordiMarkdownParser.parseInline(cell)
                        }
                    case .code:
                        break
                    }
                }
            }
        }
    }

    func testOversizedMessageHasBoundedInitialContent() throws {
        let oversized = String(repeating: "Long agent response. ", count: 20_000)

        let collapsed = try XCTUnwrap(MarkdownMessageContent.collapsedText(oversized))

        XCTAssertEqual(collapsed.count, MarkdownMessageContent.oversizedTextPreviewCharacters + 1)
        XCTAssertTrue(oversized.hasPrefix(collapsed.dropLast()))
        XCTAssertNil(MarkdownMessageContent.collapsedText("Short response"))
    }

    func testConversationTimelineMountsOnlyTheNewestPageInitially() {
        let messages = (0..<341).map { index in
            ChatMessage(
                id: "message-\(index)",
                conversationId: "conversation",
                author: index.isMultiple(of: 2) ? .me : .person,
                authorName: "Person",
                text: "Message \(index)",
                createdAt: Date(timeIntervalSince1970: TimeInterval(index)),
                deliveryState: .delivered,
                errorMessage: nil,
                requestMessageId: nil
            )
        }

        let visible = ConversationTimelineWindow.visibleMessages(
            in: messages,
            limit: ConversationTimelineWindow.initialLimit
        )

        XCTAssertEqual(visible.count, 64)
        XCTAssertEqual(visible.first?.id, "message-277")
        XCTAssertEqual(visible.last?.id, "message-340")
    }

    func testPreviewConversationKindsExerciseWindowedScrolling() throws {
        let fixture = PreviewData.make(now: Date(timeIntervalSince1970: 1_000_000))
        let expectedLatestMessageIDs = [
            "person:acct_maya": "m6",
            "group:mobile": "gm4",
            "agent:my-kordi": "m2"
        ]

        for (conversationID, expectedLatestMessageID) in expectedLatestMessageIDs {
            let messages = try XCTUnwrap(fixture.messagesByConversation[conversationID])
            XCTAssertGreaterThan(messages.count, ConversationTimelineWindow.initialLimit)
            XCTAssertEqual(Set(messages.map(\.id)).count, messages.count)
            XCTAssertEqual(messages.last?.id, expectedLatestMessageID)
        }
    }

    func testInitialWindowStaysBoundedWhenRemoteHistoryArrives() {
        let limitBeforeReveal = ConversationTimelineWindow.limitAfterAppending(
            currentLimit: ConversationTimelineWindow.initialLimit,
            oldCount: 5,
            newCount: 341,
            isInitialViewportRevealed: false
        )
        let limitAfterReveal = ConversationTimelineWindow.limitAfterAppending(
            currentLimit: ConversationTimelineWindow.initialLimit,
            oldCount: 341,
            newCount: 342,
            isInitialViewportRevealed: true
        )

        XCTAssertEqual(limitBeforeReveal, ConversationTimelineWindow.initialLimit)
        XCTAssertEqual(limitAfterReveal, ConversationTimelineWindow.initialLimit + 1)
    }

    func testEarlierHistoryExpandsByOneBoundedPage() {
        XCTAssertEqual(ConversationTimelineWindow.pageSize, 44)
        XCTAssertEqual(
            ConversationTimelineWindow.limitAfterLoadingEarlier(
                currentLimit: ConversationTimelineWindow.initialLimit,
                totalCount: 341
            ),
            108
        )
        XCTAssertEqual(
            ConversationTimelineWindow.limitAfterLoadingEarlier(
                currentLimit: 320,
                totalCount: 341
            ),
            341
        )
    }

    @MainActor
    func testOpeningEveryPreviewSessionKindClearsUnreadImmediately() throws {
        let model = AppModel(previewMode: true)
        let conversationIDs = ["person:acct_maya", "group:mobile", "agent:my-kordi"]

        for conversationID in conversationIDs {
            let conversation = try XCTUnwrap(
                model.conversations.first(where: { $0.id == conversationID })
            )
            XCTAssertGreaterThan(conversation.unreadCount, 0)
            model.markConversationOpened(conversation)
            XCTAssertEqual(
                model.conversations.first(where: { $0.id == conversationID })?.unreadCount,
                0
            )
        }
    }

    @MainActor
    func testExplicitlyMarkingPreviewGroupReadClearsUnreadWithoutCloud() async throws {
        let model = AppModel(previewMode: true)
        let space = try XCTUnwrap(
            GroupSpaceCatalog.build(
                conversations: model.conversations,
                ownAccountId: try XCTUnwrap(model.account?.accountId)
            ).first
        )

        XCTAssertGreaterThan(space.unreadCount, 0)
        await model.markGroupSpaceRead(space)

        let sessionIDs = Set(space.sessions.map(\.id))
        XCTAssertTrue(
            model.conversations
                .filter { sessionIDs.contains($0.id) }
                .allSatisfy { $0.unreadCount == 0 }
        )
        XCTAssertNil(model.errorMessage)
    }

    @MainActor
    func testCachedConversationCanRevealBeforeRemoteReload() throws {
        let model = AppModel(previewMode: true)
        for conversationID in ["person:acct_maya", "group:mobile", "agent:my-kordi"] {
            let currentConversation = try XCTUnwrap(
                model.conversations.first(where: { $0.id == conversationID })
            )
            XCTAssertTrue(model.canRevealConversationImmediately(currentConversation))
        }

        let conversation = try XCTUnwrap(
            model.conversations.first(where: { $0.id == "person:acct_maya" })
        )
        let latestMessage = try XCTUnwrap(model.messages(for: conversation).last)

        XCTAssertTrue(model.canRevealConversationImmediately(conversation))

        var pendingConversation = conversation
        pendingConversation.lastActivityAt = latestMessage.createdAt.addingTimeInterval(1)
        XCTAssertTrue(model.canRevealConversationImmediately(pendingConversation))
    }

    @MainActor
    func testPreviewLoadPreservesNestedGroupMessages() async throws {
        let model = AppModel(previewMode: true)
        let conversation = try XCTUnwrap(
            model.conversations.first(where: { $0.id == "group:mobile-release" })
        )
        let messagesBeforeLoad = model.messages(for: conversation)

        await model.loadConversation(conversation)

        XCTAssertFalse(messagesBeforeLoad.isEmpty)
        XCTAssertEqual(model.messages(for: conversation), messagesBeforeLoad)
    }

    func testConversationIdentityResolverFallsBackToStableSessionID() {
        let cached = ConversationSummary(
            id: "cached-agent-session",
            kind: .agent,
            peerAccountId: "acct_me",
            agentId: nil,
            ownerDisplayName: "Shu Yang",
            displayName: "Hello",
            lastMessage: "Cached",
            lastActivityAt: Date(timeIntervalSince1970: 1),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: "session:self-agent:hello"
        )
        let refreshed = ConversationSummary(
            id: "refreshed-agent-session",
            kind: .agent,
            peerAccountId: "acct_me",
            agentId: nil,
            ownerDisplayName: "Shu Yang",
            displayName: "Hello",
            lastMessage: "Refreshed",
            lastActivityAt: Date(timeIntervalSince1970: 2),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: .ready,
            sessionId: cached.sessionId
        )

        XCTAssertEqual(
            ConversationIdentityResolver.current(cached, in: [refreshed]),
            refreshed
        )
        XCTAssertNotEqual(cached.id, refreshed.id)
        XCTAssertEqual(
            ConversationIdentityResolver.loadingTaskID(for: cached),
            ConversationIdentityResolver.loadingTaskID(for: refreshed)
        )
    }

    @MainActor
    func testPreviewCallUpdatesOneActivityFromStartedToEnded() throws {
        let model = AppModel(previewMode: true)
        let conversation = try XCTUnwrap(
            model.conversations.first(where: { $0.id == "group:mobile" })
        )
        let call = CloudCall(
            id: "0198aabc-8b27-7a30-8cba-215495609c7a",
            conversationId: conversation.sessionId,
            kind: .meeting,
            state: .active,
            createdByAccountId: "acct_me",
            createdAt: "2026-08-14T10:00:00Z",
            answeredAt: "2026-08-14T10:00:00Z",
            endedAt: nil,
            participants: []
        )

        model.recordPreviewCallStarted(call, in: conversation)
        XCTAssertEqual(model.activeCall(for: conversation)?.id, call.id)

        model.recordPreviewCallEnded(call, in: conversation)
        let callActivities = model.messages(for: conversation).compactMap(\.callActivity)

        XCTAssertNil(model.activeCall(for: conversation))
        XCTAssertEqual(callActivities.suffix(1).map(\.event), [.ended])
        XCTAssertEqual(callActivities.filter { $0.callId == call.id }.count, 1)
        XCTAssertTrue(
            model.conversations.first(where: { $0.id == conversation.id })?.lastMessage
                .contains("Duration") == true
        )
    }

    func testCallTimelineCollapsesLegacyStartAndEndIntoOneDurationEvent() throws {
        let callID = "0198aabc-8b27-7a30-8cba-215495609c7a"
        let started = ChatMessage(
            id: "started",
            conversationId: "conversation",
            author: .me,
            authorName: "You",
            text: "You started a voice call.",
            createdAt: Date(timeIntervalSince1970: 1_000),
            deliveryState: .read,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: ChatCallActivity.messageKind(for: .started, callId: callID)
        )
        let ended = ChatMessage(
            id: "ended",
            conversationId: "conversation",
            author: .me,
            authorName: "You",
            text: "The voice call ended.",
            createdAt: Date(timeIntervalSince1970: 1_077),
            deliveryState: .read,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: ChatCallActivity.messageKind(for: .ended, callId: callID)
        )

        let timeline = ChatCallActivityTimeline.collapsingStatuses(in: [started, ended])

        XCTAssertEqual(timeline.count, 1)
        XCTAssertEqual(timeline[0].id, started.id)
        XCTAssertEqual(timeline[0].callActivity?.event, .ended)
        XCTAssertEqual(timeline[0].text, "The voice call ended. Duration 01:17.")
    }

    func testConversationLoadingKeepsTheSyncMarkMoving() {
        let motion = MessageSyncStatusBehavior.motion(
            pullState: .idle,
            messageSyncState: .upToDate,
            isLoadingMessages: true
        )

        XCTAssertEqual(motion, .syncing)
        XCTAssertTrue(motion.runsContinuously)
    }

    func testSimulatorUsesInAppCallIntegration() {
#if targetEnvironment(simulator)
        XCTAssertFalse(KordiCallSystemIntegration.usesCallKit)
#else
        XCTAssertTrue(KordiCallSystemIntegration.usesCallKit)
#endif
    }

    func testIncomingCallPolicyReportsDirectCallsAndActiveMeetings() {
        let participant = CloudCallParticipant(
            accountId: "acct_me",
            displayName: "Me",
            avatarUrl: nil,
            state: "invited",
            joinedAt: nil,
            leftAt: nil
        )
        let directCall = CloudCall(
            id: "direct-call",
            conversationId: "direct-conversation",
            kind: .video,
            state: .ringing,
            createdByAccountId: "acct_peer",
            createdAt: "2026-08-31T16:00:00Z",
            answeredAt: nil,
            endedAt: nil,
            participants: [participant]
        )
        let meeting = CloudCall(
            id: "meeting-call",
            conversationId: "group-conversation",
            kind: .meeting,
            state: .active,
            createdByAccountId: "acct_peer",
            createdAt: "2026-08-31T16:00:00Z",
            answeredAt: nil,
            endedAt: nil,
            participants: [participant]
        )

        XCTAssertTrue(KordiIncomingCallPolicy.shouldReport(
            call: directCall,
            accountID: "acct_me",
            alreadyReported: false
        ))
        XCTAssertTrue(KordiIncomingCallPolicy.shouldReport(
            call: meeting,
            accountID: "acct_me",
            alreadyReported: false
        ))
        XCTAssertFalse(KordiIncomingCallPolicy.shouldReport(
            call: meeting,
            accountID: "acct_me",
            alreadyReported: true
        ))
    }

    func testRealtimeCallFrameCarriesTheCallBeforeDurableRepair() throws {
        let data = Data("""
        {
          "type": "event",
          "stream_seq": 42,
          "event": {
            "stream_seq": 42,
            "event_id": "event-call-updated",
            "protocol_version": 2,
            "type": "call.updated",
            "critical": true,
            "conversation_id": "conversation-1",
            "entity_id": null,
            "entity_version": null,
            "occurred_at": "2026-08-31T16:00:00Z",
            "payload": {
              "call": {
                "id": "call-1",
                "revision": 3,
                "conversation_id": "conversation-1",
                "kind": "video",
                "state": "ended",
                "created_by_account_id": "acct_peer",
                "created_at": "2026-08-31T15:59:30Z",
                "answered_at": "2026-08-31T15:59:40Z",
                "ended_at": "2026-08-31T16:00:00Z",
                "participants": []
              }
            }
          }
        }
        """.utf8)

        let frame = try JSONDecoder().decode(CloudRealtimeServerFrame.self, from: data)

        XCTAssertEqual(frame.streamSequence, 42)
        XCTAssertEqual(frame.call?.id, "call-1")
        XCTAssertEqual(frame.call?.state, .ended)
    }

    func testCallKitMuteTimeoutNeverEndsTheCall() {
        let mute = CXSetMutedCallAction(call: UUID(), muted: true)
        XCTAssertFalse(KordiCallActionPolicy.timeoutEndsCall(mute))
    }

    func testCallKitStartAndAnswerTimeoutsEndIncompleteCalls() {
        let callID = UUID()
        let start = CXStartCallAction(
            call: callID,
            handle: CXHandle(type: .generic, value: "Kordi contact")
        )
        let answer = CXAnswerCallAction(call: callID)

        XCTAssertTrue(KordiCallActionPolicy.timeoutEndsCall(start))
        XCTAssertTrue(KordiCallActionPolicy.timeoutEndsCall(answer))
    }

    func testCallStartPolicyRejectsEveryConcurrentOwnershipState() {
        XCTAssertTrue(KordiCallStartPolicy.canBegin(
            hasActiveCall: false,
            isStartInFlight: false,
            hasSystemCall: false
        ))
        XCTAssertFalse(KordiCallStartPolicy.canBegin(
            hasActiveCall: true,
            isStartInFlight: false,
            hasSystemCall: false
        ))
        XCTAssertFalse(KordiCallStartPolicy.canBegin(
            hasActiveCall: false,
            isStartInFlight: true,
            hasSystemCall: false
        ))
        XCTAssertFalse(KordiCallStartPolicy.canBegin(
            hasActiveCall: false,
            isStartInFlight: false,
            hasSystemCall: true
        ))
    }

    func testDuplicateCallKitUUIDUsesBoundedRecoveryCopy() {
        let message = KordiCallSystemStartErrorPresentation.message(
            domain: CXErrorDomainRequestTransaction,
            code: CXErrorCodeRequestTransactionError.Code.callUUIDAlreadyExists.rawValue
        )

        XCTAssertEqual(message, "A call is already starting. Wait a moment, then try again.")
        XCTAssertFalse(message.contains("com.apple.CallKit"))
    }

    func testDirectCallActivityIsANeutralSystemNotice() {
        let message = ChatMessage(
            id: "voice-ended",
            conversationId: "contact",
            author: .me,
            authorName: "Alex",
            text: "The voice call ended. Duration 00:07.",
            createdAt: Date(timeIntervalSince1970: 1_000),
            deliveryState: .read,
            errorMessage: nil,
            requestMessageId: nil,
            messageKind: ChatCallActivity.messageKind(for: .ended, callId: UUID().uuidString)
        )

        XCTAssertTrue(message.isSystemNotice)
    }

    func testOnlyInitialMicrophonePublicationFailuresAreFatal() {
        XCTAssertTrue(KordiCallMediaFailurePolicy.isFatalInitialMicrophonePublication(
            requestedEnabled: true,
            hasPublished: false
        ))
        XCTAssertFalse(KordiCallMediaFailurePolicy.isFatalInitialMicrophonePublication(
            requestedEnabled: true,
            hasPublished: true
        ))
        XCTAssertFalse(KordiCallMediaFailurePolicy.isFatalInitialMicrophonePublication(
            requestedEnabled: false,
            hasPublished: false
        ))
    }

    @MainActor
    func testTerminalCallMutationRequiresASessionOutsidePreview() async {
        let call = CloudCall(
            id: "0198aabc-8b27-7a30-8cba-215495609c7a",
            conversationId: "session:group:test",
            kind: .meeting,
            state: .active,
            createdByAccountId: "acct_me",
            createdAt: "2026-08-14T10:00:00Z",
            answeredAt: nil,
            endedAt: nil,
            participants: []
        )
        let signedOutModel = AppModel(previewMode: false)
        let previewModel = AppModel(previewMode: true)
        let signedOutResult = await signedOutModel.endCall(call)
        let previewResult = await previewModel.endCall(call)

        XCTAssertFalse(signedOutResult)
        XCTAssertEqual(signedOutModel.errorMessage, "Sign in again before ending the call.")
        XCTAssertTrue(previewResult)
    }

    func testDirectCallConnectsOnlyAfterRemoteParticipantJoinsRoom() {
        XCTAssertFalse(
            KordiCallConnectionReadiness.isConnected(
                kind: .video,
                hasRemoteParticipant: false
            )
        )
        XCTAssertTrue(
            KordiCallConnectionReadiness.isConnected(
                kind: .video,
                hasRemoteParticipant: true
            )
        )
    }

    func testMeetingConnectsWhenLocalRoomTransportIsReady() {
        XCTAssertTrue(
            KordiCallConnectionReadiness.isConnected(
                kind: .meeting,
                hasRemoteParticipant: false
            )
        )
    }

    func testCallRecoveryUsesBoundedIncreasingBackoff() {
        XCTAssertEqual(
            KordiCallRecoveryPolicy.reconnectDelays,
            [.seconds(1), .seconds(3)]
        )
    }

    func testCallMediaFailuresIdentifyTheirStage() {
        XCTAssertTrue(KordiCallMediaFailureStage.signaling.message.contains("signaling"))
        XCTAssertTrue(KordiCallMediaFailureStage.iceOrTurn.message.contains("ICE or TURN"))
        XCTAssertTrue(KordiCallMediaFailureStage.device.message.contains("microphone"))
    }

    func testCallCameraCaptureUsesFullHD() {
        XCTAssertEqual(KordiCallVideoQuality.captureDimensions.width, 1_920)
        XCTAssertEqual(KordiCallVideoQuality.captureDimensions.height, 1_080)
    }

    func testTimelinePresentationShowsAvatarOnlyOnTheLastAdjacentHumanMessage() {
        let start = Date(timeIntervalSince1970: 1_000)
        let messages = [
            timelineMessage(id: "peer-1", author: .person, name: "Maya", date: start),
            timelineMessage(id: "peer-2", author: .person, name: "Maya", date: start.addingTimeInterval(20)),
            timelineMessage(id: "own-1", author: .me, name: "You", date: start.addingTimeInterval(40)),
            timelineMessage(id: "own-2", author: .me, name: "You", date: start.addingTimeInterval(60)),
            timelineMessage(id: "agent", author: .agent, name: "My Kordi", date: start.addingTimeInterval(80))
        ]

        let presentation = ConversationTimelinePresentation.make(
            messages: messages,
            selfAccountId: "acct_me",
            participants: [
                CloudGroupParticipant(accountId: "acct_maya", displayName: "Maya", avatarUrl: nil, role: "person")
            ]
        )

        XCTAssertEqual(presentation.map(\.showsAvatar), [false, true, false, true, false])
        XCTAssertTrue(presentation[1].groupedWithPrevious)
        XCTAssertTrue(presentation[2].groupedWithNext)
    }

    func testTimelinePresentationBreaksAGroupAtTheTimestampBoundary() {
        let start = Date(timeIntervalSince1970: 1_000)
        let messages = [
            timelineMessage(id: "peer-1", author: .person, name: "Maya", date: start),
            timelineMessage(id: "peer-2", author: .person, name: "Maya", date: start.addingTimeInterval(299)),
            timelineMessage(id: "peer-3", author: .person, name: "Maya", date: start.addingTimeInterval(600))
        ]

        let presentation = ConversationTimelinePresentation.make(
            messages: messages,
            selfAccountId: "acct_me",
            participants: []
        )

        XCTAssertEqual(presentation.map(\.showsTimestamp), [true, false, true])
        XCTAssertEqual(presentation.map(\.showsAvatar), [false, true, true])
        XCTAssertFalse(presentation[2].groupedWithPrevious)
    }

    @MainActor
    func testTimelineTimestampUsesAWeekdayForRecentHistoricalMessages() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let locale = Locale(identifier: "en_US_POSIX")
        let now = Date(timeIntervalSince1970: 1_723_206_600) // Friday, Aug 9, 2024 09:50 UTC
        let date = now.addingTimeInterval(-2 * 86_400)

        XCTAssertTrue(
            ConversationTimestampFormatter.label(
                for: date,
                now: now,
                calendar: calendar,
                locale: locale
            ).hasPrefix("Wednesday ")
        )
    }

    func testChatListKeepsCustomThreeDotPullToRefreshAndNativeRows() throws {
        XCTAssertFalse(ChatPullToRefreshBehavior.shouldStart(distance: 24, isRefreshing: false))
        XCTAssertTrue(ChatPullToRefreshBehavior.shouldStart(
            distance: ChatPullToRefreshBehavior.triggerDistance,
            isRefreshing: false
        ))
        XCTAssertFalse(ChatPullToRefreshBehavior.shouldStart(distance: 120, isRefreshing: true))
        XCTAssertEqual(
            ChatPullToRefreshBehavior.pullDistance(contentOffsetY: -93, contentInsetTop: 59),
            34
        )

        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Chats/ChatHomeView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "private struct ChatPullToRefreshScrollView"))
        let end = try XCTUnwrap(source.range(
            of: "private struct ChatPullOffsetPreferenceKey",
            range: start.upperBound..<source.endIndex
        ))
        let refreshView = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(refreshView.contains("List {"))
        XCTAssertTrue(refreshView.contains("visualState = .pulling(progress:"))
        XCTAssertFalse(source.contains(".refreshable"))
    }

    func testChatSearchNormalizesWhitespaceAndMatchesContactIdentity() {
        let conversation = searchConversation(
            displayName: "Research Agent",
            lastMessage: "Review the latest build"
        )
        let contact = CloudContact(
            accountId: "acct_fish",
            kordiId: "331749497",
            displayName: "Research Agent",
            avatarUrl: nil,
            nodeId: nil,
            createdAt: "2026-08-10T00:00:00Z"
        )

        XCTAssertEqual(ChatHomeSearch.normalized("  latest\n"), "latest")
        XCTAssertTrue(ChatHomeSearch.matches(conversation, contact: contact, query: "3317"))
        XCTAssertTrue(ChatHomeSearch.matches(conversation, contact: contact, query: "LATEST"))
        XCTAssertFalse(ChatHomeSearch.matches(conversation, contact: contact, query: "missing"))
    }

    func testChatSearchMatchesGroupParticipantsAndSessions() {
        let session = searchConversation(
            displayName: "Budget planning",
            lastMessage: "Share the final numbers",
            kind: .group
        )
        let space = GroupSpaceSummary(
            id: "group:lab",
            displayName: "Lab",
            lastMessage: "Yesterday",
            lastActivityAt: Date(timeIntervalSince1970: 1_000),
            unreadCount: 0,
            unreadMentionCount: 0,
            participants: [
                CloudGroupParticipant(
                    accountId: "acct_maya",
                    displayName: "Maya Chen",
                    avatarUrl: nil,
                    role: "person"
                )
            ],
            sessions: [session],
            membershipSessions: [session]
        )

        XCTAssertTrue(ChatHomeSearch.matches(space, query: "maya"))
        XCTAssertTrue(ChatHomeSearch.matches(space, query: "budget"))
        XCTAssertFalse(ChatHomeSearch.matches(space, query: "roadmap"))
    }

    func testSessionRelatedGroupsRequireBothConversationParticipants() {
        let fixture = PreviewData.make(now: Date(timeIntervalSince1970: 1_000))

        let sharedWithMaya = SessionRelatedGroupCatalog.mutualSpaces(
            conversations: fixture.conversations,
            ownAccountID: fixture.account.accountId,
            peerAccountID: "acct_maya"
        )
        let sharedWithPriya = SessionRelatedGroupCatalog.mutualSpaces(
            conversations: fixture.conversations,
            ownAccountID: fixture.account.accountId,
            peerAccountID: "acct_priya"
        )

        XCTAssertEqual(sharedWithMaya.map(\.displayName), ["Mobile builders"])
        XCTAssertEqual(sharedWithMaya.first?.sessions.count, 2)
        XCTAssertTrue(sharedWithPriya.isEmpty)
    }

    func testConversationDoesNotAnimateItsInitialLatestMessagePosition() {
        XCTAssertFalse(ConversationTimelineScrollBehavior.shouldFollowLatest(
            hasPositionedInitialTimeline: false,
            isAtBottom: false,
            previousLatestMessageID: nil,
            currentLatestMessageID: "message-12"
        ))
    }

    func testConversationDoesNotJumpWhenANewMessageArrivesAfterScrollingUp() {
        XCTAssertFalse(ConversationTimelineScrollBehavior.shouldFollowLatest(
            hasPositionedInitialTimeline: true,
            isAtBottom: false,
            previousLatestMessageID: "message-12",
            currentLatestMessageID: "message-13"
        ))
        XCTAssertTrue(ConversationTimelineScrollBehavior.shouldShowLatestButton(
            isAtBottom: false,
            messageCount: 13
        ))
    }

    func testLocalOutgoingMessagesRequestTheBottomBeforeSending() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ConversationView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "private func sendOutgoingMessages"))
        let end = try XCTUnwrap(source.range(
            of: "private func resolvedMentionTarget",
            range: start.upperBound..<source.endIndex
        ))
        let sender = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(sender.contains("scrollToBottom(animated: true)"))
    }

    func testConversationKeepsFollowingNewMessagesWhileAtLatest() {
        XCTAssertTrue(ConversationTimelineScrollBehavior.shouldFollowLatest(
            hasPositionedInitialTimeline: true,
            isAtBottom: true,
            previousLatestMessageID: "message-12",
            currentLatestMessageID: "message-13"
        ))
        XCTAssertFalse(ConversationTimelineScrollBehavior.shouldShowLatestButton(
            isAtBottom: true,
            messageCount: 13
        ))
    }

    func testConversationKeepsFollowingWhenLatestMessageStreamsInPlace() {
        XCTAssertTrue(ConversationTimelineScrollBehavior.shouldFollowLatest(
            hasPositionedInitialTimeline: true,
            isAtBottom: true,
            previousLatestMessageID: "message-13",
            currentLatestMessageID: "message-13"
        ))
    }

    func testConversationUsesTheBottomAnchorWhileGeometryCatchesUp() {
        XCTAssertTrue(ConversationTimelineScrollBehavior.isFollowingLatest(
            isAtBottom: false,
            trackedMessageID: "conversation-bottom",
            bottomAnchorID: "conversation-bottom"
        ))
        XCTAssertFalse(ConversationTimelineScrollBehavior.isFollowingLatest(
            isAtBottom: false,
            trackedMessageID: "message-12",
            bottomAnchorID: "conversation-bottom"
        ))
    }

    func testConversationSourceLayoutContracts() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ConversationView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let animation = ".animation(.snappy(duration: 0.2), value: isAtBottom)"
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false)

        XCTAssertTrue(lines.contains("                            \(animation)"))
        XCTAssertFalse(lines.contains("                        \(animation)"))
        XCTAssertFalse(source.contains(".safeAreaInset(edge: .bottom"))
        XCTAssertFalse(source.contains(".scrollDismissesKeyboard("))
        XCTAssertFalse(source.contains("keyboardAvoidanceHeight"))
        XCTAssertTrue(source.contains("scrollView.keyboardDismissMode = .onDrag"))
        XCTAssertTrue(source.contains(".padding(.bottom, timelineVerticalInset)\n                                        .id(bottomAnchorID)"))
        XCTAssertTrue(source.contains("viewport.size.height - timelineVerticalInset"))
        XCTAssertTrue(source.contains(".padding(.top, timelineVerticalInset)"))
        XCTAssertFalse(source.contains(".padding(.vertical, timelineVerticalInset)"))
        XCTAssertTrue(source.contains("@State private var isComposerFocused = false"))
        XCTAssertTrue(source.contains("isFocused: $isComposerFocused,"))
        XCTAssertTrue(source.contains("dismissKeyboard()\n                                    dismissComposerPickers()"))

        let composer = try XCTUnwrap(source.range(of: "                        ComposerView("))
        let rootModifiers = try XCTUnwrap(source.range(of: "            .onChange(of: timeline.count)"))
        XCTAssertLessThan(composer.lowerBound, rootModifiers.lowerBound)
    }

    func testConversationRepositionsLatestAfterLazyTimelineLayout() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Kordi/Features/Conversation/ConversationView.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "private func positionAndRevealInitialViewport"))
        let end = try XCTUnwrap(source.range(
            of: "private func loadAndRevealInitialConversation",
            range: start.upperBound..<source.endIndex
        ))
        let positioning = source[start.lowerBound..<end.lowerBound]

        XCTAssertEqual(
            positioning.components(separatedBy: "proxy.scrollTo(bottomAnchorID, anchor: .bottom)").count - 1,
            2
        )
    }

    func testConversationShowsLatestButtonWhenInitialScrollHasNotCompleted() {
        XCTAssertTrue(ConversationTimelineScrollBehavior.shouldShowLatestButton(
            isAtBottom: false,
            messageCount: 13
        ))
    }

    func testConversationInitialLoadingDoesNotInventRowsWithoutCachedMessages() {
        XCTAssertTrue(ConversationInitialPlaceholderCatalog.make(from: []).isEmpty)
    }

    func testConversationInitialLoadingUsesBoundedCachedMessageGeometry() {
        let baseDate = Date(timeIntervalSince1970: 1_000)
        let image = ChatAttachment(
            attachmentId: "image-1",
            name: "preview.png",
            kind: .image,
            mimeType: "image/png",
            sizeBytes: 1_024,
            previewURL: nil
        )
        let messages = [
            ChatMessage(
                id: "message-1",
                conversationId: "conversation-1",
                author: .me,
                authorName: "Me",
                text: "A cached message",
                createdAt: baseDate,
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil
            ),
            ChatMessage(
                id: "message-2",
                conversationId: "conversation-1",
                author: .person,
                authorName: "Alex",
                text: "https://kordi.ai/cached-preview",
                createdAt: baseDate.addingTimeInterval(1),
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil
            ),
            ChatMessage(
                id: "message-3",
                conversationId: "conversation-1",
                author: .person,
                authorName: "Alex",
                text: "",
                createdAt: baseDate.addingTimeInterval(2),
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil,
                attachments: [image]
            ),
            ChatMessage(
                id: "message-4",
                conversationId: "conversation-1",
                author: .agent,
                authorName: "My Kordi",
                text: "Cached agent response",
                createdAt: baseDate.addingTimeInterval(3),
                deliveryState: .read,
                errorMessage: nil,
                requestMessageId: nil
            ),
        ]

        let placeholders = ConversationInitialPlaceholderCatalog.make(from: messages)

        XCTAssertEqual(placeholders.map(\.id), messages.map(\.id))
        XCTAssertEqual(placeholders.map(\.kind), [.message, .link, .image, .agent])
        XCTAssertEqual(placeholders.map(\.author), [.me, .person, .person, .agent])
        XCTAssertLessThanOrEqual(placeholders.count, ConversationInitialPlaceholderCatalog.limit)
    }

    func testConversationDetectsLatestPositionFromVisibleScrollGeometry() {
        XCTAssertFalse(ConversationTimelineScrollBehavior.isAtLatest(
            visibleMaxY: 700,
            contentHeight: 1_400,
            containerHeight: 600
        ))
        XCTAssertTrue(ConversationTimelineScrollBehavior.isAtLatest(
            visibleMaxY: 1_392,
            contentHeight: 1_400,
            containerHeight: 600
        ))
    }

    func testConversationFollowsViewportResizeOnlyWhileAlreadyAtLatest() {
        let fullViewport = CGSize(width: 390, height: 700)
        let reducedViewport = CGSize(width: 390, height: 380)

        XCTAssertTrue(ConversationTimelineScrollBehavior.shouldKeepLatestVisibleAfterViewportChange(
            hasRevealedInitialViewport: true,
            wasAtLatest: true,
            previousViewportSize: fullViewport,
            currentViewportSize: reducedViewport
        ))
        XCTAssertFalse(ConversationTimelineScrollBehavior.shouldKeepLatestVisibleAfterViewportChange(
            hasRevealedInitialViewport: true,
            wasAtLatest: false,
            previousViewportSize: fullViewport,
            currentViewportSize: reducedViewport
        ))
        XCTAssertFalse(ConversationTimelineScrollBehavior.shouldKeepLatestVisibleAfterViewportChange(
            hasRevealedInitialViewport: false,
            wasAtLatest: true,
            previousViewportSize: .zero,
            currentViewportSize: fullViewport
        ))

        XCTAssertTrue(ConversationTimelineScrollBehavior.shouldFollowLatestWhenPresentingInputSurface(
            hasRevealedInitialViewport: true,
            wasAtLatest: true,
            isPresented: true
        ))
        XCTAssertFalse(ConversationTimelineScrollBehavior.shouldFollowLatestWhenPresentingInputSurface(
            hasRevealedInitialViewport: true,
            wasAtLatest: false,
            isPresented: true
        ))
    }

    func testConversationRestoresPositionForAQuickReturnWithoutNewMessages() {
        let memory = ConversationViewportMemory()
        let leftAt = Date(timeIntervalSince1970: 1_000)
        memory.remember(
            key: "account:session",
            messageID: "message-4",
            latestMessageID: "message-9",
            at: leftAt
        )

        XCTAssertEqual(
            memory.resumedMessageID(
                for: "account:session",
                latestMessageID: "message-9",
                availableMessageIDs: ["message-4", "message-9"],
                now: leftAt.addingTimeInterval(119)
            ),
            "message-4"
        )
    }

    func testThreadViewportDoesNotClearParentConversationPosition() {
        let memory = ConversationViewportMemory()
        let leftAt = Date(timeIntervalSince1970: 1_000)
        memory.remember(
            key: "account:session:conversation",
            messageID: "message-4",
            latestMessageID: "message-9",
            at: leftAt
        )
        memory.remember(
            key: "account:session:thread:root",
            messageID: nil,
            latestMessageID: "thread-reply",
            at: leftAt.addingTimeInterval(1)
        )

        XCTAssertEqual(
            memory.resumedMessageID(
                for: "account:session:conversation",
                latestMessageID: "message-9",
                availableMessageIDs: ["message-4", "message-9"],
                now: leftAt.addingTimeInterval(2)
            ),
            "message-4"
        )
    }

    func testConversationStartsAtLatestAfterTwoMinutes() {
        let memory = ConversationViewportMemory()
        let leftAt = Date(timeIntervalSince1970: 1_000)
        memory.remember(
            key: "account:session",
            messageID: "message-4",
            latestMessageID: "message-9",
            at: leftAt
        )

        XCTAssertNil(memory.resumedMessageID(
            for: "account:session",
            latestMessageID: "message-9",
            availableMessageIDs: ["message-4", "message-9"],
            now: leftAt.addingTimeInterval(120)
        ))
    }

    func testConversationStartsAtLatestWhenANewMessageArrived() {
        let memory = ConversationViewportMemory()
        let leftAt = Date(timeIntervalSince1970: 1_000)
        memory.remember(
            key: "account:session",
            messageID: "message-4",
            latestMessageID: "message-9",
            at: leftAt
        )

        XCTAssertNil(memory.resumedMessageID(
            for: "account:session",
            latestMessageID: "message-10",
            availableMessageIDs: ["message-4", "message-9", "message-10"],
            now: leftAt.addingTimeInterval(30)
        ))
    }

    func testPullProgressIsClampedToTheRefreshThreshold() {
        XCTAssertEqual(KordiSyncMarkGeometry.pullProgress(for: -12, triggerDistance: 68), 0)
        XCTAssertEqual(KordiSyncMarkGeometry.pullProgress(for: 34, triggerDistance: 68), 0.5)
        XCTAssertEqual(KordiSyncMarkGeometry.pullProgress(for: 120, triggerDistance: 68), 1)
    }

    func testColorRelayPulsesBrandCirclesInOrder() {
        let initial = (0..<3).map {
            KordiColorRelayMotion.sample(index: $0, elapsed: 0)
        }
        let samples = (0..<3).map {
            KordiColorRelayMotion.sample(
                index: $0,
                elapsed: KordiColorRelayMotion.handoffDuration
                    + (KordiColorRelayMotion.cycleDuration / 4)
            )
        }

        XCTAssertEqual(initial.map(\.scale), [1, 1, 1])
        XCTAssertEqual(initial.map(\.opacity), [1, 1, 1])
        XCTAssertEqual(samples[0].scale, 1.12, accuracy: 0.001)
        XCTAssertEqual(samples[0].opacity, 1, accuracy: 0.001)
        XCTAssertGreaterThan(samples[0].scale, samples[1].scale)
        XCTAssertGreaterThan(samples[1].scale, samples[2].scale)
    }

    func testThreeBallMarkReturnsToNormalSpacingWhileRefreshing() {
        for index in 0..<3 {
            let pull = KordiSyncMarkGeometry.sample(
                index: index,
                motion: .pulling(progress: 1),
                elapsed: 0
            )
            let refresh = KordiSyncMarkGeometry.sample(
                index: index,
                motion: .refreshing,
                elapsed: 0
            )

            XCTAssertEqual(pull.offset.width, 0, accuracy: 0.001)
            XCTAssertEqual(refresh.offset.height, 0, accuracy: 0.001)
            if index != 1 {
                XCTAssertGreaterThan(abs(pull.offset.height), abs(refresh.offset.width))
                XCTAssertEqual(abs(refresh.offset.width), KordiSyncMarkGeometry.ballSpacing, accuracy: 0.001)
            }
        }
    }

    func testRefreshWaitsForTheReturnBeforeStartingTheBounce() {
        let atRelease = KordiSyncMarkGeometry.sample(
            index: 0,
            motion: .refreshing,
            elapsed: 0
        )
        let afterReturn = KordiSyncMarkGeometry.sample(
            index: 0,
            motion: .refreshing,
            elapsed: KordiSyncMarkGeometry.refreshBounceDelay + 0.24
        )

        XCTAssertEqual(atRelease.offset.height, 0, accuracy: 0.001)
        XCTAssertLessThan(afterReturn.offset.height, 0)
        XCTAssertGreaterThan(afterReturn.scale, 1)
    }

    func testThreeBallMarkUsesSeparatedHorizontalAndVerticalLines() {
        let idle = (0..<3).map {
            KordiSyncMarkGeometry.sample(index: $0, motion: .idle, elapsed: 0).offset
        }
        XCTAssertEqual(idle.map(\.height), [0, 0, 0])
        XCTAssertEqual(idle[1].width - idle[0].width, KordiSyncMarkGeometry.ballSpacing)
        XCTAssertEqual(idle[2].width - idle[1].width, KordiSyncMarkGeometry.ballSpacing)
        XCTAssertGreaterThan(KordiSyncMarkGeometry.ballSpacing, KordiSyncMarkGeometry.ballDiameter)

        let pulled = (0..<3).map {
            KordiSyncMarkGeometry.sample(index: $0, motion: .pulling(progress: 1), elapsed: 0).offset
        }
        XCTAssertEqual(pulled[0].width, 0, accuracy: 0.001)
        XCTAssertEqual(pulled[1].width, 0, accuracy: 0.001)
        XCTAssertEqual(pulled[2].width, 0, accuracy: 0.001)
        XCTAssertEqual(
            pulled[1].height - pulled[0].height,
            KordiSyncMarkGeometry.expandedBallSpacing,
            accuracy: 0.001
        )
        XCTAssertEqual(
            pulled[2].height - pulled[1].height,
            KordiSyncMarkGeometry.expandedBallSpacing,
            accuracy: 0.001
        )
    }

    func testThreeBallSpacingGrowsWithPullDistance() {
        let start = KordiSyncMarkGeometry.sample(
            index: 0,
            motion: .pulling(progress: 0),
            elapsed: 0
        ).offset
        let middle = KordiSyncMarkGeometry.sample(
            index: 0,
            motion: .pulling(progress: 0.5),
            elapsed: 0
        ).offset
        let end = KordiSyncMarkGeometry.sample(
            index: 0,
            motion: .pulling(progress: 1),
            elapsed: 0
        ).offset

        XCTAssertLessThan(hypot(start.width, start.height), hypot(middle.width, middle.height))
        XCTAssertLessThan(hypot(middle.width, middle.height), hypot(end.width, end.height))
    }

    private func timelineMessage(
        id: String,
        author: MessageAuthor,
        name: String,
        date: Date
    ) -> ChatMessage {
        ChatMessage(
            id: id,
            conversationId: "conversation",
            author: author,
            authorName: name,
            text: id,
            createdAt: date,
            deliveryState: .delivered,
            errorMessage: nil,
            requestMessageId: nil
        )
    }

    private func searchConversation(
        displayName: String,
        lastMessage: String,
        kind: ConversationKind = .person
    ) -> ConversationSummary {
        ConversationSummary(
            id: "conversation:search",
            kind: kind,
            peerAccountId: "acct_fish",
            agentId: nil,
            ownerDisplayName: "Alex Morgan",
            displayName: displayName,
            lastMessage: lastMessage,
            lastActivityAt: Date(timeIntervalSince1970: 1_000),
            unreadCount: 0,
            avatarSource: nil,
            agentActivity: nil,
            sessionId: "session:search"
        )
    }
}
