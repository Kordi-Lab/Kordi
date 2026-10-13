import Foundation

/// Someone the comment composer can mention.
struct DocumentMentionCandidate: Hashable, Identifiable {
    let name: String
    let isAgent: Bool
    /// The text written after `@`.
    let mention: String

    var id: String { (isAgent ? "agent:" : "person:") + mention }

    init(name: String, isAgent: Bool, mention: String? = nil) {
        self.name = name
        self.isAgent = isAgent
        self.mention = mention ?? name
    }
}

enum DocumentMentionCandidates {
    /// The viewer's own agents, then the session's other agents, then its
    /// people. A public reader sees only the document's agent, and nobody
    /// sees agents while `viewerCan.askAgent` is off.
    static func list(
        document: DocumentResponse,
        ownAccountId: String?,
        targets: [ComposerMentionTarget],
        fallbackPeople: [String] = []
    ) -> [DocumentMentionCandidate] {
        let documentAgent = document.viewerCan.askAgent ? document.agent?.displayName.nonEmpty : nil
        guard document.viewer != .public else {
            return documentAgent.map { [DocumentMentionCandidate(name: $0, isAgent: true)] } ?? []
        }

        var candidates: [DocumentMentionCandidate] = []
        if document.viewerCan.askAgent {
            let agents = targets.filter { $0.kind == .agent }
            var own = agents.filter { $0.accountId == ownAccountId }.map(agentCandidate)
            var others = agents.filter { $0.accountId != ownAccountId }.map(agentCandidate)
            if let documentAgent, !(own + others).contains(where: { same($0.mention, documentAgent) }) {
                let candidate = DocumentMentionCandidate(name: documentAgent, isAgent: true)
                if document.viewer == .owner { own.insert(candidate, at: 0) } else { others.insert(candidate, at: 0) }
            }
            candidates = unique(own + disambiguated(others, against: own, targets: agents))
        }

        let targetPeople = targets.filter { $0.kind == .person }.map(\.displayName)
        let people = targetPeople.isEmpty ? fallbackPeople : targetPeople
        var seen = Set<String>()
        for name in people where !name.isEmpty && seen.insert(name.lowercased()).inserted {
            candidates.append(DocumentMentionCandidate(name: name, isAgent: false))
        }
        return candidates
    }

    /// The names of the agents in a candidate list, for the working line.
    static func agentNames(_ candidates: [DocumentMentionCandidate]) -> [String] {
        candidates.filter(\.isAgent).map(\.mention)
    }

    /// "Alex's Kordi" is mentioned as `@Kordi`: the server matches the
    /// agent's own name, optionally followed by its owner's.
    private static func agentCandidate(_ target: ComposerMentionTarget) -> DocumentMentionCandidate {
        let name = target.displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        let bare = name.replacingOccurrences(
            of: #"^(?:my|your)\s+|^[^'’]+['’]s\s+"#, with: "", options: [.regularExpression, .caseInsensitive]
        )
        return DocumentMentionCandidate(name: name, isAgent: true, mention: bare.nonEmpty ?? name)
    }

    /// Another member's agent that shares a name with an earlier agent is
    /// mentioned with its owner's name.
    private static func disambiguated(
        _ others: [DocumentMentionCandidate],
        against own: [DocumentMentionCandidate],
        targets: [ComposerMentionTarget]
    ) -> [DocumentMentionCandidate] {
        var taken = own.map(\.mention)
        return others.map { candidate in
            defer { taken.append(candidate.mention) }
            guard taken.contains(where: { same($0, candidate.mention) }),
                  let owner = targets.first(where: { $0.displayName == candidate.name })?.ownerName?.nonEmpty else {
                return candidate
            }
            return DocumentMentionCandidate(name: candidate.name, isAgent: true, mention: "\(candidate.mention) \(owner)")
        }
    }

    private static func unique(_ candidates: [DocumentMentionCandidate]) -> [DocumentMentionCandidate] {
        var seen = Set<String>()
        return candidates.filter { seen.insert($0.mention.lowercased()).inserted }
    }

    private static func same(_ lhs: String, _ rhs: String) -> Bool {
        lhs.caseInsensitiveCompare(rhs) == .orderedSame
    }
}
