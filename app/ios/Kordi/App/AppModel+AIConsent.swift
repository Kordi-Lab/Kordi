import Foundation

/// Client side of the AI data-sharing choice (owner decision A1). The server
/// refuses AI work only for `declined`; the app also asks while the choice is
/// `unset`, before the first AI action.
enum AIConsentGate {
    enum Decision: Equatable {
        case proceed
        /// Show the consent sheet.
        case ask
        /// Show "AI models are off".
        case explainDeclined
    }

    /// No known status (not loaded yet, or a server without the setting) proceeds;
    /// the server still enforces a declined choice.
    static func decision(for status: AIConsentStatus?) -> Decision {
        switch status {
        case nil, .allowed?: .proceed
        case .unset?: .ask
        case .declined?: .explainDeclined
        }
    }

    /// Whether a message starts AI work: agent conversations and background
    /// sessions, an @mentioned agent, and the System agent's support session.
    static func messageRequestsAI(
        isAgentConversation: Bool,
        isSubsession: Bool,
        mentionsAgent: Bool,
        routesToSupportAgent: Bool
    ) -> Bool {
        isAgentConversation || isSubsession || mentionsAgent || routesToSupportAgent
    }

    /// The server's refusal for an account that declined.
    static func isConsentRequired(_ error: Error) -> Bool {
        (error as? CloudAPIError)?.code == "ai_consent_required"
    }

    /// Settings › Privacy shows the switch on unless the account declined or never chose.
    static func sharesWithAI(_ status: AIConsentStatus?) -> Bool {
        switch status {
        case nil, .allowed?: true
        case .unset?, .declined?: false
        }
    }
}

/// Contract copy for the AI choice.
enum AIConsentCopy {
    static let title = "Kordi uses AI models"
    static let body = "Agents, the System agent, Digest and Grounding send the messages, files and calendar details they work on to AI providers such as OpenAI and Google."
    static let declinedTitle = "AI models are off"
    static let declinedMessage = "Allow in Settings › Privacy to use agents."
    static let toggle = "Share with AI models"
    static let caption = "OpenAI and Google process what agents work on."
}

extension AppModel {
    /// True when AI work may start now. Otherwise asks for the choice: the
    /// consent sheet while undecided, "AI models are off" after a decline.
    @discardableResult
    func requireAIConsent() -> Bool {
        switch AIConsentGate.decision(for: aiConsent?.status) {
        case .proceed:
            return true
        case .ask:
            AIConsentPresenter.presentConsent(model: self)
            return false
        case .explainDeclined:
            AIConsentPresenter.presentDeclined(model: self)
            return false
        }
    }

    /// The send gate: only messages that start an agent need the choice.
    func allowsAIRequest(for conversation: ConversationSummary, mention: ComposerMentionTarget?) -> Bool {
        let requestsAI = AIConsentGate.messageRequestsAI(
            isAgentConversation: conversation.kind == .agent,
            isSubsession: conversation.subsessionId != nil,
            mentionsAgent: mention?.kind == .agent,
            routesToSupportAgent: conversation.representsKordiSupport
                && KordiSupportIdentity.isSystemAgentSession(conversation.sessionId)
        )
        return !requestsAI || requireAIConsent()
    }

    /// Loads the choice after sign-in and asks once while it is undecided.
    func refreshAIConsent(promptIfUnset: Bool = false) async {
        if isPreviewMode {
            if aiConsent == nil {
                let asks = ProcessInfo.processInfo.arguments.contains("--preview-consent")
                aiConsent = CloudAIConsent(status: asks ? .unset : .allowed)
            }
        } else {
            guard let (api, token, accountId) = try? projectContext() else { return }
            do {
                let consent = try await api.aiConsent(token: token)
                guard account?.accountId == accountId else { return }
                aiConsent = consent
            } catch {
                // An older server has no setting; keep what is known.
                return
            }
        }
        guard promptIfUnset, aiConsent?.status == .unset,
              let accountId = account?.accountId,
              AIConsentPresenter.shouldPromptAfterSignIn(accountId: accountId) else { return }
        // Let the signed-in screen settle before the sheet rises over it.
        try? await Task.sleep(for: .milliseconds(450))
        guard aiConsent?.status == .unset, account?.accountId == accountId else { return }
        AIConsentPresenter.presentConsent(model: self)
    }

    /// Saves the choice. Returns an error message to show, or nil.
    func setAIConsent(_ status: AIConsentStatus) async -> String? {
        if isPreviewMode {
            aiConsent = CloudAIConsent(status: status, decidedAt: ISO8601DateFormatter().string(from: Date()))
            return nil
        }
        guard let (api, token, accountId) = try? projectContext() else {
            return "Sign in to change this."
        }
        do {
            let consent = try await api.updateAIConsent(token: token, status: status)
            guard account?.accountId == accountId else { return nil }
            aiConsent = consent
            return nil
        } catch {
            return userFacing(error, fallback: "Could not save your choice. Try again.")
        }
    }

    /// A 403 `ai_consent_required`: the account declined, perhaps on another
    /// device. The alert shows once; later attempts stop at the client gate.
    func noteAIConsentRequired() {
        let alreadyDeclined = aiConsent?.status == .declined
        aiConsent = CloudAIConsent(status: .declined, decidedAt: aiConsent?.decidedAt)
        if !alreadyDeclined { AIConsentPresenter.presentDeclined(model: self) }
    }
}
