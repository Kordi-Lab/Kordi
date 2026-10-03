import Foundation

// Copy and labels for AI access, actions that need a person, "About this
// reply", and AI marks on messages. Kept free of SwiftUI so tests can check
// every string.

enum AIAccessCopy {
    static let title = "AI access"
    static let rowTitle = "AI access"
    static let scopeLabel = "What agents can see"
    static let mentionsLabel = "Only messages sent to them"
    static let recentLabel = "Recent messages"
    static let mentionsHelp = "When someone asks an agent here, it gets that message, the message it replies to or quotes, and that person's earlier requests to it with its replies. It can't read the rest of this conversation."
    static let recentHelp = "When someone asks an agent here, it can also read recent messages and search this conversation's history."
    static let scopeNote = "This covers agents that people ask here. To keep your own messages away from other people's AI, use “Don't let AI use my messages.”"
    static let nonManager = "Only group owners and admins can change this."
    static let confirmTitle = "Let agents read recent messages?"
    static let confirmBody = "When someone asks an agent in this group, it will be able to read recent messages and search the group's history. Everyone here will see a notice. Messages from people who turned on “Don't let AI use my messages” stay left out."
    static let confirmAllow = "Allow"
    static let optOutLabel = "Don't let AI use my messages"
    static let optOutHelp = "When this is on, other people's agents, PiP, and other members' digests and private assistants leave out the messages you send here. Messages you send to an agent yourself, including in its task threads, are still used for that request. Everyone here can see that this is on."
    static let optOutFootnote = "Kordi's servers and up-to-date Kordi apps apply this. It doesn't remove what an AI already received, and people here can still read, copy, or forward your messages."
    static let turnedOnBy = "Turned on by"
    static let noOne = "No one"
    static let pipLabel = "PiP plan helper"
    static let footer = "When you ask someone else's agent here, it works in a workspace kept separate for you. Open “About this reply” on an agent's message to see who runs it and where it ran."
    static let loading = "Loading AI access…"
    static let unavailable = "AI access isn't available for this conversation."
    static let loadFailed = "Couldn't load AI access. Try again."
    static let updateFailed = "Couldn't update AI access. Try again."
    static let pipUnavailable = "PiP isn't available on this server."
    static let createPipLabel = "Add PiP, the plan helper"
    static let createPipFailure = "The group was created, but PiP couldn't be turned on. You can turn it on in AI access."

    static func scopeHelp(_ scope: CloudAIHistoryScope) -> String {
        scope == .recent ? recentHelp : mentionsHelp
    }

    static func scopeTitle(_ scope: CloudAIHistoryScope) -> String {
        scope == .recent ? recentLabel : mentionsLabel
    }

    private static func providerName(_ provider: String?) -> String {
        provider?.nonEmpty ?? "an AI provider"
    }

    static func pipHelp(provider: String?) -> String {
        "PiP reads new messages here to spot plans and keep a plan card up to date. It uses \(providerName(provider)) through Kordi's account. PiP only suggests answers and decisions; people confirm them."
    }

    static func createPipHelp(provider: String?) -> String {
        "PiP reads new messages in this group to help plan events, using \(providerName(provider)) through Kordi's account. You can change this later in AI access."
    }

    /// Inline error text for a failed change, by server error code.
    static func updateErrorText(code: String?) -> String {
        switch code {
        case "PIP_UNAVAILABLE": pipUnavailable
        case "CHAT_FORBIDDEN": nonManager
        default: updateFailed
        }
    }

    /// "Turned on by" names. The signed-in member reads "You".
    static func turnedOnByText(
        excludedMemberIds: [String],
        names: [String: String],
        currentAccountId: String?
    ) -> String {
        guard !excludedMemberIds.isEmpty else { return noOne }
        return excludedMemberIds
            .map { id in id == currentAccountId ? "You" : names[id]?.nonEmpty ?? "A member" }
            .joined(separator: ", ")
    }

    /// Conversations synced through Kordi Cloud that have AI access settings.
    static func supportsAIAccess(sessionId: String) -> Bool {
        sessionId.hasPrefix("session:group:") || sessionId.hasPrefix("session:direct-person:")
    }
}

// MARK: - Actions that need a person

struct PendingAgentActionCopy: Equatable {
    let title: String
    let body: String
    let footnote: String?
    let approveLabel: String
    let declineLabel: String
    /// Spoken names for the two buttons.
    let approveAccessibilityLabel: String
    let declineAccessibilityLabel: String

    static let regionLabel = "Waiting for you"

    private static let dateOnly = try? NSRegularExpression(pattern: #"^\d{4}-\d{2}-\d{2}$"#)

    /// "Fri, Oct 2 · 6:30 PM PDT", or the date alone for a date without a
    /// time, in local time with a time zone label as plan cards show times.
    static func formatTime(_ value: String?, timeZone: TimeZone = .current, locale: Locale = .current) -> String? {
        guard let raw = value?.nonEmpty else { return nil }
        let range = NSRange(raw.startIndex..., in: raw)
        if dateOnly?.firstMatch(in: raw, range: range) != nil {
            var utc = Calendar(identifier: .gregorian)
            utc.timeZone = TimeZone(identifier: "UTC") ?? .gmt
            let parts = raw.split(separator: "-").compactMap { Int($0) }
            guard parts.count == 3,
                  let date = utc.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else {
                return raw
            }
            return date.formatted(
                Date.FormatStyle(locale: locale, calendar: utc, timeZone: utc.timeZone)
                    .weekday(.abbreviated).month(.abbreviated).day()
            )
        }
        guard let date = PlanCard.parseDate(raw) else { return raw }
        let day = date.formatted(
            Date.FormatStyle(locale: locale, timeZone: timeZone).weekday(.abbreviated).month(.abbreviated).day()
        )
        let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, timeZone: timeZone))
        let zone = timeZone.abbreviation(for: date) ?? timeZone.identifier
        return "\(day) · \(time) \(zone)"
    }

    static func calendarWindow(
        startAt: String?,
        endAt: String?,
        timeZone: TimeZone = .current,
        locale: Locale = .current
    ) -> String {
        let start = formatTime(startAt, timeZone: timeZone, locale: locale)
        let end = formatTime(endAt, timeZone: timeZone, locale: locale)
        switch (start, end) {
        case let (start?, end?): return "\(start) – \(end)"
        case let (start?, nil): return "from \(start)"
        case let (nil, end?): return "until \(end)"
        case (nil, nil): return "all dates"
        }
    }

    private static func quoted(_ value: String) -> String { "“\(value)”" }

    /// `nil` for an action this app does not know how to describe.
    static func make(
        for action: CloudPendingAgentAction,
        timeZone: TimeZone = .current,
        locale: Locale = .current
    ) -> PendingAgentActionCopy? {
        guard let kind = action.kind else { return nil }
        let subject = action.subject
        let title = subject.title ?? "this plan"
        let onWhen = formatTime(subject.startAt, timeZone: timeZone, locale: locale).map { " on \($0)" } ?? ""
        let withReason = subject.reason.map { ": \(quoted($0))" } ?? ""
        switch kind {
        case .calendarDisclosure:
            let agent = subject.agentName ?? action.proposedBy.displayName ?? "Your agent"
            let window = calendarWindow(startAt: subject.startAt, endAt: subject.endAt, timeZone: timeZone, locale: locale)
            return PendingAgentActionCopy(
                title: "Share your calendar in this chat?",
                body: "\(agent) wants to read your saved Kordi calendar for \(window) and may summarize it for everyone here.",
                footnote: "If you allow this, \(agent) can read these dates again in this chat for the next 10 minutes.",
                approveLabel: "Allow",
                declineLabel: "Don't allow",
                approveAccessibilityLabel: "Allow sharing your calendar",
                declineAccessibilityLabel: "Don't allow sharing your calendar"
            )
        case .planRSVP:
            let going = subject.rsvp != "no"
            return PendingAgentActionCopy(
                title: going ? "PiP noted you're in" : "PiP noted you can't make it",
                body: "From your message, PiP thinks you \(going ? "can" : "can't") make \(quoted(title))\(onWhen). Confirm so the plan shows your answer.",
                footnote: nil,
                approveLabel: "Confirm",
                declineLabel: "Not right",
                approveAccessibilityLabel: "Confirm your answer for \(title)",
                declineAccessibilityLabel: "Dismiss PiP's answer for \(title)"
            )
        case .planVote:
            let option = subject.optionLabel ?? "this option"
            return PendingAgentActionCopy(
                title: "PiP noted your choice",
                body: "From your message, PiP thinks you prefer \(quoted(option)) for \(quoted(title)). Confirm to add your vote.",
                footnote: nil,
                approveLabel: "Vote",
                declineLabel: "Not right",
                approveAccessibilityLabel: "Vote for \(option)",
                declineAccessibilityLabel: "Dismiss PiP's vote for \(option)"
            )
        case .planConfirm:
            let atLocation = subject.location.map { " at \($0)" } ?? ""
            return PendingAgentActionCopy(
                title: "Confirm this plan?",
                body: "PiP thinks the group settled on \(quoted(title))\(onWhen)\(atLocation). Confirming adds it to the Kordi calendar of everyone who said they're in.",
                footnote: nil,
                approveLabel: "Confirm plan",
                declineLabel: "Not yet",
                approveAccessibilityLabel: "Confirm the plan \(title)",
                declineAccessibilityLabel: "Don't confirm the plan \(title) yet"
            )
        case .planCancel:
            return PendingAgentActionCopy(
                title: "Cancel this plan?",
                body: "PiP thinks \(quoted(title)) is off\(withReason). Canceling removes it from everyone's Kordi calendar.",
                footnote: nil,
                approveLabel: "Cancel plan",
                declineLabel: "Keep plan",
                approveAccessibilityLabel: "Cancel the plan \(title)",
                declineAccessibilityLabel: "Keep the plan \(title)"
            )
        case .planReopen:
            return PendingAgentActionCopy(
                title: "Reopen this plan?",
                body: "PiP thinks \(quoted(title)) may no longer stand\(withReason). Reopening removes it from calendars until someone confirms it again.",
                footnote: nil,
                approveLabel: "Reopen",
                declineLabel: "Keep as is",
                approveAccessibilityLabel: "Reopen the plan \(title)",
                declineAccessibilityLabel: "Keep the plan \(title) as is"
            )
        }
    }

    /// Inline error text for a failed decision, by server error code.
    static func errorText(code: String?) -> String {
        switch code {
        case "plan_changed": "This plan changed. Check the card and try again."
        case "agent_action_closed": "This request is no longer waiting. Ask again if you still need it."
        default: "Couldn't save your answer. Try again."
        }
    }

    /// What VoiceOver announces after a decision is saved.
    static func announcement(for kind: CloudPendingAgentAction.Kind?, decision: CloudAgentActionDecision) -> String {
        if kind == .calendarDisclosure {
            return decision == .approve ? "Calendar sharing allowed." : "Calendar sharing declined."
        }
        return decision == .approve ? "Answer saved." : "Suggestion dismissed."
    }

    /// What VoiceOver announces once when new actions start waiting.
    static func arrivalAnnouncement(count: Int) -> String {
        count == 1 ? "1 request is waiting for you." : "\(count) requests are waiting for you."
    }
}

// MARK: - About this reply

enum AgentReplyDisclosurePresentation {
    static let title = "About this reply"
    static let menuTitle = "About This Reply"
    static let heading = "Written by AI"
    static let footnote = "The model provider received this request and the messages the agent used. The provider's terms decide what it keeps. The AI label comes from the sender's Kordi app; Kordi checks which account sent the message."
    static let loading = "Checking…"
    static let missing = "Details aren't available for this reply."
    static let failed = "Couldn't load details. Try again."

    private static func possessive(_ name: String) -> String { "\(name)'s" }

    /// The rows "About this reply" shows for a reply Kordi described.
    static func rows(
        for disclosure: CloudAgentReplyDisclosure,
        fallbackAgentName: String? = nil,
        fallbackOwnerName: String? = nil
    ) -> [String] {
        let agent = disclosure.agentName ?? fallbackAgentName?.nonEmpty ?? "Agent"
        let owner = disclosure.ownerName ?? fallbackOwnerName?.nonEmpty ?? "the owner"
        let kordiRuns = disclosure.credentials == .kordi
        var rows = ["Agent: \(agent)", "Runs for: \(kordiRuns ? "Kordi" : owner)"]
        if let requester = disclosure.requesterName { rows.append("Requested by: \(requester)") }
        if disclosure.runtime == .ownerDevice {
            rows.append("Ran on: \(possessive(owner)) Mac")
            rows.append("Model: Chosen on \(possessive(owner)) Mac. Kordi isn't told which one.")
            return rows
        }
        if disclosure.runtime == .kordiCloud { rows.append("Ran on: Kordi Cloud") }
        let provider = disclosure.providerLabel ?? disclosure.provider
        switch (disclosure.model, provider) {
        case let (model?, provider?): rows.append("Model: \(model) (\(provider))")
        case let (nil, provider?): rows.append("Model: \(provider)")
        case let (model?, nil): rows.append("Model: \(model)")
        case (nil, nil): rows.append("Model: Not reported")
        }
        if disclosure.credentials != nil {
            rows.append("Model account: \(kordiRuns ? "Kordi's" : possessive(owner))")
        }
        return rows
    }

    /// PiP's rows: who it is and whose account it runs on. PiP answers no
    /// one's request, so there is no "Requested by".
    static func pipRows(providerLabel: String?) -> [String] {
        ["Agent: \(KordiPipIdentity.displayName)", "Runs for: Kordi", pipText(providerLabel: providerLabel)]
    }

    static func pipText(providerLabel: String?) -> String {
        if let providerLabel = providerLabel?.nonEmpty {
            return "PiP is Kordi's built-in plan helper. It runs on \(providerLabel) through Kordi's account."
        }
        return "PiP is Kordi's built-in plan helper. It runs through Kordi's account."
    }

    /// What the disclosure route needs for an agent reply in a conversation
    /// synced through Kordi Cloud, or `nil` when it cannot be looked up.
    static func request(
        for message: ChatMessage,
        sessionId: String
    ) -> CloudAgentReplyDisclosureRequest? {
        guard message.author == .agent,
              AIAccessCopy.supportsAIAccess(sessionId: sessionId),
              let requestId = message.requestMessageId?.nonEmpty ?? message.replyToMessageId?.nonEmpty,
              let ownerAccountId = message.agentOwnerAccountId?.nonEmpty else { return nil }
        let key = message.reactionTargetMessageId?.nonEmpty ?? message.id
        return CloudAgentReplyDisclosureRequest(key: key, requestId: requestId, ownerAccountId: ownerAccountId)
    }

    /// Agent replies that finished, and PiP, offer "About this reply".
    static func offersDisclosure(for message: ChatMessage, isPip: Bool) -> Bool {
        if isPip { return true }
        guard message.author == .agent, !message.isSystemNotice else { return false }
        if let execution = message.agentExecution, !execution.completed { return false }
        return message.deliveryState != .sending && message.deliveryState != .failed
    }
}

// MARK: - AI marks on messages

enum AgentMessageLabels {
    static let chipText = "AI"
    static let chipAccessibilityLabel = "AI agent, about this reply"

    /// PiP posts as a sender that is not a member; its avatar seed (its
    /// account) or, without one, its name marks it. People never match.
    static func isPip(_ message: ChatMessage, avatarSeed: String?) -> Bool {
        message.author == .person && KordiPipIdentity.matches(name: message.authorName, seed: avatarSeed)
    }

    /// The same rule where only the conversation is at hand: in a group, a
    /// message named PiP from someone who is not one of the group's people
    /// is PiP's, as its avatar shows it.
    static func isPip(_ message: ChatMessage, in conversation: ConversationSummary) -> Bool {
        guard message.author == .person, conversation.kind == .group else { return false }
        if let participant = conversation.groupParticipants.first(where: {
            $0.displayName.localizedCaseInsensitiveCompare(message.authorName) == .orderedSame
        }) {
            return KordiPipIdentity.isPip(accountId: participant.accountId)
        }
        return KordiPipIdentity.isPipName(message.authorName)
    }

    static func withAILabel(_ label: String, agentAuthored: Bool) -> String {
        agentAuthored ? "\(label) (AI)" : label
    }

    /// The forwarded header. The AI mark comes from the source message's
    /// kind, which the sender's app declares.
    static func forwardedFrom(_ source: MessageActionSource) -> String {
        "Forwarded from \(withAILabel(source.senderLabel, agentAuthored: source.sourceMessageKind == "agent-turn"))"
    }

    /// A quoted sender, preferring the loaded source message over the kind
    /// the quoting app declared.
    static func quotedSender(
        _ label: String,
        source: MessageActionSource,
        resolvedSource: ChatMessage?,
        resolvedSourceIsPip: Bool = false
    ) -> String {
        let agentAuthored = resolvedSource.map { $0.author == .agent || resolvedSourceIsPip }
            ?? (source.sourceMessageKind == "agent-turn")
        return withAILabel(label, agentAuthored: agentAuthored)
    }

    /// How VoiceOver names the author of a message.
    static func accessibilityAuthor(for message: ChatMessage, isPip: Bool) -> String {
        if isPip { return "\(message.authorName), Kordi's built-in AI agent" }
        guard message.author == .agent else { return message.authorName }
        if let owner = message.senderOwnerName?.nonEmpty {
            return "\(message.authorName), AI agent of \(owner)"
        }
        return "\(message.authorName), AI agent"
    }
}
