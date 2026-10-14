import SwiftUI

struct ConnectorDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let definition: ConnectorDefinition
    @ObservedObject var store: ConnectorsStore

    @State private var consent: ConnectorConsent?
    @State private var consentBusy = false
    @State private var showsDisconnect = false

    private var state: ConnectorState? { store.states[definition.providerId] }
    private var busy: Bool { store.busyProviderId == definition.providerId }

    var body: some View {
        SettingsPage {
            CompactSettingsLabel(
                title: "Status",
                subtitle: definition.experimental ? "Experimental, read-only, best effort." : nil,
                systemImage: ConnectorsModel.systemImage(definition.providerId),
                value: ConnectorsModel.statusLabel(definition: definition, state: state, agents: store.agents)
            )
            .frame(minHeight: SettingsMetrics.rowMinHeight)

            primaryAction

            if let error = store.errorMessage?.nonEmpty {
                SettingsErrorLabel(error)
            }

            if let state, state.status == .connected {
                connectedSections(state)
            }
        }
        .navigationTitle(definition.name)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { store.errorMessage = nil }
        .sheet(item: $consent) { consent in
            ConnectorConsentSheet(consent: consent, busy: consentBusy) {
                Task { await confirm(consent) }
            } onCancel: {
                self.consent = nil
            }
            .interactiveDismissDisabled(consentBusy)
        }
        .confirmationDialog(
            "Disconnect \(definition.name)?",
            isPresented: $showsDisconnect,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                Task {
                    if await store.disconnect(definition) { dismiss() }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(ConnectorsModel.disconnectConsequences(definition).joined(separator: "\n"))
        }
    }

    @ViewBuilder
    private var primaryAction: some View {
        switch state?.status ?? .notConnected {
        case .connected:
            EmptyView()
        case .needsReauth:
            actionRow("Sign in again", systemImage: "key", opensSheet: true, accessibilityLabel: "Sign in to \(definition.name) again") {
                consent = .connect(definition, reauth: true)
            }
        case .permissionMissing:
            actionRow(busy ? "Checking…" : "Check again", systemImage: "arrow.clockwise", opensSheet: false, accessibilityLabel: "Check \(definition.name) permission again") {
                Task {
                    await store.perform(definition.providerId, fallback: "Could not update this connector. Try again.") {
                        try await store.client.recheckPermission(definition.providerId)
                    }
                }
            }
        case .notConnected:
            actionRow("Connect", systemImage: "link", opensSheet: true, accessibilityLabel: "Connect \(definition.name)") {
                consent = .connect(definition, reauth: false)
            }
        }
    }

    /// The one action of a connector that is not connected, as a full-width row.
    private func actionRow(
        _ title: String,
        systemImage: String,
        opensSheet: Bool,
        accessibilityLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            SettingsRow {
                CompactSettingsLabel(title: title, systemImage: systemImage)
            } trailing: {
                if busy {
                    ProgressView()
                } else if opensSheet {
                    SettingsChevron()
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private func connectedSections(_ state: ConnectorState) -> some View {
        SettingsDivider()
        SettingsSectionTitle("Access")
        ForEach(ConnectorsModel.allowedScopes(definition: definition, state: state)) { scope in
            CompactSettingsLabel(title: scope.label, systemImage: scope.systemImage)
                .frame(minHeight: SettingsMetrics.textRowMinHeight)
                .accessibilityLabel("Allowed: \(scope.label)")
        }
        if !definition.actScopes.isEmpty {
            Toggle(isOn: actBinding(state)) {
                CompactSettingsLabel(
                    title: "Let my agent act here",
                    // Kept: says what acting allows and that approvals still apply.
                    subtitle: state.actEnabled
                        ? "\(definition.actDescription) Anything on your Ask me before list still waits for your approval."
                        : nil,
                    systemImage: "bolt"
                )
            }
            .frame(minHeight: SettingsMetrics.rowMinHeight)
            .disabled(busy)
            .accessibilityIdentifier("connector-act-toggle")
        }

        if !store.agents.isEmpty {
            SettingsDivider()
            SettingsSectionTitle("Agents")
            ForEach(store.agents) { agent in
                Toggle(isOn: agentBinding(agent, state: state)) {
                    CompactSettingsLabel(
                        title: agent.name,
                        subtitle: agent.isDefault ? "Default agent" : nil,
                        systemImage: "sparkles"
                    )
                }
                .frame(minHeight: SettingsMetrics.rowMinHeight)
                .disabled(busy)
                .accessibilityLabel("Let \(agent.name) use \(definition.name)")
            }
        }

        SettingsDivider()
        SettingsSectionTitle("Activity")
        NavigationLink {
            ConnectorActivityView(definition: definition, client: store.client)
        } label: {
            SettingsRow {
                CompactSettingsLabel(title: "Activity log", systemImage: "list.bullet.rectangle")
            } trailing: {
                SettingsChevron()
            }
        }
        .buttonStyle(.plain)

        SettingsDivider()
        SettingsDestructiveRow("Disconnect") { showsDisconnect = true }
            .disabled(busy)
            .accessibilityLabel("Disconnect \(definition.name)")
    }

    private func actBinding(_ state: ConnectorState) -> Binding<Bool> {
        Binding(
            get: { store.states[definition.providerId]?.actEnabled ?? false },
            set: { enabled in
                guard let current = store.states[definition.providerId] else { return }
                if enabled && definition.kind == .service
                    && !ConnectorsModel.hasGrantedActScopes(definition: definition, state: current) {
                    consent = .grant(definition)
                    return
                }
                Task { await store.setActEnabled(definition, enabled: enabled) }
            }
        )
    }

    private func agentBinding(_ agent: ConnectorAgent, state: ConnectorState) -> Binding<Bool> {
        Binding(
            get: { store.states[definition.providerId]?.agentIds.contains(agent.agentId) ?? false },
            set: { granted in
                Task { await store.setAgentGrant(definition, agent: agent, granted: granted) }
            }
        )
    }

    private func confirm(_ consent: ConnectorConsent) async {
        consentBusy = true
        defer {
            consentBusy = false
            self.consent = nil
        }
        switch consent.kind {
        case .connect:
            _ = await store.connect(definition)
        case .grant:
            _ = await store.grantAct(definition)
        }
    }
}

/// A consent step: the connection, which grants read and act together for a
/// service, or the act grant when a provider returned read-only access.
struct ConnectorConsent: Identifiable {
    enum Kind { case connect, grant }

    let kind: Kind
    let title: String
    let message: String
    let scopes: [ConnectorScope]
    let note: String?
    let cancelTitle: String
    let confirmTitle: String
    let waitingText: String

    var id: String { "\(kind)-\(title)" }

    static func connect(_ definition: ConnectorDefinition, reauth: Bool) -> ConnectorConsent {
        if definition.kind == .service {
            return ConnectorConsent(
                kind: .connect,
                title: reauth ? "Sign in to \(definition.name) again" : "Connect \(definition.name)",
                message: "Kordi asks \(definition.providerName) for the access your agent needs to read and act here. You can turn acting off at any time from this page.",
                scopes: ConnectorsModel.connectScopes(definition),
                note: nil,
                cancelTitle: "Cancel",
                confirmTitle: "Continue to \(definition.providerName)",
                waitingText: "Waiting for \(definition.providerName)…"
            )
        }
        return ConnectorConsent(
            kind: .connect,
            title: "Allow access to \(definition.name)",
            message: "iOS will ask you to allow Kordi to read \(definition.name). Your agent only sees results, never your whole library.",
            scopes: definition.readScopes,
            note: nil,
            cancelTitle: "Cancel",
            confirmTitle: "Allow access",
            waitingText: "Waiting for iOS…"
        )
    }

    static func grant(_ definition: ConnectorDefinition) -> ConnectorConsent {
        ConnectorConsent(
            kind: .grant,
            title: "Let your agent act in \(definition.name)",
            message: "\(definition.providerName) did not grant this when you connected. Your agent will be able to:",
            scopes: definition.actScopes,
            note: "It still asks you first for anything on your Ask me before list, and background runs never get these tools.",
            cancelTitle: "Not now",
            confirmTitle: definition.kind == .service ? "Continue to \(definition.providerName)" : "Allow",
            waitingText: "Waiting for \(definition.providerName)…"
        )
    }
}

private struct ConnectorConsentSheet: View {
    let consent: ConnectorConsent
    let busy: Bool
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(consent.title)
                        .font(.title3.weight(.semibold))
                        .accessibilityAddTraits(.isHeader)
                    Text(consent.message)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(consent.scopes) { scope in
                            Label(scope.label, systemImage: scope.systemImage)
                                .font(.subheadline)
                        }
                    }
                    if let note = consent.note {
                        Text(note)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    if busy {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text(consent.waitingText)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    Button(action: onConfirm) {
                        Text(consent.confirmTitle).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    Button(consent.cancelTitle, action: onCancel)
                        .controlSize(.large)
                }
                .disabled(busy)
                .padding(.horizontal, 20)
                .padding(.bottom, 12)
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

extension ConnectorScope {
    /// Outline icon shared by the consent sheet and the Access rows.
    var systemImage: String { group == .act ? "hand.tap" : "eye" }
}

extension ConnectorsModel {
    /// Scopes the detail screen lists under Access: what was granted to read
    /// (or everything the connector reads, when the server reports none), plus
    /// the granted act scopes while acting is on.
    static func allowedScopes(definition: ConnectorDefinition, state: ConnectorState) -> [ConnectorScope] {
        let grantedRead = definition.readScopes.filter { state.grantedScopeIds.contains($0.id) }
        let grantedAct = definition.actScopes.filter { state.grantedScopeIds.contains($0.id) }
        return (grantedRead.isEmpty ? definition.readScopes : grantedRead) + (state.actEnabled ? grantedAct : [])
    }
}
