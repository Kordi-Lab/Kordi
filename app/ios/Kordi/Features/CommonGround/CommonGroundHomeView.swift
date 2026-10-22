import SwiftUI

/// Grounding's Home: the shared card's chip, the wallet, the Pair code row,
/// Rooms, Recent and Your card.
struct CommonGroundHome: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var path: [CommonGroundRoute]
    var onClose: (() -> Void)? = nil
    @State private var containerWidth: CGFloat = 390
    @State private var fanned = false
    @State private var detail: CommonGroundWalletCard?
    @State private var code = ""
    @State private var codeError: String?
    @State private var joinCode: CommonGroundCodeTarget?
    @State private var createFor: CommonGroundCodeTarget?
    @State private var addsCard = false
    @State private var lookFor: CommonGroundCodeTarget?
    @State private var afterSharing: SharingStep?

    private enum SharingStep { case join(String), create(String?) }

    private var cardWidth: CGFloat { ProfileCardView.width(in: containerWidth) }
    private var selectedCard: CommonGroundWalletCard? {
        model.walletCards.first { $0.id == model.walletSelectedID }
    }
    private var canPair: Bool { model.hasCard || model.anyProfileHasCard }

    var body: some View {
        CommonGroundPage(showsBack: onClose != nil, onBack: onClose) {
            VStack(spacing: 16) {
                if let card = selectedCard, !card.isSuggested {
                    CommonGroundSharingChip(design: card.design, name: card.name)
                        .animation(.easeOut(duration: 0.24), value: card.id)
                }
                CommonGroundWallet(
                    cardWidth: cardWidth,
                    fanned: $fanned,
                    hiddenID: detail?.id,
                    onDetail: openDetail,
                    onBuild: { path.append(.build) },
                    onNewCard: { addsCard = true },
                    onLook: { lookFor = CommonGroundCodeTarget(profileId: $0) }
                )
                .padding(.bottom, 8)
                VStack(spacing: 24) {
                    CommonGroundPairCodeRow(
                        code: $code,
                        error: codeError,
                        enabled: canPair,
                        onComplete: entered,
                        onCreate: { create(for: model.currentProfileID) }
                    )
                    CommonGroundRoomsSection(path: $path)
                    if !model.recent.isEmpty { recentSection }
                    if let card = selectedCard, !card.isSuggested { yourCard(card) }
                }
            }
            .padding(.horizontal, 16)
            .onGeometryChange(for: CGFloat.self) { $0.size.width + 32 } action: { containerWidth = $0 }
        }
        .overlay(alignment: .top) {
            Text("Grounding")
                .font(.headline)
                .frame(height: 44)
                .safeAreaPadding(.top, 8)
                .allowsHitTesting(false)
                .accessibilityAddTraits(.isHeader)
        }
        .overlay {
            if let detail {
                CommonGroundCardDetail(
                    card: model.walletCards.first { $0.id == detail.id } ?? detail,
                    cardWidth: cardWidth,
                    onClose: { self.detail = nil },
                    onShare: { create(for: detail.id) },
                    onLook: { lookFor = CommonGroundCodeTarget(profileId: detail.id) }
                )
            }
        }
        .onChange(of: code) { _, typed in if !typed.isEmpty { codeError = nil } }
        .task { await model.loadHome(); await model.loadWalletTopics() }
        .task(id: model.isBuilding) { await model.waitForBuild() }
        .sheet(item: $joinCode, onDismiss: { code = "" }) { target in
            CommonGroundJoinSheet(code: target.code ?? "", cardWidth: cardWidth) { room, profile in
                model.notice = profile.map { "Sharing \($0.title) in \(room.title)" } ?? "Joined \(room.title)"
            }
            .environmentObject(model)
            .presentationDetents([.height(model.roomDetail(target.code ?? "") == nil ? 470 : 492)])
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $createFor) { target in
            CommonGroundCreateCodeSheet(initialProfileID: target.profileId)
                .environmentObject(model)
                .presentationDetents([.height(390)])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $lookFor) { target in
            if let id = target.profileId, let profile = model.profile(id) {
                CommonGroundCardLookSheet(
                    design: profile.cardDesign,
                    icon: profile.cardIcon,
                    kindDesign: profile.kindDesign,
                    onDesign: { design in Task { await model.setCardLook(id, design: design) } },
                    onIcon: { icon in Task { await model.setCardLook(id, icon: .some(icon)) } }
                )
                .presentationDetents([.medium])
                .presentationDragIndicator(.visible)
            }
        }
        .sheet(isPresented: $addsCard) {
            CommonGroundNewCardSheet(cardWidth: cardWidth)
                .environmentObject(model)
                .presentationDetents([.height(470)])
                .presentationDragIndicator(.visible)
        }
        .alert("Turn on sharing?", isPresented: Binding(get: { afterSharing != nil }, set: { if !$0 { afterSharing = nil } })) {
            Button("Turn on") {
                let step = afterSharing
                Task {
                    await model.setSharing(true)
                    guard model.sharing, let step else { return }
                    switch step {
                    case .join(let entered): join(entered)
                    case .create(let profileId): createFor = CommonGroundCodeTarget(profileId: profileId)
                    }
                }
            }
            Button("Cancel", role: .cancel) { code = "" }
        } message: {
            Text("Others in a room see your topics.")
        }
    }

    // MARK: Actions

    private func openDetail(_ id: String) {
        guard let card = model.walletCards.first(where: { $0.id == id }), card.hasCard else { return }
        fanned = false
        detail = card
    }

    private func create(for profileId: String?) {
        guard canPair else { return }
        if model.sharing { createFor = CommonGroundCodeTarget(profileId: profileId) } else { afterSharing = .create(profileId) }
    }

    /// Looks the code up once, then joins, asking to turn on sharing first.
    private func entered(_ entered: String) {
        codeError = nil
        guard !model.isInOpenRoom(entered) else { return join(entered) }
        Task {
            switch await model.previewRoom(entered) {
            case .failed(let message):
                codeError = message
                code = ""
                return
            case .found(let room) where room.member:
                code = ""
                model.notice = "Already in \(room.title)"
                return
            case .found, .unavailable:
                break
            }
            if model.sharing { join(entered) } else { afterSharing = .join(entered) }
        }
    }

    private func join(_ entered: String) {
        if model.isInOpenRoom(entered) {
            code = ""
            model.notice = "Already in \(model.roomTitle(entered))"
            return
        }
        if model.asksWhichProfile {
            joinCode = CommonGroundCodeTarget(code: entered)
            return
        }
        Task {
            let profileId = model.shareChoices.first?.profileId
            if let room = await model.joinFromHome(entered, profileId: profileId) {
                model.notice = model.profile(profileId).map { "Sharing \($0.title) in \(room.title)" } ?? "Joined \(room.title)"
            } else {
                // The row shows the error under the boxes instead of the toast.
                codeError = model.notice
                model.notice = nil
            }
            code = ""
        }
    }

    // MARK: Sections

    private func yourCard(_ card: CommonGroundWalletCard) -> some View {
        CommonGroundSection(title: "Your card") {
            Button { path.append(.card) } label: {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 12) {
                        CommonGroundCardSwatch(design: card.design)
                        Text(card.name).font(.body).foregroundStyle(.primary)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    if !card.topics.isEmpty {
                        FlowLayout(spacing: 6) {
                            ForEach(card.topics.prefix(8), id: \.self) { CommonGroundTag(topic: $0) }
                        }
                    }
                }
                .padding(SessionDetailMetrics.rowHorizontalInset)
                .contentShape(Rectangle())
            }
            .buttonStyle(SessionRowButtonStyle())
        }
    }

    private var recentSection: some View {
        CommonGroundSection(title: "Recent") {
            CommonGroundPeopleRows(
                entries: model.recent.map { .init(person: $0.person, subtitle: $0.headline ?? "", score: $0.score) }
            ) { person in
                model.view(person.accountId, through: model.recent.first { $0.person == person }?.profileId)
                path.append(.match(person.accountId))
            }
        }
    }
}

/// What a code sheet opens with: the typed code, or the card to share.
struct CommonGroundCodeTarget: Identifiable {
    var code: String?
    var profileId: String?
    let id = UUID()
}
