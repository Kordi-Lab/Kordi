import SwiftUI
import UIKit
import XCTest
@testable import Kordi

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

    private func checkSubsession(status: String, long: Bool, visits: Int = 1, interruptFirstEntry: Bool = false) async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let model = AppModel(cache: try LocalMessageStore(inMemory: true), previewMode: true)
        let owner = try XCTUnwrap(model.account?.accountId)
        let parent = try XCTUnwrap(model.conversations.first { $0.id == "person:acct_maya" })
        var snapshot = AgentSubsessionStopPreview.snapshot(accountId: owner)
        snapshot.status = status
        snapshot.live = status == "running"
        snapshot.messages[1] = .init(id: "subsession-answer", role: "assistant",
            text: long ? "# Completed report\n\n" + String(repeating: "The investigation covers findings, examples, and supporting evidence.\n\n", count: 40) : "The investigation is in progress.",
            timestampMs: snapshot.messages[0].timestampMs + 5000, senderAgentId: snapshot.agentId)
        model.installSubsessionStopPreview(snapshot)
        let expected = model.messages(for: snapshot.conversation)
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
            for _ in 0..<150 {
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
            XCTAssertTrue(visible, "A loaded agent-started subsession must display its answer on visit \(visit)")
            navigation.opensChild = false
            try await Task.sleep(for: .milliseconds(600))
        }
    }
}
