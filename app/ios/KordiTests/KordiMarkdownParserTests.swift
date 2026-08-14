import XCTest
@testable import Kordi

final class KordiMarkdownParserTests: XCTestCase {
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
            "group:mobile": "gm3",
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
    func testExpandingPreviewGroupClearsUnreadWithoutCloud() async throws {
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
    func testCurrentOrPreviouslySettledConversationCanRevealBeforeReload() throws {
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
        XCTAssertFalse(model.canRevealConversationImmediately(pendingConversation))

        model.markConversationPresentationSettled(pendingConversation)
        XCTAssertTrue(model.canRevealConversationImmediately(pendingConversation))

        var updatedConversation = pendingConversation
        updatedConversation.lastActivityAt = pendingConversation.lastActivityAt.addingTimeInterval(1)
        XCTAssertFalse(model.canRevealConversationImmediately(updatedConversation))
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

    @MainActor
    func testPreviewCallWritesStartAndEndActivitiesToTheConversation() throws {
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
        XCTAssertEqual(callActivities.suffix(2).map(\.event), [.started, .ended])
        XCTAssertEqual(
            model.conversations.first(where: { $0.id == conversation.id })?.lastMessage,
            "The video chat ended."
        )
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

    func testPullToRefreshStartsOnceOnlyAfterCrossingTheThreshold() {
        XCTAssertFalse(ChatPullToRefreshBehavior.shouldStart(distance: 24, isRefreshing: false))
        XCTAssertTrue(ChatPullToRefreshBehavior.shouldStart(
            distance: ChatPullToRefreshBehavior.triggerDistance,
            isRefreshing: false
        ))
        XCTAssertFalse(ChatPullToRefreshBehavior.shouldStart(distance: 120, isRefreshing: true))
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
            participants: [
                CloudGroupParticipant(
                    accountId: "acct_maya",
                    displayName: "Maya Chen",
                    avatarUrl: nil,
                    role: "person"
                )
            ],
            sessions: [session]
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

    func testPullDistanceUsesNativeScrollGeometryInsets() {
        XCTAssertEqual(
            ChatPullToRefreshBehavior.pullDistance(contentOffsetY: -59, contentInsetTop: 59),
            0
        )
        XCTAssertEqual(
            ChatPullToRefreshBehavior.pullDistance(contentOffsetY: -93, contentInsetTop: 59),
            34
        )
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

    func testConversationDoesNotScrollWhenRemoteSyncOnlyRefreshesExistingMessages() {
        XCTAssertFalse(ConversationTimelineScrollBehavior.shouldFollowLatest(
            hasPositionedInitialTimeline: true,
            isAtBottom: true,
            previousLatestMessageID: "message-13",
            currentLatestMessageID: "message-13"
        ))
    }

    func testConversationShowsLatestButtonWhenInitialScrollHasNotCompleted() {
        XCTAssertTrue(ConversationTimelineScrollBehavior.shouldShowLatestButton(
            isAtBottom: false,
            messageCount: 13
        ))
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

    func testAvatarFallbackMatchesTheDesktopInitialsRule() {
        XCTAssertEqual(CloudAvatarFallback.initials(for: "Kordi Support"), "KO")
        XCTAssertEqual(CloudAvatarFallback.initials(for: "Chen Xiaoming"), "CH")
        XCTAssertEqual(CloudAvatarFallback.initials(for: " -- "), "KO")
        XCTAssertEqual(
            CloudAvatarFallback.paletteIndex(for: "Kordi Support"),
            CloudAvatarFallback.paletteIndex(for: "Kordi Support")
        )
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
