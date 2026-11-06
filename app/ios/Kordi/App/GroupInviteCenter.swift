import SwiftUI

/// Runs group invite links and pending invitations for the signed-in
/// account: claims a link, shows one Join sheet at a time, and opens the
/// group after joining.
@MainActor
final class GroupInviteCenter: ObservableObject {
    static let shared = GroupInviteCenter()
    private static let queuedTokenKey = "kordi.pendingGroupInvitation.v1"

    @Published private(set) var flow: GroupInviteFlow
    /// Taken by the main navigation, which pushes it.
    @Published var conversationToOpen: ConversationSummary?

    private weak var model: AppModel?
    private var accountId: String?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = defaults.string(forKey: Self.queuedTokenKey).flatMap {
            GroupInviteLink.isValidToken($0) ? $0 : nil
        }
        flow = GroupInviteFlow(queuedToken: stored)
    }

    func receive(_ link: GroupInviteLink) {
        perform(flow.receiveLink(token: link.token))
        storeQueuedToken()
    }

    /// Called with the signed-in account, or nil when signed out.
    func accountChanged(model: AppModel, accountId: String?) {
        self.model = model
        guard accountId != self.accountId else { return }
        self.accountId = accountId
        flow.signedOut()
        guard accountId != nil else { return }
        perform(flow.signedIn(now: .now))
        storeQueuedToken()
    }

    func foregrounded() {
        perform(flow.foregrounded(now: .now))
    }

    func join() {
        guard let (api, token, accountId) = context(), let pendingId = flow.beginJoin() else { return }
        Task {
            do {
                let conversationId = try await api.acceptPendingGroupInvitation(token: token, pendingId: pendingId)
                guard self.accountId == accountId else { return }
                perform(flow.joined(conversationId: conversationId))
            } catch {
                guard self.accountId == accountId else { return }
                let failure = error as? CloudAPIError
                perform(flow.joinFailed(
                    errorCode: failure?.code ?? "network_error",
                    message: failure?.message ?? "Could not join the group."
                ))
            }
        }
    }

    /// Not now, Done, or a swipe down. A turned-down invitation leaves the
    /// pending list; opening the link again brings it back.
    func dismiss() {
        guard let pendingId = flow.dismiss(), let (api, token, _) = context() else { return }
        Task { try? await api.dismissPendingGroupInvitation(token: token, pendingId: pendingId) }
    }

    private func context() -> (CloudAPIClient, String, String)? {
        guard let model, !model.isPreviewMode, accountId != nil,
              let context = try? model.projectContext(), context.2 == accountId else { return nil }
        return context
    }

    private func perform(_ action: GroupInviteFlow.Action) {
        switch action {
        case .none:
            return
        case let .claim(inviteToken):
            Task { await claim(inviteToken) }
        case .fetchPending:
            Task { await fetchPending() }
        case let .open(conversationId):
            Task { await open(conversationId: conversationId) }
        }
    }

    private func claim(_ inviteToken: String) async {
        guard let (api, token, accountId) = context() else { return }
        do {
            let result = try await api.claimGroupInvitation(token: token, inviteToken: inviteToken)
            guard self.accountId == accountId else { return }
            perform(flow.claimed(result))
        } catch {
            guard self.accountId == accountId, !CloudTransportErrorPolicy.isCancellation(error) else { return }
            flow.claimFailed(errorCode: (error as? CloudAPIError)?.code ?? "network_error")
        }
    }

    private func fetchPending() async {
        guard let (api, token, accountId) = context(),
              let invitations = try? await api.listPendingGroupInvitations(token: token),
              self.accountId == accountId else { return }
        flow.pendingLoaded(invitations)
    }

    /// Waits briefly for the joined group to reach the chat list, then opens it.
    private func open(conversationId: String?) async {
        guard let model, let accountId else { return }
        for attempt in 0..<8 {
            if let conversationId,
               let conversation = model.conversationForNotification(canonicalConversationID: conversationId) {
                conversationToOpen = conversation
                return
            }
            if attempt % 3 == 0 { _ = await model.refreshWorkspace(showSyncActivity: false) }
            guard conversationId != nil, self.accountId == accountId else { return }
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }

    private func storeQueuedToken() {
        if let token = flow.queuedToken {
            defaults.set(token, forKey: Self.queuedTokenKey)
        } else {
            defaults.removeObject(forKey: Self.queuedTokenKey)
        }
    }
}

extension View {
    /// Claims group invite links, fetches pending invitations after sign-in
    /// and on foreground, and shows the Join sheet.
    func groupInviteHandling() -> some View {
        modifier(GroupInviteHandling())
    }
}

private struct GroupInviteHandling: ViewModifier {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var center = GroupInviteCenter.shared
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.kordiChatTheme) private var chatTheme

    private var signedInAccountId: String? {
        model.phase == .signedIn && !model.isPreviewMode ? model.account?.accountId : nil
    }

    func body(content: Content) -> some View {
        content
            .task(id: signedInAccountId) {
                center.accountChanged(model: model, accountId: signedInAccountId)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { center.foregrounded() }
            }
            .sheet(item: Binding(
                get: { center.flow.sheet },
                set: { if $0 == nil { center.dismiss() } }
            )) { sheet in
                GroupInviteJoinSheet(
                    sheet: sheet,
                    isJoining: center.flow.isJoining,
                    joinError: center.flow.joinError,
                    onJoin: center.join,
                    onDismiss: center.dismiss
                )
                .environment(\.kordiChatTheme, chatTheme)
                .tint(chatTheme.accent)
            }
    }
}

/// Pushes the conversation a join opened onto the main stack.
struct GroupInviteRouting: ViewModifier {
    @ObservedObject private var center = GroupInviteCenter.shared
    @Binding var path: [MainNavigationRoute]

    func body(content: Content) -> some View {
        content.task(id: center.conversationToOpen?.id) {
            guard let conversation = center.conversationToOpen else { return }
            path = [.conversation(conversation)]
            center.conversationToOpen = nil
        }
    }
}
