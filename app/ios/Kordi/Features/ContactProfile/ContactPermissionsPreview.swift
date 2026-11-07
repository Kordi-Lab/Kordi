import SwiftUI

#if DEBUG
/// `--preview-contact-permissions`: Contacts with Maya's profile open on the
/// Permissions page. Synthetic data only; the switches flip locally.
struct ContactPermissionsPreviewHost: View {
    @EnvironmentObject private var model: AppModel
    @State private var subject: ContactProfileSubject?

    var body: some View {
        NavigationStack {
            ContactsView()
                .contactProfileSheet(subject: $subject)
        }
        .task {
            let accountId = ContactPermissionsAvailability.previewAccountId
            subject = model.contacts.first { $0.accountId == accountId }.map(ContactProfileSubject.init(contact:))
                ?? ContactProfileSubject(accountId: accountId, name: "Maya Chen", kordiId: "284106395")
        }
    }
}

/// `--preview-contact-blocked`: Maya's profile while she is on the block
/// list, so the More menu offers Unblock. Synthetic data only.
struct ContactBlockedPreviewHost: View {
    static let argument = "--preview-contact-blocked"

    @EnvironmentObject private var model: AppModel
    @State private var subject: ContactProfileSubject?

    var body: some View {
        NavigationStack {
            ContactsView()
                .contactProfileSheet(subject: $subject)
        }
        .task {
            let accountId = ContactPermissionsAvailability.previewAccountId
            let contact = model.contacts.first { $0.accountId == accountId }
            model.previewMarkBlocked(CloudBlockedAccount(
                accountId: accountId,
                kordiId: contact?.kordiId ?? "284106395",
                displayName: contact?.preferredName ?? "Maya Chen",
                avatarUrl: contact?.avatarUrl
            ))
            subject = contact.map(ContactProfileSubject.init(contact:))
                ?? ContactProfileSubject(accountId: accountId, name: "Maya Chen", kordiId: "284106395")
        }
    }
}
#endif
