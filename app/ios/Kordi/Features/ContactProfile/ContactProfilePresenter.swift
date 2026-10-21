import SwiftUI

extension View {
    /// Presents the contact profile sheet for `subject`. A chat picked in the
    /// sheet opens after the sheet closes: through `onOpenConversation` when
    /// given, otherwise pushed on the surrounding navigation stack. The chat
    /// with `currentConversationID` is already on screen, so picking it only closes the sheet.
    func contactProfileSheet(
        subject: Binding<ContactProfileSubject?>,
        currentConversationID: String? = nil,
        onOpenConversation: ((ConversationSummary) -> Void)? = nil
    ) -> some View {
        modifier(ContactProfileSheetModifier(
            subject: subject,
            currentConversationID: currentConversationID,
            onOpenConversation: onOpenConversation
        ))
    }

    /// A message author or mention in a conversation: people open the profile
    /// sheet, anything else keeps the pushed details screen.
    func authorProfileDestination(item: Binding<ConversationSummary?>, source: ConversationSummary) -> some View {
        modifier(AuthorProfileDestinationModifier(item: item, source: source))
    }
}

private struct ContactProfileSheetModifier: ViewModifier {
    @EnvironmentObject private var model: AppModel
    @Binding var subject: ContactProfileSubject?
    let currentConversationID: String?
    let onOpenConversation: ((ConversationSummary) -> Void)?
    @State private var pending: ConversationSummary?
    @State private var pushed: ConversationSummary?

    func body(content: Content) -> some View {
        content
            .sheet(item: $subject, onDismiss: routePending) { subject in
                ContactProfileView(subject: subject, profileModel: model.makeContactProfileModel(for: subject)) { conversation in
                    pending = conversation
                    self.subject = nil
                }
                // A fresh view, model and scroll position for every subject.
                .id(subject.id)
            }
            .navigationDestination(item: $pushed) { conversation in
                ConversationView(conversation: conversation)
                    .task { _ = await model.restoreConversationIfNeeded(conversation) }
            }
    }

    private func routePending() {
        guard let conversation = pending else { return }
        pending = nil
        if conversation.id == currentConversationID { return }
        if let onOpenConversation {
            onOpenConversation(conversation)
        } else {
            pushed = conversation
        }
    }
}

private struct AuthorProfileDestinationModifier: ViewModifier {
    @EnvironmentObject private var model: AppModel
    @Binding var item: ConversationSummary?
    let source: ConversationSummary
    @State private var subject: ContactProfileSubject?

    private var detailsItem: Binding<ConversationSummary?> {
        Binding(
            get: { item.flatMap { $0.kind == .person ? nil : $0 } },
            set: { if $0 == nil { item = nil } }
        )
    }

    func body(content: Content) -> some View {
        content
            .navigationDestination(item: detailsItem) { destination in
                SessionDetailView(
                    conversation: destination,
                    presentationContext: .authorProfile(sourceConversation: source, destination: destination)
                )
            }
            .onChange(of: item) { _, destination in
                guard let destination, destination.kind == .person else { return }
                subject = model.contactProfileSubject(for: destination)
                item = nil
            }
            .contactProfileSheet(subject: $subject, currentConversationID: source.id)
    }
}

/// One contact in the Contacts list: the row opens the chat, the avatar and a
/// swipe open the profile.
struct ContactsContactEntry: View {
    let contact: CloudContact
    let conversation: ConversationSummary
    let onOpenConversation: ((ConversationSummary) -> Void)?
    let onOpenProfile: () -> Void

    var body: some View {
        Group {
            if let onOpenConversation {
                Button { onOpenConversation(conversation) } label: { row }
                    .buttonStyle(.plain)
            } else {
                NavigationLink(value: conversation) { row }
            }
        }
        .contactsListRow()
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Profile", systemImage: "person.crop.circle", action: onOpenProfile)
                .tint(KordiTheme.signalBlue)
        }
        .accessibilityAction(named: "Profile", onOpenProfile)
    }

    private var row: some View {
        ContactIdentityRow(contact: contact, onOpenProfile: onOpenProfile)
    }
}

enum ContactProfileRoute: Hashable {
    case groups
    case details(ConversationSummary)
    case focused(ConversationSummary, SessionDetailTab)
    case shared(ContactProfileSharedPage, ConversationSummary)
    case chat(ConversationSummary)
}

/// The header of a chat opens the contact profile page for a person and the
/// session details page for everything else (agents, groups, Kordi Support).
struct ConversationDetailsPage: View {
    @EnvironmentObject private var model: AppModel
    let conversation: ConversationSummary
    var onBack: (() -> Void)? = nil

    static func showsContactProfile(for conversation: ConversationSummary) -> Bool {
        conversation.kind == .person && !conversation.representsKordiSupport && !conversation.isAgentLaunchTemplate
    }

    var body: some View {
        if Self.showsContactProfile(for: conversation) {
            let subject = model.contactProfileSubject(for: conversation)
            ContactProfileView(
                subject: subject,
                profileModel: model.makeContactProfileModel(for: subject),
                style: .page(conversation: conversation, onBack: onBack),
                onOpenConversation: { _ in }
            )
            .id(subject.id)
        } else {
            SessionDetailView(conversation: conversation, onBack: onBack)
        }
    }
}
