import SwiftUI

/// The owner's card: topics with remove and add, Now and the timeline from
/// the profile, sharing, rebuild and delete. Tapping a tag opens its
/// references, where it can be hidden from others.
struct CommonGroundCardView: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var path: [CommonGroundRoute]
    @State private var references: CommonGroundReferenceTopic?
    @State private var adding: WritableKeyPath<CommonGroundTopics, [String]>?
    @State private var draft = ""
    @State private var confirmsDelete = false
    @State private var editing: CommonGroundProfileEditTarget?
    @FocusState private var draftFocused: Bool

    private var profile: CommonGroundProfile? { model.card?.profile }

    var body: some View {
        CommonGroundPage {
            CommonGroundHero(title: model.currentProfile?.title ?? "Your card", status: model.hasCard ? "\(model.myTopics.count) topics shared" : "") {
                CommonGroundAvatar(person: model.me, size: 92)
            }
            VStack(spacing: 16) {
                if let card = model.card {
                    if let latest = profile?.latest, !latest.isEmpty {
                        CommonGroundSection(title: "Now") {
                            FlowLayout(spacing: 8) {
                                ForEach(latest, id: \.self) { topic in
                                    CommonGroundTag(topic: topic, muted: model.isHidden(topic), onOpen: { open(topic) })
                                }
                            }
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    ForEach(CommonGroundTopics.sections.indices, id: \.self) { index in
                        let section = CommonGroundTopics.sections[index]
                        topicSection(section.title, section.key, topics: card.topics[keyPath: section.key])
                    }
                    if let profile, !profile.timeline.isEmpty || !profile.earlier.isEmpty {
                        CommonGroundTimeline(profile: profile, onOpen: open)
                    }
                    settings
                } else {
                    CommonGroundSection {
                        CommonGroundRow(title: model.buildTitle) { path.append(.build) }
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .overlay(alignment: .topTrailing) {
            if let profile = model.currentProfile {
                Menu {
                    CommonGroundProfileMenuItems(profile: profile, editing: $editing)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(.primary)
                        .frame(width: 44, height: 44)
                        .sessionGlass(in: Circle())
                        .contentShape(Circle())
                }
                .padding(.trailing, 16)
                .safeAreaPadding(.top, 8)
                .accessibilityLabel("Profile")
            }
        }
        .commonGroundProfileEditor($editing) { path = [] }
        .sheet(item: $references) { topic in
            CommonGroundReferences(topic: topic.label, profile: profile)
                .environmentObject(model)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .confirmationDialog("Delete your card?", isPresented: $confirmsDelete, titleVisibility: .visible) {
            Button("Delete card", role: .destructive) {
                Task { if await model.deleteCard() { path = [] } }
            }
        } message: {
            Text("People you met no longer see it.")
        }
    }

    private var settings: some View {
        VStack(spacing: 16) {
            CommonGroundSection {
                Toggle(isOn: Binding(get: { model.sharing }, set: { on in Task { await model.setSharing(on) } })) {
                    Text("Share my card").font(.body)
                }
                .disabled(model.busy == "sharing")
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .frame(minHeight: SessionDetailMetrics.rowMinHeight)
                SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset)
                CommonGroundRow(title: "Rebuild card") { path.append(.build) }
            }
            CommonGroundSection {
                Button(role: .destructive) { confirmsDelete = true } label: {
                    Text("Delete card")
                        .font(.body)
                        .foregroundStyle(.red)
                        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                        .frame(maxWidth: .infinity, minHeight: SessionDetailMetrics.rowMinHeight, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(SessionRowButtonStyle())
                .disabled(model.busy == "delete")
            }
        }
    }

    private func open(_ topic: String) {
        references = CommonGroundReferenceTopic(label: topic)
    }

    private func topicSection(_ title: String, _ key: WritableKeyPath<CommonGroundTopics, [String]>, topics: [String]) -> some View {
        CommonGroundSection(title: title) {
            FlowLayout(spacing: 8) {
                ForEach(topics, id: \.self) { topic in
                    CommonGroundTag(
                        topic: topic,
                        muted: model.isHidden(topic),
                        onOpen: { open(topic) },
                        onRemove: { Task { await model.removeTopic(topic, from: key) } }
                    )
                }
                if adding == key {
                    draftChip(for: key)
                } else {
                    Button {
                        if let open = adding { commit(to: open) }
                        adding = key
                        draftFocused = true
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "plus")
                                .font(.system(size: 11, weight: .semibold))
                            Text("Add")
                                .font(.subheadline.weight(.medium))
                        }
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .frame(height: commonGroundTagHeight)
                        .background(Color(uiColor: .tertiarySystemFill), in: commonGroundTagShape)
                        .contentShape(commonGroundTagShape)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Add to \(title)")
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Inline tag-sized field that grows with its text.
    private func draftChip(for key: WritableKeyPath<CommonGroundTopics, [String]>) -> some View {
        let max = CommonGroundModel.tagMax
        return HStack(spacing: 7) {
            Circle().fill(chatTheme.accent.opacity(0.35)).frame(width: 8, height: 8)
            ZStack(alignment: .leading) {
                // Invisible copy of the text sets the field's width.
                Text(draft.isEmpty ? "New topic" : draft)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .fixedSize()
                    .hidden()
                TextField("New topic", text: $draft)
                    .font(.subheadline.weight(.medium))
                    .focused($draftFocused)
                    .submitLabel(.done)
                    .onSubmit { commit(to: key) }
            }
            .frame(minWidth: 90, maxWidth: 240, alignment: .leading)
            .fixedSize(horizontal: true, vertical: false)
            if draft.count >= max - 10 {
                Text("\(draft.count)/\(max)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(draft.count >= max ? Color.red : Color.secondary)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: commonGroundTagHeight)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: commonGroundTagShape)
        .overlay(commonGroundTagShape.strokeBorder(chatTheme.accent.opacity(0.55), lineWidth: 1.5))
        .onChange(of: draft) { _, text in
            if text.count > max { draft = String(text.prefix(max)) }
        }
        .onChange(of: draftFocused) { _, focused in
            if !focused, adding == key { commit(to: key) }
        }
    }

    private func commit(to key: WritableKeyPath<CommonGroundTopics, [String]>) {
        let text = draft
        draft = ""
        adding = nil
        Task { await model.addTopic(text, to: key) }
    }
}

struct CommonGroundReferenceTopic: Identifiable {
    let label: String
    var id: String { label }
}
