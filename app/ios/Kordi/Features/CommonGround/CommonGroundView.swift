import SwiftUI

/// Common ground: the agent turns chosen sources into a card, and people meet
/// by pairing codes (one to one) or by entering the same four-digit room code.
/// Backed by `/v1/cloud/common-ground`; see CommonGroundModel.swift.

// MARK: - Routes

enum CommonGroundRoute: Hashable {
    case build
    case card
    case code
    case lobby(String)
    case results(String)
    case match(String)
    case person(String, paired: Bool)
}

private struct CommonGroundOpenConversationKey: EnvironmentKey {
    static let defaultValue: (ConversationSummary) -> Void = { _ in }
}

extension EnvironmentValues {
    /// Opens a Kordi chat from inside Common ground.
    var commonGroundOpenConversation: (ConversationSummary) -> Void {
        get { self[CommonGroundOpenConversationKey.self] }
        set { self[CommonGroundOpenConversationKey.self] = newValue }
    }
}

// MARK: - Root

/// Built from the conversation info page's parts (hero, glass action tiles,
/// grouped sections, segmented picker) so it reads as the same product.
struct CommonGroundView: View {
    /// Leaves Common ground from its home page; nil hides the back button.
    let onClose: (() -> Void)?
    let onOpenConversation: (ConversationSummary) -> Void
    @StateObject private var model: CommonGroundModel
    @State private var path: [CommonGroundRoute] = []

    init(
        appModel: AppModel,
        onClose: (() -> Void)? = nil,
        onOpenConversation: @escaping (ConversationSummary) -> Void
    ) {
        self.onClose = onClose
        self.onOpenConversation = onOpenConversation
        _model = StateObject(wrappedValue: appModel.makeCommonGroundModel())
    }

    var body: some View {
        NavigationStack(path: $path) {
            root
                .navigationDestination(for: CommonGroundRoute.self) { route in
                    switch route {
                    case .build: CommonGroundBuildView()
                    case .card: CommonGroundCardView(path: $path)
                    case .code: CommonGroundCodeView(path: $path)
                    case .lobby(let code): CommonGroundLobbyView(code: code, path: $path)
                    case .results(let code): CommonGroundResultsView(code: code, path: $path)
                    case .match(let id): CommonGroundMatchView(personID: id)
                    case .person(let id, let paired): CommonGroundPersonView(personID: id, paired: paired, path: $path)
                    }
                }
        }
        .overlay(alignment: .top) { CommonGroundToast(text: $model.notice) }
        .environmentObject(model)
        .environment(\.commonGroundOpenConversation, onOpenConversation)
        .tint(commonGroundTint)
    }

    /// First run shows the sources until a card exists.
    @ViewBuilder private var root: some View {
        if model.owner != nil && !model.hasCard {
            CommonGroundBuildView(onClose: onClose)
        } else {
            CommonGroundHome(path: $path, onClose: onClose)
        }
    }
}

let commonGroundTint = KordiTheme.signalBlue

/// Info-page frame: tinted grouped background, hidden bar, round glass back.
struct CommonGroundPage<Content: View>: View {
    @Environment(\.dismiss) private var dismiss
    var showsBack = true
    var onBack: (() -> Void)? = nil
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                content
            }
            .padding(.top, 56)
            .padding(.bottom, 28)
        }
        .scrollDismissesKeyboard(.interactively)
        .background {
            SessionDetailBackground(tint: commonGroundTint).ignoresSafeArea()
        }
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .overlay(alignment: .topLeading) {
            if showsBack { SessionDetailBackButton { if let onBack { onBack() } else { dismiss() } } }
        }
    }
}

/// Full-screen wait state on the page background, with the animated mark.
struct CommonGroundWaitPage: View {
    @Environment(\.dismiss) private var dismiss
    let steps: [String]
    var onBack: (() -> Void)? = nil
    let work: @MainActor () async -> Void

    var body: some View {
        VStack {
            Spacer()
            CommonGroundThinking(steps: steps, work: work)
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background { SessionDetailBackground(tint: commonGroundTint).ignoresSafeArea() }
        .toolbar(.hidden, for: .navigationBar)
        .overlay(alignment: .topLeading) {
            SessionDetailBackButton { if let onBack { onBack() } else { dismiss() } }
        }
    }
}

/// Avatar, name and one status line, as on the conversation info page.
struct CommonGroundHero<Avatar: View, Actions: View>: View {
    let title: String
    let status: String
    @ViewBuilder let avatar: Avatar
    @ViewBuilder let actions: Actions
    @ScaledMetric(relativeTo: .title2) private var nameSize = 24.0

    var body: some View {
        VStack(spacing: 0) {
            avatar.shadow(color: .black.opacity(0.08), radius: 10, y: 4)
            VStack(spacing: 2) {
                Text(title)
                    .font(.system(size: nameSize, weight: .bold))
                    .multilineTextAlignment(.center)
                if !status.isEmpty {
                    Text(status)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.top, 10)
            .accessibilityElement(children: .combine)
            actions.padding(.top, 16)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
    }
}

extension CommonGroundHero where Actions == EmptyView {
    init(title: String, status: String, @ViewBuilder avatar: () -> Avatar) {
        self.init(title: title, status: status, avatar: avatar) { EmptyView() }
    }
}

struct CommonGroundActions<Content: View>: View {
    var columns = 4
    @ViewBuilder let content: Content

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: columns), spacing: 10) {
            content
        }
    }
}

/// The login screen's primary button: a full-width dark capsule.
struct CommonGroundPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 52)
            .foregroundStyle(KordiTheme.loginPrimaryText)
            .background(KordiTheme.loginPrimaryFill, in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.42)
    }
}

/// One line at the top of the screen, clear of the bottom buttons.
struct CommonGroundToast: View {
    @Binding var text: String?

    var body: some View {
        Group {
            if let text {
                Text(text)
                    .font(.subheadline.weight(.medium))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .sessionGlass(in: Capsule())
                    // Clears the round back button at the top leading corner.
                    .padding(.horizontal, 64)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: text) {
                        try? await Task.sleep(for: .seconds(2.4))
                        withAnimation { self.text = nil }
                    }
            }
        }
        .padding(.top, 8)
        .animation(.snappy, value: text)
    }
}

/// A plain row inside a section: title, optional value, chevron when tappable.
struct CommonGroundRow: View {
    let title: String
    var subtitle: String? = nil
    var action: (() -> Void)? = nil

    var body: some View {
        if let action {
            Button(action: action) { label(chevron: true) }
                .buttonStyle(SessionRowButtonStyle())
        } else {
            label(chevron: false)
        }
    }

    private func label(chevron: Bool) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body).foregroundStyle(.primary)
                if let subtitle {
                    Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
        .contentShape(Rectangle())
    }
}
