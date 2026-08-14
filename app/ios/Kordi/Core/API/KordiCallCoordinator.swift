import AVFoundation
import CallKit
import Foundation
import LiveKit
import PushKit
import UIKit
import UserNotifications

enum KordiCallPhase: Equatable {
    case preparing
    case ringing
    case connecting
    case connected
    case reconnecting
    case failed(String)

    var label: String {
        switch self {
        case .preparing: "Preparing call"
        case .ringing: "Ringing"
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .reconnecting: "Reconnecting"
        case .failed(let message): message
        }
    }
}

struct KordiCallPresentation: Identifiable, Equatable {
    enum Direction: Equatable {
        case incoming
        case outgoing
    }

    let call: CloudCall
    let conversation: ConversationSummary
    let direction: Direction
    let startsWithVideo: Bool
    let isPreview: Bool

    var id: String { call.id }
}

@MainActor
final class KordiCallCoordinator: NSObject, ObservableObject {
    @Published private(set) var activeCall: KordiCallPresentation?
    @Published private(set) var phase: KordiCallPhase = .preparing
    @Published private(set) var isMicrophoneEnabled = true
    @Published private(set) var isCameraEnabled = false
    @Published private(set) var previewVideoTrack: LocalVideoTrack?
    @Published private(set) var connectedAt: Date?
    @Published var isCallScreenPresented = false
    @Published var isParticipantListPresented = false

    let room: Room

    private weak var model: AppModel?
    private let callController = CXCallController()
    private let provider: CXProvider
    private let pushRegistry: PKPushRegistry
    private var media: CloudCallMediaConnection?
    private var activeCallUUID: UUID?
    private var pendingVoIPToken: String?
    private var reportedIncomingCallIDs = Set<String>()
    private var isAnsweringIncomingCall = false
    private var hasRequestedMeetingNotifications = false

    override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportedHandleTypes = [.generic]
        configuration.maximumCallsPerCallGroup = 1
        configuration.maximumCallGroups = 1
        configuration.supportsVideo = true
        provider = CXProvider(configuration: configuration)
        pushRegistry = PKPushRegistry(queue: .main)
        room = Room()
        super.init()

        provider.setDelegate(self, queue: nil)
        pushRegistry.delegate = self
        pushRegistry.desiredPushTypes = [.voIP]
        room.add(delegate: self)

        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = false
        try? AudioManager.shared.setEngineAvailability(.none)
    }

    func configure(model: AppModel) {
        self.model = model
        if let pendingVoIPToken {
            Task { await model.registerVoIPPushToken(pendingVoIPToken) }
        }
        requestMeetingNotificationRegistration()
    }

    private func requestMeetingNotificationRegistration() {
        guard !hasRequestedMeetingNotifications,
              model?.isPreviewMode != true,
              model?.account != nil else { return }
        hasRequestedMeetingNotifications = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            Task { @MainActor in
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func start(conversation: ConversationSummary, kind: CloudCallKind) async {
        guard activeCall == nil else {
            isCallScreenPresented = true
            return
        }
        guard conversation.kind != .agent else {
            phase = .failed("Calls are available in contact and group conversations.")
            return
        }
        guard let model else {
            phase = .failed("Kordi is still preparing your account.")
            return
        }

        if model.isPreviewMode {
            await startPreview(conversation: conversation, kind: kind)
            return
        }
        guard await requestMediaPermission(for: kind) else {
            phase = .failed("Allow microphone and camera access in Settings to start this call.")
            return
        }

        phase = .preparing
        do {
            let response = try await model.startCall(in: conversation, kind: kind)
            media = response.media
            activeCall = KordiCallPresentation(
                call: response.call,
                conversation: conversation,
                direction: .outgoing,
                startsWithVideo: kind.allowsVideo,
                isPreview: false
            )
            isCameraEnabled = kind.allowsVideo
            isMicrophoneEnabled = true
            phase = response.call.state == .ringing ? .ringing : .connecting
            isCallScreenPresented = true
            try await requestSystemStart(for: response.call, conversation: conversation)
        } catch {
            let message = error.localizedDescription
            if let activeCall {
                await finish(activeCall: activeCall, action: .end)
            } else {
                await cleanUpRoom()
            }
            phase = .failed(message)
        }
    }

    func join(_ call: CloudCall, in conversation: ConversationSummary) async {
        guard activeCall == nil else {
            isCallScreenPresented = true
            return
        }
        guard let model else { return }
        if model.isPreviewMode {
            await startPreview(conversation: conversation, kind: call.kind)
            return
        }
        guard await requestMediaPermission(for: call.kind) else {
            phase = .failed("Allow microphone and camera access in Settings to join this call.")
            return
        }

        phase = .connecting
        do {
            let response = try await model.joinCall(call)
            media = response.media
            activeCall = KordiCallPresentation(
                call: response.call,
                conversation: conversation,
                direction: .incoming,
                startsWithVideo: response.call.kind.allowsVideo,
                isPreview: false
            )
            isCameraEnabled = response.call.kind.allowsVideo
            isCallScreenPresented = true
            try await requestSystemStart(for: response.call, conversation: conversation)
        } catch {
            let message = error.localizedDescription
            if let activeCall {
                await finish(activeCall: activeCall, action: .leave)
            } else {
                await cleanUpRoom()
            }
            phase = .failed(message)
        }
    }

    func receive(callSnapshots: [CloudCall]) {
        guard let model else { return }
        for call in callSnapshots where call.state != .ended {
            guard let conversation = model.conversation(for: call) else { continue }
            if activeCall?.call.id == call.id {
                updateActiveCall(call, conversation: conversation)
                continue
            }
            guard call.kind != .meeting,
                  call.state == .ringing,
                  call.createdByAccountId != model.account?.accountId,
                  call.participants.contains(where: {
                      $0.accountId == model.account?.accountId && $0.state == "invited"
                  }),
                  !reportedIncomingCallIDs.contains(call.id) else { continue }
            reportIncoming(call: call, conversation: conversation)
        }
    }

    func setMicrophoneEnabled(_ enabled: Bool) async {
        guard let activeCall else { return }
        guard let callUUID = activeCallUUID else {
            guard activeCall.isPreview else { return }
            isMicrophoneEnabled = enabled
            return
        }
        let transaction = CXTransaction(
            action: CXSetMutedCallAction(call: callUUID, muted: !enabled)
        )
        do {
            try await callController.request(transaction)
        } catch {
            phase = .failed("Could not update the microphone.")
        }
    }

    func setCameraEnabled(_ enabled: Bool) async {
        guard let activeCall, activeCall.call.kind.allowsVideo else { return }
        if activeCall.isPreview {
            await setPreviewCameraEnabled(enabled)
            return
        }
        do {
            try await room.localParticipant.setCamera(enabled: enabled)
            isCameraEnabled = enabled
        } catch {
            phase = .failed("Could not update the camera.")
        }
    }

    func leave() async {
        guard let activeCall else { return }
        guard let callUUID = activeCallUUID else {
            await finish(activeCall: activeCall, action: .leave)
            return
        }
        do {
            try await callController.request(
                CXTransaction(action: CXEndCallAction(call: callUUID))
            )
        } catch {
            await finish(activeCall: activeCall, action: .leave)
        }
    }

    func showCallScreen() {
        guard activeCall != nil else { return }
        isCallScreenPresented = true
    }

    func minimize() {
        isParticipantListPresented = false
        isCallScreenPresented = false
    }

    func inviteParticipants() async throws {
        guard let activeCall, activeCall.call.kind == .meeting else {
            throw CloudAPIError(
                code: "CALL_STATE_CONFLICT",
                message: "Participant invitations are available during group meetings.",
                statusCode: 409
            )
        }
        guard !activeCall.isPreview else { return }
        guard let model else {
            throw CloudAPIError(
                code: "invalid_session",
                message: "Kordi is still preparing your account.",
                statusCode: 401
            )
        }
        let updated = try await model.inviteCallParticipants(activeCall.call)
        updateActiveCall(updated, conversation: activeCall.conversation)
    }

    private func requestSystemStart(
        for call: CloudCall,
        conversation: ConversationSummary
    ) async throws {
        let callUUID = UUID(uuidString: call.id) ?? UUID()
        activeCallUUID = callUUID
        let handle = CXHandle(type: .generic, value: conversation.displayName)
        let action = CXStartCallAction(call: callUUID, handle: handle)
        action.isVideo = activeCall?.startsWithVideo == true
        try await callController.request(CXTransaction(action: action))
    }

    private func reportIncoming(call: CloudCall, conversation: ConversationSummary) {
        let callUUID = UUID(uuidString: call.id) ?? UUID()
        reportedIncomingCallIDs.insert(call.id)
        activeCallUUID = callUUID
        activeCall = KordiCallPresentation(
            call: call,
            conversation: conversation,
            direction: .incoming,
            startsWithVideo: call.kind.allowsVideo,
            isPreview: false
        )
        phase = .ringing

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: conversation.displayName)
        update.localizedCallerName = conversation.displayName
        update.hasVideo = call.kind.allowsVideo
        try? AVAudioSession.sharedInstance().setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetoothHFP]
        )
        provider.reportNewIncomingCall(with: callUUID, update: update) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in
                self?.phase = .failed("Could not present the incoming call.")
                self?.resetPresentation()
            }
        }
    }

    private func updateActiveCall(_ call: CloudCall, conversation: ConversationSummary) {
        guard let current = activeCall else { return }
        if call.state == .ended {
            Task { await leave() }
            return
        }
        activeCall = KordiCallPresentation(
            call: call,
            conversation: conversation,
            direction: current.direction,
            startsWithVideo: current.startsWithVideo,
            isPreview: current.isPreview
        )
        if call.state == .active, room.connectionState == .connected {
            markConnected()
        }
    }

    private func connectCurrentRoom() async throws {
        guard let activeCall, let media else {
            throw CloudAPIError(
                code: "CALL_MEDIA_UNAVAILABLE",
                message: "The call connection is unavailable.",
                statusCode: 503
            )
        }
        phase = .connecting
        try await room.connect(url: media.url, token: media.token)
        try await room.localParticipant.setMicrophone(enabled: true)
        if activeCall.startsWithVideo {
            try await room.localParticipant.setCamera(enabled: true)
        }
        if waitsForRemoteAnswer {
            connectedAt = nil
            phase = .ringing
        } else {
            markConnected()
        }
        isCallScreenPresented = true
    }

    private var waitsForRemoteAnswer: Bool {
        guard let activeCall else { return false }
        return activeCall.direction == .outgoing
            && activeCall.call.kind != .meeting
            && activeCall.call.state == .ringing
            && room.remoteParticipants.isEmpty
    }

    private func markConnected() {
        guard connectedAt == nil else {
            phase = .connected
            return
        }
        let date = Date()
        connectedAt = date
        phase = .connected
        if let activeCallUUID, activeCall?.direction == .outgoing {
            provider.reportOutgoingCall(with: activeCallUUID, connectedAt: date)
        }
    }

    private enum FinishAction {
        case decline
        case leave
        case end
    }

    private func finish(activeCall: KordiCallPresentation, action: FinishAction) async {
        await cleanUpRoom()
        if activeCall.isPreview {
            model?.recordPreviewCallEnded(activeCall.call, in: activeCall.conversation)
        } else if let model {
            switch action {
            case .decline:
                await model.declineCall(activeCall.call)
            case .leave:
                await model.leaveCall(activeCall.call)
            case .end:
                await model.endCall(activeCall.call)
            }
        }
        resetPresentation()
    }

    private func cleanUpRoom() async {
        if let previewVideoTrack {
            try? await previewVideoTrack.stop()
            self.previewVideoTrack = nil
        }
        _ = try? await room.localParticipant.setCamera(enabled: false)
        _ = try? await room.localParticipant.setMicrophone(enabled: false)
        await room.disconnect()
    }

    private func resetPresentation() {
        activeCall = nil
        media = nil
        activeCallUUID = nil
        connectedAt = nil
        isCallScreenPresented = false
        isParticipantListPresented = false
        isCameraEnabled = false
        isMicrophoneEnabled = true
        isAnsweringIncomingCall = false
    }

    private func startPreview(
        conversation: ConversationSummary,
        kind: CloudCallKind
    ) async {
        let accountID = model?.account?.accountId ?? "preview-self"
        let participants = ([CloudCallParticipant(
            accountId: accountID,
            displayName: model?.account?.preferredName ?? "You",
            avatarUrl: model?.account?.avatarUrl,
            state: "joined",
            joinedAt: ISO8601DateFormatter().string(from: Date()),
            leftAt: nil
        )] + conversation.remotePeerAccountIds.map { accountID in
            let member = conversation.groupParticipants.first { $0.accountId == accountID }
            return CloudCallParticipant(
                accountId: accountID,
                displayName: member?.displayName ?? conversation.displayName,
                avatarUrl: member?.avatarUrl ?? conversation.avatarSource,
                state: "joined",
                joinedAt: ISO8601DateFormatter().string(from: Date()),
                leftAt: nil
            )
        })
        let call = CloudCall(
            id: UUID().uuidString.lowercased(),
            conversationId: conversation.sessionId,
            kind: conversation.kind == .group ? .meeting : kind,
            state: .active,
            createdByAccountId: accountID,
            createdAt: ISO8601DateFormatter().string(from: Date()),
            answeredAt: ISO8601DateFormatter().string(from: Date()),
            endedAt: nil,
            participants: participants
        )
        activeCall = KordiCallPresentation(
            call: call,
            conversation: conversation,
            direction: .outgoing,
            startsWithVideo: kind.allowsVideo,
            isPreview: true
        )
        phase = .connecting
        connectedAt = nil
        isMicrophoneEnabled = true
        isCameraEnabled = false
        isCallScreenPresented = true
        model?.recordPreviewCallStarted(call, in: conversation)
        do {
            try await requestSystemStart(for: call, conversation: conversation)
            if kind.allowsVideo {
                await setPreviewCameraEnabled(true)
            }
        } catch {
            let message = error.localizedDescription
            if let activeCall {
                await finish(activeCall: activeCall, action: .leave)
            }
            phase = .failed(message)
        }
    }

    private func setPreviewCameraEnabled(_ enabled: Bool) async {
        if enabled {
            guard await requestCaptureAccess(for: .video) else {
                isCameraEnabled = false
                phase = .failed("Allow camera access in Settings to preview your video.")
                return
            }
            do {
                let track = previewVideoTrack ?? LocalVideoTrack.createCameraTrack()
                try await track.start()
                previewVideoTrack = track
                isCameraEnabled = true
                phase = .connected
            } catch {
                isCameraEnabled = false
                phase = .failed("The camera preview could not start.")
            }
        } else {
            if let previewVideoTrack {
                try? await previewVideoTrack.stop()
            }
            isCameraEnabled = false
        }
    }

    private func requestMediaPermission(for kind: CloudCallKind) async -> Bool {
        let microphone = await requestCaptureAccess(for: .audio)
        guard microphone else { return false }
        guard kind.allowsVideo else { return true }
        return await requestCaptureAccess(for: .video)
    }

    private func requestCaptureAccess(for mediaType: AVMediaType) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: mediaType) {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: mediaType) { granted in
                    continuation.resume(returning: granted)
                }
            }
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }
}

extension KordiCallCoordinator: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor [weak self] in
            guard let self, let activeCall else { return }
            await finish(activeCall: activeCall, action: .leave)
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor [weak self] in
            guard let self, let activeCall else {
                action.fail()
                return
            }
            do {
                let startedAt = Date()
                provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: startedAt)
                if activeCall.isPreview {
                    markConnected()
                    isCallScreenPresented = true
                    action.fulfill(withDateStarted: startedAt)
                    return
                }
                try await connectCurrentRoom()
                action.fulfill()
            } catch {
                phase = .failed(error.localizedDescription)
                action.fail()
                await finish(activeCall: activeCall, action: .end)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Task { @MainActor [weak self] in
            guard let self, let activeCall, let model else {
                action.fail()
                return
            }
            isAnsweringIncomingCall = true
            do {
                guard await requestMediaPermission(for: activeCall.call.kind) else {
                    throw CloudAPIError(
                        code: "CALL_MEDIA_PERMISSION_DENIED",
                        message: "Allow microphone and camera access in Settings to answer this call.",
                        statusCode: 403
                    )
                }
                let response = try await model.joinCall(activeCall.call)
                media = response.media
                self.activeCall = KordiCallPresentation(
                    call: response.call,
                    conversation: activeCall.conversation,
                    direction: .incoming,
                    startsWithVideo: activeCall.startsWithVideo,
                    isPreview: false
                )
                try await connectCurrentRoom()
                action.fulfill()
            } catch {
                phase = .failed(error.localizedDescription)
                action.fail()
                await finish(activeCall: activeCall, action: .decline)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor [weak self] in
            guard let self, let activeCall else {
                action.fulfill()
                return
            }
            let finishAction: FinishAction
            if activeCall.direction == .incoming && !isAnsweringIncomingCall && connectedAt == nil {
                finishAction = .decline
            } else if activeCall.direction == .outgoing && connectedAt == nil {
                finishAction = .end
            } else {
                finishAction = .leave
            }
            await finish(activeCall: activeCall, action: finishAction)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor [weak self] in
            guard let self else {
                action.fail()
                return
            }
            if activeCall?.isPreview == true {
                isMicrophoneEnabled = !action.isMuted
                action.fulfill()
                return
            }
            do {
                try await room.localParticipant.setMicrophone(enabled: !action.isMuted)
                isMicrophoneEnabled = !action.isMuted
                action.fulfill()
            } catch {
                action.fail()
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        do {
            try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
            try AudioManager.shared.setEngineAvailability(.default)
        } catch {
            Task { @MainActor [weak self] in
                self?.phase = .failed("The call audio session could not start.")
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        try? AudioManager.shared.setEngineAvailability(.none)
    }
}

extension KordiCallCoordinator: PKPushRegistryDelegate {
    nonisolated func pushRegistry(
        _ registry: PKPushRegistry,
        didUpdate pushCredentials: PKPushCredentials,
        for type: PKPushType
    ) {
        guard type == .voIP else { return }
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor [weak self] in
            self?.pendingVoIPToken = token
            if let model = self?.model {
                await model.registerVoIPPushToken(token)
            }
        }
    }

    nonisolated func pushRegistry(
        _ registry: PKPushRegistry,
        didInvalidatePushTokenFor type: PKPushType
    ) {
        guard type == .voIP else { return }
        Task { @MainActor [weak self] in self?.pendingVoIPToken = nil }
    }

    nonisolated func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP else {
            completion()
            return
        }
        let values = payload.dictionaryPayload
        guard let callID = values["call_id"] as? String,
              let conversationID = values["conversation_id"] as? String else {
            completion()
            return
        }
        let kind = CloudCallKind(rawValue: values["kind"] as? String ?? "voice") ?? .voice
        let callerID = values["caller_account_id"] as? String ?? "unknown"
        let callerName = values["caller_name"] as? String ?? "Kordi call"
        let now = ISO8601DateFormatter().string(from: Date())
        let call = CloudCall(
            id: callID,
            conversationId: conversationID,
            kind: kind,
            state: .ringing,
            createdByAccountId: callerID,
            createdAt: now,
            answeredAt: nil,
            endedAt: nil,
            participants: []
        )
        dispatchPrecondition(condition: .onQueue(.main))
        MainActor.assumeIsolated { [weak self] in
            guard let self else { return }
            let conversation = model?.conversation(for: call) ?? ConversationSummary(
                id: "call:\(conversationID)",
                kind: .person,
                peerAccountId: callerID,
                agentId: nil,
                ownerDisplayName: callerName,
                displayName: callerName,
                lastMessage: "Incoming call",
                lastActivityAt: Date(),
                unreadCount: 0,
                avatarSource: nil,
                agentActivity: nil,
                sessionId: conversationID
            )
            reportIncoming(call: call, conversation: conversation)
        }
        completion()
    }
}

extension KordiCallCoordinator: RoomDelegate {
    nonisolated func room(
        _ room: Room,
        didUpdateConnectionState connectionState: ConnectionState,
        from oldConnectionState: ConnectionState
    ) {
        Task { @MainActor [weak self] in
            switch connectionState {
            case .connecting:
                self?.phase = .connecting
            case .connected:
                if self?.waitsForRemoteAnswer == true {
                    self?.phase = .ringing
                } else {
                    self?.markConnected()
                }
            case .reconnecting:
                self?.phase = .reconnecting
            case .disconnected, .disconnecting:
                break
            @unknown default:
                break
            }
        }
    }

    nonisolated func room(_ room: Room, didStartReconnectWithMode reconnectMode: ReconnectMode) {
        Task { @MainActor [weak self] in self?.phase = .reconnecting }
    }

    nonisolated func room(_ room: Room, didCompleteReconnectWithMode reconnectMode: ReconnectMode) {
        Task { @MainActor [weak self] in self?.markConnected() }
    }

    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor [weak self] in
            guard let self,
                  activeCall?.direction == .outgoing,
                  activeCall?.call.kind != .meeting else { return }
            markConnected()
        }
    }

    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        guard let error else { return }
        Task { @MainActor [weak self] in
            self?.phase = .failed(error.localizedDescription)
        }
    }
}
