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
            ProviderAuthenticationRow(
                provider: provider,
                profiles: model.authenticationSnapshots(for: provider.id)
            )
        }
    }

    var body: some View {
        ScrollViewReader { index in
          List {
            Section {
                HStack(spacing: 11) {
                    Image(systemName: model.providerAuthProfiles.isEmpty ? "key" : "checkmark.shield.fill")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(model.providerAuthProfiles.isEmpty ? Color.secondary : Color.green)
                        .frame(width: 32, height: 32)
                        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.providerAuthProfiles.isEmpty ? "Add provider access" : "Authentication synced")
                            .font(.body.weight(.semibold))
                        Text(authenticationSummary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 2)
            }

            Section {
                TextField("Search \(model.authenticationProviderDefinitions.count) providers", text: $providerSearch)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Providers · \(visibleProviders.count)")
            }

            if providerSearch.isEmpty && !connectedProviders.isEmpty {
                Section("Connected") {
                    ForEach(connectedProviders) { provider in
                        providerLink(provider)
                            .accessibilityIdentifier("connected-provider-\(provider.id)")
                    }
                }
            }

            ForEach(indexLetters, id: \.self) { letter in
                Section(letter) {
                    ForEach(visibleProviders.filter { $0.name.uppercased().hasPrefix(letter) }) { provider in
                        providerLink(provider)
                    }
                }
                .id(letter)
            }

            if let error = model.providerAuthenticationErrorMessage.nonEmpty {
                Section {
                    AuthenticationErrorRow(error: error) {
                        Task { await model.refreshProviderAuthentication() }
                    }
                }
            }

            Section {} footer: {
                Text("Saved provider accounts are encrypted in Kordi Cloud. Choose a specific account for each agent session. Local-model access stays on your Mac.")
            }
          }
          .overlay(alignment: .trailing) {
              if providerSearch.isEmpty && indexLetters.count > 1 {
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
        .listStyle(.insetGrouped)
        .environment(\.defaultMinListRowHeight, 44)
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

    private var authenticationSummary: String {
        let count = model.providerAuthProfiles.count
        return count == 0 ? "Choose a provider below to connect it." : "\(count) saved \(count == 1 ? "account" : "accounts") available across Kordi."
    }
}

struct ProviderAuthenticationRow: View {
    let provider: ProviderAuthenticationDefinition
    let profiles: [CloudProviderAuthSnapshot]

    var body: some View {
        HStack(spacing: 11) {
            ProviderAuthenticationIcon(provider: provider, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.shortName)
                    .font(.body.weight(.medium))
                Text(profiles.isEmpty ? catalogSubtitle : savedAccessLabel)
                    .font(.caption)
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
        .padding(.vertical, 1)
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

struct ProviderAuthenticationIcon: View {
    let provider: ProviderAuthenticationDefinition
    let size: CGFloat

    var body: some View {
        Image(systemName: provider.systemImage)
            .font(.body.weight(.semibold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
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
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(.red)
                .padding(.top, 2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                Button("Try again", action: retry)
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 32)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }
}
