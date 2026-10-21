import SwiftUI
import UIKit

/// Metrics of the iPhone profile sheet, taken from the approved preview.
enum ContactProfileMetrics {
    static let gutter: CGFloat = 20
    static let infoRowMinHeight: CGFloat = 52
    static let sharedRowMinHeight: CGFloat = 48
    static let sharedDividerInset: CGFloat = 52
    static let tileHeight: CGFloat = 62
}

/// A flat row divider starting at `inset`, the Settings-sheet style.
struct ContactProfileDivider: View {
    var inset: CGFloat = ContactProfileMetrics.gutter

    var body: some View {
        Divider().padding(.leading, inset)
    }
}

/// Small section label: "Shared with you", "Common ground".
struct ContactProfileSectionLabel: View {
    let title: String

    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .textCase(nil)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, ContactProfileMetrics.gutter)
            .padding(.top, 28)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Value over a caption ("Kordi ID", "About"), with optional leading and trailing views.
struct ContactProfileInfoRow<Leading: View, Trailing: View>: View {
    let value: String
    let caption: String
    var valueColor: Color = .primary
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            leading
            VStack(alignment: .leading, spacing: 1) {
                Text(value)
                    .font(.body)
                    .foregroundStyle(valueColor)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Text(caption)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            trailing
        }
        .padding(.leading, ContactProfileMetrics.gutter)
        .padding(.trailing, 16)
        .padding(.vertical, 10)
        .frame(minHeight: ContactProfileMetrics.infoRowMinHeight)
        .fixedSize(horizontal: false, vertical: true)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

extension ContactProfileInfoRow where Leading == EmptyView, Trailing == EmptyView {
    init(value: String, caption: String, valueColor: Color = .primary) {
        self.init(value: value, caption: caption, valueColor: valueColor, leading: { EmptyView() }, trailing: { EmptyView() })
    }
}

/// Kordi ID row with a copy button that turns into a check for a moment.
struct ContactProfileKordiIdRow: View {
    let kordiId: String
    @State private var copied = false

    var body: some View {
        ContactProfileInfoRow(
            value: ContactProfilePresentation.formattedKordiId(kordiId),
            caption: "Kordi ID",
            valueColor: KordiTheme.signalBlue
        ) {
            EmptyView()
        } trailing: {
            Button(action: copy) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(copied ? "Copied" : "Copy Kordi ID")
        }
    }

    private func copy() {
        UIPasteboard.general.string = kordiId
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }
}

/// A person row (their agent, the owner) that opens something.
struct ContactProfilePersonRow: View {
    let name: String
    let caption: String
    let avatarUrl: String?
    let kind: ConversationKind
    let seed: String?
    let action: (() -> Void)?

    var body: some View {
        Button { action?() } label: {
            ContactProfileInfoRow(value: name, caption: caption) {
                IdentityAvatar(name: name, imageSource: avatarUrl, kind: kind, size: 28, seed: seed, cornerRadius: 14)
            } trailing: {
                if action != nil { SettingsChevron() }
            }
        }
        .buttonStyle(.plain)
        .allowsHitTesting(action != nil)
    }
}

/// "Shared with you": four counted rows, or one muted line when nothing is shared.
struct ContactProfileSharedSection: View {
    let shared: CloudContactProfile.Shared
    let onOpenChat: () -> Void
    let onOpenGroups: () -> Void

    var body: some View {
        ContactProfileSectionLabel("Shared with you")
        if shared.isEmpty {
            Text("Nothing shared yet")
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: ContactProfileMetrics.sharedRowMinHeight, alignment: .leading)
                .padding(.horizontal, ContactProfileMetrics.gutter)
        } else {
            row("photo", "Photos and files", shared.mediaCount, action: onOpenChat)
            ContactProfileDivider(inset: ContactProfileMetrics.sharedDividerInset)
            row("link", "Links", shared.linkCount, action: onOpenChat)
            ContactProfileDivider(inset: ContactProfileMetrics.sharedDividerInset)
            row("doc.text", "Documents", shared.documentCount, action: onOpenChat)
            ContactProfileDivider(inset: ContactProfileMetrics.sharedDividerInset)
            row("person.2", "Groups in common", shared.groups.count, groups: Array(shared.groups.prefix(2)), action: onOpenGroups)
        }
    }

    private func row(
        _ systemImage: String,
        _ title: String,
        _ count: Int,
        groups: [CloudContactProfile.SharedGroup] = [],
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: systemImage)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                Text(title)
                    .font(.body)
                    .foregroundStyle(count == 0 ? .secondary : .primary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !groups.isEmpty {
                    HStack(spacing: -6) {
                        ForEach(groups) { group in
                            IdentityAvatar(name: group.title, imageSource: group.avatarUrl, kind: .group, size: 20, seed: group.groupId, cornerRadius: 10)
                                .overlay { Circle().stroke(Color(uiColor: .systemBackground), lineWidth: 1.5) }
                        }
                    }
                }
                Text("\(count)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(count == 0 ? .tertiary : .secondary)
                SettingsChevron()
            }
            .padding(.leading, ContactProfileMetrics.gutter)
            .padding(.trailing, 16)
            .frame(minHeight: ContactProfileMetrics.sharedRowMinHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(count == 0)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(count)")
    }
}

/// "Common ground": label and chips for each list that has topics.
struct ContactProfileCommonGroundSection: View {
    let ground: CloudContactProfile.CommonGround

    var body: some View {
        ContactProfileSectionLabel("Common ground")
        VStack(alignment: .leading, spacing: 10) {
            line("Working on", ground.workingOn)
            line("Can help", ground.canHelp)
            line("Looking for", ground.lookingFor)
        }
        .padding(.horizontal, ContactProfileMetrics.gutter)
        .padding(.top, 10)
        .padding(.bottom, 6)
    }

    @ViewBuilder
    private func line(_ label: String, _ topics: [String]) -> some View {
        if !topics.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(width: 84, alignment: .leading)
                FlowLayout(spacing: 6) {
                    ForEach(Array(topics.prefix(4).enumerated()), id: \.offset) { _, topic in
                        Text(topic)
                            .font(.caption)
                            .lineLimit(1)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Color(uiColor: .tertiarySystemFill), in: Capsule())
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// Red "Delete contact" row. Disabled while the server has no route to remove a contact.
struct ContactProfileDeleteRow: View {
    let action: (() -> Void)?

    var body: some View {
        Button(role: .destructive) { action?() } label: {
            Label("Delete contact", systemImage: "trash")
                .font(.body)
                .foregroundStyle(.red)
                .frame(maxWidth: .infinity, minHeight: SettingsMetrics.rowMinHeight, alignment: .leading)
                .padding(.horizontal, ContactProfileMetrics.gutter)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
        .opacity(action == nil ? 0.45 : 1)
        .padding(.top, 24)
    }
}

/// Groups in common, when there is more than one.
struct ContactProfileGroupsList: View {
    let groups: [CloudContactProfile.SharedGroup]
    let onOpen: (CloudContactProfile.SharedGroup) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                    if index > 0 { ContactProfileDivider(inset: 68) }
                    Button { onOpen(group) } label: {
                        HStack(spacing: 12) {
                            IdentityAvatar(name: group.title, imageSource: group.avatarUrl, kind: .group, size: 36, seed: group.groupId, cornerRadius: 18)
                            Text(group.title)
                                .font(.body)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            SettingsChevron()
                        }
                        .padding(.leading, ContactProfileMetrics.gutter)
                        .padding(.trailing, 16)
                        .frame(minHeight: 56)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .background(Color(uiColor: .systemBackground))
        .navigationTitle("Groups in common")
        .navigationBarTitleDisplayMode(.inline)
    }
}
