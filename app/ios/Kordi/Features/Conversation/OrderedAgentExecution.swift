import SwiftUI

/// One disclosure per adjacent tool group, with assistant commentary left in place.
struct OrderedAgentExecution: View {
    let execution: AgentExecutionSnapshot
    var stopRequestID: String?
    let conversationID: String
    let onExpansionChange: (Bool) -> Void

    var body: some View {
        let groups = execution.orderedGroups
        VStack(alignment: .leading, spacing: 8) {
            ForEach(groups) { group in
                if let text = group.text {
                    MarkdownMessageContent(text: text)
                } else {
                    activity(group, isTail: group.id == groups.last?.id)
                }
            }
            if groups.last?.text != nil && (!execution.completed || execution.startedAtMs != nil || execution.thinkingText?.isEmpty == false) {
                activity(AgentTurnContentGroup(id: "turn-status"), isTail: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func activity(_ group: AgentTurnContentGroup, isTail: Bool) -> some View {
        AgentActivityGroup(
            group: group, execution: execution, isTail: isTail,
            stopRequestID: isTail ? stopRequestID : nil,
            conversationID: conversationID, onExpansionChange: onExpansionChange
        )
    }
}

struct AgentActivityGroup: View {
    @Environment(\.conversationRowContentState) private var rowContentState
    @State private var localExpanded = false
    let group: AgentTurnContentGroup
    let execution: AgentExecutionSnapshot
    let isTail: Bool
    let stopRequestID: String?
    let conversationID: String
    let onExpansionChange: (Bool) -> Void

    var messageID: String? = nil

    private var expanded: Bool { rowContentState?.expandedActivityGroups.contains(group.id) ?? localExpanded }
    private var legacySteps: [AgentExecutionStep] { group.id == "legacy" && group.tools.isEmpty ? execution.steps : [] }
    private var expandable: Bool { !group.tools.isEmpty || group.unavailable > 0 || !legacySteps.isEmpty || (isTail && execution.thinkingText?.isEmpty == false) }
    private var active: Bool { isTail && !execution.completed }
    private var label: String {
        if active || (isTail && group.tools.isEmpty && group.unavailable == 0) {
            return execution.completed && execution.phase == .complete && execution.startedAtMs == nil ? "Activity" : execution.progressLabel
        }
        let count = group.tools.count + group.unavailable
        return "Used \(count) \(count == 1 ? "tool" : "tools")"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Button(action: toggle) {
                    HStack(spacing: 7) {
                        if active { AgentExecutionActivityIndicator(accessibilityStatus: label) }
                        Text(label)
                        if isTail {
                            if execution.completed {
                                if let elapsed = execution.elapsedLabel(at: .now) { Text(elapsed).monospacedDigit() }
                            } else {
                                TimelineView(.periodic(from: .now, by: 1)) { context in
                                    if let elapsed = execution.elapsedLabel(at: context.date) { Text(elapsed).monospacedDigit() }
                                }
                            }
                        }
                        if expandable {
                            Image(systemName: "chevron.right")
                                .rotationEffect(.degrees(expanded ? 90 : 0))
                                .accessibilityHidden(true)
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!expandable)
                .accessibilityValue(expandable ? (expanded ? "Expanded" : "Collapsed") : "")
                #if DEBUG
                .background {
                    if let messageID, ConversationMotionProbeRegistry.enabled {
                        ConversationMotionProbe(id: "trajectory-header:\(messageID)", trajectoryToggle: toggle)
                    }
                }
                #endif
                if let stopRequestID { AgentRequestStopButton(conversationId: conversationID, requestMessageId: stopRequestID) }
            }
            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if isTail, let thinking = execution.thinkingText, !thinking.isEmpty {
                        DisclosureGroup("Reasoning") {
                            MarkdownMessageContent(text: thinking, density: .compact).foregroundStyle(.secondary)
                        }.font(.caption)
                    }
                    ForEach(legacySteps) { step in
                        Text(step.label).font(.caption).foregroundStyle(step.state == .failed ? Color.red : Color.secondary)
                    }
                    ForEach(group.tools) { tool in
                        DisclosureGroup {
                            Text([tool.arguments, tool.liveOutput, tool.resultText ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n"))
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } label: {
                            Text(tool.detail ?? tool.name)
                                .font(.caption)
                                .foregroundStyle(tool.state == .failed ? Color.red : Color.secondary)
                        }
                    }
                    if group.unavailable > 0 { Text("Some earlier tool details are unavailable.").font(.caption).foregroundStyle(.secondary) }
                }
                .padding(.leading, 12)
                .fixedSize(horizontal: false, vertical: true)
                #if DEBUG
                .background {
                    if let messageID, ConversationMotionProbeRegistry.enabled {
                        ConversationMotionProbe(id: "trajectory-details:\(messageID)")
                    }
                }
                #endif
            }
        }
    }

    private func toggle() {
        let next = !expanded
        onExpansionChange(next)
        localExpanded = next
        if let rowContentState {
            if next { rowContentState.expandedActivityGroups.insert(group.id) }
            else { rowContentState.expandedActivityGroups.remove(group.id) }
        }
    }
}
