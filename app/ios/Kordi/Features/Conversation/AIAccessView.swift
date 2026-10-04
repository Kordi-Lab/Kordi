import SwiftUI
import UIKit

/// "AI access" for a group or direct conversation: what agents asked here can
/// see, the member's own opt-out, and PiP. Groups show every setting; direct
/// conversations show only "Don't let AI use my messages".
struct AIAccessView: View {
    @EnvironmentObject private var model: AppModel
    let conversation: ConversationSummary

    private enum LoadState: Equatable {
        case loading
        case loaded
        case unavailable
        case failed
    }

    @State private var access: CloudAIAccess?
    @State private var loadState = LoadState.loading
    @State private var isUpdating = false
    @State private var errorText: String?
    @State private var isConfirmingRecent = false
    @State private var loadAttempt = 0

    private var isGroup: Bool { conversation.kind == .group }

    var body: some View {
        Form {
            switch loadState {
            case .loading:
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text(AIAccessCopy.loading).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            case .unavailable:
                Section { Text(AIAccessCopy.unavailable).foregroundStyle(.secondary) }
            case .failed:
                Section {
                    Text(AIAccessCopy.loadFailed).foregroundStyle(.secondary)
                    Button("Try Again") { loadAttempt += 1 }
                        .frame(minHeight: 44)
                }
            case .loaded:
                if let access { settings(access) }
            }
        }
        .navigationTitle(AIAccessCopy.title)
        .navigationBarTitleDisplayMode(.inline)
        .disabled(isUpdating)
        .task(id: loadAttempt) { await load() }
        .confirmationDialog(
            AIAccessCopy.confirmTitle,
            isPresented: $isConfirmingRecent,
            titleVisibility: .visible
        ) {
            Button(AIAccessCopy.confirmAllow) { apply(.historyScope(.recent)) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(AIAccessCopy.confirmBody)
        }
    }

    @ViewBuilder
    private func settings(_ access: CloudAIAccess) -> some View {
        if let errorText {
            Section {
                Label(errorText, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Error: \(errorText)")
            }
        }
        if isGroup { scopeSection(access) }
        optOutSection(access)
        if isGroup, let pip = access.pip, pip.available { pipSection(pip, canManage: access.viewerCanManage) }
        if isGroup {
            Section {
                EmptyView()
            } footer: {
                Text(AIAccessCopy.footer)
            }
        }
    }

    @ViewBuilder
    private func scopeSection(_ access: CloudAIAccess) -> some View {
        Section {
            if access.viewerCanManage {
                Picker(AIAccessCopy.scopeLabel, selection: Binding(
                    get: { access.historyScope },
                    set: { requestScope($0, current: access.historyScope) }
                )) {
                    ForEach(CloudAIHistoryScope.allCases) { scope in
                        Text(AIAccessCopy.scopeTitle(scope)).tag(scope)
                    }
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .accessibilityHint(AIAccessCopy.scopeHelp(access.historyScope))
            } else {
                LabeledContent(AIAccessCopy.scopeLabel) {
                    Text(AIAccessCopy.scopeTitle(access.historyScope))
                        .multilineTextAlignment(.trailing)
                }
                .accessibilityElement(children: .combine)
                Text(AIAccessCopy.nonManager)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(AIAccessCopy.scopeLabel)
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Text(AIAccessCopy.scopeHelp(access.historyScope))
                Text(AIAccessCopy.scopeNote)
            }
        }
    }

    private func optOutSection(_ access: CloudAIAccess) -> some View {
        Section {
            Toggle(AIAccessCopy.optOutLabel, isOn: Binding(
                get: { access.viewerExcluded },
                set: { apply(.excludeMyMessages($0)) }
            ))
            .frame(minHeight: 44)
            .accessibilityHint(AIAccessCopy.optOutHelp)
            LabeledContent(AIAccessCopy.turnedOnBy) {
                Text(turnedOnBy(access))
                    .multilineTextAlignment(.trailing)
            }
            .accessibilityElement(children: .combine)
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                Text(AIAccessCopy.optOutHelp)
                Text(AIAccessCopy.optOutFootnote)
            }
        }
    }

    private func pipSection(_ pip: CloudPipAccess, canManage: Bool) -> some View {
        Section {
            Toggle(AIAccessCopy.pipLabel, isOn: Binding(
                get: { pip.enabled },
                set: { apply(.pipEnabled($0)) }
            ))
            .frame(minHeight: 44)
            .disabled(!canManage)
            .accessibilityHint(AIAccessCopy.pipHelp(provider: pip.providerLabel))
            if !canManage {
                Text(AIAccessCopy.nonManager)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } footer: {
            Text(AIAccessCopy.pipHelp(provider: pip.providerLabel))
        }
    }

    private var memberNames: [String: String] {
        var names: [String: String] = [:]
        for participant in conversation.groupParticipants {
            if let name = participant.displayName.nonEmpty { names[participant.accountId] = name }
        }
        if conversation.kind == .person, let peer = conversation.peerAccountId.nonEmpty {
            names[peer] = names[peer] ?? conversation.displayName
        }
        return names
    }

    private func turnedOnBy(_ access: CloudAIAccess) -> String {
        AIAccessCopy.turnedOnByText(
            excludedMemberIds: access.excludedMemberIds,
            names: memberNames,
            currentAccountId: model.account?.accountId
        )
    }

    private func requestScope(_ scope: CloudAIHistoryScope, current: CloudAIHistoryScope) {
        guard scope != current else { return }
        if scope == .recent {
            isConfirmingRecent = true
        } else {
            apply(.historyScope(scope))
        }
    }

    private func load() async {
        if access == nil { loadState = .loading }
        do {
            let loaded = try await model.loadAIAccess(for: conversation)
            guard !Task.isCancelled else { return }
            access = loaded
            loadState = loaded == nil ? .unavailable : .loaded
        } catch let error as CloudAPIError where error.statusCode == 404 {
            // No synced conversation exists yet, so there is nothing to set.
            guard !Task.isCancelled else { return }
            loadState = access == nil ? .unavailable : .loaded
        } catch {
            guard !Task.isCancelled, !CloudTransportErrorPolicy.isCancellation(error) else { return }
            loadState = access == nil ? .failed : .loaded
        }
    }

    private func apply(_ change: CloudAIAccessChange) {
        guard !isUpdating else { return }
        isUpdating = true
        errorText = nil
        Task { @MainActor in
            defer { isUpdating = false }
            switch await model.updateAIAccess(change, for: conversation) {
            case .success(let updated):
                if let updated { access = updated } else { await load() }
            case .failure(let failure):
                errorText = failure.message
                UIAccessibility.post(notification: .announcement, argument: failure.message)
            }
        }
    }
}
