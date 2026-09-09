import Foundation

/// The same human group request contract used by desktop and server admission.
struct GroupAgentTarget: Codable, Hashable {
    let ownerAccountId: String
    let agentId: String

    private static func clean(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private static func normalized(_ value: String) -> String {
        String(String.UnicodeScalarView(value.precomposedStringWithCompatibilityMapping.unicodeScalars.filter {
            CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0)
        })).lowercased()
    }

    private static func tokens(_ text: String) -> [String] {
        // This constant expression is covered by the cross-platform contract fixtures.
        let pattern = try! NSRegularExpression(pattern: #"(?:^|\s)@(my[ \t]+kordi(?=$|[\s:;,.!?—-])|[\p{L}\p{N}._'’-]+)"#, options: .caseInsensitive)
        let source = text as NSString
        return pattern.matches(in: text, range: NSRange(location: 0, length: source.length)).map {
            source.substring(with: $0.range(at: 1))
        }
    }

    private static func target(agent: String, owner: String, sender: String, participants: [CloudGroupParticipant]) -> Self? {
        guard !owner.isEmpty, participants.contains(where: { $0.accountId == owner }) else { return nil }
        let canonical = "cloud-agent:\(owner)"
        let agent = agent == "cloud-self:\(owner)" || (agent == "cloud-local-agent" && owner == sender) ? canonical : agent
        guard agent == canonical || agent.hasPrefix("cloud_agent_") else { return nil }
        return Self(ownerAccountId: owner, agentId: agent)
    }

    private static func mentionTarget(_ mention: MessageMention, message: CloudGroupMessagePayload, participants: [CloudGroupParticipant]) -> Self? {
        guard ["", "cloud"].contains(clean(mention.sourceHostId)) else { return nil }
        let identity = clean(mention.targetIdentityId)
        let identityAgent: String
        if identity.hasPrefix("agent:cloud-agent:cloud-agent:") || identity.hasPrefix("agent:cloud-agent:cloud_agent_") {
            identityAgent = String(identity.dropFirst("agent:cloud-agent:".count))
        } else {
            identityAgent = identity.hasPrefix("agent:") ? String(identity.dropFirst("agent:".count)) : ""
        }
        let agent = clean(mention.agentId).isEmpty ? identityAgent : clean(mention.agentId)
        let inferredOwner = agent.hasPrefix("cloud-agent:") ? String(agent.dropFirst("cloud-agent:".count))
            : participants.first(where: { $0.agentId == agent || $0.accountId == agent || "cloud:\($0.accountId)" == agent })?.accountId ?? ""
        let owner = [clean(mention.humanId), clean(mention.nodeId), inferredOwner].first(where: { !$0.isEmpty }) ?? ""
        func canonical(_ id: String) -> String {
            !owner.isEmpty && (id == owner || id == "cloud:\(owner)") ? "cloud-agent:\(owner)" : id
        }
        let canonicalAgent = canonical(agent)
        guard identity.isEmpty || (!identityAgent.isEmpty && canonical(identityAgent) == canonicalAgent) else { return nil }
        if mention.startUtf16 != nil || mention.lengthUtf16 != nil {
            let source = message.text as NSString
            guard let start = mention.startUtf16, let length = mention.lengthUtf16,
                  start >= 0, length > 0, start <= source.length, length <= source.length - start,
                  let display = mention.displayText, display.hasPrefix("@"), display.utf16.count == length,
                  source.substring(with: NSRange(location: start, length: length)) == display else { return nil }
        } else {
            guard !mention.label.isEmpty, tokens(message.text).contains(where: { normalized($0) == normalized(mention.label) }) else { return nil }
        }
        return target(agent: canonicalAgent, owner: owner, sender: message.senderAccountId, participants: participants)
    }

    static func resolve(_ message: CloudGroupMessagePayload, participants: [CloudGroupParticipant]) -> Self? {
        guard message.senderKind != "agent", message.forkSnapshot != true, message.messageAction?.kind != "forward" else { return nil }
        let sender = clean(message.senderAccountId)
        guard participants.contains(where: { $0.accountId == sender }) else { return nil }
        let agent = clean(message.targetCloudAgentId)
        let owner = clean(message.targetCloudAgentOwnerAccountId)
        let explicit = target(agent: agent, owner: owner, sender: sender, participants: participants)
        guard (agent.isEmpty && owner.isEmpty) || explicit != nil else { return nil }
        let mentions = message.mentions ?? []
        let agentMentions = mentions.filter { $0.targetKind == "agent" }
        if !agentMentions.isEmpty {
            let targets = agentMentions.compactMap { mentionTarget($0, message: message, participants: participants) }
            guard targets.count == agentMentions.count, Set(targets).count == 1, let selected = targets.first,
                  explicit == nil || explicit == selected else { return nil }
            return selected
        }
        if let explicit { return explicit }
        let source = message.text as NSString
        let legacyText = NSMutableString(string: message.text)
        for mention in mentions {
            guard let start = mention.startUtf16, let length = mention.lengthUtf16,
                  start >= 0, length > 0, start <= source.length, length <= source.length - start,
                  source.substring(with: NSRange(location: start, length: length)) == mention.displayText else { return nil }
            legacyText.replaceCharacters(in: NSRange(location: start, length: length), with: String(repeating: " ", count: length))
        }
        var candidates = Set<Self>()
        for token in tokens(legacyText as String) {
            let handle = normalized(token)
            if ["kordi", "mykordi"].contains(handle) {
                candidates.insert(Self(ownerAccountId: sender, agentId: "cloud-agent:\(sender)"))
                continue
            }
            let matches = participants.filter {
                let person = normalized($0.displayName)
                let name = normalized(clean($0.agentDisplayName).isEmpty ? "Kordi" : clean($0.agentDisplayName))
                return [name + person, "kordi" + person, person + "kordi", person + "skordi"].contains(handle)
            }
            guard matches.count <= 1 else { return nil }
            if let participant = matches.first {
                guard let selected = target(agent: participant.agentId?.nonEmpty ?? "cloud-agent:\(participant.accountId)", owner: participant.accountId, sender: sender, participants: participants) else { return nil }
                candidates.insert(selected)
            }
        }
        return candidates.count == 1 ? candidates.first : nil
    }
}
