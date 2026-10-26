import SwiftUI

struct ConnectorDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let definition: ConnectorDefinition
    @ObservedObject var store: ConnectorsStore

    @State private var consent: ConnectorConsent?
    @State private var showsDisconnect = false

    private var state: ConnectorState? { store.states[definition.providerId] }
    private var busy: Bool { store.busyProviderId == definition.providerId }

    var body: some View {
        SettingsPage {
            header
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
        .connectorConsent($consent, store: store)
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

    /// Larger logo, the name, and one short grey state.
    private var header: some View {
        HStack(spacing: SettingsMetrics.iconSpacing) {
            ConnectorLogo(providerId: definition.providerId, size: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(definition.name)
                    .font(SettingsFont.headerTitle)
                    .accessibilityAddTraits(.isHeader)
                Text(ConnectorsModel.detailState(definition: definition, state: state))
                    .font(SettingsFont.subtitle)
                    .foregroundStyle(.secondary)
                if definition.experimental {
                    Text("Experimental, read-only, best effort.")
                        .font(SettingsFont.subtitle)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var primaryAction: some View {
        switch state?.status ?? .notConnected {
        case .connected:
            EmptyView()
        case .needsReauth:
            prominentAction("Sign in again", accessibilityLabel: "Sign in to \(definition.name) again") {
                consent = .connect(definition, reauth: true)
            }
        case .permissionMissing:
            prominentAction("Check again", accessibilityLabel: "Check \(definition.name) permission again") {
                Task {
                    await store.perform(definition.providerId, fallback: "Could not update this connector. Try again.") {
                        try await store.client.recheckPermission(definition.providerId)
                    }
                }
            }
        case .notConnected:
            prominentAction("Connect", accessibilityLabel: "Connect \(definition.name)") {
                consent = .connect(definition, reauth: false)
            }
        }
    }

    /// The one action of a connector that is not connected, as a filled button.
    private func prominentAction(
        _ title: String,
        accessibilityLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Group {
                if busy {
                    ProgressView()
                } else {
                    Text(title)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(busy)
        .padding(.top, 12)
        .padding(.bottom, 4)
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
}

/// A consent step: the connection, which grants read and act together for a
/// service, or the act grant when a provider returned read-only access.
struct ConnectorConsent: Identifiable {
    enum Kind { case connect, grant }

    let kind: Kind
    let definition: ConnectorDefinition
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
                definition: definition,
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
            definition: definition,
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
            definition: definition,
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

/// Presents the consent step and runs the connect or act grant it confirms.
private struct ConnectorConsentPresenter: ViewModifier {
    @Binding var consent: ConnectorConsent?
    @ObservedObject var store: ConnectorsStore
    @State private var busy = false

    func body(content: Content) -> some View {
        content.sheet(item: $consent) { consent in
            ConnectorConsentSheet(consent: consent, busy: busy) {
                Task { await confirm(consent) }
            } onCancel: {
                self.consent = nil
            }
            .interactiveDismissDisabled(busy)
        }
    }

    private func confirm(_ consent: ConnectorConsent) async {
        busy = true
        defer {
            busy = false
            self.consent = nil
        }
        switch consent.kind {
        case .connect:
            _ = await store.connect(consent.definition)
        case .grant:
            _ = await store.grantAct(consent.definition)
        }
    }
}

extension View {
    func connectorConsent(_ consent: Binding<ConnectorConsent?>, store: ConnectorsStore) -> some View {
        modifier(ConnectorConsentPresenter(consent: consent, store: store))
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
                        .font(SettingsFont.rowTitle)
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(consent.scopes) { scope in
                            Label(scope.label, systemImage: scope.systemImage)
                                .font(SettingsFont.rowTitle)
                        }
                    }
                    if let note = consent.note {
                        Text(note)
                            .font(SettingsFont.subtitle)
                            .foregroundStyle(.secondary)
                    }
                    if busy {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text(consent.waitingText)
                                .font(SettingsFont.subtitle)
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
