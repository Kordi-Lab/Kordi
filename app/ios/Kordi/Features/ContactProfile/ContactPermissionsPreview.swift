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
#endif
