import AVFoundation
import CallKit
import Foundation
import LiveKit
import OSLog
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

enum KordiCallSystemIntegration {
    static var usesCallKit: Bool {
#if targetEnvironment(simulator)
        false
#else
        true
#endif
    }
}

enum KordiCallActionPolicy {
    static func timeoutEndsCall(_ action: CXAction) -> Bool {
        action is CXStartCallAction || action is CXAnswerCallAction
    }
}

enum KordiCallConnectionReadiness {
    static func isConnected(kind: CloudCallKind, hasRemoteParticipant: Bool) -> Bool {
        kind == .meeting || hasRemoteParticipant
    }
}

enum KordiCallRecoveryPolicy {
    static let reconnectDelays: [Duration] = [.seconds(1), .seconds(3)]
}

private let kordiCallLogger = Logger(
    subsystem: "ai.kordi.ios",
    category: "CallCoordinator"
)

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
    private var isRequestingIncomingAnswer = false
    private var isAnsweringIncomingCall = false
    private var finishingCallID: String?
    private var isSystemAudioSessionActive = false
    private var isPublishingMicrophone = false
    private var isPublishingCamera = false
    private var microphonePublicationTask: Task<Void, Never>?
    private var cameraPublicationTask: Task<Void, Never>?
    private var roomRecoveryTask: Task<Void, Never>?
    private var roomRecoveryID: UUID?

    private var usesSystemCallIntegration: Bool {
        KordiCallSystemIntegration.usesCallKit
    }

    var isAwaitingIncomingAnswer: Bool {
        activeCall?.direction == .incoming && media == nil && phase == .ringing
    }

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
            try await beginCurrentCall(response.call, conversation: conversation)
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
        if let activeCall {
            if activeCall.call.id == call.id,
               activeCall.direction == .incoming,
               media == nil {
                await answerPendingIncomingCall(call, in: conversation)
                return
            }
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
            try await beginCurrentCall(response.call, conversation: conversation)
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
        for call in callSnapshots {
            guard let conversation = model.conversation(for: call) else { continue }
            if activeCall?.call.id == call.id {
                updateActiveCall(call, conversation: conversation)
                continue
            }
            guard call.state != .ended,
                  call.kind != .meeting,
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
        guard enabled != isMicrophoneEnabled else { return }
        if activeCall.isPreview {
            isMicrophoneEnabled = enabled
            return
        }
        if usesSystemCallIntegration, let activeCallUUID {
            do {
                try await callController.request(
                    CXTransaction(
                        action: CXSetMutedCallAction(
                            call: activeCallUUID,
                            muted: !enabled
                        )
                    )
                )
            } catch {
                kordiCallLogger.error("CallKit rejected a microphone state request")
                phase = .failed("Could not update the microphone.")
            }
            return
        }
        await applyMicrophoneState(enabled)
    }

    func setCameraEnabled(_ enabled: Bool) async {
        guard let activeCall, activeCall.call.kind.allowsVideo else { return }
        if activeCall.isPreview {
            await setPreviewCameraEnabled(enabled)
            return
        }
        await applyCameraState(enabled)
    }

    func leave() async {
        guard let activeCall else { return }
        guard let callUUID = activeCallUUID else {
            let action: FinishAction = activeCall.direction == .outgoing && connectedAt == nil
                ? .end
                : .leave
            await finish(activeCall: activeCall, action: action)
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

    func answerIncomingCall() async {
        guard let activeCall, activeCall.direction == .incoming else { return }
        await answerPendingIncomingCall(activeCall.call, in: activeCall.conversation)
    }

    func declineIncomingCall() async {
        guard let activeCall, activeCall.direction == .incoming else { return }
        if usesSystemCallIntegration, let activeCallUUID {
            do {
                try await callController.request(
                    CXTransaction(action: CXEndCallAction(call: activeCallUUID))
                )
            } catch {
                await finish(activeCall: activeCall, action: .decline)
            }
            return
        }
        await finish(activeCall: activeCall, action: .decline)
    }

    func showCallScreen() {
        guard activeCall != nil else { return }
        if usesSystemCallIntegration,
           isAwaitingIncomingAnswer,
           activeCallUUID != nil {
            return
        }
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
        try configureCallAudioSession(startsWithVideo: call.kind.allowsVideo)
        let callUUID = UUID(uuidString: call.id) ?? UUID()
        activeCallUUID = callUUID
        let handle = CXHandle(type: .generic, value: conversation.displayName)
        let action = CXStartCallAction(call: callUUID, handle: handle)
        action.isVideo = activeCall?.startsWithVideo == true
        try await callController.request(CXTransaction(action: action))
    }

    private func beginCurrentCall(
        _ call: CloudCall,
        conversation: ConversationSummary
    ) async throws {
        if usesSystemCallIntegration {
            try await requestSystemStart(for: call, conversation: conversation)
        } else {
            try activateAppManagedAudioSession()
            try await connectCurrentRoom()
        }
    }

    private func answerPendingIncomingCall(
        _ call: CloudCall,
        in conversation: ConversationSummary
    ) async {
        if usesSystemCallIntegration, let activeCallUUID {
            guard !isRequestingIncomingAnswer,
                  !isAnsweringIncomingCall else { return }
            isRequestingIncomingAnswer = true
            defer { isRequestingIncomingAnswer = false }
            do {
                try await callController.request(
                    CXTransaction(action: CXAnswerCallAction(call: activeCallUUID))
                )
            } catch {
                phase = .failed("Could not answer the call.")
            }
            return
        }

        guard !isAnsweringIncomingCall else { return }
        guard let model else { return }
        guard await requestMediaPermission(for: call.kind) else {
            phase = .failed("Allow microphone and camera access in Settings to answer this call.")
            return
        }

        isAnsweringIncomingCall = true
        phase = .connecting
        var hasJoined = false
        do {
            let response = try await model.joinCall(call)
            hasJoined = true
            media = response.media
            activeCall = KordiCallPresentation(
                call: response.call,
                conversation: conversation,
                direction: .incoming,
                startsWithVideo: response.call.kind.allowsVideo,
                isPreview: false
            )
            isCameraEnabled = response.call.kind.allowsVideo
            try activateAppManagedAudioSession()
            try await connectCurrentRoom()
        } catch {
            phase = .failed(error.localizedDescription)
            if let activeCall {
                await finish(
                    activeCall: activeCall,
                    action: hasJoined ? .leave : .decline
                )
            }
        }
    }

    private func reportIncoming(call: CloudCall, conversation: ConversationSummary) {
        let callUUID = UUID(uuidString: call.id) ?? UUID()
        reportedIncomingCallIDs.insert(call.id)
        activeCall = KordiCallPresentation(
            call: call,
            conversation: conversation,
            direction: .incoming,
            startsWithVideo: call.kind.allowsVideo,
            isPreview: false
        )
        phase = .ringing

        guard usesSystemCallIntegration else {
            isCallScreenPresented = true
            scheduleLocalIncomingCallNotification(
                call: call,
                conversation: conversation
            )
            return
        }
        activeCallUUID = callUUID
        isCallScreenPresented = false

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: conversation.displayName)
        update.localizedCallerName = conversation.displayName
        update.hasVideo = call.kind.allowsVideo
        do {
            try configureCallAudioSession(startsWithVideo: call.kind.allowsVideo)
        } catch {
            let error = error as NSError
            kordiCallLogger.error(
                "Could not configure incoming call audio, domain: \(error.domain, privacy: .public), code: \(error.code)"
            )
        }
        provider.reportNewIncomingCall(with: callUUID, update: update) { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self,
                      self.activeCall?.call.id == call.id else { return }
                if let error = error as NSError? {
                    kordiCallLogger.error(
                        "CallKit could not present an incoming call, domain: \(error.domain, privacy: .public), code: \(error.code)"
                    )
                    self.activeCallUUID = nil
                    self.phase = .ringing
                    self.isCallScreenPresented = true
                    self.scheduleLocalIncomingCallNotification(
                        call: call,
                        conversation: conversation
                    )
                    return
                }
            }
        }
    }

    private func scheduleLocalIncomingCallNotification(
        call: CloudCall,
        conversation: ConversationSummary
    ) {
        guard UIApplication.shared.applicationState != .active else { return }
        let content = UNMutableNotificationContent()
        content.title = call.kind.allowsVideo ? "Incoming video call" : "Incoming voice call"
        content.body = "\(conversation.displayName) is calling."
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(
                identifier: "incoming-call-\(call.id)",
                content: content,
                trigger: nil
            )
        )
    }

    private func updateActiveCall(_ call: CloudCall, conversation: ConversationSummary) {
        guard let current = activeCall else { return }
        if call.state == .ended {
            if let activeCallUUID {
                provider.reportCall(with: activeCallUUID, endedAt: Date(), reason: .remoteEnded)
            }
            Task {
                await cleanUpRoom()
                resetPresentation()
            }
            return
        }
        activeCall = KordiCallPresentation(
            call: call,
            conversation: conversation,
            direction: current.direction,
            startsWithVideo: current.startsWithVideo,
            isPreview: current.isPreview
        )
    }

    private func connectCurrentRoom() async throws {
        guard activeCall != nil, let media else {
            throw CloudAPIError(
                code: "CALL_MEDIA_UNAVAILABLE",
                message: "The call connection is unavailable.",
                statusCode: 503
            )
        }
        phase = .connecting
        do {
            try await room.connect(url: media.url, token: media.token)
        } catch {
            let error = error as NSError
            kordiCallLogger.error(
                "LiveKit room connection failed, domain: \(error.domain, privacy: .public), code: \(error.code)"
            )
            throw error
        }
        updateConnectionPhaseFromRoom()
        isCallScreenPresented = true
        scheduleLocalMediaPublication()
    }

    private func scheduleRoomRecovery(for callID: String) {
        guard roomRecoveryTask == nil else { return }
        let recoveryID = UUID()
        roomRecoveryID = recoveryID
        phase = .reconnecting
        roomRecoveryTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if roomRecoveryID == recoveryID {
                    roomRecoveryTask = nil
                    roomRecoveryID = nil
                }
            }

            for (index, delay) in KordiCallRecoveryPolicy.reconnectDelays.enumerated() {
                do {
                    try await Task.sleep(for: delay)
                } catch {
                    return
                }
                guard activeCall?.id == callID else { return }
                do {
                    try await connectCurrentRoom()
                    kordiCallLogger.notice(
                        "LiveKit room recovery succeeded on attempt \(index + 1, privacy: .public)"
                    )
                    return
                } catch {
                    let error = error as NSError
                    kordiCallLogger.error(
                        "LiveKit room recovery attempt \(index + 1, privacy: .public) failed, domain: \(error.domain, privacy: .public), code: \(error.code)"
                    )
                }
            }

            guard let activeCall, activeCall.id == callID else { return }
            roomRecoveryTask = nil
            phase = .failed("The call connection was lost.")
            if let activeCallUUID {
                provider.reportCall(with: activeCallUUID, endedAt: Date(), reason: .failed)
            }
            await finish(activeCall: activeCall, action: .leave)
        }
    }

    private func updateConnectionPhaseFromRoom() {
        guard room.connectionState == .connected, let activeCall else { return }
        let isReady = KordiCallConnectionReadiness.isConnected(
            kind: activeCall.call.kind,
            hasRemoteParticipant: !room.remoteParticipants.isEmpty
        )
        guard isReady else {
            if connectedAt != nil {
                phase = .reconnecting
            } else {
                phase = activeCall.direction == .outgoing ? .ringing : .connecting
            }
            return
        }
        markConnected()
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

    private func scheduleLocalMediaPublication() {
        scheduleMicrophonePublication()
        guard activeCall?.startsWithVideo == true else { return }
        scheduleCameraPublication()
    }

    private func scheduleMicrophonePublication() {
        guard microphonePublicationTask == nil else { return }
        microphonePublicationTask = Task { @MainActor [weak self] in
            await self?.publishMicrophoneIfReady()
            self?.microphonePublicationTask = nil
        }
    }

    private func scheduleCameraPublication() {
        guard cameraPublicationTask == nil else { return }
        cameraPublicationTask = Task { @MainActor [weak self] in
            await self?.publishCameraIfReady()
            self?.cameraPublicationTask = nil
        }
    }

    private func publishMicrophoneIfReady() async {
        guard let callID = activeCall?.id,
              room.connectionState == .connected,
              !usesSystemCallIntegration || isSystemAudioSessionActive,
              !isPublishingMicrophone else { return }
        let requestedState = isMicrophoneEnabled
        isPublishingMicrophone = true
        defer { isPublishingMicrophone = false }
        do {
            try await room.localParticipant.setMicrophone(enabled: requestedState)
        } catch {
            guard activeCall?.id == callID else { return }
            if isMicrophoneEnabled == requestedState {
                isMicrophoneEnabled = !requestedState
            }
            let error = error as NSError
            kordiCallLogger.error(
                "LiveKit microphone publication failed, domain: \(error.domain, privacy: .public), code: \(error.code)"
            )
        }
    }

    private func publishCameraIfReady() async {
        guard let activeCall,
              activeCall.startsWithVideo,
              room.connectionState == .connected,
              !isPublishingCamera else { return }
        let callID = activeCall.id
        let requestedState = isCameraEnabled
        isPublishingCamera = true
        defer { isPublishingCamera = false }
        do {
            try await room.localParticipant.setCamera(enabled: requestedState)
        } catch {
            guard self.activeCall?.id == callID else { return }
            if isCameraEnabled == requestedState {
                isCameraEnabled = !requestedState
            }
            let error = error as NSError
            kordiCallLogger.error(
                "LiveKit camera publication failed, domain: \(error.domain, privacy: .public), code: \(error.code)"
            )
        }
    }

    private func applyMicrophoneState(_ enabled: Bool) async {
        isMicrophoneEnabled = enabled
        await publishMicrophoneIfReady()
    }

    private func applyCameraState(_ enabled: Bool) async {
        isCameraEnabled = enabled
        await publishCameraIfReady()
    }

    private enum FinishAction {
        case decline
        case leave
        case end
    }

    private func finish(activeCall: KordiCallPresentation, action: FinishAction) async {
        guard finishingCallID != activeCall.id else { return }
        finishingCallID = activeCall.id
        defer {
            if finishingCallID == activeCall.id {
                finishingCallID = nil
            }
        }
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
        roomRecoveryTask?.cancel()
        roomRecoveryTask = nil
        roomRecoveryID = nil
        cancelLocalMediaPublication()
        if let previewVideoTrack {
            try? await previewVideoTrack.stop()
            self.previewVideoTrack = nil
        }
        _ = try? await room.localParticipant.setCamera(enabled: false)
        _ = try? await room.localParticipant.setMicrophone(enabled: false)
        await room.disconnect()
        if !usesSystemCallIntegration {
            try? AudioManager.shared.setEngineAvailability(.none)
            try? AVAudioSession.sharedInstance().setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
        }
    }

    private func activateAppManagedAudioSession() throws {
        let audioSession = AVAudioSession.sharedInstance()
        try configureCallAudioSession(startsWithVideo: activeCall?.startsWithVideo == true)
        try audioSession.setActive(true)
        try AudioManager.shared.setEngineAvailability(.default)
    }

    private func configureCallAudioSession(startsWithVideo: Bool) throws {
        try AVAudioSession.sharedInstance().setCategory(
            .playAndRecord,
            mode: startsWithVideo ? .videoChat : .voiceChat,
            options: [.allowBluetoothHFP]
        )
    }

    private func cancelLocalMediaPublication() {
        microphonePublicationTask?.cancel()
        microphonePublicationTask = nil
        cameraPublicationTask?.cancel()
        cameraPublicationTask = nil
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
        isRequestingIncomingAnswer = false
        isAnsweringIncomingCall = false
        isSystemAudioSessionActive = false
        isPublishingMicrophone = false
        isPublishingCamera = false
    }

    private func startPreview(
        conversation: ConversationSummary,
        kind: CloudCallKind
    ) async {
        let accountID = model?.account?.accountId ?? "preview-self"
        let participants = ([CloudCallParticipant(
            accountId: accountID,
            displayName: model?.account?.preferredName ?? "You",
            avatarUrl: model?.account?.avatar.imageSource,
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
            if usesSystemCallIntegration {
                try await requestSystemStart(for: call, conversation: conversation)
            } else {
                markConnected()
            }
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
            guard let self,
                  let activeCall,
                  finishingCallID != activeCall.id else { return }
            kordiCallLogger.error("CallKit provider reset an active call")
            await finish(activeCall: activeCall, action: .leave)
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor [weak self] in
            guard let self, let activeCall else {
                action.fail()
                return
            }
            let startedAt = Date()
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: startedAt)
            if activeCall.isPreview {
                action.fulfill(withDateStarted: startedAt)
                markConnected()
                isCallScreenPresented = true
                return
            }
            do {
                try await connectCurrentRoom()
                action.fulfill(withDateStarted: startedAt)
            } catch {
                action.fail()
                phase = .failed(error.localizedDescription)
                provider.reportCall(with: action.callUUID, endedAt: Date(), reason: .failed)
                kordiCallLogger.error("Outgoing call media connection failed before CallKit acknowledgement")
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
            guard !isAnsweringIncomingCall else {
                action.fulfill()
                return
            }
            isAnsweringIncomingCall = true
            isRequestingIncomingAnswer = false
            isCallScreenPresented = true
            var hasJoined = false
            do {
                guard await requestMediaPermission(for: activeCall.call.kind) else {
                    throw CloudAPIError(
                        code: "CALL_MEDIA_PERMISSION_DENIED",
                        message: "Allow microphone and camera access in Settings to answer this call.",
                        statusCode: 403
                    )
                }
                let response = try await model.joinCall(activeCall.call)
                hasJoined = true
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
                action.fail()
                phase = .failed(error.localizedDescription)
                provider.reportCall(with: action.callUUID, endedAt: Date(), reason: .failed)
                kordiCallLogger.error("Incoming call media connection failed before CallKit acknowledgement")
                await finish(activeCall: activeCall, action: hasJoined ? .leave : .decline)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor [weak self] in
            guard let self, let activeCall else {
                action.fulfill()
                return
            }
            kordiCallLogger.notice(
                "CallKit requested call end, incoming: \(activeCall.direction == .incoming), connected: \(connectedAt != nil)"
            )
            let finishAction: FinishAction
            if activeCall.direction == .incoming && !isAnsweringIncomingCall && connectedAt == nil {
                finishAction = .decline
            } else if activeCall.direction == .outgoing && connectedAt == nil {
                finishAction = .end
            } else {
                finishAction = .leave
            }
            action.fulfill()
            await finish(activeCall: activeCall, action: finishAction)
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor [weak self] in
            guard let self else {
                action.fail()
                return
            }
            action.fulfill()
            if activeCall?.isPreview == true {
                isMicrophoneEnabled = !action.isMuted
                return
            }
            await applyMicrophoneState(!action.isMuted)
        }
    }

    nonisolated func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            kordiCallLogger.error(
                "CallKit action timed out: \(String(describing: type(of: action)), privacy: .public)"
            )
            guard KordiCallActionPolicy.timeoutEndsCall(action) else { return }
            guard
                  let callAction = action as? CXCallAction,
                  let activeCall else {
                phase = .failed("The system call control did not respond. Try again.")
                return
            }
            provider.reportCall(with: callAction.callUUID, endedAt: Date(), reason: .failed)
            let finishAction: FinishAction = activeCall.direction == .outgoing ? .end : .leave
            await finish(activeCall: activeCall, action: finishAction)
        }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        do {
            try AudioManager.shared.setEngineAvailability(.default)
            kordiCallLogger.notice("CallKit activated the call audio session")
            Task { @MainActor [weak self] in
                guard let self else { return }
                isSystemAudioSessionActive = true
                scheduleMicrophonePublication()
            }
        } catch {
            let error = error as NSError
            kordiCallLogger.error(
                "LiveKit audio engine activation failed, domain: \(error.domain, privacy: .public), code: \(error.code)"
            )
            Task { @MainActor [weak self] in
                self?.phase = .failed("The call audio session could not start.")
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        kordiCallLogger.notice("CallKit deactivated the call audio session")
        Task { @MainActor [weak self] in
            self?.isSystemAudioSessionActive = false
        }
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
                guard let self, let activeCall else { return }
                self.phase = activeCall.direction == .outgoing && self.connectedAt == nil
                    ? .ringing
                    : .connecting
            case .connected:
                self?.updateConnectionPhaseFromRoom()
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
        Task { @MainActor [weak self] in self?.updateConnectionPhaseFromRoom() }
    }

    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
        Task { @MainActor [weak self] in self?.updateConnectionPhaseFromRoom() }
    }

    nonisolated func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
        Task { @MainActor [weak self] in
            guard let self,
                  activeCall?.call.kind != .meeting,
                  connectedAt != nil else { return }
            phase = .reconnecting
        }
    }

    nonisolated func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
        guard let error else { return }
        Task { @MainActor [weak self] in
            guard let self,
                  let activeCall,
                  finishingCallID != activeCall.id else { return }
            let error = error as NSError
            kordiCallLogger.error(
                "LiveKit room disconnected, domain: \(error.domain, privacy: .public), code: \(error.code)"
            )
            scheduleRoomRecovery(for: activeCall.id)
        }
    }
}
