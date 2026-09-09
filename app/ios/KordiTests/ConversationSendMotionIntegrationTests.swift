import SwiftUI
import UIKit
import XCTest
@testable import Kordi

@MainActor
private final class SendMotionNavigation: ObservableObject {
    @Published var path: [MainNavigationRoute] = []
}

private struct SendMotionHost: View {
    @ObservedObject var navigation: SendMotionNavigation
    let model: AppModel
    let calls: KordiCallCoordinator
    let notifications: KordiNotificationCoordinator

    var body: some View {
        MainNavigationHost(path: $navigation.path) {
            Text("Conversations")
        } destination: { route in
            MainNavigationDestination(path: $navigation.path, route: route, selectedTab: .chats)
        }
        .ignoresSafeArea(.container, edges: .vertical)
        .environmentObject(model)
        .environmentObject(calls)
        .environmentObject(notifications)
    }
}

@MainActor
final class ConversationSendMotionIntegrationTests: XCTestCase {
    func testShortChatSendDoesNotReverseDirection() async throws { try await checkSend(count: 2) }
    func testLongChatSendDoesNotReverseDirection() async throws { try await checkSend(count: 40) }

    func testMultilineSendDoesNotReverseDirection() async throws {
        try await checkSend(count: 40, draft: Array(repeating: "A longer line for the composer", count: 6).joined(separator: "\n"))
    }

    func testRapidSendStartsAtItsFinalVisiblePosition() async throws {
        try await checkSend(count: 40, draft: "Second message", rapid: true)
    }

    private func checkSend(count: Int, draft: String = "New message", rapid: Bool = false) async throws {
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
        window.frame = scene.coordinateSpace.bounds
        let navigation = SendMotionNavigation()
        let controller = UIHostingController(rootView: SendMotionHost(navigation: navigation, model: model,
            calls: KordiCallCoordinator(), notifications: KordiNotificationCoordinator()))
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
        navigation.path = [.conversation(conversation)]
        let lastSeedID = model.timelineIdentity(for: seed[count - 1])
        for _ in 0..<250 {
            if ConversationMotionProbeRegistry.frame(for: lastSeedID, in: window) != nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        _ = try XCTUnwrap(ConversationMotionProbeRegistry.frame(for: lastSeedID, in: window), "Wait for the real history to finish its initial reveal")
        func editor(in view: UIView) -> UITextView? {
            if let text = view as? UITextView, text.isEditable { return text }
            return view.subviews.lazy.compactMap { editor(in: $0) }.first
        }
        ConversationMotionProbeRegistry.setDraft?(draft)
        let composer = try XCTUnwrap(editor(in: controller.view))
        composer.becomeFirstResponder()
        var previousEditorTop: CGFloat?
        var stableKeyboardFrames = 0
        for _ in 0..<250 {
            try await Task.sleep(for: .milliseconds(20))
            let frame = composer.convert(composer.bounds, to: window)
            if frame.maxY < window.bounds.maxY - 120, let previousEditorTop,
               abs(previousEditorTop - frame.minY) < 0.5 {
                stableKeyboardFrames += 1
            } else {
                stableKeyboardFrames = 0
            }
            previousEditorTop = frame.minY
            if stableKeyboardFrames >= 3 { break }
        }
        XCTAssertGreaterThanOrEqual(stableKeyboardFrames, 3, "The software keyboard must finish opening before measuring send motion")
        XCTAssertNotNil(ConversationMotionProbeRegistry.send)
        if rapid {
            ConversationMotionProbeRegistry.setDraft?("First message")
            ConversationMotionProbeRegistry.send?()
            try await Task.sleep(for: .milliseconds(40))
            ConversationMotionProbeRegistry.setDraft?(draft)
        }
        let sendTime = CACurrentMediaTime()
        ConversationMotionProbeRegistry.send?()
        var firstVisibleTime: CFTimeInterval?
        var positions: [CGFloat] = []
        var composerGaps: [CGFloat] = []
        for _ in 0..<45 {
            try await Task.sleep(for: .milliseconds(10))
            if let last = model.messages(for: conversation).last, last.text == draft,
               let frame = ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: last), in: window) {
                if firstVisibleTime == nil {
                    firstVisibleTime = CACurrentMediaTime()
                    if count == 40, draft == "New message", !rapid {
                        attachSnapshot(of: window, name: "First visible message frame")
                    }
                }
                positions.append(frame.minY)
                if let editorLayer = composer.layer.presentation(), let root = window.layer.presentation() {
                    composerGaps.append(editorLayer.convert(editorLayer.bounds, to: root).minY - frame.maxY)
                }
            }
        }
        XCTAssertGreaterThan(positions.count, 5)
        XCTAssertNotNil(firstVisibleTime, "Every accepted send must become visible")
        let maximumDownwardStep = zip(positions, positions.dropFirst()).map { $1 - $0 }.max() ?? 0
        print("Synthetic send motion count=\(count), positions=\(positions.map { Int($0.rounded()) }), maximumDownwardStep=\(maximumDownwardStep), firstVisibleMs=\(((firstVisibleTime ?? sendTime) - sendTime) * 1000)")
        XCTAssertLessThanOrEqual(maximumDownwardStep, 1, "The real chat must not jump down after its initial upward movement")
        let positionRange = (positions.max() ?? 0) - (positions.min() ?? 0)
        XCTAssertLessThanOrEqual(positionRange, 1, "The first visible frame must already use the final message position")
        print("Synthetic composer gap count=\(count), gaps=\(composerGaps.map { Int($0.rounded()) })")
        if count == 40, draft == "New message", !rapid {
            attachSnapshot(of: window, name: "Settled message frame")
        }
        composer.resignFirstResponder()
        try await Task.sleep(for: .milliseconds(250))
    }
    private func attachSnapshot(of window: UIWindow, name: String) {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

}
