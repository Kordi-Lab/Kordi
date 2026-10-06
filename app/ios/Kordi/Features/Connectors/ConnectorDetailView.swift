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
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        CompactSettingsLabel(
                            title: ConnectorsModel.statusLabel(definition: definition, state: state, agents: store.agents),
                            subtitle: definition.experimental
                                ? "\(definition.summary) Experimental, read-only, best effort."
                                : definition.summary,
                            systemImage: ConnectorsModel.systemImage(definition.providerId)
                        )
                        if definition.experimental {
                            ConnectorCapsule(text: "Experimental", tint: .orange)
                        }
                    }
                    primaryAction
                }
            }

            if let error = store.errorMessage?.nonEmpty {
                Section {
                    Label(error, systemImage: "exclamationmark.circle.fill")
                        .foregroundStyle(.red)
                }
            }

            if let state, state.status == .connected {
                connectedSections(state)
            }
        }
        .listStyle(.insetGrouped)
        .environment(\.defaultMinListRowHeight, 44)
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
            actionButton("Sign in again", accessibilityLabel: "Sign in to \(definition.name) again") {
                consent = .connect(definition, reauth: true)
            }
        case .permissionMissing:
            actionButton(busy ? "Checking…" : "Check again", accessibilityLabel: "Check \(definition.name) permission again") {
                Task {
                    await store.perform(definition.providerId, fallback: "Could not update this connector. Try again.") {
                        try await store.client.recheckPermission(definition.providerId)
                    }
                }
            }
        case .notConnected:
            actionButton("Connect", accessibilityLabel: "Connect \(definition.name)") {
                consent = .connect(definition, reauth: false)
            }
        }
    }

    private func actionButton(_ title: String, accessibilityLabel: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(busy)
            .padding(.leading, 34)
            .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private func connectedSections(_ state: ConnectorState) -> some View {
        let grantedRead = definition.readScopes.filter { state.grantedScopeIds.contains($0.id) }
        let grantedAct = definition.actScopes.filter { state.grantedScopeIds.contains($0.id) }
        let chips = (grantedRead.isEmpty ? definition.readScopes : grantedRead) + (state.actEnabled ? grantedAct : [])

        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text("Allowed").font(.subheadline)
                FlowLayout(spacing: 6) {
                    ForEach(chips) { ConnectorScopeChip(scope: $0) }
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)

            if !definition.actScopes.isEmpty {
                Toggle(isOn: actBinding(state)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Let my agent act here").font(.subheadline)
                        Text(state.actEnabled
                            ? "\(definition.actDescription) Anything on your Ask me before list still waits for your approval."
                            : "Your agent can only read from \(definition.name).")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .disabled(busy)
                .accessibilityIdentifier("connector-act-toggle")
            }
        } header: {
            Text("Access")
        } footer: {
            Text("Background runs: digests and scheduled work can only read. They never get act tools.")
        }

        Section("Agents") {
            ForEach(store.agents) { agent in
                Toggle(isOn: agentBinding(agent, state: state)) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(agent.name).font(.subheadline)
                        if agent.isDefault {
                            Text("Default agent").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .disabled(busy)
                .accessibilityLabel("Let \(agent.name) use \(definition.name)")
            }
        }

        Section {
            NavigationLink {
                ConnectorActivityView(definition: definition, client: store.client)
            } label: {
                CompactSettingsLabel(title: "Activity log", subtitle: "Every read and act call is recorded.", systemImage: "list.bullet.rectangle")
            }
        } header: {
            Text("Activity")
        }

        Section {
            Button(role: .destructive) {
                showsDisconnect = true
            } label: {
                Text("Disconnect")
            }
            .disabled(busy)
            .accessibilityLabel("Disconnect \(definition.name)")
        } header: {
            Text("Remove")
        } footer: {
            Text("Removes the sign-in and stored events from \(definition.name).")
        }
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

/// A consent step: the first read-only connection, or the separate act grant.
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
                message: "Kordi asks \(definition.providerName) for read access only. You can let your agent act here later from this page.",
                scopes: definition.readScopes,
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
            message: "This is a second permission you grant on purpose. Your agent will be able to:",
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
                            Label(scope.label, systemImage: scope.group == .act ? "hand.tap" : "eye")
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

private struct ConnectorScopeChip: View {
    let scope: ConnectorScope

    var body: some View {
        Text(scope.label)
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .foregroundStyle(scope.group == .act ? Color.orange : Color.secondary)
            .background((scope.group == .act ? Color.orange : Color.secondary).opacity(0.14), in: Capsule())
    }
}
