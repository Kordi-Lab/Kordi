import SwiftUI
import UIKit
import XCTest
@testable import Kordi

@MainActor
final class ConversationAgentSendIntegrationTests: XCTestCase {
    func testFirstAgentMentionRevealsRequestBeforeProgress() async throws {
        try await checkSend(historyCount: 0, duringInitialLoad: false)
    }

    func testAgentMentionWithHistoryRevealsRequestBeforeProgress() async throws {
        try await checkSend(historyCount: 4, duringInitialLoad: false)
    }

    func testAgentMentionDuringInitialLoadDoesNotNeedNavigationToReveal() async throws {
        try await checkSend(historyCount: 0, duringInitialLoad: true)
    }

    func testSendAcknowledgementRevealsAnimatedProgressWithoutRunEvents() async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let queue = ConversationSendQueue()
        let model = AppModel(cache: try LocalMessageStore(inMemory: true), sendQueue: queue, previewMode: true)
        let template = try XCTUnwrap(model.conversations.first { $0.agentId == "cloud_agent_research" })
        let conversation = ConversationSummary(id: "agent-session:confirmed-progress", kind: .agent,
            peerAccountId: template.peerAccountId, agentId: template.agentId, ownerDisplayName: template.ownerDisplayName,
            displayName: "Confirmed progress", lastMessage: "", lastActivityAt: .distantPast, unreadCount: 0,
            avatarSource: nil, agentActivity: .ready, sessionId: "session:confirmed-progress")
        await queue.acquire(conversation.id)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let navigation = SendMotionNavigation()
        let controller = UIHostingController(rootView: SendMotionHost(navigation: navigation, model: model,
            calls: KordiCallCoordinator(), notifications: KordiNotificationCoordinator()))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            queue.release(conversation.id)
            window.isHidden = true; window.rootViewController = nil
            previousWindow?.makeKeyAndVisible()
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
        }
        navigation.path = [.conversation(conversation)]
        try await Task.sleep(for: .seconds(1))
        let sending = Task { await model.send("Synthetic status test", attachments: [], to: conversation) }
        for _ in 0..<100 {
            if model.messages(for: conversation).contains(where: { $0.author == .me }) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        var request = try XCTUnwrap(model.messages(for: conversation).first { $0.author == .me })
        XCTAssertEqual(request.deliveryState, .sending)
        XCTAssertFalse(model.messages(for: conversation).contains { $0.agentExecution != nil })
        request.deliveryState = .sent
        model.upsertPreviewMessage(request)
        let progress = try XCTUnwrap(model.messages(for: conversation).first { $0.agentExecution != nil })
        XCTAssertTrue(MessageBubble.showsAgentWaitingIndicator(execution: try XCTUnwrap(progress.agentExecution), responseText: progress.text))
        let stableRowID = model.timelineIdentity(for: progress)
        var remote = ChatMessage(id: "remote-progress", conversationId: conversation.id, author: .agent,
            authorName: "Agent", text: "", createdAt: request.createdAt.addingTimeInterval(0.001),
            deliveryState: .delivered, errorMessage: nil, requestMessageId: request.id)
        let phases: [AgentExecutionSnapshot.Phase] = [.preparing, .queued, .preparing, .analyzing, .usingTool, .preparing]
        for (index, phase) in phases.enumerated() {
            if index > 0 {
                remote.agentExecution = AgentExecutionSnapshot(phase: phase, summary: "Working",
                    steps: phase == .analyzing ? [AgentExecutionStep(id: "analysis", label: "Checking context", state: .running)] : [],
                    thinkingText: phase == .analyzing ? "Checking context" : nil,
                    startedAtMs: 1_000, updatedAtMs: Double(index + 1) * 1_000, completed: false)
                model.upsertPreviewMessage(remote)
            }
            let active = try XCTUnwrap(model.messages(for: conversation).first { $0.agentExecution?.completed == false })
            XCTAssertEqual(MessageBubble.showsAgentWaitingIndicator(execution: try XCTUnwrap(active.agentExecution), responseText: active.text), phase != .analyzing, "Thinking output replaces the waiting animation while the row stays visible")
            XCTAssertEqual(model.timelineIdentity(for: active), stableRowID)
            XCTAssertEqual(model.messages(for: conversation).filter { $0.author == .agent }.count, 1)
            var visibleFrames = 0
            for _ in 0..<30 {
                try await Task.sleep(for: .milliseconds(16))
                if let frame = ConversationMotionProbeRegistry.frame(for: stableRowID, in: window),
                   frame.intersects(window.bounds), frame.height > 0 { visibleFrames += 1 }
            }
            XCTAssertGreaterThan(visibleFrames, 10, "Activity must remain visible through phase \(phase.rawValue)")
        }
        remote.text = "Done"
        remote.deliveryState = .delivered
        remote.agentExecution = AgentExecutionSnapshot(phase: .complete, summary: "Done", steps: [],
            startedAtMs: 1_000, updatedAtMs: 8_000, completed: true)
        model.upsertPreviewMessage(remote)
        XCTAssertFalse(model.messages(for: conversation).contains { $0.agentExecution?.completed == false })
        XCTAssertEqual(model.messages(for: conversation).filter { $0.author == .agent }.map(\.text), ["Done"])
        queue.release(conversation.id)
        await sending.value
    }

    private func checkSend(historyCount: Int, duringInitialLoad: Bool) async throws {
        ConversationMotionProbeRegistry.enabled = true
        ConversationMotionProbeRegistry.views = [:]
        let store = try LocalMessageStore(inMemory: true)
        let queue = ConversationSendQueue()
        let model = AppModel(cache: store, sendQueue: queue, previewMode: true,
            previewHistoryLoadDelay: duringInitialLoad ? .seconds(5) : .zero)
        let accountID = try XCTUnwrap(model.account?.accountId)
        let peer = try XCTUnwrap(model.contacts.first {
            $0.accountId != accountID && !KordiSupportIdentity.matches(name: $0.preferredName, seed: $0.accountId)
        })
        let peerID = peer.accountId
        let conversation = ConversationSummary(id: "group:send-order", kind: .group, peerAccountId: peerID,
            agentId: nil, ownerDisplayName: nil, displayName: "Agent send fixture", lastMessage: "", lastActivityAt: Date(),
            unreadCount: 0, avatarSource: nil, agentActivity: .ready, sessionId: "session:group:send-order",
            groupParticipants: [
                .init(accountId: accountID, displayName: "Viewer", avatarUrl: nil, role: "owner"),
                .init(accountId: peerID, displayName: peer.preferredName, avatarUrl: nil,
                    agentId: peer.defaultAgent?.agentId ?? "cloud-agent:\(peerID)",
                    agentDisplayName: peer.defaultAgent?.displayName ?? "Kordi", role: "person")
            ])
        let seed = (0..<historyCount).map { index in
            ChatMessage(id: "seed-\(index)", conversationId: conversation.id, author: .person, authorName: "Fixture peer",
                text: "Earlier message \(index)", createdAt: Date().addingTimeInterval(Double(index - 10)),
                deliveryState: .delivered, errorMessage: nil, requestMessageId: nil)
        }
        store.saveMessages(seed, conversationId: conversation.id, accountId: accountID, hasEarlier: false)
        let target = try XCTUnwrap(model.mentionTargets(for: conversation).first { $0.kind == .agent && $0.accountId == peerID })
        await queue.acquire(conversation.id)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let navigation = SendMotionNavigation()
        let controller = UIHostingController(rootView: SendMotionHost(navigation: navigation, model: model,
            calls: KordiCallCoordinator(), notifications: KordiNotificationCoordinator()))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            queue.release(conversation.id)
            window.isHidden = true; window.rootViewController = nil
            previousWindow?.makeKeyAndVisible()
            ConversationMotionProbeRegistry.enabled = false
            ConversationMotionProbeRegistry.views = [:]
            ConversationMotionProbeRegistry.setDraft = nil
            ConversationMotionProbeRegistry.send = nil
            ConversationMotionProbeRegistry.goToLatest = nil
        }
        controller.view.layoutIfNeeded()
        navigation.path = [.conversation(conversation)]
        for _ in 0..<200 {
            if ConversationMotionProbeRegistry.send != nil { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        func editor(in view: UIView) -> UITextView? {
            if let text = view as? UITextView, text.isEditable { return text }
            return view.subviews.lazy.compactMap { editor(in: $0) }.first
        }
        let composer = try XCTUnwrap(editor(in: controller.view))
        composer.becomeFirstResponder()
        try await Task.sleep(for: .milliseconds(duringInitialLoad ? 300 : 2300))
        let text = target.mentionText + " Check this synthetic request"
        let setDraft = try XCTUnwrap(ConversationMotionProbeRegistry.setDraft)
        let send = try XCTUnwrap(ConversationMotionProbeRegistry.send)
        setDraft(text)
        send()
        var firstRequestTime: CFTimeInterval?
        var firstProgressTime: CFTimeInterval?
        var revealedWhileHistoryWasLoading = false
        var progressBeforeRequest = 0
        var requestFrames = 0
        for _ in 0..<250 {
            try await Task.sleep(for: .milliseconds(10))
            let messages = model.messages(for: conversation)
            guard let request = messages.first(where: { $0.author == .me && $0.text == text }) else { continue }
            let composerTop: CGFloat
            if let layer = composer.layer.presentation(), let root = window.layer.presentation() {
                composerTop = layer.convert(layer.bounds, to: root).minY
            } else {
                composerTop = composer.convert(composer.bounds, to: window).minY
            }
            let viewport = CGRect(x: 0, y: window.safeAreaInsets.top + 44,
                width: window.bounds.width, height: max(0, composerTop - window.safeAreaInsets.top - 44))
            let requestFrame = ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: request), in: window)
            let requestVisible = requestFrame.map { $0.intersects(viewport) && $0.maxY <= composerTop + 1 } ?? false
            if requestVisible {
                if firstRequestTime == nil {
                    firstRequestTime = CACurrentMediaTime()
                    revealedWhileHistoryWasLoading = model.loadingConversationIDs.contains(conversation.id)
                }
                requestFrames += 1
            }
            if let progress = messages.first(where: { $0.author == .agent && $0.requestMessageId == request.id }),
               let frame = ConversationMotionProbeRegistry.frame(for: model.timelineIdentity(for: progress), in: window),
               frame.intersects(viewport) {
                firstProgressTime = firstProgressTime ?? CACurrentMediaTime()
                if firstRequestTime == nil { progressBeforeRequest += 1 }
                if let requestFrame, requestVisible {
                    XCTAssertGreaterThanOrEqual(frame.minY, requestFrame.maxY - 1, "Processing must follow its request in the transcript")
                }
            }
        }
        XCTAssertNotNil(firstRequestTime, "A staged agent request must reveal without navigating away")
        XCTAssertNil(firstProgressTime, "A staged request waiting for send must not claim agent processing")
        XCTAssertGreaterThan(requestFrames, 5)
        XCTAssertEqual(progressBeforeRequest, 0, "Processing must never appear before the outgoing request")
        if duringInitialLoad {
            XCTAssertTrue(revealedWhileHistoryWasLoading, "A locally accepted send must reveal before history loading finishes")
        }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = "Synthetic agent send with \(historyCount) prior messages, loading=\(duringInitialLoad)"
        attachment.lifetime = .keepAlways
        add(attachment)
        queue.release(conversation.id)
        composer.resignFirstResponder()
        try await Task.sleep(for: .milliseconds(100))
    }
}
