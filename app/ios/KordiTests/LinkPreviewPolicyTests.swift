import UIKit
import XCTest
@testable import Kordi

/// Serves synthetic site icons and redirects, and records every requested URL.
private final class SiteIconStubProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var requested: [URL] = []

    static var requestedURLs: [URL] { lock.withLock { requested } }

    static let iconData: Data = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32)).pngData { context in
        UIColor.systemBlue.setFill()
        context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let host = url.host else { return }
        Self.lock.withLock { Self.requested.append(url) }
        switch url.path {
        case "/ok.ico":
            respond(status: 200, body: Self.iconData)
        case "/large.ico":
            respond(status: 200, body: Data(repeating: 0x41, count: LinkSiteIconLoader.maximumBytes + 1))
        case "/missing.ico":
            respond(status: 404, body: Data("missing".utf8))
        case "/redirect-public.ico":
            redirect(to: "https://cdn.\(host)/ok.ico")
        case "/redirect-private.ico":
            redirect(to: "https://127.0.0.1/ok.ico")
        default:
            respond(status: 404, body: Data())
        }
    }

    override func stopLoading() {}

    private func respond(status: Int, body: Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    private func redirect(to target: String) {
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": target]
        )!
        client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: URL(string: target)!), redirectResponse: response)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class LinkPreviewPolicyTests: XCTestCase {
    private let contacts: Set<String> = ["acct_contact", "acct_peer"]

    private func allows(
        _ setting: LinkPreviewSetting,
        author: MessageAuthor,
        sender: String?,
        kind: ConversationKind = .group,
        peer: String? = "acct_peer",
        blocked: Set<String> = []
    ) -> Bool {
        LinkPreviewPolicy.allowsNetworkFetch(
            setting: setting,
            author: author,
            senderAccountId: sender,
            conversationKind: kind,
            conversationPeerAccountId: peer,
            contactAccountIds: contacts,
            blockedAccountIds: blocked
        )
    }

    func testOffNeverFetchesAndEveryoneAlwaysFetches() {
        for author in [MessageAuthor.me, .person, .agent] {
            for sender in [nil, "acct_contact", "acct_stranger"] as [String?] {
                XCTAssertFalse(allows(.off, author: author, sender: sender))
                XCTAssertTrue(allows(.everyone, author: author, sender: sender))
            }
        }
    }

    func testContactsAllowsOwnMessagesAndContactsOnly() {
        XCTAssertTrue(allows(.contacts, author: .me, sender: nil))
        XCTAssertTrue(allows(.contacts, author: .me, sender: "acct_me"))
        XCTAssertTrue(allows(.contacts, author: .person, sender: "acct_contact"))
        XCTAssertFalse(allows(.contacts, author: .person, sender: "acct_stranger"))
        XCTAssertFalse(allows(.contacts, author: .person, sender: ""))
    }

    func testContactsNeverAllowsAgentOutput() {
        XCTAssertFalse(allows(.contacts, author: .agent, sender: nil))
        XCTAssertFalse(allows(.contacts, author: .agent, sender: "acct_contact"))
        XCTAssertFalse(allows(.contacts, author: .agent, sender: nil, kind: .person))
        XCTAssertFalse(allows(.contacts, author: .agent, sender: nil, kind: .agent))
    }

    func testDirectConversationFallsBackToThePeerOnlyWhenTheSenderIsUnknown() {
        XCTAssertTrue(allows(.contacts, author: .person, sender: nil, kind: .person, peer: "acct_peer"))
        XCTAssertFalse(allows(.contacts, author: .person, sender: nil, kind: .person, peer: "acct_stranger"))
        XCTAssertFalse(allows(.contacts, author: .person, sender: nil, kind: .person, peer: nil))
        // A known sender is never replaced by the peer.
        XCTAssertFalse(allows(.contacts, author: .person, sender: "acct_stranger", kind: .person, peer: "acct_peer"))
    }

    func testGroupAndAgentConversationsFailClosedWithoutASender() {
        XCTAssertFalse(allows(.contacts, author: .person, sender: nil, kind: .group, peer: "acct_peer"))
        XCTAssertFalse(allows(.contacts, author: .person, sender: nil, kind: .agent, peer: "acct_peer"))
    }

    func testBlockedContactsNeverFetch() {
        XCTAssertFalse(allows(.contacts, author: .person, sender: "acct_contact", blocked: ["acct_contact"]))
        XCTAssertFalse(allows(.contacts, author: .person, sender: nil, kind: .person, peer: "acct_peer", blocked: ["acct_peer"]))
    }

    func testSettingDefaultsToContactsForMissingOrUnknownValues() throws {
        XCTAssertEqual(LinkPreviewSetting(storedValue: nil), .contacts)
        XCTAssertEqual(LinkPreviewSetting(storedValue: "bogus"), .contacts)
        XCTAssertEqual(LinkPreviewSetting(storedValue: "everyone"), .everyone)
        XCTAssertEqual(LinkPreviewSetting(storedValue: "off"), .off)
        XCTAssertEqual(LinkPreviewSetting.storageKey, "kordi.privacy.linkPreviews")
        XCTAssertEqual(LinkPreviewSetting.allCases.map(\.title), ["From contacts", "Everyone", "Off"])

        let suite = "kordi.tests.link-previews.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(LinkPreviewSetting.current(defaults: defaults), .contacts)
        defaults.set(42, forKey: LinkPreviewSetting.storageKey)
        XCTAssertEqual(LinkPreviewSetting.current(defaults: defaults), .contacts)
        defaults.set("off", forKey: LinkPreviewSetting.storageKey)
        XCTAssertEqual(LinkPreviewSetting.current(defaults: defaults), .off)
    }

    func testPreviewableURLRejectsNonPublicTargets() {
        let rejected = [
            "http://example.com/",
            "https://example.com:8443/",
            "https://127.1/",
            "https://0x7f.1/",
            "https://10.0.0.1/",
            "https://1.2.3.4/",
            "https://[::1]/",
            "https://localhost/",
            "https://localhost./",
            "https://foo.localhost/",
            "https://nas.local./",
            "https://x.internal/",
            "https://printer.lan/",
            "https://router.home.arpa/",
            "https://1.0.0.127.in-addr.arpa/",
            "https://intranet/",
            "https://user:pw@example.com/",
            "https://user@example.com/",
            "https://a_b.example.com/",
            "https://example..com/",
            "https://\(String(repeating: "a", count: 64)).example/",
        ]
        for value in rejected {
            XCTAssertFalse(LinkPreviewPolicy.isPreviewableURL(URL(string: value)), value)
        }
        XCTAssertFalse(LinkPreviewPolicy.isPreviewableURL(nil))
    }

    func testPreviewableURLAcceptsPublicHTTPSNames() {
        let accepted = [
            "https://example.com/",
            "https://example.com./",
            "https://EXAMPLE.com/path?q=1",
            "https://example.com:443/",
            "https://xn--bcher-kva.example/",
            "https://docs.github.com/en",
            "https://0x7f.example/",
            "https://1password.com/",
        ]
        for value in accepted {
            XCTAssertTrue(LinkPreviewPolicy.isPreviewableURL(URL(string: value)), value)
        }
    }

    @MainActor
    func testSiteIconURLUsesOnlyPreviewableHosts() {
        XCTAssertEqual(
            LinkSiteIconLoader.iconURL(forHost: "Example.com")?.absoluteString,
            "https://example.com/favicon.ico"
        )
        for host in ["127.1", "localhost", "nas.local", "a_b.example.com", "example.com:8443", "other.example/@x"] {
            XCTAssertNil(LinkSiteIconLoader.iconURL(forHost: host), host)
        }
    }

    @MainActor
    func testSiteIconLoaderReturnsNothingForNonPreviewableHosts() async {
        let icon = await LinkSiteIconLoader.icon(forHost: "127.0.0.1")
        XCTAssertNil(icon)
    }

    private func stubbedSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SiteIconStubProtocol.self]
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 5
        return URLSession(configuration: configuration)
    }

    func testSiteIconSessionKeepsNothingOnDisk() {
        let configuration = LinkSiteIconLoader.makeSessionConfiguration()
        XCTAssertNil(configuration.urlCache)
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertNil(configuration.urlCredentialStorage)
        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertEqual(configuration.httpCookieAcceptPolicy, .never)
        XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(configuration.timeoutIntervalForRequest, 10)
        XCTAssertEqual(configuration.timeoutIntervalForResource, 15)
    }

    func testSiteIconFetchDecodesSmallIconsAndRejectsLargeOrFailedResponses() async throws {
        let session = stubbedSession()
        defer { session.invalidateAndCancel() }
        let host = "icons-\(UUID().uuidString.lowercased()).example"

        let icon = await LinkSiteIconLoader.fetchIcon(try XCTUnwrap(URL(string: "https://\(host)/ok.ico")), session: session)
        let image = try XCTUnwrap(icon)
        XCTAssertLessThanOrEqual(max(image.size.width, image.size.height) * image.scale, LinkSiteIconLoader.maximumPixelSize)

        let large = await LinkSiteIconLoader.fetchIcon(try XCTUnwrap(URL(string: "https://\(host)/large.ico")), session: session)
        XCTAssertNil(large)
        let missing = await LinkSiteIconLoader.fetchIcon(try XCTUnwrap(URL(string: "https://\(host)/missing.ico")), session: session)
        XCTAssertNil(missing)
    }

    func testSiteIconFetchFollowsPublicRedirectsOnly() async throws {
        let session = stubbedSession()
        defer { session.invalidateAndCancel() }
        let host = "icons-\(UUID().uuidString.lowercased()).example"

        let redirected = await LinkSiteIconLoader.fetchIcon(
            try XCTUnwrap(URL(string: "https://\(host)/redirect-public.ico")),
            session: session
        )
        XCTAssertNotNil(redirected)
        XCTAssertTrue(SiteIconStubProtocol.requestedURLs.contains { $0.host == "cdn.\(host)" })

        let refused = await LinkSiteIconLoader.fetchIcon(
            try XCTUnwrap(URL(string: "https://\(host)/redirect-private.ico")),
            session: session
        )
        XCTAssertNil(refused)
        XCTAssertFalse(SiteIconStubProtocol.requestedURLs.contains { $0.host == "127.0.0.1" })

        let direct = await LinkSiteIconLoader.fetchIcon(try XCTUnwrap(URL(string: "https://127.0.0.1/ok.ico")), session: session)
        XCTAssertNil(direct)
        XCTAssertFalse(SiteIconStubProtocol.requestedURLs.contains { $0.host == "127.0.0.1" })
    }

    func testRedirectGuardAllowsThreePublicHopsAndRefusesPrivateTargets() throws {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let start = try XCTUnwrap(URL(string: "https://example.com/favicon.ico"))
        let task = session.dataTask(with: start)
        let response = try XCTUnwrap(HTTPURLResponse(url: start, statusCode: 302, httpVersion: nil, headerFields: nil))

        func redirect(_ guardian: SiteIconRedirectGuard, to target: String) -> URLRequest? {
            var result: URLRequest?
            guardian.urlSession(
                session,
                task: task,
                willPerformHTTPRedirection: response,
                newRequest: URLRequest(url: URL(string: target)!)
            ) { result = $0 }
            return result
        }

        let publicHops = SiteIconRedirectGuard()
        XCTAssertNotNil(redirect(publicHops, to: "https://www.example.com/favicon.ico"))
        XCTAssertNotNil(redirect(publicHops, to: "https://cdn.example.com/favicon.ico"))
        XCTAssertNotNil(redirect(publicHops, to: "https://static.example.com/favicon.ico"))
        XCTAssertNil(redirect(publicHops, to: "https://img.example.com/favicon.ico"), "fourth hop")

        XCTAssertNil(redirect(SiteIconRedirectGuard(), to: "https://127.0.0.1/"))
        XCTAssertNil(redirect(SiteIconRedirectGuard(), to: "http://example.com/favicon.ico"))
        XCTAssertNil(redirect(SiteIconRedirectGuard(), to: "https://router.home.arpa/"))
    }

    func testContactAccountIDsExcludeSystemAgents() {
        let contacts = [
            CloudContact(accountId: "acct_friend", kordiId: nil, displayName: "Friend", avatarUrl: nil, nodeId: nil, createdAt: "2026-09-01T00:00:00Z"),
            CloudContact(accountId: "acct_support", kordiId: nil, displayName: "Support", avatarUrl: nil, nodeId: nil, createdAt: "2026-09-01T00:00:00Z", contactKind: "system_agent"),
            CloudContact(accountId: "acct_colleague", kordiId: nil, displayName: "Colleague", avatarUrl: nil, nodeId: nil, createdAt: "2026-09-01T00:00:00Z", contactKind: "human"),
        ]
        XCTAssertEqual(AppModel.linkPreviewContactAccountIDs(contacts), ["acct_friend", "acct_colleague"])
    }

    @MainActor
    func testPreviewModelPublishesContactAccountIDs() {
        let model = AppModel(previewMode: true)
        XCTAssertFalse(model.contacts.isEmpty)
        XCTAssertEqual(model.contactAccountIDs, AppModel.linkPreviewContactAccountIDs(model.contacts))
    }

    // MARK: Sender identity

    private let groupConversation = ConversationSummary(
        id: "group:privacy", kind: .group, peerAccountId: "acct_peer", agentId: nil,
        ownerDisplayName: "Group", displayName: "Group", lastMessage: "",
        lastActivityAt: Date(timeIntervalSince1970: 1), unreadCount: 0,
        avatarSource: nil, agentActivity: nil, sessionId: "session:group:privacy"
    )

    private func groupWire(
        id: String,
        storedSender: String,
        envelopeSender: String,
        senderKind: String? = nil
    ) throws -> CloudMessageDTO {
        let actor = CloudGroupParticipant(accountId: envelopeSender, displayName: "Sender", avatarUrl: nil, role: "member")
        let envelope = CloudGroupControlEnvelope(
            kind: "group-message", groupId: groupConversation.sessionId,
            groupSpaceId: groupConversation.sessionId, groupTitle: "Group",
            createdByAccountId: envelopeSender, actor: actor, participants: [actor],
            message: CloudGroupMessagePayload(
                id: id, senderAccountId: envelopeSender, text: "https://example.com/",
                createdAtMs: 1_000, senderKind: senderKind, senderDisplayName: "Sender",
                deliveryState: nil, replyToMessageId: nil, requestId: nil
            )
        )
        return CloudMessageDTO(
            messageId: "wire-\(id)", fromAccountId: storedSender, toAccountId: "acct_viewer",
            body: try CloudGroupMessageCodec.encode(envelope),
            createdAt: "2026-09-01T00:00:01Z", deliveredAt: nil, readAt: nil,
            direction: "incoming", sessionId: groupConversation.sessionId
        )
    }

    func testGroupProjectionUsesTheStoredSenderInsteadOfTheEnvelope() throws {
        let messages = AppModel.mapGroupMessages(
            [
                try groupWire(id: "claims-contact", storedSender: "acct_stranger", envelopeSender: "acct_contact"),
                try groupWire(id: "claims-viewer", storedSender: "acct_stranger", envelopeSender: "acct_viewer"),
                try groupWire(id: "own", storedSender: "acct_viewer", envelopeSender: "acct_viewer"),
                try groupWire(id: "agent", storedSender: "acct_contact", envelopeSender: "acct_contact", senderKind: "agent"),
            ],
            conversation: groupConversation,
            ownAccountId: "acct_viewer"
        )
        let byID = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })

        let claimsContact = try XCTUnwrap(byID["claims-contact"])
        XCTAssertEqual(claimsContact.author, .person)
        XCTAssertEqual(claimsContact.senderAccountId, "acct_stranger")
        XCTAssertFalse(allows(.contacts, author: claimsContact.author, sender: claimsContact.senderAccountId))

        let claimsViewer = try XCTUnwrap(byID["claims-viewer"])
        XCTAssertEqual(claimsViewer.author, .person)
        XCTAssertEqual(claimsViewer.senderAccountId, "acct_stranger")

        let own = try XCTUnwrap(byID["own"])
        XCTAssertEqual(own.author, .me)
        XCTAssertEqual(own.senderAccountId, "acct_viewer")

        let agent = try XCTUnwrap(byID["agent"])
        XCTAssertEqual(agent.author, .agent)
        XCTAssertNil(agent.senderAccountId)
    }

    func testDirectProjectionRecordsTheHumanSender() throws {
        let conversation = ConversationSummary(
            id: "contact", kind: .person, peerAccountId: "acct_peer", agentId: nil,
            ownerDisplayName: "Peer", displayName: "Peer", lastMessage: "", lastActivityAt: .distantPast,
            unreadCount: 0, avatarSource: nil, agentActivity: nil, sessionId: "session:contact:privacy"
        )
        let wires = [("incoming", "acct_peer"), ("outgoing", "acct_viewer")].map { id, sender in
            CloudMessageDTO(
                messageId: id, fromAccountId: sender, toAccountId: "acct_other",
                body: "https://example.com/", createdAt: "2026-09-01T00:00:01Z",
                deliveredAt: nil, readAt: nil, direction: "incoming", sessionId: conversation.sessionId
            )
        }
        let messages = CloudDirectMessageProjector.project(wires, conversation: conversation, ownAccountId: "acct_viewer")
        XCTAssertEqual(messages.first { $0.id == "incoming" }?.senderAccountId, "acct_peer")
        XCTAssertEqual(messages.first { $0.id == "outgoing" }?.senderAccountId, "acct_viewer")
    }

    func testSubsessionMessagesKeepHumanSendersAndDropAgentSenders() throws {
        let subsession = try JSONDecoder().decode(CloudAgentSubsession.self, from: Data(#"""
        {"sessionId":"task","parentSessionId":"parent","parentRequestId":"request","ownerAccountId":"acct_owner",
         "agentId":"agent","ownerDisplayName":"Owner","agentDisplayName":"Helper","title":"Task","status":"completed",
         "version":1,"updatedAt":"2026-09-08T00:00:00Z","messages":[
           {"id":"human","role":"user","text":"https://example.com/","timestampMs":1000,"senderAccountId":"acct_contact"},
           {"id":"answer","role":"assistant","text":"https://example.com/","timestampMs":2000,"senderAccountId":"acct_owner"}
         ]}
        """#.utf8))
        let messages = subsession.chatMessages(accountId: "acct_viewer")
        XCTAssertEqual(messages.first { $0.id == "human" }?.senderAccountId, "acct_contact")
        XCTAssertEqual(messages.first { $0.id == "answer" }?.author, .agent)
        XCTAssertNil(messages.first { $0.id == "answer" }?.senderAccountId)
    }

    // MARK: Rendering

    @MainActor
    private func bubble(allowsLinkNetworkFetch: Bool) -> MessageBubble {
        let message = ChatMessage(
            id: "bubble", conversationId: "contact", author: .person, authorName: "Peer",
            senderAccountId: "acct_peer", text: "https://example.com/", createdAt: Date(timeIntervalSince1970: 1),
            deliveryState: .delivered, errorMessage: nil, requestMessageId: nil
        )
        return MessageBubble(
            message: message, mentionTargets: [], showAuthor: false, showAvatar: false,
            replySourceMessage: nil, isHighlighted: false, isActionPresented: false,
            isPinned: false, selectionMode: false, isSelected: false, allowsQuotedReplies: true,
            threadReplyCount: 0, showsAvatarSlot: true, authorAvatarName: "Peer",
            authorAvatarSource: nil, authorAvatarSeed: nil, ownAccountId: "acct_viewer",
            allowsLinkNetworkFetch: allowsLinkNetworkFetch,
            automaticallyPresentsActions: false, backgroundSessions: [], fullScreenVideoAttachmentID: nil,
            onOpenAuthorProfile: {}, onOpenMentionProfile: { _ in }, onRetry: {}, onSelect: {},
            onOpenActions: { _, _ in }, onUpdateActionFrame: { _ in }, actionPreviewScroll: nil,
            onReactToAttachment: { _, _ in }, onReact: { _ in }, onNavigateToReply: { _ in },
            onOpenThread: {}, onOpenAttachment: { _, _ in }, onShareAttachment: { _ in },
            onPrepareVoiceMessage: { _ in nil }, voiceTranscriptions: VoiceTranscriptionJobs(),
            onTranscribeVoiceMessage: {}, onPrepareAttachment: { _ in nil },
            onPrepareAttachmentPreview: { _ in nil }, onOpenVideo: { _, _, _ in },
            onAddAttachmentToMediaLibrary: { _ in nil }, onOpenBackgroundSession: { _ in },
            onContentExpansionChange: { _ in }
        )
    }

    @MainActor
    func testMessageBubbleEqualityIncludesTheLinkFetchDecision() {
        XCTAssertTrue(bubble(allowsLinkNetworkFetch: true) == bubble(allowsLinkNetworkFetch: true))
        XCTAssertFalse(bubble(allowsLinkNetworkFetch: true) == bubble(allowsLinkNetworkFetch: false))
    }

    func testLinkFetchTaskKeyChangesWithTheDecision() {
        XCTAssertNotEqual(
            LinkFetchTaskKey(value: "https://example.com/", allowed: true),
            LinkFetchTaskKey(value: "https://example.com/", allowed: false)
        )
        XCTAssertEqual(
            LinkFetchTaskKey(value: "https://example.com/", allowed: false),
            LinkFetchTaskKey(value: "https://example.com/", allowed: false)
        )
    }

    @MainActor
    func testMetadataCacheFetchSkipsNonPreviewableURLsBeforeLinkPresentation() throws {
        let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(
            contentsOf: directory.appendingPathComponent("Kordi/Features/Conversation/MessageLinkPreview.swift"),
            encoding: .utf8
        )
        let guardRange = try XCTUnwrap(source.range(of: "guard LinkPreviewPolicy.isPreviewableURL(url) else {"))
        let providerRange = try XCTUnwrap(source.range(of: "LPMetadataProvider()"))
        let showcaseRange = try XCTUnwrap(source.range(of: "PreviewData.themeContrastLinkMetadata(for: url)"))
        XCTAssertLessThan(showcaseRange.lowerBound, guardRange.lowerBound)
        XCTAssertLessThan(guardRange.lowerBound, providerRange.lowerBound)
        XCTAssertTrue(source.contains("guard allowsNetworkFetch, LinkPreviewPolicy.isPreviewableURL(url) else { return }"))

        let markdown = try String(
            contentsOf: directory.appendingPathComponent("Kordi/Features/Conversation/MarkdownMessageContent.swift"),
            encoding: .utf8
        )
        XCTAssertFalse(markdown.contains("favicon.ico"))
        XCTAssertFalse(markdown.contains("AvatarImageLoader"))
        XCTAssertTrue(markdown.contains("LinkSiteIconLoader.icon(forHost: host)"))
    }

    func testPrivacySettingsCopy() {
        XCTAssertEqual(
            PrivacySettingsView.linkPreviewFooter(for: .contacts),
            "Kordi loads previews and site icons only for links you send and links from people in your contacts. Other links show just the web address. Loading a preview connects this iPhone to the linked website, which can see your IP address and when the link was viewed."
        )
        XCTAssertEqual(
            PrivacySettingsView.linkPreviewFooter(for: .everyone),
            "Kordi loads previews and site icons for every link, including links from agents and from people who aren't in your contacts. Loading a preview connects this iPhone to the linked website, which can see your IP address and when the link was viewed."
        )
        XCTAssertEqual(
            PrivacySettingsView.linkPreviewFooter(for: .off),
            "Kordi doesn't load link previews or site icons. Links show just the web address. Loading a preview connects this iPhone to the linked website, which can see your IP address and when the link was viewed."
        )
        XCTAssertTrue(NotificationSettingsView.messagePreviewsFooter.hasSuffix("alerts only say \"New message\"."))
    }
}
