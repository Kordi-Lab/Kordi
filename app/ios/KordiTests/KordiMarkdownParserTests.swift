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
            displayName: "C UFishAI",
            lastMessage: "Review the latest build"
        )
        let contact = CloudContact(
            accountId: "acct_fish",
            kordiId: "331749497",
            displayName: "C UFishAI",
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

    func testPullDistanceUsesNativeScrollGeometryInsets() {
        XCTAssertEqual(
            ChatPullToRefreshBehavior.pullDistance(contentOffsetY: -59, contentInsetTop: 59),
            0
        )
        XCTAssertEqual(
            ChatPullToRefreshBehavior.pullDistance(contentOffsetY: -93, contentInsetTop: 59),
            34
        )
        XCTAssertEqual(
            ChatPullToRefreshBehavior.pullDistance(contentOffsetY: 20, contentInsetTop: 0),
            0
        )
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
        XCTAssertEqual(CloudAvatarFallback.initials(for: "陈 小明"), "陈小")
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
            ownerDisplayName: "Shu Yang",
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
