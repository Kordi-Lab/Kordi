import SwiftUI
import UIKit
import XCTest
@testable import Kordi

@MainActor
final class AgentTrajectoryLayoutTests: XCTestCase {
    private var execution: AgentExecutionSnapshot {
        AgentExecutionSnapshot(phase: .complete, summary: "Finished",
            steps: [AgentExecutionStep(id: "response", label: "Preparing the sample response", state: .complete)],
            thinkingText: "Reviewing the sample inputs.\n\nChecking the result with a second pass.",
            startedAtMs: 1_000, updatedAtMs: 12_000, completed: true)
    }

    func testExpandingTrajectoryNeverCrossesItsHeader() async throws {
        try await checkExpansion(animationsDisabled: false)
    }

    func testDisabledAnimationsTrajectoryHasSeparatedSections() async throws {
        try await checkExpansion(animationsDisabled: true)
    }

    private func checkExpansion(animationsDisabled: Bool) async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        ConversationMotionProbeRegistry.trajectoryToggles = [:]
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let content = VStack(alignment: .leading, spacing: 7) {
            AgentExecutionTimeline(messageID: "fixture", execution: execution,
                showsWaitingIndicator: false, onExpansionChange: { _ in })
            Text("A short synthetic answer below the trajectory.")
                .background(ConversationMotionProbe(id: "trajectory-answer"))
        }
        .padding(12).frame(width: 320).background(Color.purple.opacity(0.1))
        .clipShape(.rect(cornerRadius: 16))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.top, 30)
        .transaction { transaction in
            if animationsDisabled { transaction.animation = nil; transaction.disablesAnimations = true }
        }
        window.rootViewController = UIHostingController(rootView: content)
        window.makeKeyAndVisible()
        defer { close(window, previous: previous) }
        for _ in 0..<100 {
            if ConversationMotionProbeRegistry.trajectoryToggles["trajectory-header:fixture"] != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let toggle = try XCTUnwrap(ConversationMotionProbeRegistry.trajectoryToggles["trajectory-header:fixture"])
        try await Task.sleep(for: .milliseconds(100))
        var worstOverlap: CGFloat = 0
        var samples = 0
        for _ in 0..<3 {
            toggle()
            for index in 0..<45 {
                if let header = ConversationMotionProbeRegistry.frame(for: "trajectory-header:fixture", in: window),
                   let details = ConversationMotionProbeRegistry.frame(for: "trajectory-details:fixture", in: window) {
                    worstOverlap = max(worstOverlap, header.maxY - details.minY)
                    samples += 1
                }
                if index == 8 { snapshot(window, name: "Synthetic trajectory opening") }
                try await Task.sleep(for: .milliseconds(8))
            }
            let details = try XCTUnwrap(ConversationMotionProbeRegistry.frame(for: "trajectory-details:fixture", in: window))
            let answer = try XCTUnwrap(ConversationMotionProbeRegistry.frame(for: "trajectory-answer", in: window))
            XCTAssertGreaterThanOrEqual(answer.minY, details.maxY, "The answer must remain below the expanded trajectory")
            toggle()
            try await Task.sleep(for: .milliseconds(350))
        }
        XCTAssertGreaterThan(samples, 10)
        XCTAssertLessThanOrEqual(worstOverlap, 1, "Visible trajectory details must not cross the header during expansion")
    }

    func testShortAgentConversationRepeatedlyOpensAtBottom() async throws {
        try await checkConversation(expand: false)
    }

    func testExpandingInConversationPreservesHeaderPosition() async throws {
        try await checkConversation(expand: true)
    }

    func testShortConversationReopensAtBottomAfterTrajectoryInteraction() async throws {
        try await checkConversation(expand: true, reenter: true)
    }

    private func checkConversation(expand: Bool, reenter: Bool = false) async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let model = AppModel(cache: try LocalMessageStore(inMemory: true), previewMode: true)
        let accountID = try XCTUnwrap(model.account?.accountId)
        let conversation = ConversationSummary(id: "trajectory-entry", kind: .agent, peerAccountId: accountID,
            agentId: "fixture-agent", ownerDisplayName: "Fixture Owner", displayName: "Short agent fixture",
            lastMessage: "Ready", lastActivityAt: Date(), unreadCount: 0, avatarSource: nil,
            agentActivity: .ready, sessionId: "trajectory-entry")
        let request = ChatMessage(id: "fixture-request", conversationId: conversation.id,
            conversationSequence: 1, author: .me, authorName: "You", text: "Review the sample.",
            createdAt: Date().addingTimeInterval(-2), deliveryState: .read, errorMessage: nil, requestMessageId: nil)
        let reply = ChatMessage(id: "fixture-reply", conversationId: conversation.id,
            conversationSequence: 2, author: .agent, authorName: "Fixture Agent", text: "The sample is ready to review.",
            createdAt: Date().addingTimeInterval(-1), deliveryState: .delivered, errorMessage: nil,
            requestMessageId: request.id, agentExecution: execution)
        [request, reply].forEach(model.upsertPreviewMessage)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let navigation = SendMotionNavigation()
        let controller = UIHostingController(rootView: SendMotionHost(navigation: navigation, model: model,
            calls: KordiCallCoordinator(), notifications: KordiNotificationCoordinator()))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { close(window, previous: previous) }
        for cycle in 0..<(expand && !reenter ? 1 : 4) {
            navigation.path = [.conversation(conversation)]
            var gaps: [CGFloat] = []
            for _ in 0..<150 {
                if let row = ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: reply), in: window),
                   row.intersects(window.bounds), let input = textView(in: controller.view) {
                    gaps.append(input.convert(input.bounds, to: window).minY - row.maxY)
                }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertGreaterThan(gaps.count, 20)
            XCTAssertLessThan(gaps.max() ?? .infinity, 90, "Every visible frame should keep the latest message above the composer")
            snapshot(window, name: "Synthetic short agent entry \(cycle)")
            if expand {
                let initial = try XCTUnwrap(ConversationMotionProbeRegistry.frame(for: "trajectory-header:fixture-reply", in: window))
                let initialRow = ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: reply), in: window)
                let toggle = try XCTUnwrap(ConversationMotionProbeRegistry.trajectoryToggles["trajectory-header:\(reply.id)"])
                toggle()
                var largestShift: CGFloat = 0
                var headerPositions: [CGFloat] = []
                for _ in 0..<60 {
                    if let header = ConversationMotionProbeRegistry.frame(for: "trajectory-header:fixture-reply", in: window) {
                        largestShift = max(largestShift, abs(header.minY - initial.minY))
                        headerPositions.append(header.minY)
                    }
                    try await Task.sleep(for: .milliseconds(10))
                }
                snapshot(window, name: "Synthetic expanded conversation trajectory")
                print("Trajectory row initial=\(initialRow?.minY ?? -1) final=\(ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: reply), in: window)?.minY ?? -1) headerHeight=\(initial.height)")
                print("Trajectory header initial=\(initial.minY) first=\(headerPositions.first ?? -1) last=\(headerPositions.last ?? -1) min=\(headerPositions.min() ?? -1) max=\(headerPositions.max() ?? -1)")
                XCTAssertLessThanOrEqual(largestShift, 2, "Expansion must keep the tapped header in place instead of navigating to the reply bottom")
                if reenter {
                    toggle()
                    try await Task.sleep(for: .milliseconds(60))
                }
            }
            navigation.path = []
            try await Task.sleep(for: .milliseconds(350))
        }
    }

    private func textView(in view: UIView) -> UITextView? {
        if let text = view as? UITextView { return text }
        return view.subviews.lazy.compactMap { self.textView(in: $0) }.first
    }

    private func snapshot(_ window: UIWindow, name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func close(_ window: UIWindow, previous: UIWindow?) {
        window.isHidden = true
        window.rootViewController = nil
        previous?.makeKeyAndVisible()
        ConversationMotionProbeRegistry.enabled = false
        ConversationMotionProbeRegistry.views = [:]
        ConversationMotionProbeRegistry.trajectoryToggles = [:]
    }
}
