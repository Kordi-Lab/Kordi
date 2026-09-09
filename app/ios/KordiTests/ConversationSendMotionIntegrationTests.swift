import SwiftUI
import UIKit
import XCTest
@testable import Kordi

@MainActor
final class ConversationSendMotionIntegrationTests: XCTestCase {
    func testShortChatSendDoesNotReverseDirection() async throws { try await checkSend(count: 2) }
    func testLongChatSendDoesNotReverseDirection() async throws { try await checkSend(count: 40) }

    func testMultilineSendDoesNotReverseDirection() async throws {
        try await checkSend(count: 40, draft: Array(repeating: "A longer line for the composer", count: 6).joined(separator: "\n"))
    }

    private func checkSend(count: Int, draft: String = "New message") async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let store = try LocalMessageStore(inMemory: true)
        let model = AppModel(cache: store, previewMode: true)
        let accountID = try XCTUnwrap(model.account?.accountId)
        let conversation = ConversationSummary(id: "motion-chat", kind: .person, peerAccountId: "fixture-peer", agentId: nil, ownerDisplayName: nil,
            displayName: "Motion fixture", lastMessage: "Ready", lastActivityAt: Date(), unreadCount: 0,
            avatarSource: nil, agentActivity: .ready, sessionId: "motion-chat")
        let seed = (0..<count).map { index in
            ChatMessage(id: "fixture-\(index)", conversationId: conversation.id, author: .me, authorName: "You",
                text: "Fixture message \(index)", createdAt: Date().addingTimeInterval(Double(index - count)),
                deliveryState: .read, errorMessage: nil, requestMessageId: nil)
        }
        store.saveMessages(seed, conversationId: conversation.id, accountId: accountID, hasEarlier: false)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let controller = UIHostingController(rootView: ConversationView(conversation: conversation)
            .environmentObject(model).environmentObject(KordiCallCoordinator())
            .environmentObject(KordiNotificationCoordinator()))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true; window.rootViewController = nil
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil
            ConversationMotionProbeRegistry.send = nil
        }
        controller.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(700))
        XCTAssertNotNil(ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: seed[count - 1]), in: window))
        func editor(in view: UIView) -> UITextView? {
            if let text = view as? UITextView, text.isEditable { return text }
            return view.subviews.lazy.compactMap { editor(in: $0) }.first
        }
        ConversationMotionProbeRegistry.setDraft?(draft)
        let composer = try XCTUnwrap(editor(in: controller.view))
        composer.becomeFirstResponder()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertNotNil(ConversationMotionProbeRegistry.send)
        ConversationMotionProbeRegistry.send?()
        var positions: [CGFloat] = []
        var composerGaps: [CGFloat] = []
        for _ in 0..<45 {
            try await Task.sleep(for: .milliseconds(10))
            if let last = model.messages(for: conversation).last, last.text == draft,
               let frame = ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: last), in: window) {
                positions.append(frame.minY)
                if let editorLayer = composer.layer.presentation(), let root = window.layer.presentation() {
                    composerGaps.append(editorLayer.convert(editorLayer.bounds, to: root).minY - frame.maxY)
                }
            }
        }
        XCTAssertGreaterThan(positions.count, 5)
        let maximumDownwardStep = zip(positions, positions.dropFirst()).map { $1 - $0 }.max() ?? 0
        print("Synthetic send motion count=\(count), positions=\(positions.map { Int($0.rounded()) }), maximumDownwardStep=\(maximumDownwardStep)")
        XCTAssertLessThanOrEqual(maximumDownwardStep, 1, "The real chat must not jump down after its initial upward movement")
        print("Synthetic composer gap count=\(count), gaps=\(composerGaps.map { Int($0.rounded()) })")
        composer.resignFirstResponder()
        try await Task.sleep(for: .milliseconds(250))
    }
}
