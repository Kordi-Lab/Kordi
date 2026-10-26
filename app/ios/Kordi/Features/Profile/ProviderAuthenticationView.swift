import SwiftUI

struct ProviderAuthenticationView: View {
    @EnvironmentObject private var model: AppModel
    @State private var providerSearch = ""

    private var visibleProviders: [ProviderAuthenticationDefinition] {
        let definitions = model.authenticationProviderDefinitions
        let query = providerSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        return (query.isEmpty ? definitions : definitions.filter {
            $0.name.localizedCaseInsensitiveContains(query)
                || $0.id.localizedCaseInsensitiveContains(query)
        }).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private var indexLetters: [String] {
        Array(Set(visibleProviders.map { String($0.name.prefix(1)).uppercased() })).sorted()
    }

    private var connectedProviders: [ProviderAuthenticationDefinition] {
        visibleProviders.filter { !model.authenticationSnapshots(for: $0.id).isEmpty }
    }

    private func providerLink(_ provider: ProviderAuthenticationDefinition) -> some View {
        NavigationLink {
            ProviderAuthenticationDetailView(provider: provider)
        } label: {
            HStack(spacing: 10) {
                ProviderAuthenticationRow(
                    provider: provider,
                    profiles: model.authenticationSnapshots(for: provider.id)
                )
                SettingsChevron()
            }
            .frame(minHeight: SettingsMetrics.rowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var showsIndex: Bool {
        providerSearch.isEmpty && indexLetters.count > 1
    }

    var body: some View {
        ScrollViewReader { index in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    summaryRow
                    SettingsDivider()

                    SettingsSectionTitle("Providers · \(visibleProviders.count)")
                    SettingsSearchField("Search \(model.authenticationProviderDefinitions.count) providers", text: $providerSearch)

                    if providerSearch.isEmpty && !connectedProviders.isEmpty {
                        SettingsDivider()
                        SettingsSectionTitle("Connected")
                        ForEach(connectedProviders) { provider in
                            providerLink(provider)
                                .accessibilityIdentifier("connected-provider-\(provider.id)")
                        }
                    }

                    ForEach(indexLetters, id: \.self) { letter in
                        VStack(alignment: .leading, spacing: 0) {
                            SettingsDivider()
                            SettingsSectionTitle(letter)
                            ForEach(visibleProviders.filter { $0.name.uppercased().hasPrefix(letter) }) { provider in
                                providerLink(provider)
                            }
                        }
                        .id(letter)
                    }

                    if let error = model.providerAuthenticationErrorMessage.nonEmpty {
                        SettingsDivider()
                        AuthenticationErrorRow(error: error) {
                            Task { await model.refreshProviderAuthentication() }
                        }
                    }

                    SettingsDivider()
                    SettingsCaption("Saved provider accounts are encrypted in Kordi Cloud. Choose a specific account for each agent session. Local-model access stays on your Mac.")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(SettingsMetrics.pageInsets)
                // Keep the chevrons clear of the letter index.
                .padding(.trailing, showsIndex ? Self.indexWidth : 0)
            }
            .background(Color(uiColor: .systemBackground))
            .overlay(alignment: .trailing) {
                if showsIndex {
                    VStack(spacing: 0) {
                        ForEach(indexLetters, id: \.self) { letter in
                            Button(letter) {
                                withAnimation(.easeOut(duration: 0.2)) { index.scrollTo(letter, anchor: .top) }
                            }
                            .font(.system(size: 10, weight: .semibold))
                            .frame(width: 24, height: 17)
                            .accessibilityLabel("Jump to \(letter) providers")
                        }
                    }
                    .background(.regularMaterial, in: Capsule())
                    .padding(.trailing, 2)
                }
            }
        }
        .navigationTitle("Authentication")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task {
                        await model.refreshProviderAuthentication()
                        await model.refreshOMPProviderCatalog()
                    }
                } label: {
                    if model.isRefreshingProviderAuthentication {
                        ProgressView()
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .disabled(model.isRefreshingProviderAuthentication)
                .accessibilityLabel("Refresh authentication")
            }
        }
        .refreshable {
            await model.refreshProviderAuthentication()
            await model.refreshOMPProviderCatalog()
        }
        .task {
            if model.providerAuthProfiles.isEmpty {
                await model.refreshProviderAuthentication()
            }
            // Each visit retries a failed fetch; a backend without OMP waits for a manual refresh.
            if !model.hasLiveOMPProviderCatalog && !model.ompBackendUnavailable {
                await model.refreshOMPProviderCatalog()
            }
        }
    }

    /// Room the letter index takes at the trailing edge, beyond the page inset.
    private static let indexWidth: CGFloat = 12

    private var summaryRow: some View {
        HStack(spacing: SettingsMetrics.iconSpacing) {
            Image(systemName: model.providerAuthProfiles.isEmpty ? "key" : "checkmark.shield")
                .font(.body)
                .foregroundStyle(model.providerAuthProfiles.isEmpty ? Color.primary : Color.green)
                .frame(width: SettingsMetrics.iconWidth)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.providerAuthProfiles.isEmpty ? "Add provider access" : "Authentication synced")
                    .font(SettingsFont.rowTitle)
                Text(authenticationSummary)
                    .font(SettingsFont.subtitle)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 5)
        .frame(minHeight: SettingsMetrics.rowMinHeight)
        .accessibilityElement(children: .combine)
    }

    private var authenticationSummary: String {
        let count = model.providerAuthProfiles.count
        return count == 0 ? "Choose a provider below to connect it." : "\(count) saved \(count == 1 ? "account" : "accounts") available across Kordi."
    }
}

struct ProviderAuthenticationRow: View {
    let provider: ProviderAuthenticationDefinition
    let profiles: [CloudProviderAuthSnapshot]

    var body: some View {
        HStack(spacing: SettingsMetrics.iconSpacing) {
            ProviderAuthenticationIcon(provider: provider)
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.shortName)
                    .font(SettingsFont.rowTitle)
                    .foregroundStyle(.primary)
                Text(profiles.isEmpty ? catalogSubtitle : savedAccessLabel)
                    .font(SettingsFont.subtitle)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if !profiles.isEmpty {
                Circle()
                    .fill(.green)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel("Connected")
            }
        }
        .padding(.vertical, 5)
    }

    /// The parenthetical from OMP's name, then the sign-in methods and model count.
    private var catalogSubtitle: String {
        [provider.nameQualifier, provider.subtitle].compactMap { $0 }.joined(separator: " · ")
    }

    private var savedAccessLabel: String {
        let count = profiles.count
        let summary = "\(count) saved \(count == 1 ? "account" : "accounts")"
        let names = profiles.compactMap { $0.label?.nonEmpty }
        return names.isEmpty ? summary : "\(summary) · \(names.joined(separator: ", "))"
    }
}

/// The provider's symbol in its colour, without a badge: in the row icon
/// column by default, or larger beside a screen's header.
struct ProviderAuthenticationIcon: View {
    let provider: ProviderAuthenticationDefinition
    var size: CGFloat = SettingsMetrics.iconWidth

    var body: some View {
        Image(systemName: provider.systemImage)
            .font(size > SettingsMetrics.iconWidth ? .system(size: size * 0.7) : .body)
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }

    private var tint: Color {
        switch provider.id {
        case "openai": .teal
        case "anthropic": .brown
        case "github-copilot": .indigo
        case "google": .blue
        case "groq": .purple
        case "openrouter": .cyan
        case "xai": .primary
        default: .orange
        }
    }
}

struct AuthenticationErrorRow: View {
    let error: String
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsErrorLabel(error)
            Button("Try again", action: retry)
                .font(SettingsFont.action)
                .buttonStyle(.borderless)
                .frame(minHeight: SettingsMetrics.textRowMinHeight)
        }
        .accessibilityElement(children: .contain)
    }
}
