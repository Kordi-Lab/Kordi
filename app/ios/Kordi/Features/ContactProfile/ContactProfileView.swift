import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// The contact profile sheet (issue #1945): header and tiles from the contact
/// row right away, sections once `GET /v1/cloud/contacts/{id}/profile` answers.
struct ContactProfileView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.calendar) private var calendar
    @Environment(\.locale) private var locale
    let subject: ContactProfileSubject
    /// Opens a chat behind the sheet; the presenter dismisses the sheet first.
    let onOpenConversation: (ConversationSummary) -> Void
    @StateObject private var profileModel: ContactProfileModel
    @State private var path: [ContactProfileRoute] = []
    @State private var showsShare = false
    @State private var ownerSubject: ContactProfileSubject?
    @State private var isMuting = false
    @State private var confirmsDelete = false
    @State private var deleteError: String?

    init(
        subject: ContactProfileSubject,
        profileModel: @autoclosure @escaping () -> ContactProfileModel,
        onOpenConversation: @escaping (ConversationSummary) -> Void
    ) {
        self.subject = subject
        self.onOpenConversation = onOpenConversation
        _profileModel = StateObject(wrappedValue: profileModel())
    }

    private var presentation: ContactProfilePresentation {
        ContactProfilePresentation(
            subject: subject,
            profile: profileModel.profile,
            isFallback: profileModel.isFallback,
            selfAccountId: model.account?.accountId,
            presence: model.contactPresenceByAccountID[subject.accountId],
            canDelete: profileModel.canDelete
        )
    }

    private var directConversation: ConversationSummary? {
        model.directConversation(withAccountId: subject.accountId)
    }

    private var isMuted: Bool {
        directConversation.map { model.mutedSessionIds.contains($0.sessionId) } ?? false
    }

    private var tint: Color {
        switch presentation.kind {
        case .person: KordiTheme.signalBlue
        case .agent: KordiTheme.agentViolet
        case .system: Color(uiColor: .systemGray)
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: ContactProfileRoute.self) { route in
                    switch route {
                    case .groups:
                        ContactProfileGroupsList(groups: presentation.shared?.groups ?? [], onOpen: openGroup)
                    case let .details(conversation):
                        SessionDetailView(conversation: conversation)
                    }
                }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .task { await profileModel.load() }
        .confirmationDialog("Delete contact?", isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button("Delete contact", role: .destructive, action: deleteContact)
        } message: {
            Text("They will need approval before messages can reach you again.")
        }
        .alert(
            "Could not delete contact",
            isPresented: Binding(get: { deleteError != nil }, set: { if !$0 { deleteError = nil } })
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(deleteError ?? "")
        }
        .sheet(isPresented: $showsShare) {
            ContactProfileShareSheet(name: presentation.name, kordiId: presentation.kordiId ?? "")
        }
        .sheet(item: $ownerSubject) { owner in
            ContactProfileView(subject: owner, profileModel: model.makeContactProfileModel(for: owner)) { conversation in
                ownerSubject = nil
                onOpenConversation(conversation)
            }
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                tiles
                    .padding(.horizontal, ContactProfileMetrics.gutter)
                    .padding(.top, 24)
                infoRows
                    .padding(.top, 24)
                if let shared = presentation.shared {
                    ContactProfileSharedSection(shared: shared, onOpenChat: openDirectChat, onOpenGroups: openGroups)
                }
                if let ground = presentation.commonGround {
                    ContactProfileCommonGroundSection(ground: ground)
                }
                if presentation.showsDelete {
                    ContactProfileDeleteRow { confirmsDelete = true }
                        .disabled(profileModel.isDeleting)
                }
            }
            .padding(.top, 52)
            .padding(.bottom, 44)
            .animation(.easeOut(duration: 0.2), value: profileModel.profile)
        }
        .background(alignment: .top) { wash }
        .background(Color(uiColor: .systemBackground))
        .overlay(alignment: .topTrailing) { closeButton }
    }

    private var wash: some View {
        RadialGradient(
            colors: [tint.opacity(0.2), tint.opacity(0.09), .clear],
            center: .top,
            startRadius: 0,
            endRadius: 380
        )
        .frame(height: 380)
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    private var closeButton: some View {
        Button { dismiss() } label: {
            Image(systemName: "xmark")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: 32, height: 32)
                .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 8)
        .padding(.trailing, 10)
        .accessibilityLabel("Close")
        .accessibilityIdentifier("contact-profile-close")
    }

    private var header: some View {
        VStack(spacing: 0) {
            IdentityAvatar(
                name: presentation.name,
                imageSource: presentation.avatarUrl,
                kind: presentation.kind == .agent ? .agent : .person,
                size: 96,
                seed: subject.accountId,
                cornerRadius: 48
            )
            .overlay(alignment: .bottomTrailing) {
                if presentation.isOnline {
                    Circle()
                        .fill(Color.green)
                        .frame(width: 16, height: 16)
                        .overlay { Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 2.5) }
                        .offset(x: -4, y: -4)
                        .accessibilityHidden(true)
                }
            }
            Text(presentation.name)
                .font(.title2.weight(.semibold))
                .lineLimit(1)
                .padding(.top, 14)
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(presentation.statusLine(now: context.date, calendar: calendar, locale: locale))
                    .font(.subheadline)
                    .foregroundStyle(presentation.statusTone == .online ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, ContactProfileMetrics.gutter)
        .accessibilityElement(children: .combine)
    }

    private var tiles: some View {
        HStack(spacing: 8) {
            ForEach(presentation.tiles) { tile in
                tileView(tile)
            }
        }
    }

    @ViewBuilder
    private func tileView(_ tile: ContactProfileTile) -> some View {
        switch tile {
        case .message:
            ContactProfileTileButton(title: "Message", systemImage: "message", action: openDirectOrAgentChat)
        case .mute:
            ContactProfileTileButton(
                title: isMuted ? "Unmute" : "Mute",
                systemImage: isMuted ? "bell.slash" : "bell",
                action: toggleMute
            )
            .disabled(directConversation == nil || isMuting)
        case .share:
            ContactProfileTileButton(title: "Share", systemImage: "square.and.arrow.up") { showsShare = true }
                .disabled(presentation.kordiId == nil)
        case .settings:
            ContactProfileTileButton(title: "Settings", systemImage: "gearshape", action: openOwnAgentSettings)
                .disabled(ownAgentConversation == nil)
        case .more:
            Menu {
                if presentation.isOwnAgent {
                    Button("Share", systemImage: "square.and.arrow.up") {}.disabled(true)
                } else {
                    Button("Block", systemImage: "nosign") {}.disabled(true)
                    Button("Report", systemImage: "flag") {}.disabled(true)
                    Divider()
                    if presentation.offersDelete {
                        Button("Delete contact", systemImage: "trash", role: .destructive) { confirmsDelete = true }
                            .disabled(!presentation.canDelete || profileModel.isDeleting)
                    }
                }
            } label: {
                ContactProfileTileLabel(title: "More", systemImage: "ellipsis")
            }
            .accessibilityLabel("More")
        }
    }

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(infoRowItems.enumerated()), id: \.element) { index, item in
                VStack(alignment: .leading, spacing: 0) {
                    if index > 0 { ContactProfileDivider() }
                    infoRow(item)
                }
            }
        }
    }

    private enum InfoRow: Hashable { case kordiId, about, type, theirAgent, owner, since }

    private var infoRowItems: [InfoRow] {
        var rows: [InfoRow] = []
        if presentation.showsKordiId { rows.append(.kordiId) }
        if presentation.about != nil { rows.append(.about) }
        if presentation.showsType { rows.append(.type) }
        if presentation.theirAgent != nil { rows.append(.theirAgent) }
        if presentation.owner != nil { rows.append(.owner) }
        if presentation.contactSince != nil { rows.append(.since) }
        return rows
    }

    @ViewBuilder
    private func infoRow(_ row: InfoRow) -> some View {
        switch row {
        case .kordiId:
            ContactProfileKordiIdRow(kordiId: presentation.kordiId ?? "")
        case .about:
            ContactProfileInfoRow(value: presentation.about ?? "", caption: "About")
        case .type:
            ContactProfileInfoRow(value: "Agent", caption: "Type")
        case .theirAgent:
            if let agent = presentation.theirAgent {
                let conversation = model.agentConversation(agentId: agent.agentId, accountId: agent.accountId)
                ContactProfilePersonRow(
                    name: CloudDefaultAgentProfile.displayName(agent.displayName, ownerName: presentation.name),
                    caption: "Their agent",
                    avatarUrl: agent.avatarUrl,
                    kind: .agent,
                    seed: agent.agentId,
                    action: conversation.map { target in { onOpenConversation(target) } }
                )
            }
        case .owner:
            if let owner = presentation.owner {
                let name = owner.displayName?.nonEmpty ?? owner.kordiId ?? "Kordi user"
                ContactProfilePersonRow(name: name, caption: "Owner", avatarUrl: owner.avatarUrl, kind: .person, seed: owner.accountId) {
                    ownerSubject = ContactProfileSubject(accountId: owner.accountId, name: name, avatarUrl: owner.avatarUrl, kordiId: owner.kordiId)
                }
            }
        case .since:
            if let since = presentation.contactSince {
                ContactProfileInfoRow(
                    value: ContactProfilePresentation.formattedDay(since, locale: locale, calendar: calendar),
                    caption: "Contact since"
                )
            }
        }
    }

    // MARK: Actions

    private var ownAgentConversation: ConversationSummary? {
        guard presentation.isOwnAgent else { return nil }
        return model.agentConversation(accountId: subject.accountId)
    }

    private func openDirectOrAgentChat() {
        if presentation.kind == .agent {
            if let conversation = model.agentConversation(accountId: subject.accountId) {
                onOpenConversation(conversation)
            }
            return
        }
        openDirectChat()
    }

    private func openDirectChat() {
        if let directConversation { onOpenConversation(directConversation) }
    }

    private func openGroups() {
        let groups = presentation.shared?.groups ?? []
        if groups.count == 1, let group = groups.first {
            openGroup(group)
        } else if groups.count > 1 {
            path.append(.groups)
        }
    }

    private func openGroup(_ group: CloudContactProfile.SharedGroup) {
        Task {
            if let conversation = model.groupConversation(groupSpaceId: group.groupId) {
                onOpenConversation(conversation)
            } else if let conversation = await model.commonGroundConversation(groupSpaceId: group.groupId) {
                onOpenConversation(conversation)
            }
        }
    }

    private func openOwnAgentSettings() {
        if let ownAgentConversation { path.append(.details(ownAgentConversation)) }
    }

    private func deleteContact() {
        Task {
            do {
                try await profileModel.removeContact()
                dismiss()
            } catch {
                deleteError = (error as? CloudAPIError)?.message.nonEmpty ?? "Could not delete this contact."
            }
        }
    }

    private func toggleMute() {
        guard let directConversation, !isMuting else { return }
        isMuting = true
        let muted = !isMuted
        Task {
            _ = await model.setConversationMuted(directConversation, muted: muted)
            isMuting = false
        }
    }
}

enum ContactProfileRoute: Hashable {
    case groups
    case details(ConversationSummary)
}

struct ContactProfileTileLabel: View {
    let title: String
    let systemImage: String
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: systemImage)
                .font(.system(size: 18, weight: .medium))
                .frame(height: 22)
            Text(title)
                .font(.caption.weight(.medium))
                .lineLimit(1)
        }
        .foregroundStyle(isEnabled ? KordiTheme.signalBlue : Color(uiColor: .tertiaryLabel))
        .frame(maxWidth: .infinity)
        .frame(height: ContactProfileMetrics.tileHeight)
        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct ContactProfileTileButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ContactProfileTileLabel(title: title, systemImage: systemImage)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}

/// Share: the Kordi ID as a QR code, with a copy button.
struct ContactProfileShareSheet: View {
    @Environment(\.dismiss) private var dismiss
    let name: String
    let kordiId: String
    @State private var copied = false

    var body: some View {
        VStack(spacing: 16) {
            Text(name)
                .font(.headline)
                .lineLimit(1)
                .padding(.top, 28)
            if let image = Self.qrImage(for: kordiId) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 200, height: 200)
                    .padding(12)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .accessibilityLabel("QR code for Kordi ID \(kordiId)")
            }
            Text(ContactProfilePresentation.formattedKordiId(kordiId))
                .font(.body.monospacedDigit())
                .foregroundStyle(.secondary)
            Button {
                UIPasteboard.general.string = kordiId
                copied = true
            } label: {
                Label(copied ? "Copied" : "Copy Kordi ID", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.roundedRectangle(radius: 12))
            .padding(.horizontal, 20)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity)
        .background(Color(uiColor: .systemBackground))
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }

    static func qrImage(for text: String) -> UIImage? {
        guard !text.isEmpty else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cgImage = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
