import Foundation

enum MessageAuthor: String, Codable, Hashable {
    case me
    case person
    case agent
}

enum MessageDeliveryState: String, Codable, Hashable {
    case sending
    case sent
    case delivered
    case read
    case failed
    case cancelled

    var label: String {
        switch self {
        case .sending: "Sending"
        case .sent: "Sent"
        case .delivered: "Delivered"
        case .read: "Read"
        case .failed: "Failed to send"
        case .cancelled: "Canceled"
        }
    }
}

struct AgentExecutionStep: Identifiable, Codable, Hashable {
    enum State: String, Codable, Hashable {
        case pending
        case running
        case complete
        case failed
    }

    let id: String
    let label: String
    let state: State
}

struct AgentExecutionTool: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let status: String
    let arguments: String
    let liveOutput: String
    let resultText: String?
    let detail: String?
    let toolLayer: String?
    let isError: Bool

    var state: AgentExecutionStep.State {
        if isError { return .failed }
        switch status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "complete", "completed", "success", "succeeded", "done": return .complete
        case "failed", "error", "cancelled", "canceled": return .failed
        case "queued", "pending": return .pending
        default: return .running
        }
    }
}

struct BackgroundAgentSession: Identifiable, Codable, Hashable {
    enum State: String, Codable, Hashable {
        case running
        case done
        case failed
        case stopped

        var label: String {
            switch self {
            case .running: "Running"
            case .done: "Done"
            case .failed: "Failed"
            case .stopped: "Stopped"
            }
        }

        var agentActivity: AgentActivity {
            switch self {
            case .running: .replying
            case .failed: .failed
            case .done, .stopped: .ready
            }
        }

        init?(wireValue: String) {
            switch wireValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "running", "processing", "queued", "pending": self = .running
            case "done", "complete", "completed", "success", "succeeded": self = .done
            case "failed", "error", "crashed": self = .failed
            case "stopped", "cancelled", "canceled", "interrupted": self = .stopped
            default: return nil
            }
        }
    }

    struct Wire: Codable {
        let sessionId: String
        let turnId: String?
        let title: String
        let status: String
    }

    let sessionId: String
    let turnId: String?
    let title: String
    let state: State

    var id: String { sessionId }

    init?(wire: Wire) {
        guard let sessionId = Self.cleanIdentifier(wire.sessionId),
              let state = State(wireValue: wire.status) else { return nil }
        let title = wire.title
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        guard !title.isEmpty else { return nil }
        self.sessionId = sessionId
        turnId = wire.turnId.flatMap(Self.cleanIdentifier)
        self.title = String(title.prefix(80))
        self.state = state
    }

    static func validated(_ wires: [Wire]) -> [BackgroundAgentSession] {
        var seen = Set<String>()
        return wires.compactMap { wire in
            guard let session = BackgroundAgentSession(wire: wire),
                  seen.insert(session.sessionId).inserted else { return nil }
            return session
        }
        .prefix(4)
        .map { $0 }
    }

    static func fromTaskOperatorTools(_ tools: [AgentExecutionTool]) -> [BackgroundAgentSession] {
        let prefix = "Background session: "
        let wires = tools.compactMap { tool -> Wire? in
            guard !tool.isError,
                  tool.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "task_operator",
                  let line = tool.resultText?
                    .split(whereSeparator: \.isNewline)
                    .map(String.init)
                    .first(where: { $0.hasPrefix(prefix) }),
                  let data = String(line.dropFirst(prefix.count)).data(using: .utf8) else {
                return nil
            }
            return try? JSONDecoder().decode(Wire.self, from: data)
        }
        return validated(wires)
    }

    func resolvedState(in conversations: [ConversationSummary]) -> State {
        guard let conversation = conversations.first(where: { $0.sessionId == sessionId }),
              let activity = conversation.agentActivity else { return state }
        return switch activity {
        case .ready: .done
        case .replying: .running
        case .failed: .failed
        }
    }

    func destination(
        from source: ConversationSummary,
        conversations: [ConversationSummary],
        ownAccountId: String,
        ownDisplayName: String,
        createdAt: Date
    ) -> ConversationSummary {
        if let existing = conversations.first(where: { $0.sessionId == sessionId }) {
            return existing
        }
        return ConversationSummary(
            id: "agent-session:\(sessionId)",
            kind: .agent,
            peerAccountId: ownAccountId,
            agentId: source.agentId ?? CanonicalAvatarSystem.defaultAgentId,
            ownerDisplayName: ownDisplayName,
            displayName: title,
            lastMessage: "Background session",
            lastActivityAt: createdAt,
            unreadCount: 0,
            avatarSource: source.kind == .agent ? source.avatarSource : nil,
            agentActivity: state.agentActivity,
            sessionId: sessionId,
            agentDisplayName: source.agentDisplayName ?? "My Kordi",
            forkedFromSessionId: source.sessionId
        )
    }

    private static func cleanIdentifier(_ value: String) -> String? {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              normalized.utf8.count <= 256,
              normalized.unicodeScalars.allSatisfy({
                  !CharacterSet.controlCharacters.contains($0)
              }) else { return nil }
        return normalized
    }
}

struct BackgroundAgentSessionPresentation: Identifiable, Hashable {
    let session: BackgroundAgentSession
    let state: BackgroundAgentSession.State

    var id: String { session.id }
}

struct AgentExecutionSnapshot: Codable, Hashable {
    enum Phase: String, Codable, Hashable {
        case preparing
        case analyzing
        case usingTool = "using-tool"
        case writing
        case complete
        case failed
        case cancelled
    }

    let phase: Phase
    let summary: String
    let steps: [AgentExecutionStep]
    let thinkingText: String?
    let tools: [AgentExecutionTool]?
    let startedAtMs: Double?
    let updatedAtMs: Double
    let completed: Bool

    init(
        phase: Phase,
        summary: String,
        steps: [AgentExecutionStep],
        thinkingText: String? = nil,
        tools: [AgentExecutionTool]? = nil,
        startedAtMs: Double?,
        updatedAtMs: Double,
        completed: Bool
    ) {
        self.phase = phase
        self.summary = summary
        self.steps = steps
        self.thinkingText = thinkingText
        self.tools = tools
        self.startedAtMs = startedAtMs
        self.updatedAtMs = updatedAtMs
        self.completed = completed
    }
}

struct AgentExecutionTimelinePresentation: Equatable {
    let planningStep: AgentExecutionStep?
    let toolSteps: [AgentExecutionStep]
    let responseStep: AgentExecutionStep?
    let thinkingText: String?
    let tools: [AgentExecutionTool]
    let failedToolCount: Int
    let headline: String
    let completionLabel: String?

    var hasExpandableContent: Bool {
        planningStep != nil
            || !toolSteps.isEmpty
            || thinkingText != nil
            || !tools.isEmpty
            || responseStep != nil
            || failedToolCount > 0
    }

    var activeOutputStatus: String? {
        if let tool = tools.last(where: { $0.state == .running }) {
            return tool.detail?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? tool.name.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        }
        if let step = toolSteps.last(where: { $0.state == .running }) {
            return step.label.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        }
        if let thinking = Self.firstOutputLine(thinkingText) {
            return thinking
        }
        if let tool = tools.last {
            return tool.detail?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? tool.name.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        }
        if let step = toolSteps.last {
            return step.label.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        }
        return planningStep?.label.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            ?? responseStep?.label.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
    }

    init(execution: AgentExecutionSnapshot) {
        planningStep = execution.steps.first { $0.id == "analysis" }
        toolSteps = execution.steps.filter { $0.id.hasPrefix("tool:") }
        responseStep = execution.steps.first { $0.id == "response" }
        thinkingText = execution.thinkingText?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        tools = execution.tools ?? []
        failedToolCount = toolSteps.filter { $0.state == .failed }.count
        headline = execution.summary
        if execution.completed, let startedAtMs = execution.startedAtMs {
            let elapsedSeconds = max(
                0,
                Int((execution.updatedAtMs - startedAtMs) / 1_000)
            )
            completionLabel = "Worked for \(elapsedSeconds)s"
        } else {
            completionLabel = nil
        }
    }

    private static func firstOutputLine(_ text: String?) -> String? {
        guard var line = text?
            .split(whereSeparator: \.isNewline)
            .map({ $0.trimmingCharacters(in: .whitespacesAndNewlines) })
            .first(where: { !$0.isEmpty }) else { return nil }
        if line.hasPrefix("- ") || line.hasPrefix("* ") {
            line.removeFirst(2)
        }
        return line.nonEmpty
    }
}

enum ChatAttachmentKind: String, Codable, Hashable {
    case image
    case file
}

enum ChatAttachmentSubtype: String, Codable, Hashable {
    case meme
}

struct ChatAttachment: Identifiable, Codable, Hashable {
    let attachmentId: String
    let name: String
    let kind: ChatAttachmentKind
    let subtype: ChatAttachmentSubtype?
    let altText: String?
    let mimeType: String?
    let sizeBytes: Int64?
    let previewURL: String?

    var id: String { attachmentId }

    init(
        attachmentId: String,
        name: String,
        kind: ChatAttachmentKind,
        subtype: ChatAttachmentSubtype? = nil,
        altText: String? = nil,
        mimeType: String?,
        sizeBytes: Int64?,
        previewURL: String?
    ) {
        self.attachmentId = attachmentId
        self.name = name
        self.kind = kind
        self.subtype = subtype
        self.altText = altText
        self.mimeType = mimeType
        self.sizeBytes = sizeBytes
        self.previewURL = previewURL
    }

    var formatLabel: String {
        if let extensionName = URL(fileURLWithPath: name).pathExtension.nonEmpty {
            return extensionName.uppercased()
        }
        if let subtype = mimeType?.split(separator: "/").last?.trimmingCharacters(in: .whitespacesAndNewlines),
           !subtype.isEmpty {
            return subtype.uppercased()
        }
        return kind == .image ? "IMAGE" : "FILE"
    }

    var sizeLabel: String? {
        guard let sizeBytes, sizeBytes >= 0 else { return nil }
        return ByteCountFormatter.string(fromByteCount: sizeBytes, countStyle: .file)
    }
}

struct MessageActionSource: Codable, Hashable, Identifiable {
    let sourceSessionId: String
    let sourceMessageId: String
    let sourceMessageKind: String?
    let senderLabel: String
    let textPreview: String
    let mentions: [MessageMention]?
    let attachmentCount: Int
    let createdAtMs: Double?
    let timeLabel: String?

    var id: String { "\(sourceSessionId):\(sourceMessageId)" }

    init(
        sourceSessionId: String,
        sourceMessageId: String,
        sourceMessageKind: String? = "text",
        senderLabel: String,
        textPreview: String,
        mentions: [MessageMention]? = nil,
        attachmentCount: Int,
        createdAtMs: Double? = nil,
        timeLabel: String? = nil
    ) {
        self.sourceSessionId = sourceSessionId
        self.sourceMessageId = sourceMessageId
        self.sourceMessageKind = sourceMessageKind
        self.senderLabel = senderLabel
        self.textPreview = textPreview
        self.mentions = mentions
        self.attachmentCount = attachmentCount
        self.createdAtMs = createdAtMs
        self.timeLabel = timeLabel
    }
}

struct MessageActionMetadata: Codable, Hashable {
    let schemaVersion: Int
    let kind: String
    let source: MessageActionSource

    static func quote(_ source: MessageActionSource) -> MessageActionMetadata {
        MessageActionMetadata(schemaVersion: 1, kind: "quote", source: source)
    }

    static func forward(_ source: MessageActionSource) -> MessageActionMetadata {
        MessageActionMetadata(schemaVersion: 1, kind: "forward", source: source)
    }

    var replyToMessageId: String? {
        kind == "quote" ? source.sourceMessageId : nil
    }
}

struct PendingAttachment: Identifiable, Hashable, @unchecked Sendable {
    let id: String
    let name: String
    let kind: ChatAttachmentKind
    var subtype: ChatAttachmentSubtype?
    var altText: String?
    var memeRightsConfirmed: Bool
    let mimeType: String?
    let data: Data
    let previewURL: String?

    init(
        id: String,
        name: String,
        kind: ChatAttachmentKind,
        subtype: ChatAttachmentSubtype? = nil,
        altText: String? = nil,
        memeRightsConfirmed: Bool = false,
        mimeType: String?,
        data: Data,
        previewURL: String?
    ) {
        self.id = id
        self.name = name
        self.kind = kind
        self.subtype = subtype
        self.altText = altText
        self.memeRightsConfirmed = memeRightsConfirmed
        self.mimeType = mimeType
        self.data = data
        self.previewURL = previewURL
    }

    var sizeBytes: Int64 { Int64(data.count) }

    var optimisticAttachment: ChatAttachment {
        ChatAttachment(
            attachmentId: "pending:\(id)",
            name: name,
            kind: kind,
            subtype: subtype,
            altText: altText,
            mimeType: mimeType,
            sizeBytes: sizeBytes,
            previewURL: previewURL
        )
    }
}

enum MemeAttachmentPolicy {
    static let maximumAltTextCharacters = 500
    static let imageMIMETypes: Set<String> = [
        "image/gif",
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/webp",
    ]
    static let imageExtensions: Set<String> = ["gif", "jpeg", "jpg", "png", "webp"]

    static func isSupportedImage(_ attachment: PendingAttachment) -> Bool {
        guard attachment.kind == .image else { return false }
        if let mimeType = attachment.mimeType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
           !mimeType.isEmpty {
            return imageMIMETypes.contains(mimeType)
        }
        return imageExtensions.contains(URL(fileURLWithPath: attachment.name).pathExtension.lowercased())
    }

    static func draftError(
        for attachments: [PendingAttachment],
        requiresRightsConfirmation: Bool = true
    ) -> String? {
        for attachment in attachments where attachment.subtype == .meme {
            guard isSupportedImage(attachment) else {
                return "Choose a PNG, JPEG, GIF, or WebP image for \(attachment.name)."
            }
            let altText = attachment.altText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !altText.isEmpty else {
                return "Add alt text for \(attachment.name) before sending."
            }
            guard altText.count <= maximumAltTextCharacters else {
                return "Shorten the alt text for \(attachment.name) to \(maximumAltTextCharacters) characters or fewer."
            }
            if requiresRightsConfirmation, !attachment.memeRightsConfirmed {
                return "Confirm that you have permission or another legal right to share \(attachment.name)."
            }
        }
        return nil
    }
}

enum ComposerMentionKind: String, Hashable {
    case person
    case agent
}

struct MessageMention: Codable, Hashable {
    let label: String
    let targetKind: String?
    let targetIdentityId: String?
    let startUtf16: Int?
    let lengthUtf16: Int?
    let displayText: String?
    let sourceHostId: String?
    let nodeId: String?
    let humanId: String?
    let agentId: String?
    let displayLabel: String?

    init(
        label: String,
        targetKind: String? = nil,
        targetIdentityId: String? = nil,
        startUtf16: Int? = nil,
        lengthUtf16: Int? = nil,
        displayText: String? = nil,
        sourceHostId: String? = nil,
        nodeId: String? = nil,
        humanId: String? = nil,
        agentId: String? = nil,
        displayLabel: String? = nil
    ) {
        self.label = label
        self.targetKind = targetKind
        self.targetIdentityId = targetIdentityId
        self.startUtf16 = startUtf16
        self.lengthUtf16 = lengthUtf16
        self.displayText = displayText
        self.sourceHostId = sourceHostId
        self.nodeId = nodeId
        self.humanId = humanId
        self.agentId = agentId
        self.displayLabel = displayLabel
    }

    var kind: ComposerMentionKind? {
        targetKind.flatMap(ComposerMentionKind.init(rawValue:))
    }

    private var hasValidIdentity: Bool {
        guard let targetIdentityId = targetIdentityId?.nonEmpty, let kind else { return false }
        return switch kind {
        case .person: targetIdentityId.hasPrefix("human:")
        case .agent: targetIdentityId.hasPrefix("agent:")
        }
    }

    init(target: ComposerMentionTarget, text: String, range: Range<String.Index>) {
        let nsRange = NSRange(range, in: text)
        label = target.displayName
        targetKind = target.kind.rawValue
        targetIdentityId = target.kind == .person
            ? "human:\(target.accountId)"
            : target.id
        startUtf16 = nsRange.location
        lengthUtf16 = nsRange.length
        displayText = String(text[range])
        sourceHostId = nil
        nodeId = target.accountId
        humanId = target.accountId
        agentId = target.agentId
        displayLabel = target.displayName
    }

    static func rebased(_ mentions: [MessageMention], in text: String) -> [MessageMention] {
        let source = text as NSString
        var occupied: [NSRange] = []
        return mentions.prefix(32).compactMap { mention in
            let label = mention.label.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !label.isEmpty, label.count <= 256 else { return nil }
            if let start = mention.startUtf16,
               let length = mention.lengthUtf16,
               start >= 0,
               length > 0,
               start + length <= source.length,
               let displayText = mention.displayText,
               displayText.hasPrefix("@"),
               length == (displayText as NSString).length,
               source.substring(with: NSRange(location: start, length: length)) == displayText,
               mention.hasValidIdentity {
                let range = NSRange(location: start, length: length)
                guard !occupied.contains(where: { NSIntersectionRange($0, range).length > 0 }) else { return nil }
                occupied.append(range)
                return mention
            }

            let aliases = [
                mention.displayText,
                mention.displayLabel.map { "@\($0)" },
                "@\(label)",
            ].compactMap(\.self).filter { !$0.isEmpty }
            for alias in aliases {
                var searchRange = NSRange(location: 0, length: source.length)
                while searchRange.length > 0 {
                    let range = source.range(
                        of: alias,
                        options: [.caseInsensitive, .diacriticInsensitive],
                        range: searchRange
                    )
                    guard range.location != NSNotFound else { break }
                    if !occupied.contains(where: { NSIntersectionRange($0, range).length > 0 }) {
                        occupied.append(range)
                        return MessageMention(
                            label: label,
                            targetKind: mention.targetKind,
                            targetIdentityId: mention.targetIdentityId,
                            startUtf16: range.location,
                            lengthUtf16: range.length,
                            displayText: source.substring(with: range),
                            sourceHostId: mention.sourceHostId,
                            nodeId: mention.nodeId,
                            humanId: mention.humanId,
                            agentId: mention.agentId,
                            displayLabel: mention.displayLabel
                        )
                    }
                    let next = NSMaxRange(range)
                    searchRange = NSRange(location: next, length: source.length - next)
                }
            }
            return nil
        }
    }
}

struct ComposerMentionTarget: Identifiable, Hashable {
    let id: String
    let displayName: String
    let kind: ComposerMentionKind
    let accountId: String
    let agentId: String?
    let ownerName: String?
    let avatarSource: String?

    var mentionText: String { "@\(displayName)" }
}

enum ChatCallActivityEvent: String, Codable, Hashable {
    case started
    case ended
}

struct ChatCallActivity: Hashable {
    let event: ChatCallActivityEvent
    let callId: String?

    init?(messageKind: String?) {
        guard let messageKind = messageKind?.trimmingCharacters(in: .whitespacesAndNewlines),
              !messageKind.isEmpty else { return nil }
        if messageKind == "call" {
            event = .started
            callId = nil
            return
        }
        let components = messageKind.split(
            separator: ".",
            maxSplits: 2,
            omittingEmptySubsequences: false
        )
        guard components.count == 3,
              components[0] == "call",
              let parsedEvent = ChatCallActivityEvent(rawValue: String(components[1])),
              !components[2].isEmpty else { return nil }
        event = parsedEvent
        callId = String(components[2])
    }

    static func messageKind(for event: ChatCallActivityEvent, callId: String) -> String {
        "call.\(event.rawValue).\(callId.lowercased())"
    }

    func matchesActiveCall(_ call: CloudCall?) -> Bool {
        guard event == .started, let call, call.state != .ended else { return false }
        return callId == nil || callId == call.id
    }
}

enum ChatCallActivityTimeline {
    static func collapsingStatuses(in messages: [ChatMessage]) -> [ChatMessage] {
        var result: [ChatMessage] = []
        var indexByCallID: [String: Int] = [:]

        for message in messages {
            guard let activity = message.callActivity, let callID = activity.callId else {
                result.append(message)
                continue
            }
            guard let existingIndex = indexByCallID[callID] else {
                indexByCallID[callID] = result.count
                result.append(message)
                continue
            }

            let existing = result[existingIndex]
            guard activity.event == .ended else {
                if existing.callActivity?.event != .ended {
                    result[existingIndex] = message
                }
                continue
            }
            var ended = existing
            ended.messageKind = message.messageKind
            ended.text = endedText(
                message.text,
                startedText: existing.text,
                startedAt: existing.createdAt,
                endedAt: message.createdAt
            )
            result[existingIndex] = ended
        }
        return result
    }

    static func durationString(from start: Date, to end: Date) -> String {
        let totalSeconds = max(0, Int(end.timeIntervalSince(start)))
        let hours = totalSeconds / 3_600
        let minutes = (totalSeconds % 3_600) / 60
        let seconds = totalSeconds % 60
        if hours > 0 {
            return String(format: "%02d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%02d:%02d", minutes, seconds)
    }

    private static func endedText(
        _ endedText: String,
        startedText: String,
        startedAt: Date,
        endedAt: Date
    ) -> String {
        if endedText.localizedCaseInsensitiveContains("duration") {
            return endedText
        }
        let source = endedText.isEmpty ? startedText : endedText
        let noun: String
        if source.localizedCaseInsensitiveContains("voice call") {
            noun = "voice call"
        } else if source.localizedCaseInsensitiveContains("video chat") {
            noun = "video chat"
        } else {
            noun = "video call"
        }
        return "The \(noun) ended. Duration \(durationString(from: startedAt, to: endedAt))."
    }
}

struct MessageReaction: Identifiable, Codable, Hashable {
    let value: String
    var accountIds: [String]

    var id: String { value }

    func includes(accountId: String?) -> Bool {
        accountId.map(accountIds.contains) ?? false
    }
}

struct ChatMessage: Identifiable, Codable, Hashable {
    static let agentModelChangeMessageKind = "agent-model-change"
    static let groupMemberJoinMessageKind = "group-member-joined"
    private static let agentModelChangePrefix = "Switched model to "
    private static let agentRuntimeRouteNoticePrefix = "Model: "
    private static let agentRuntimeRouteNoticeSeparator = " · Thinking effort: "

    static func modelFromAgentModelChangeNotice(_ text: String) -> String? {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.hasPrefix(agentModelChangePrefix) {
            return String(normalized.dropFirst(agentModelChangePrefix.count)).nonEmpty
        }
        guard normalized.hasPrefix(agentRuntimeRouteNoticePrefix) else { return nil }
        let summary = String(normalized.dropFirst(agentRuntimeRouteNoticePrefix.count))
        return summary.components(separatedBy: agentRuntimeRouteNoticeSeparator).first?.nonEmpty
    }

    static func runtimeRouteChangeNotice(model: String, thinking: String?) -> String {
        "\(agentRuntimeRouteNoticePrefix)\(model)\(agentRuntimeRouteNoticeSeparator)\(thinkingEffortLabel(thinking))"
    }

    private static func thinkingEffortLabel(_ thinking: String?) -> String {
        let value = thinking?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "default"
        let normalized = value
            .lowercased()
            .replacingOccurrences(of: "_", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: " ", with: "")
        let label = switch normalized {
        case "off": "Off"
        case "default", "auto", "thinking": "Default"
        case "minimal": "Minimal"
        case "low": "Low"
        case "medium": "Medium"
        case "high": "High"
        case "xhigh", "extrahigh": "Extra High"
        case "max", "maximum": "Max"
        default: value
        }
        return label
    }

    let id: String
    let clientMessageId: String?
    let conversationId: String
    let conversationSequence: Int64?
    let author: MessageAuthor
    let authorName: String
    var text: String
    let createdAt: Date
    var deliveryState: MessageDeliveryState
    var errorMessage: String?
    var requestMessageId: String?
    var readByCount: Int?
    var readByAccountIds: [String]
    var attachments: [ChatAttachment]
    var replyToMessageId: String?
    var reactionTargetMessageId: String?
    var messageAction: MessageActionMetadata?
    var messageKind: String?
    var agentExecution: AgentExecutionSnapshot?
    var backgroundAgentSessions: [BackgroundAgentSession]
    var mentions: [MessageMention]
    var reactions: [MessageReaction]

    var callActivity: ChatCallActivity? {
        ChatCallActivity(messageKind: messageKind)
    }

    var isAgentModelChangeNotice: Bool {
        messageKind == Self.agentModelChangeMessageKind
    }

    var isGroupMemberJoinNotice: Bool {
        messageKind == Self.groupMemberJoinMessageKind
    }

    var isSystemNotice: Bool {
        isAgentModelChangeNotice
            || isGroupMemberJoinNotice
            || callActivity != nil
    }

    static func timelinePrecedes(_ left: ChatMessage, _ right: ChatMessage) -> Bool {
        if let leftSequence = left.conversationSequence,
           let rightSequence = right.conversationSequence,
           leftSequence != rightSequence {
            return leftSequence < rightSequence
        }
        if left.createdAt != right.createdAt { return left.createdAt < right.createdAt }
        return left.id < right.id
    }

    init(
        id: String,
        clientMessageId: String? = nil,
        conversationId: String,
        conversationSequence: Int64? = nil,
        author: MessageAuthor,
        authorName: String,
        text: String,
        createdAt: Date,
        deliveryState: MessageDeliveryState,
        errorMessage: String?,
        requestMessageId: String?,
        readByCount: Int? = nil,
        readByAccountIds: [String] = [],
        attachments: [ChatAttachment] = [],
        replyToMessageId: String? = nil,
        reactionTargetMessageId: String? = nil,
        messageAction: MessageActionMetadata? = nil,
        mentions: [MessageMention] = [],
        messageKind: String? = nil,
        agentExecution: AgentExecutionSnapshot? = nil,
        backgroundAgentSessions: [BackgroundAgentSession] = [],
        reactions: [MessageReaction] = []
    ) {
        self.id = id
        self.clientMessageId = clientMessageId
        self.conversationId = conversationId
        self.conversationSequence = conversationSequence
        self.author = author
        self.authorName = authorName
        self.text = text
        self.createdAt = createdAt
        self.deliveryState = deliveryState
        self.errorMessage = errorMessage
        self.requestMessageId = requestMessageId
        self.readByCount = readByCount
        self.readByAccountIds = readByAccountIds
        self.attachments = attachments
        self.replyToMessageId = replyToMessageId
        self.reactionTargetMessageId = reactionTargetMessageId
        self.messageAction = messageAction
        self.messageKind = messageKind
        self.agentExecution = agentExecution
        self.backgroundAgentSessions = backgroundAgentSessions
        self.mentions = mentions
        self.reactions = reactions
    }

    var actionSource: MessageActionSource {
        actionSource(sessionId: conversationId)
    }

    func actionSource(sessionId: String) -> MessageActionSource {
        let normalized = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let preview = normalized.count <= 220
            ? normalized
            : String(normalized.prefix(219)).trimmingCharacters(in: .whitespacesAndNewlines) + "…"
        let previewMentions = MessageMention.rebased(mentions, in: preview)
        return MessageActionSource(
            sourceSessionId: sessionId,
            sourceMessageId: id,
            sourceMessageKind: author == .agent ? "agent-turn" : "text",
            senderLabel: author == .me ? "You" : authorName,
            textPreview: preview,
            mentions: previewMentions.isEmpty ? nil : previewMentions,
            attachmentCount: attachments.count,
            createdAtMs: createdAt.timeIntervalSince1970 * 1_000,
            timeLabel: createdAt.formatted(.dateTime.hour().minute())
        )
    }

    /// Re-forwarding a forwarded message keeps the original attribution instead
    /// of turning the current sender into the source of the forwarded content.
    func forwardSource(sessionId: String) -> MessageActionSource {
        if let action = messageAction, action.kind == "forward" {
            return action.source
        }
        return actionSource(sessionId: sessionId)
    }

    enum CodingKeys: String, CodingKey {
        case id, clientMessageId, conversationId, conversationSequence, author, authorName, text, createdAt, deliveryState, errorMessage
        case requestMessageId, readByCount, readByAccountIds, attachments, replyToMessageId, reactionTargetMessageId, messageAction
        case messageKind
        case agentExecution
        case backgroundAgentSessions
        case mentions
        case reactions
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        clientMessageId = try container.decodeIfPresent(String.self, forKey: .clientMessageId)
        conversationId = try container.decode(String.self, forKey: .conversationId)
        conversationSequence = try container.decodeIfPresent(Int64.self, forKey: .conversationSequence)
        author = try container.decode(MessageAuthor.self, forKey: .author)
        authorName = try container.decode(String.self, forKey: .authorName)
        text = try container.decode(String.self, forKey: .text)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        deliveryState = try container.decode(MessageDeliveryState.self, forKey: .deliveryState)
        errorMessage = try container.decodeIfPresent(String.self, forKey: .errorMessage)
        requestMessageId = try container.decodeIfPresent(String.self, forKey: .requestMessageId)
        readByCount = try container.decodeIfPresent(Int.self, forKey: .readByCount)
        readByAccountIds = try container.decodeIfPresent([String].self, forKey: .readByAccountIds) ?? []
        attachments = try container.decodeIfPresent([ChatAttachment].self, forKey: .attachments) ?? []
        replyToMessageId = try container.decodeIfPresent(String.self, forKey: .replyToMessageId)
        reactionTargetMessageId = try container.decodeIfPresent(
            String.self,
            forKey: .reactionTargetMessageId
        )
        messageAction = try container.decodeIfPresent(MessageActionMetadata.self, forKey: .messageAction)
        messageKind = try container.decodeIfPresent(String.self, forKey: .messageKind)
        agentExecution = try container.decodeIfPresent(
            AgentExecutionSnapshot.self,
            forKey: .agentExecution
        )
        backgroundAgentSessions = try container.decodeIfPresent(
            [BackgroundAgentSession].self,
            forKey: .backgroundAgentSessions
        ) ?? []
        mentions = try container.decodeIfPresent([MessageMention].self, forKey: .mentions) ?? []
        reactions = try container.decodeIfPresent([MessageReaction].self, forKey: .reactions) ?? []
    }
}
