import SwiftUI

/// The shared card turned over: its topics with Hide or Show, the sources
/// that feed it, then Share, Rename (inline) and Delete. The full card page
/// with references and Rebuild stays on the Your card row.
struct CommonGroundCardDetail: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let card: CommonGroundWalletCard
    let cardWidth: CGFloat
    let onClose: () -> Void
    let onShare: () -> Void
    var onLook: (() -> Void)? = nil
    @State private var flipped = false
    @State private var renaming = false
    @State private var nameDraft = ""
    @State private var confirmsDelete = false
    @State private var backHeight: CGFloat = 0
    @FocusState private var nameFocused: Bool

    private var cardHeight: CGFloat { cardWidth * ProfileCardView.aspect }
    private var profile: CommonGroundProfileSummary? { model.profile(card.id) }
    private var title: String { profile?.title ?? card.name }
    private var allTopics: [String] { model.card?.topics.all ?? card.topics }

    var body: some View {
        GeometryReader { geo in
            let maxHeight = max(cardHeight, geo.size.height - 52 - 24)
            ZStack(alignment: .top) {
                Color.black.opacity(scheme == .dark ? 0.55 : 0.32)
                    .opacity(flipped ? 1 : 0)
                    .ignoresSafeArea()
                    .onTapGesture(perform: close)
                ZStack {
                    ProfileCardView(design: card.design, icon: card.icon, kindDesign: card.kindDesign, name: card.name, focus: card.focus, bottom: .topics(card.topics), width: cardWidth)
                        .opacity(flipped ? 0 : 1)
                    back(maxHeight: maxHeight)
                        .rotation3DEffect(.degrees(reduceMotion ? 0 : 180), axis: (x: 0, y: 1, z: 0))
                        .opacity(flipped ? 1 : 0)
                }
                .frame(width: cardWidth, height: flipped ? min(max(backHeight, cardHeight), maxHeight) : cardHeight, alignment: .top)
                .rotation3DEffect(.degrees(flipped && !reduceMotion ? 180 : 0), axis: (x: 0, y: 1, z: 0), perspective: 0.4)
                .shadow(color: .black.opacity(0.3), radius: 16, y: 12)
                .padding(.top, 52)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .onAppear {
            withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .easeOut(duration: 0.3)) { flipped = true }
        }
        .alert("Delete \(title)?", isPresented: $confirmsDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) { Task { await delete() } }
        } message: {
            Text("Its card goes, and you leave rooms it was shared in.")
        }
    }

    private func close() {
        if renaming { saveName() }
        withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .easeOut(duration: 0.3)) { flipped = false }
        Task {
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 200 : 300))
            onClose()
        }
    }

    private func back(maxHeight: CGFloat) -> some View {
        let palette = card.design.palette(scheme)
        return ScrollView(showsIndicators: false) {
            backContent(palette)
                .background(GeometryReader { inner in
                    Color.clear.preference(key: CardBackHeightKey.self, value: inner.size.height)
                })
        }
        .scrollBounceBehavior(.basedOnSize)
        .onPreferenceChange(CardBackHeightKey.self) { backHeight = $0 }
        .foregroundStyle(palette.text)
        .background(CommonGroundCardSurface(design: card.design, cornerRadius: 20, back: true))
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private func backContent(_ palette: CommonGroundCardPalette) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                CommonGroundCardGlyph(design: card.design, palette: palette, icon: card.icon, kindDesign: card.kindDesign,
                                      onTap: model.profilesEnabled && profile != nil ? onLook : nil)
                if renaming {
                    TextField("Name", text: $nameDraft)
                        .font(.system(size: 18, weight: .semibold))
                        .focused($nameFocused)
                        .submitLabel(.done)
                        .onSubmit(saveName)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(palette.pill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .padding(.leading, -8)
                } else {
                    Text(title)
                        .font(.system(size: 18, weight: .semibold))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .frame(width: 30, height: 30)
                        .background(palette.pill, in: Circle())
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            .padding(.leading, 16)
            .padding(.trailing, 12)
            .frame(height: 60)
            if let focus = card.focus, !focus.isEmpty {
                Text(focus)
                    .font(.system(size: 14))
                    .foregroundStyle(palette.secondary)
                    .padding(.horizontal, 16)
                    .padding(.top, -4)
            }
            sectionTitle("Topics", palette)
            VStack(spacing: 0) {
                ForEach(Array(allTopics.enumerated()), id: \.element) { index, topic in
                    if index > 0 { Rectangle().fill(palette.text.opacity(0.14)).frame(height: 0.5).padding(.leading, 12) }
                    topicRow(topic, palette)
                }
            }
            .background(palette.pill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .padding(.horizontal, 12)
            let sources = model.cardSources
            if !sources.isEmpty {
                sectionTitle("Sources", palette)
                FlowLayout(spacing: 6) {
                    ForEach(sources, id: \.self) { source in
                        Label(source, systemImage: Self.symbol(forSource: source))
                            .font(.system(size: 13, weight: .medium))
                            .labelStyle(CardBackChipLabelStyle())
                            .padding(.horizontal, 10)
                            .frame(height: 28)
                            .background(palette.pill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                }
                .padding(.horizontal, 16)
            }
            actions(palette)
        }
        .padding(.bottom, 14)
    }

    private func sectionTitle(_ text: String, _ palette: CommonGroundCardPalette) -> some View {
        Text(text)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(palette.secondary)
            .padding(.horizontal, 16)
            .padding(.top, 18)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }

    private func topicRow(_ topic: String, _ palette: CommonGroundCardPalette) -> some View {
        let hidden = model.isHidden(topic)
        return HStack(spacing: 10) {
            Text(topic)
                .font(.system(size: 15))
                .lineLimit(1)
                .strikethrough(hidden)
                .opacity(hidden ? 0.45 : 1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button { Task { await model.toggleHidden(topic) } } label: {
                Label(hidden ? "Show" : "Hide", systemImage: hidden ? "eye" : "eye.slash")
                    .font(.system(size: 13, weight: .medium))
                    .labelStyle(CardBackChipLabelStyle())
                    .foregroundStyle(palette.secondary)
                    .padding(.horizontal, 9)
                    .frame(height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.busy == "hidden")
            .accessibilityLabel("\(hidden ? "Show" : "Hide") \(topic)")
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .frame(minHeight: 44)
    }

    private func actions(_ palette: CommonGroundCardPalette) -> some View {
        HStack(spacing: 8) {
            actionButton("Share", "square.and.arrow.up", palette) { close(); onShare() }
            if model.profilesEnabled, profile != nil {
                actionButton("Rename", "pencil", palette) {
                    nameDraft = title
                    renaming = true
                    nameFocused = true
                }
            }
            Spacer(minLength: 0)
            actionButton("Delete", "trash", palette, color: palette.danger) { confirmsDelete = true }
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
    }

    private func actionButton(_ title: String, _ symbol: String, _ palette: CommonGroundCardPalette,
                              color: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.system(size: 13.5, weight: .semibold))
                .labelStyle(CardBackChipLabelStyle())
                .foregroundStyle(color ?? palette.text)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(palette.pill, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func saveName() {
        let name = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        renaming = false
        guard !name.isEmpty, name != title else { return }
        let id = card.id
        Task { await model.updateProfile(id, name: name) }
    }

    private func delete() async {
        let deleted: Bool
        if model.profilesEnabled, profile != nil {
            deleted = await model.deleteProfile(card.id)
        } else {
            deleted = await model.deleteCard()
        }
        if deleted {
            model.notice = "\(title) deleted"
            onClose()
        }
    }

    static func symbol(forSource source: String) -> String {
        let text = source.lowercased()
        if text.contains("memory") { return "brain" }
        if text.contains("mail") { return "envelope" }
        if text.contains("calendar") { return "calendar" }
        if text.contains("paper") || text.contains("pdf") { return "doc.text" }
        if text.contains("health") { return "heart" }
        if text.contains("note") { return "note.text" }
        if text.contains("link") || text.contains("web") { return "link" }
        if text.contains("photo") { return "photo" }
        return "doc"
    }
}

private struct CardBackHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Icon and title close together, as on the card's small chips.
private struct CardBackChipLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
    }
}
