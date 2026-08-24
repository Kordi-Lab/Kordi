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

enum KordiCallStartPolicy {
    static func canBegin(
        hasActiveCall: Bool,
        isStartInFlight: Bool,
        hasSystemCall: Bool
    ) -> Bool {
        !hasActiveCall && !isStartInFlight && !hasSystemCall
    }
}

enum KordiCallSystemStartErrorPresentation {
    static func message(for error: Error) -> String {
        let error = error as NSError
        return message(domain: error.domain, code: error.code)
    }

    static func message(domain: String, code: Int) -> String {
        guard domain == CXErrorDomainRequestTransaction else {
            return "The call could not start. Try again."
        }
        if code == CXErrorCodeRequestTransactionError.Code.callUUIDAlreadyExists.rawValue {
            return "A call is already starting. Wait a moment, then try again."
        }
        if code == CXErrorCodeRequestTransactionError.Code.maximumCallGroupsReached.rawValue {
            return "End the current system call before starting a Kordi call."
        }
        return "The system could not start the call. Try again."
    }
}

enum KordiCallConnectionReadiness {
    static func isConnected(kind: CloudCallKind, hasRemoteParticipant: Bool) -> Bool {
        kind == .meeting || hasRemoteParticipant
    }
}

enum KordiCallMediaFailurePolicy {
    static func isFatalInitialMicrophonePublication(
        requestedEnabled: Bool,
        hasPublished: Bool
    ) -> Bool {
        requestedEnabled && !hasPublished
    }
}

enum KordiCallRecoveryPolicy {
    static let reconnectDelays: [Duration] = [.seconds(1), .seconds(3)]
}

enum KordiCallMediaFailureStage: Equatable {
    case signaling
    case iceOrTurn
    case device
    case microphonePublication

    var message: String {
        switch self {
        case .signaling:
            "Call signaling failed. Check the server connection and try again."
        case .iceOrTurn:
            "Call media could not establish an ICE or TURN connection."
        case .device:
            "Kordi could not find the microphone needed for this call."
        case .microphonePublication:
            "The microphone connected, but its audio track could not be published."
        }
    }

    static func connectionStage(for error: Error) -> Self {
        guard let error = error as? LiveKitError else { return .iceOrTurn }
        switch error.type {
        case .validation, .serviceNotFound, .insufficientPermissions, .joinFailure:
            return .signaling
        default:
            return .iceOrTurn
        }
    }

    static func publicationStage(for error: Error, fallback: Self) -> Self {
        guard let error = error as? LiveKitError else { return fallback }
        switch error.type {
        case .deviceNotFound, .captureFormatNotFound, .unableToResolveFPSRange:
            return .device
        default:
            return fallback
        }
    }
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
    @Published private(set) var isStartingCall = false
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
    private var hasPublishedMicrophone = false
    private var microphonePublicationTask: Task<Void, Never>?
    private var cameraPublicationTask: Task<Void, Never>?
    private var roomRecoveryTask: Task<Void, Never>?
    private var roomRecoveryID: UUID?
    private var systemStartWorkTasks: [UUID: Task<Void, Never>] = [:]

    private enum PendingSystemStartRequest {
        case start(conversation: ConversationSummary, kind: CloudCallKind)
        case join(call: CloudCall, conversation: ConversationSummary)

        var conversation: ConversationSummary {
            switch self {
            case .start(let conversation, _), .join(_, let conversation):
                conversation
            }
        }

        var startsWithVideo: Bool {
            switch self {
            case .start(_, let kind): kind.allowsVideo
            case .join(let call, _): call.kind.allowsVideo
            }
        }
    }

    private struct PendingSystemStart {
        let callUUID: UUID
        let request: PendingSystemStartRequest
        let continuation: CheckedContinuation<Void, Error>
    }

    private enum SystemStartFailure: LocalizedError {
        case existingSystemCall
        case timedOut
        case providerReset
        case accountUnavailable
        case cancelled

        var errorDescription: String? {
            switch self {
            case .existingSystemCall:
                "End the current system call before starting a Kordi call."
            case .timedOut:
                "The system call control did not respond. Try again."
            case .providerReset:
                "The system call service restarted. Try again."
            case .accountUnavailable:
                "Sign in again before starting a call."
            case .cancelled:
                "Call canceled."
            }
        }
    }

    private var pendingSystemStart: PendingSystemStart?

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

    func cancelUnadmittedStart() {
        guard activeCall == nil else { return }
        cancelPendingSystemStart(with: .cancelled)
    }

    func prepareForAccountTeardown() async {
        cancelPendingSystemStart(with: .accountUnavailable)
        _ = await finishActiveCallForTeardown()
        let tasks = Array(systemStartWorkTasks.values)
        for task in tasks {
            await task.value
        }
        _ = await finishActiveCallForTeardown()
        guard activeCall != nil else { return }
        await cleanUpRoom()
        resetPresentation()
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

        guard !isStartingCall else { return }
        let hasSystemCall = usesSystemCallIntegration && callController.callObserver.calls.contains {
            !$0.hasEnded
        }
        guard KordiCallStartPolicy.canBegin(
            hasActiveCall: activeCall != nil,
            isStartInFlight: isStartingCall,
            hasSystemCall: hasSystemCall
        ) else {
            if hasSystemCall {
                phase = .failed("End the current system call before starting a Kordi call.")
            }
            return
        }
        isStartingCall = true
        defer { isStartingCall = false }

        if model.isPreviewMode {
            await startPreview(conversation: conversation, kind: kind)
            return
        }
        guard await requestMediaPermission(for: kind) else {
            phase = .failed("Allow microphone and camera access in Settings to start this call.")
            return
        }
        guard !Task.isCancelled else { return }

        phase = .preparing
        do {
            if usesSystemCallIntegration {
                try await withTaskCancellationHandler {
                    try await requestSystemStart(.start(conversation: conversation, kind: kind))
                } onCancel: {
                    Task { @MainActor [weak self] in self?.cancelUnadmittedStart() }
                }
            } else {
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
                try activateAppManagedAudioSession()
                try await connectCurrentRoom()
            }
        } catch {
            if let failure = error as? SystemStartFailure, case .cancelled = failure { return }
            if !usesSystemCallIntegration {
                if let activeCall {
                    await finish(activeCall: activeCall, action: .end)
                } else {
                    await cleanUpRoom()
                }
            }
            phase = .failed(systemStartMessage(for: error))
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

        guard !isStartingCall else { return }
        let hasSystemCall = usesSystemCallIntegration && callController.callObserver.calls.contains {
            !$0.hasEnded
        }
        guard KordiCallStartPolicy.canBegin(
            hasActiveCall: activeCall != nil,
            isStartInFlight: isStartingCall,
            hasSystemCall: hasSystemCall
        ) else {
            if hasSystemCall {
                phase = .failed("End the current system call before starting a Kordi call.")
            }
            return
        }
        isStartingCall = true
        defer { isStartingCall = false }

        if model.isPreviewMode {
            await startPreview(conversation: conversation, kind: call.kind)
            return
        }
        guard await requestMediaPermission(for: call.kind) else {
            phase = .failed("Allow microphone and camera access in Settings to join this call.")
            return
        }
        guard !Task.isCancelled else { return }

        phase = .connecting
        do {
            if usesSystemCallIntegration {
                try await withTaskCancellationHandler {
                    try await requestSystemStart(.join(call: call, conversation: conversation))
                } onCancel: {
                    Task { @MainActor [weak self] in self?.cancelUnadmittedStart() }
                }
            } else {
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
                try activateAppManagedAudioSession()
                try await connectCurrentRoom()
            }
        } catch {
            if let failure = error as? SystemStartFailure, case .cancelled = failure { return }
            if !usesSystemCallIntegration {
                if let activeCall {
                    await finish(activeCall: activeCall, action: .leave)
                } else {
                    await cleanUpRoom()
                }
            }
            phase = .failed(systemStartMessage(for: error))
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

    private func requestSystemStart(_ request: PendingSystemStartRequest) async throws {
        guard activeCall == nil,
              pendingSystemStart == nil,
              !callController.callObserver.calls.contains(where: { !$0.hasEnded }) else {
            throw SystemStartFailure.existingSystemCall
        }
        try configureCallAudioSession(startsWithVideo: request.startsWithVideo)
        let callUUID = UUID()
        let handle = CXHandle(type: .generic, value: request.conversation.displayName)
        let action = CXStartCallAction(call: callUUID, handle: handle)
        action.isVideo = request.startsWithVideo
        let transaction = CXTransaction(action: action)

        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            pendingSystemStart = PendingSystemStart(
                callUUID: callUUID,
                request: request,
                continuation: continuation
            )
            Task { @MainActor in
                do {
                    try await callController.request(transaction)
                } catch {
                    logSystemStartFailure(error, stage: "transaction")
                    completePendingSystemStart(callUUID: callUUID, result: .failure(error))
                }
            }
        }
    }

    private func requestPreviewSystemStart(
        for call: CloudCall,
        conversation: ConversationSummary
    ) async throws {
        guard !callController.callObserver.calls.contains(where: { !$0.hasEnded }) else {
            throw SystemStartFailure.existingSystemCall
        }
        try configureCallAudioSession(startsWithVideo: call.kind.allowsVideo)
        let callUUID = UUID()
        activeCallUUID = callUUID
        let handle = CXHandle(type: .generic, value: conversation.displayName)
        let action = CXStartCallAction(call: callUUID, handle: handle)
        action.isVideo = activeCall?.startsWithVideo == true
        try await callController.request(CXTransaction(action: action))
    }

    private func completePendingSystemStart(
        callUUID: UUID,
        result: Result<Void, Error>
    ) {
        guard let pendingSystemStart,
              pendingSystemStart.callUUID == callUUID else { return }
        self.pendingSystemStart = nil
        switch result {
        case .success:
            pendingSystemStart.continuation.resume()
        case .failure(let error):
            pendingSystemStart.continuation.resume(throwing: error)
        }
    }

    private func cancelPendingSystemStart(with error: SystemStartFailure) {
        guard let pendingSystemStart else { return }
        completePendingSystemStart(
            callUUID: pendingSystemStart.callUUID,
            result: .failure(error)
        )
    }

    private func finishActiveCallForTeardown() async -> Bool {
        guard let activeCall else { return true }
        if let activeCallUUID {
            provider.reportCall(with: activeCallUUID, endedAt: Date(), reason: .failed)
        }
        let action: FinishAction = activeCall.direction == .outgoing ? .end : .leave
        return await finish(activeCall: activeCall, action: action)
    }

    private func systemStartMessage(for error: Error) -> String {
        if let error = error as? SystemStartFailure {
            return error.localizedDescription
        }
        if error is CloudAPIError {
            return error.localizedDescription
        }
        return KordiCallSystemStartErrorPresentation.message(for: error)
    }

    private func logSystemStartFailure(
        _ error: Error,
        stage: StaticString
    ) {
        let error = error as NSError
        kordiCallLogger.error(
            "Call start failed, stage: \(stage), domain: \(error.domain, privacy: .public), code: \(error.code, privacy: .public), pending: \(self.pendingSystemStart != nil), active: \(self.activeCall != nil)"
        )
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
            if finishingCallID == call.id { return }
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
        kordiCallLogger.notice("LiveKit signaling started")
        do {
            try await room.connect(url: media.url, token: media.token)
        } catch {
            let error = error as NSError
            kordiCallLogger.error(
                "LiveKit room connection failed, domain: \(error.domain, privacy: .public), code: \(error.code)"
            )
            let stage = KordiCallMediaFailureStage.connectionStage(for: error)
            throw CloudAPIError(
                code: stage == .signaling ? "CALL_SIGNALING_FAILED" : "CALL_ICE_TURN_FAILED",
                message: stage.message,
                statusCode: 0
            )
        }
        kordiCallLogger.notice("LiveKit signaling and media transport connected")
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
            if requestedState { hasPublishedMicrophone = true }
            kordiCallLogger.notice("LiveKit microphone publication completed")
        } catch {
            guard activeCall?.id == callID else { return }
            if isMicrophoneEnabled == requestedState {
                isMicrophoneEnabled = !requestedState
            }
            let stage = KordiCallMediaFailureStage.publicationStage(
                for: error,
                fallback: .microphonePublication
            )
            let error = error as NSError
            kordiCallLogger.error(
                "LiveKit microphone publication failed, domain: \(error.domain, privacy: .public), code: \(error.code)"
            )
            if KordiCallMediaFailurePolicy.isFatalInitialMicrophonePublication(
                requestedEnabled: requestedState,
                hasPublished: hasPublishedMicrophone
            ) {
                await failCurrentCallForMedia(stage)
            } else {
                phase = .failed(stage.message)
            }
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
            kordiCallLogger.notice("LiveKit camera publication completed")
        } catch {
            guard self.activeCall?.id == callID else { return }
            if isCameraEnabled == requestedState {
                isCameraEnabled = !requestedState
            }
            let error = error as NSError
            kordiCallLogger.error(
                "LiveKit camera publication failed, domain: \(error.domain, privacy: .public), code: \(error.code)"
            )
            updateConnectionPhaseFromRoom()
        }
    }

    private func failCurrentCallForMedia(_ stage: KordiCallMediaFailureStage) async {
        phase = .failed(stage.message)
        guard let activeCall, finishingCallID != activeCall.id else { return }
        if let activeCallUUID {
            provider.reportCall(with: activeCallUUID, endedAt: Date(), reason: .failed)
        }
        let action: FinishAction = activeCall.direction == .outgoing ? .end : .leave
        _ = await finish(activeCall: activeCall, action: action)
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

    @discardableResult
    private func finish(activeCall: KordiCallPresentation, action: FinishAction) async -> Bool {
        guard finishingCallID != activeCall.id else { return false }
        finishingCallID = activeCall.id
        defer {
            if finishingCallID == activeCall.id {
                finishingCallID = nil
            }
        }
        let didFinish: Bool
        if activeCall.isPreview {
            model?.recordPreviewCallEnded(activeCall.call, in: activeCall.conversation)
            didFinish = true
        } else if let model {
            switch action {
            case .decline:
                didFinish = await model.declineCall(activeCall.call)
            case .leave:
                didFinish = await model.leaveCall(activeCall.call)
            case .end:
                didFinish = await model.endCall(activeCall.call)
            }
        } else {
            didFinish = false
        }
        guard didFinish else {
            phase = .failed("Could not update the call state. Check your connection and try again.")
            return false
        }
        await cleanUpRoom()
        resetPresentation()
        return true
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
        hasPublishedMicrophone = false
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
                try await requestPreviewSystemStart(for: call, conversation: conversation)
            } else {
                markConnected()
            }
            if kind.allowsVideo {
                await setPreviewCameraEnabled(true)
            }
        } catch {
            if let activeCall {
                await finish(activeCall: activeCall, action: .leave)
            }
            phase = .failed(systemStartMessage(for: error))
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
            guard let self else { return }
            if let pendingSystemStart {
                let error = SystemStartFailure.providerReset
                logSystemStartFailure(
                    error,
                    stage: "provider-reset"
                )
                cancelPendingSystemStart(with: error)
                if let activeCall, finishingCallID != activeCall.id {
                    let action: FinishAction = activeCall.direction == .outgoing ? .end : .leave
                    guard await finish(activeCall: activeCall, action: action) else { return }
                }
                phase = .failed(error.localizedDescription)
                return
            }
            guard let activeCall,
                  finishingCallID != activeCall.id else { return }
            kordiCallLogger.error("CallKit provider reset an active call")
            let action: FinishAction = activeCall.direction == .outgoing ? .end : .leave
            await finish(activeCall: activeCall, action: action)
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor [weak self] in
            guard let self else {
                action.fail()
                return
            }
            beginSystemStartWork(provider: provider, action: action)
        }
    }

    private func beginSystemStartWork(provider: CXProvider, action: CXStartCallAction) {
        let callUUID = action.callUUID
        let task = Task { @MainActor [weak self] in
            guard let self else {
                action.fail()
                return
            }
            await performSystemStart(provider: provider, action: action)
        }
        systemStartWorkTasks[callUUID] = task
        Task { @MainActor [weak self] in
            await task.value
            self?.systemStartWorkTasks[callUUID] = nil
        }
    }

    private func performSystemStart(provider: CXProvider, action: CXStartCallAction) async {
        let startedAt = Date()
        if let activeCall,
           activeCall.isPreview,
           activeCallUUID == action.callUUID {
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: startedAt)
            action.fulfill(withDateStarted: startedAt)
            markConnected()
            isCallScreenPresented = true
            return
        }

        guard let pending = pendingSystemStart,
              pending.callUUID == action.callUUID else {
            action.fail()
            return
        }
        guard let model else {
            let error = SystemStartFailure.accountUnavailable
            action.fail()
            completePendingSystemStart(
                callUUID: action.callUUID,
                result: .failure(error)
            )
            phase = .failed(error.localizedDescription)
            return
        }

        let request = pending.request
        var actionWasFulfilled = false
        do {
            let response: CloudCallSessionResponse
            let direction: KordiCallPresentation.Direction
            switch request {
            case .start(let conversation, let kind):
                response = try await model.startCall(in: conversation, kind: kind)
                direction = response.call.createdByAccountId == model.account?.accountId
                    ? .outgoing
                    : .incoming
            case .join(let call, _):
                response = try await model.joinCall(call)
                direction = .incoming
            }

            guard self.pendingSystemStart?.callUUID == action.callUUID else {
                action.fail()
                let didRollback: Bool
                switch request {
                case .start:
                    didRollback = await model.endCall(response.call)
                case .join:
                    didRollback = await model.leaveCall(response.call)
                }
                if !didRollback {
                    retainUnreconciledCall(
                        response,
                        request: request,
                        direction: direction
                    )
                }
                return
            }

            media = response.media
            activeCallUUID = action.callUUID
            activeCall = KordiCallPresentation(
                call: response.call,
                conversation: request.conversation,
                direction: direction,
                startsWithVideo: request.startsWithVideo,
                isPreview: false
            )
            isCameraEnabled = request.startsWithVideo
            isMicrophoneEnabled = true
            phase = response.call.state == .ringing ? .ringing : .connecting
            isCallScreenPresented = true
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: startedAt)
            action.fulfill(withDateStarted: startedAt)
            actionWasFulfilled = true
            try await connectCurrentRoom()
            completePendingSystemStart(callUUID: action.callUUID, result: .success(()))
        } catch {
            guard self.pendingSystemStart?.callUUID == action.callUUID else { return }
            logSystemStartFailure(error, stage: "cloud-or-media")
            if actionWasFulfilled {
                provider.reportCall(with: action.callUUID, endedAt: Date(), reason: .failed)
            } else {
                action.fail()
            }
            let didConfirmTerminalState: Bool
            if let activeCall {
                let finishAction: FinishAction = activeCall.direction == .outgoing ? .end : .leave
                didConfirmTerminalState = await finish(
                    activeCall: activeCall,
                    action: finishAction
                )
            } else {
                activeCallUUID = nil
                await cleanUpRoom()
                didConfirmTerminalState = true
            }
            phase = .failed(didConfirmTerminalState
                ? systemStartMessage(for: error)
                : "Could not update the call state. Check your connection and try again.")
            completePendingSystemStart(callUUID: action.callUUID, result: .failure(error))
        }
    }

    private func retainUnreconciledCall(
        _ response: CloudCallSessionResponse,
        request: PendingSystemStartRequest,
        direction: KordiCallPresentation.Direction
    ) {
        media = response.media
        activeCallUUID = nil
        activeCall = KordiCallPresentation(
            call: response.call,
            conversation: request.conversation,
            direction: direction,
            startsWithVideo: request.startsWithVideo,
            isPreview: false
        )
        isCameraEnabled = request.startsWithVideo
        isMicrophoneEnabled = true
        isCallScreenPresented = true
        phase = .failed("Could not update the call state. Check your connection and try again.")
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
            action.fulfill()
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
            } catch {
                phase = .failed(error.localizedDescription)
                provider.reportCall(with: action.callUUID, endedAt: Date(), reason: .failed)
                kordiCallLogger.error("Incoming call media connection failed before CallKit acknowledgement")
                await finish(activeCall: activeCall, action: hasJoined ? .leave : .decline)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor [weak self] in
            guard let self else {
                action.fulfill()
                return
            }
            if pendingSystemStart?.callUUID == action.callUUID {
                cancelPendingSystemStart(with: .cancelled)
                if activeCall == nil {
                    action.fulfill()
                    return
                }
            }
            guard let activeCall else {
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
            guard let callAction = action as? CXCallAction else { return }
            if pendingSystemStart?.callUUID == callAction.callUUID {
                let error = SystemStartFailure.timedOut
                logSystemStartFailure(error, stage: "timeout")
                provider.reportCall(with: callAction.callUUID, endedAt: Date(), reason: .failed)
                cancelPendingSystemStart(with: error)
                if let activeCall {
                    let finishAction: FinishAction = activeCall.direction == .outgoing ? .end : .leave
                    guard await finish(activeCall: activeCall, action: finishAction) else { return }
                }
                phase = .failed(error.localizedDescription)
                return
            }
            guard let activeCall else {
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

    nonisolated func room(
        _ room: Room,
        participant: RemoteParticipant,
        didSubscribeTrack publication: RemoteTrackPublication
    ) {
        if let videoTrack = publication.track as? VideoTrack {
            videoTrack.add(delegate: self)
        }
        kordiCallLogger.notice("LiveKit remote track subscription completed")
    }

    nonisolated func room(
        _ room: Room,
        participant: RemoteParticipant,
        didFailToSubscribeTrackWithSid trackSid: Track.Sid,
        error: LiveKitError
    ) {
        kordiCallLogger.error(
            "LiveKit remote track subscription failed, code: \(error.code, privacy: .public)"
        )
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

extension KordiCallCoordinator: TrackDelegate {
    nonisolated func track(_ track: VideoTrack, didUpdateDimensions dimensions: Dimensions?) {
        guard dimensions != nil else { return }
        kordiCallLogger.notice("LiveKit first remote video frame rendered")
    }
}
