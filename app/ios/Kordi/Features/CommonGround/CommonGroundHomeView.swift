import SwiftUI

/// Grounding's Home: the shared card's chip, the wallet, Tap and the Pair
/// code row, Rooms, Recent and Your card. A pairing link opens here.
struct CommonGroundHome: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.scenePhase) private var scenePhase
    @Binding var path: [CommonGroundRoute]
    var onClose: (() -> Void)? = nil
    @State private var containerWidth: CGFloat = 390
    @State private var fanned = false
    @State private var detail: CommonGroundWalletCard?
    @State private var code = ""
    @State private var codeError: String?
    @State private var joinCode: CommonGroundCodeTarget?
    @State private var createFor: CommonGroundCodeTarget?
    @State private var enterAfterCreate: String?
    @State private var createdRoom: CommonGroundRoom?
    @State private var addsCard = false
    @State private var lookFor: CommonGroundCodeTarget?
    @State private var afterSharing: SharingStep?
    @State private var tapping = false
    /// What to do once the Tap sheet has closed.
    @State private var afterTap: AfterTap?
    @ObservedObject private var pairLinks = CommonGroundPairLinkInbox.shared

    private enum SharingStep { case join(String), create(String?), tap, pair(String) }
    private enum AfterTap { case open(CommonGroundRoute), askSharing }

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
                        onTap: startTap,
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
        .task { await model.refreshHome() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.refreshHome() } }
        }
        .task(id: model.isBuilding) { await model.waitForBuild() }
        .sheet(item: $joinCode, onDismiss: { code = "" }) { target in
            CommonGroundJoinSheet(code: target.code ?? "", cardWidth: cardWidth) { room, profile in
                model.notice = profile.map { "Sharing \($0.title) in \(room.title)" } ?? "Joined \(room.title)"
            }
            .environmentObject(model)
            .presentationDetents([.height(model.roomDetail(target.code ?? "") == nil ? 470 : 492)])
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $createFor, onDismiss: {
            createdRoom = nil
            if let code = enterAfterCreate { enterAfterCreate = nil; path.append(.results(code)) }
        }) { target in
            CommonGroundCreateCodeSheet(initialProfileID: target.profileId, created: $createdRoom) { room in
                enterAfterCreate = room.code
                createFor = nil
            }
            .environmentObject(model)
            .presentationDetents([.height(452)])
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
        .sheet(isPresented: $tapping, onDismiss: {
            guard let next = afterTap else { return }
            afterTap = nil
            switch next {
            case .open(let route): path.append(route)
            case .askSharing: afterSharing = .tap
            }
        }) {
            CommonGroundTapSheet(cardWidth: cardWidth) { card in
                afterTap = .open(.match(card.person.accountId))
                tapping = false
            } onProblem: { problem in
                tapping = false
                afterTap = problem == .noCard ? .open(.build) : problem == .sharingOff ? .askSharing : nil
            }
            .environmentObject(model)
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        .task(id: model.loaded ? pairLinks.code : nil) {
            if model.loaded, let code = pairLinks.take() { pair(link: code) }
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
                    case .tap: tapping = true
                    case .pair(let code): pair(link: code)
                    }
                }
            }
            Button("Cancel", role: .cancel) { code = "" }
        } message: {
            switch afterSharing {
            case .tap, .pair: Text("The person you pair with sees your topics.")
            default: Text("Others in a room see your topics.")
            }
        }
    }

    // MARK: Actions

    /// Tap without a card opens the build; with sharing off it asks first.
    private func startTap() {
        guard canPair else { return path.append(.build) }
        if model.sharing { tapping = true } else { afterSharing = .tap }
    }

    /// A `kordi://common-ground/pair/<code>` link: pairs with the selected card.
    private func pair(link code: String) {
        guard canPair else { return path.append(.build) }
        guard model.sharing else { afterSharing = .pair(code); return }
        Task {
            switch await model.redeemPairCode(code) {
            case .paired(let card): path.append(.match(card.person.accountId))
            case .codeGone: model.notice = CommonGroundPairCopy.expired
            case .failed(let message): model.notice = message
            }
        }
    }

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
    /// A room you are already in opens as it is: joining again with another
    /// card would switch the shared card and clear its matches.
    private func entered(_ entered: String) {
        codeError = nil
        guard !model.isInOpenRoom(entered) else { return open(entered) }
        Task {
            switch await model.previewRoom(entered) {
            case .stale:
                return
            case .failed(let message):
                codeError = message
                code = ""
                return
            case .found(let room) where room.member:
                return open(entered)
            case .found, .unavailable:
                break
            }
            if model.sharing { join(entered) } else { afterSharing = .join(entered) }
        }
    }

    private func open(_ entered: String) {
        code = ""
        path.append(.results(entered))
    }

    private func join(_ entered: String) {
        if model.isInOpenRoom(entered) { return open(entered) }
        if model.asksWhichProfile {
            joinCode = CommonGroundCodeTarget(code: entered)
            return
        }
        Task {
            let profileId = model.preselectedProfile(forRoom: entered)
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
