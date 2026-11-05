import Foundation

/// The group invite state: a link waiting for sign-in, the one sheet on
/// screen, and when pending invitations were last fetched. It makes no
/// requests; `GroupInviteCenter` performs the actions it returns.
struct GroupInviteFlow: Equatable {
    enum Notice: String, Equatable {
        case expired
        case groupFull
        case tooManyPending
        case failed

        var title: String {
            switch self {
            case .expired: "This link expired"
            case .groupFull: "This group is full"
            case .tooManyPending: "Too many invitations"
            case .failed: "Could not open this link"
            }
        }

        var line: String {
            switch self {
            case .expired: "Ask a group admin for a new one."
            case .groupFull: "Ask a group admin to make room."
            case .tooManyPending: "Answer the ones waiting first."
            case .failed: "Check your connection and try again."
            }
        }

        init(errorCode: String) {
            switch errorCode {
            case "invitation_unavailable", "invalid_group_invitation", "group_invitation_expired":
                self = .expired
            case "group_full":
                self = .groupFull
            case "too_many_pending":
                self = .tooManyPending
            default:
                self = .failed
            }
        }
    }

    enum Sheet: Equatable, Identifiable {
        case invitation(GroupInvitePending)
        case notice(Notice)

        var id: String {
            switch self {
            case let .invitation(pending): "invitation:\(pending.id)"
            case let .notice(notice): "notice:\(notice.rawValue)"
            }
        }
    }

    enum Action: Equatable {
        case none
        case claim(String)
        case fetchPending
        /// Opens the conversation; nil refreshes the chat list only.
        case open(conversationId: String?)
    }

    /// Foreground fetches of pending invitations are at most this often.
    static let foregroundInterval: TimeInterval = 60

    private(set) var sheet: Sheet?
    /// A link opened while signed out, claimed after sign-in.
    private(set) var queuedToken: String?
    private(set) var isSignedIn = false
    private(set) var isJoining = false
    /// A join failure shown inside the invitation sheet.
    private(set) var joinError: String?
    private var lastPendingFetch: Date?

    init(queuedToken: String? = nil) {
        self.queuedToken = queuedToken
    }

    mutating func receiveLink(token: String) -> Action {
        guard isSignedIn else {
            queuedToken = token
            return .none
        }
        return .claim(token)
    }

    mutating func signedIn(now: Date) -> Action {
        isSignedIn = true
        lastPendingFetch = now
        if let token = queuedToken {
            queuedToken = nil
            return .claim(token)
        }
        return .fetchPending
    }

    /// Keeps a queued link for the next sign-in.
    mutating func signedOut() {
        isSignedIn = false
        sheet = nil
        isJoining = false
        joinError = nil
        lastPendingFetch = nil
    }

    mutating func foregrounded(now: Date) -> Action {
        guard isSignedIn, sheet == nil, !isJoining else { return .none }
        if let lastPendingFetch, now.timeIntervalSince(lastPendingFetch) < Self.foregroundInterval {
            return .none
        }
        lastPendingFetch = now
        return .fetchPending
    }

    /// A link the person opened replaces any sheet that is not joining.
    mutating func claimed(_ result: GroupInviteClaimResult) -> Action {
        guard isSignedIn, !isJoining else { return .none }
        joinError = nil
        switch result {
        case let .pending(pending):
            sheet = .invitation(pending)
            return .none
        case let .alreadyMember(conversationId):
            sheet = nil
            return .open(conversationId: conversationId)
        }
    }

    mutating func claimFailed(errorCode: String) {
        guard isSignedIn, !isJoining else { return }
        joinError = nil
        sheet = .notice(Notice(errorCode: errorCode))
    }

    /// Shows the newest invitation when nothing else is on screen.
    mutating func pendingLoaded(_ invitations: [GroupInvitePending]) {
        guard isSignedIn, sheet == nil, !isJoining, let newest = Self.newest(invitations) else { return }
        sheet = .invitation(newest)
    }

    /// Returns the pending id to accept, or nil when there is nothing to join.
    mutating func beginJoin() -> String? {
        guard case let .invitation(pending) = sheet, !isJoining else { return nil }
        isJoining = true
        joinError = nil
        return pending.id
    }

    mutating func joined(conversationId: String) -> Action {
        isJoining = false
        joinError = nil
        sheet = nil
        return .open(conversationId: conversationId)
    }

    mutating func joinFailed(errorCode: String, message: String) -> Action {
        guard isJoining else { return .none }
        isJoining = false
        switch errorCode {
        case "already_member":
            sheet = nil
            return .open(conversationId: nil)
        case "invitation_unavailable", "invalid_group_invitation", "group_invitation_expired", "group_full":
            sheet = .notice(Notice(errorCode: errorCode))
        default:
            joinError = message
        }
        return .none
    }

    /// Closes the sheet; returns the pending id to dismiss on the server
    /// when an invitation was turned down.
    mutating func dismiss() -> String? {
        guard !isJoining else { return nil }
        defer {
            sheet = nil
            joinError = nil
        }
        if case let .invitation(pending) = sheet { return pending.id }
        return nil
    }

    /// The invitation that expires last; ties keep server order.
    static func newest(_ invitations: [GroupInvitePending]) -> GroupInvitePending? {
        invitations.enumerated().max { lhs, rhs in
            let left = lhs.element.expiryDate ?? .distantPast
            let right = rhs.element.expiryDate ?? .distantPast
            return left == right ? lhs.offset > rhs.offset : left < right
        }?.element
    }
}
