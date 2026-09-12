import SwiftUI
import UIKit
import XCTest
@testable import Kordi

private final class ColdSubsessionURLProtocol: URLProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var responseTask: Task<Void, Never>?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let task = Task { [self] in
            do { try await Task.sleep(for: .milliseconds(Int(request.value(forHTTPHeaderField: "X-Test-Delay") ?? "400") ?? 400)) } catch { return }
            guard !Task.isCancelled,
                  let encoded = request.value(forHTTPHeaderField: "X-Test-Subsession-Fixture"),
                  let data = Data(base64Encoded: encoded), let url = request.url else { return }
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
        lock.withLock { responseTask = task }
    }
    override func stopLoading() {
        lock.withLock { responseTask?.cancel(); responseTask = nil }
    }
}

@MainActor
private final class SubsessionNavigationProbe: ObservableObject {
    @Published var opensChild = false
}

private struct SubsessionNavigationHarness: View {
    @ObservedObject var navigation: SubsessionNavigationProbe
    let parent: ConversationSummary
    let childID: String

    var body: some View {
        NavigationStack {
            ConversationView(conversation: parent, allowsCompanionPanel: false)
                .navigationDestination(isPresented: $navigation.opensChild) {
                    AgentSubsessionView(sessionId: childID)
                }
        }
    }
}

@MainActor
final class SubsessionConversationViewportTests: XCTestCase {
    func testScrollBridgeConnectsAfterItsFirstResolutionPrecedesNativeInsertion() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKeyAndVisible() }
        let bridge = ConversationScrollAttachmentView(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        controller.view.addSubview(bridge)
        var resolved: [UIScrollView] = []
        bridge.onResolveScrollView = { resolved.append($0) }
        bridge.scheduleScrollViewResolution(updating: true)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertTrue(resolved.isEmpty)

        let scroll = UIScrollView(frame: controller.view.bounds)
        controller.view.addSubview(scroll)
        scroll.addSubview(bridge)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(resolved.count, 1, "Native insertion must reconnect without another SwiftUI update")
        XCTAssertTrue(resolved.first === scroll)
        bridge.setNeedsLayout()
        bridge.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(resolved.count, 1, "Steady layout must not repeatedly attach observers")

        let replacement = UIScrollView(frame: controller.view.bounds)
        controller.view.addSubview(replacement)
        replacement.addSubview(bridge)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(resolved.count, 2)
        XCTAssertTrue(resolved.last === replacement)
    }

    func testScrollBridgeWaitsForUsableBoundsAndRetriesOnLayout() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        let controller = UIViewController()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKeyAndVisible() }
        let scroll = UIScrollView(frame: .zero)
        controller.view.addSubview(scroll)
        let bridge = ConversationScrollAttachmentView(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        scroll.addSubview(bridge)
        var resolutions = 0
        bridge.onResolveScrollView = { _ in resolutions += 1 }
        bridge.scheduleScrollViewResolution(updating: true)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(resolutions, 0)
        scroll.frame = controller.view.bounds
        bridge.setNeedsLayout()
        bridge.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertEqual(resolutions, 1)
    }

    func testCompletedAgentStartedSubsessionShowsItsLongAnswerAfterNestedNavigation() async throws {
        try await checkSubsession(status: "done", long: true)
    }

    func testRunningAgentStartedSubsessionShowsItsMessagesAfterNestedNavigation() async throws {
        try await checkSubsession(status: "running", long: false)
    }

    func testCompletedSubsessionCanBeReenteredRepeatedly() async throws {
        try await checkSubsession(status: "done", long: true, visits: 5)
    }

    func testInterruptedSubsessionEntryCanBeOpenedAgain() async throws {
        try await checkSubsession(status: "done", long: true, visits: 2, interruptFirstEntry: true)
    }

    func testColdCompletedSubsessionRendersAfterItsNetworkLoadingState() async throws {
        try await checkSubsession(status: "done", long: true, coldLoad: true)
    }

    func testColdSlowCompletedSubsessionRendersAfterNavigationFinishes() async throws {
        try await checkSubsession(status: "done", long: true, coldLoad: true, responseDelay: 1800)
    }

    func testColdVeryLongCompletedSubsessionRenders() async throws {
        try await checkSubsession(status: "done", long: true, coldLoad: true, paragraphCount: 300)
    }

    private func checkSubsession(status: String, long: Bool, visits: Int = 1, interruptFirstEntry: Bool = false, coldLoad: Bool = false, responseDelay: Int = 400, paragraphCount: Int = 40) async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let owner = PreviewData.make().account.accountId
        var snapshot = AgentSubsessionStopPreview.snapshot(accountId: owner)
        snapshot.status = status
        snapshot.live = status == "running"
        snapshot.messages[1] = .init(id: "subsession-answer", role: "assistant",
            text: long ? "# Completed report\n\n" + String(repeating: "The investigation covers findings, examples, and supporting evidence.\n\n", count: paragraphCount) : "The investigation is in progress.",
            timestampMs: snapshot.messages[0].timestampMs + 5000, senderAgentId: snapshot.agentId)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ColdSubsessionURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Test-Delay": String(responseDelay), "X-Test-Subsession-Fixture": try JSONEncoder().encode(snapshot).base64EncodedString()]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let api = CloudAPIClient(baseURL: URL(string: "http://127.0.0.1:17081")!, session: session)
        let model = AppModel(api: api, cache: try LocalMessageStore(inMemory: true), previewMode: true)
        let parent = try XCTUnwrap(model.conversations.first { $0.id == "person:acct_maya" })
        if coldLoad { XCTAssertNil(model.subsessions[snapshot.sessionId]) }
        else { model.installSubsessionStopPreview(snapshot) }
        let expected = snapshot.chatMessages(accountId: owner)
        XCTAssertEqual(expected.count, 2)
        let navigation = SubsessionNavigationProbe()
        let host = UIHostingController(rootView: SubsessionNavigationHarness(navigation: navigation,
            parent: parent, childID: snapshot.sessionId)
            .environmentObject(model)
            .environmentObject(KordiCallCoordinator())
            .environmentObject(KordiNotificationCoordinator()))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.endEditing(true)
            window.isHidden = true
            window.rootViewController = nil
            previousWindow?.makeKeyAndVisible()
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil
            ConversationMotionProbeRegistry.send = nil
            ConversationMotionProbeRegistry.goToLatest = nil
        }
        try await Task.sleep(for: .milliseconds(800))
        if interruptFirstEntry {
            navigation.opensChild = true
            try await Task.sleep(for: .milliseconds(40))
            navigation.opensChild = false
            try await Task.sleep(for: .milliseconds(600))
        }
        let answerID = model.timelineIdentity(for: try XCTUnwrap(expected.last))
        for visit in 0..<visits {
            navigation.opensChild = true
            var visible = false
            for _ in 0..<250 {
                try await Task.sleep(for: .milliseconds(20))
                if let frame = ConversationMotionProbeRegistry.frame(for: answerID, in: window),
                   frame.intersection(window.bounds.insetBy(dx: 0, dy: 110)).height > 30 {
                    visible = true
                    break
                }
            }
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = "Synthetic nested subsession viewport, visit \(visit)"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTAssertEqual(model.messages(for: snapshot.conversation).count, 2, "The child payload must have arrived")
            XCTAssertTrue(visible, "A loaded agent-started subsession must display its answer on visit \(visit)")
            navigation.opensChild = false
            try await Task.sleep(for: .milliseconds(600))
        }
    }
}
