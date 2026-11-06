import Foundation

/// Whether the Permissions row exists: the server reports
/// `contactPermissionsVersion` 1 or later, or the debug preview asks for it.
enum ContactPermissionsAvailability {
    /// Debug launch argument: opens Maya's profile on the Permissions page.
    static let previewArgument = "--preview-contact-permissions"

    static func isPreviewRequested(arguments: [String] = ProcessInfo.processInfo.arguments) -> Bool {
#if DEBUG
        arguments.contains(previewArgument)
#else
        false
#endif
    }

    static func isEnabled(_ capabilities: CloudAuthCapabilities?) -> Bool {
        (capabilities?.contactPermissionsVersion ?? 0) >= 1
    }
}

/// The two switches of one person. Each change is saved at once and put back
/// when the server refuses it.
@MainActor
final class ContactPermissionsModel: ObservableObject {
    typealias Loader = () async throws -> CloudContactPermissions
    typealias Saver = (CloudContactPermissionsUpdate) async throws -> CloudContactPermissions

    enum Field { case agent, card }

    @Published private(set) var permissions: CloudContactPermissions?
    @Published private(set) var isLoading = false
    @Published private(set) var savingFields: Set<Field> = []
    @Published var errorMessage: String?
    private let loader: Loader?
    private let saver: Saver?
    /// Told the values the server holds after each load or save, so the
    /// profile that opened this page shows them next time.
    private let onSaved: ((CloudContactPermissions) -> Void)?

    /// A nil loader and saver flip the switches locally (preview mode).
    init(
        initial: CloudContactPermissions?,
        loader: Loader?,
        saver: Saver?,
        onSaved: ((CloudContactPermissions) -> Void)? = nil
    ) {
        permissions = initial
        self.loader = loader
        self.saver = saver
        self.onSaved = onSaved
    }

    func loadIfNeeded() async {
        guard permissions == nil else { return }
        guard let loader else {
            permissions = CloudContactPermissions()
            return
        }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let loaded = try await loader()
            permissions = loaded
            onSaved?(loaded)
        } catch is CancellationError {
        } catch {
            errorMessage = Self.message(for: error, fallback: "Could not load permissions.")
        }
    }

    func set(_ field: Field, to value: Bool) async {
        guard var next = permissions, !savingFields.contains(field) else { return }
        let previous = next
        var update = CloudContactPermissionsUpdate()
        switch field {
        case .agent:
            next.agentAccess = value
            update.agentAccess = value
        case .card:
            next.cardAccess = value
            update.cardAccess = value
        }
        permissions = next
        errorMessage = nil
        guard let saver else {
            onSaved?(next)
            return
        }
        savingFields.insert(field)
        defer { savingFields.remove(field) }
        do {
            let saved = try await saver(update)
            // Keep the other switch if it changed while this request ran.
            switch field {
            case .agent: permissions?.agentAccess = saved.agentAccess
            case .card: permissions?.cardAccess = saved.cardAccess
            }
            if let permissions { onSaved?(permissions) }
        } catch {
            switch field {
            case .agent: permissions?.agentAccess = previous.agentAccess
            case .card: permissions?.cardAccess = previous.cardAccess
            }
            if !(error is CancellationError) {
                errorMessage = Self.message(for: error, fallback: "Could not save this change.")
            }
        }
    }

    private static func message(for error: Error, fallback: String) -> String {
        (error as? CloudAPIError)?.message.nonEmpty ?? fallback
    }
}

extension AppModel {
    func makeContactPermissionsModel(
        accountId: String,
        initial: CloudContactPermissions?,
        onSaved: ((CloudContactPermissions) -> Void)? = nil
    ) -> ContactPermissionsModel {
        if isPreviewMode {
            return ContactPermissionsModel(
                initial: initial ?? CloudContactPermissions(), loader: nil, saver: nil, onSaved: onSaved
            )
        }
        return ContactPermissionsModel(
            initial: initial,
            loader: { [weak self] in
                guard let self else { throw CancellationError() }
                let (api, token, _) = try self.digestContext()
                return try await api.fetchContactPermissions(token: token, accountId: accountId).permissions
            },
            saver: { [weak self] update in
                guard let self else { throw CancellationError() }
                let (api, token, _) = try self.digestContext()
                return try await api.updateContactPermissions(token: token, accountId: accountId, update: update).permissions
            },
            onSaved: onSaved
        )
    }
}

extension ContactPermissionsAvailability {
    static let previewAccountId = "acct_maya"
    @MainActor private static var didOpenPreviewPage = false

    /// The preview opens the page once, for the sample person only.
    @MainActor
    static func opensPreviewPage(for subject: ContactProfileSubject) -> Bool {
        guard isPreviewRequested(), subject.accountId == previewAccountId, !didOpenPreviewPage else { return false }
        didOpenPreviewPage = true
        return true
    }
}

extension ContactProfilePresentation {
    /// A person other than yourself, on a server with permissions.
    var showsPermissions: Bool {
        guard permissionsAvailable, kind == .person, profile?.isSelf != true else { return false }
        return subject.accountId != selfAccountId
    }
}

extension AppModel {
    /// Preview data shows the row only with `--preview-contact-permissions`.
    var isContactPermissionsAvailable: Bool {
        if isPreviewMode { return ContactPermissionsAvailability.isPreviewRequested() }
        return ContactPermissionsAvailability.isEnabled(memoryCapabilities)
    }
}
