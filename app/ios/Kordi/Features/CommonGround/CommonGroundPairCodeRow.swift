import SwiftUI

/// Home's Tap row (one to one) above the Pair code row: the "#" tile, four
/// digit boxes typed through one number field, an inline error and the
/// Create a code link. Tap stays enabled without a card: it opens the build.
struct CommonGroundPairCodeRow: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    @Binding var code: String
    var error: String?
    var enabled = true
    var onTap: (() -> Void)? = nil
    let onComplete: (String) -> Void
    let onCreate: () -> Void
    @FocusState private var focused: Bool

    private let titleInset: CGFloat = 58
    /// A code with no room only turns the boxes red; other errors keep their line.
    private var missing: Bool { error == CommonGroundModel.roomNotFound }

    var body: some View {
        CommonGroundSection {
            if let onTap {
                Button(action: onTap) {
                    HStack(spacing: 12) {
                        tile("iphone.radiowaves.left.and.right")
                        Text("Tap").font(.body).foregroundStyle(.primary)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                    .frame(minHeight: 56)
                    .contentShape(Rectangle())
                }
                .buttonStyle(SessionRowButtonStyle())
                SessionDetailSeparator(leading: titleInset - 16)
            }
            pairCode
                .disabled(!enabled)
                .opacity(enabled ? 1 : 0.5)
        }
    }

    private func tile(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 30, height: 30)
            .background(chatTheme.accent, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityHidden(true)
    }

    @ViewBuilder private var pairCode: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                tile("number")
                Text("Pair code").font(.body)
                Spacer(minLength: 8)
                digits
            }
            .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
            .frame(minHeight: 56)
            if let error, !missing {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .padding(.leading, titleInset)
                    .padding(.bottom, 8)
                    .padding(.top, -6)
            }
            SessionDetailSeparator(leading: titleInset - 16)
            Button(action: onCreate) {
                Text("Create a code")
                    .font(.body)
                    .foregroundStyle(chatTheme.accent)
                    .padding(.leading, titleInset)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private var digits: some View {
        ZStack {
            TextField("", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .focused($focused)
                .foregroundStyle(.clear)
                .tint(.clear)
                .frame(width: 1, height: 1)
                .opacity(0.02)
                .accessibilityLabel("Pair code")
                .accessibilityValue(missing ? "Room not found" : "")
            HStack(spacing: 6) {
                ForEach(0..<4, id: \.self) { index in
                    let digit = index < code.count ? String(Array(code)[index]) : ""
                    Text(digit)
                        .font(.system(size: 20, weight: .semibold).monospacedDigit())
                        .frame(width: 34, height: 40)
                        .background(missing ? Color.red.opacity(0.12) : Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay {
                            if missing {
                                RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.red, lineWidth: 1.5)
                            } else if focused && index == min(code.count, 3) {
                                RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(chatTheme.accent, lineWidth: 1.5)
                            }
                        }
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { focused = true }
            .accessibilityHidden(true)
        }
        .onChange(of: code) { _, text in
            let clean = String(text.filter(\.isNumber).prefix(4))
            if clean != text { code = clean; return }
            if clean.count == 4 {
                focused = false
                onComplete(clean)
            }
        }
    }
}

/// The sheet after a code: your cards in a carousel, the room's suggested
/// card first selected and labelled, and one Share this card.
struct CommonGroundJoinSheet: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Environment(\.dismiss) private var dismiss
    let code: String
    let cardWidth: CGFloat
    let onJoined: (CommonGroundRoom, CommonGroundProfileSummary?) -> Void
    @State private var selected: String?
    @State private var error: String?

    private var choices: [CommonGroundProfileSummary] { model.shareChoices }
    private var suggested: String? { model.suggestedProfile(forRoom: code) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CommonGroundSheetHeader(title: model.roomTitle(code), subtitle: model.roomDetail(code)) { dismiss() }
            CommonGroundCardCarousel(
                ids: choices.map(\.profileId),
                selection: $selected,
                cardWidth: cardWidth,
                zoom: 0.8,
                label: { $0 == suggested ? "Suggested for this room" : nil }
            ) { id in
                let profile = choices.first { $0.profileId == id }
                ProfileCardView(
                    design: model.design(ofProfile: id),
                    icon: profile?.cardIcon,
                    kindDesign: profile?.kindDesign,
                    name: profile?.title ?? "",
                    focus: profile?.focusLine,
                    bottom: .topics(id == model.currentProfileID ? model.myTopics : model.walletTopics[id] ?? []),
                    width: cardWidth
                )
            }
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity).padding(.bottom, 8)
            }
            Button("Share this card") { Task { await share() } }
                .buttonStyle(CommonGroundPrimaryButtonStyle())
                .disabled(selected == nil || model.busy == "join")
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .onAppear { selected = model.preselectedProfile(forRoom: code) }
    }

    private func share() async {
        error = nil
        if let room = await model.joinFromHome(code, profileId: selected) {
            onJoined(room, model.profile(selected))
            dismiss()
        } else {
            // The sheet covers the toast, so the error shows here.
            error = model.notice
            model.notice = nil
        }
    }
}

/// A sheet's title, an optional line under it and a round close button.
struct CommonGroundSheetHeader: View {
    let title: String
    var subtitle: String? = nil
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 22, weight: .bold))
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 32, height: 32)
                    .background(Color(uiColor: .tertiarySystemFill), in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
        }
        .padding(.top, 22)
        .padding(.bottom, 8)
    }
}

/// Cards in a paged, centred carousel: the selected one full size, the
/// others smaller and faded, page dots below.
struct CommonGroundCardCarousel<Card: View>: View {
    @Environment(\.kordiChatTheme) private var chatTheme
    let ids: [String]
    @Binding var selection: String?
    let cardWidth: CGFloat
    var zoom: CGFloat = 0.8
    var label: (String) -> String? = { _ in nil }
    /// A line between the cards and the dots, such as the design's name.
    var caption: String? = nil
    @ViewBuilder let card: (String) -> Card
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let width = cardWidth * zoom
        let height = cardWidth * ProfileCardView.aspect * zoom
        VStack(spacing: 18) {
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 12) {
                    ForEach(ids, id: \.self) { id in
                        let isSelected = id == selection
                        card(id)
                            .scaleEffect(zoom)
                            .frame(width: width, height: height)
                            .overlay(alignment: .top) {
                                if let text = label(id) {
                                    Label(text, systemImage: "sparkles")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(chatTheme.accent)
                                        .padding(.horizontal, 9)
                                        .frame(height: 22)
                                        .background(chatTheme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                                        .fixedSize()
                                        .offset(y: -28)
                                }
                            }
                            .scaleEffect(isSelected ? 1 : 0.9)
                            .opacity(isSelected ? 1 : 0.55)
                            .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: isSelected)
                            .onTapGesture {
                                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.28)) { selection = id }
                            }
                            .id(id)
                    }
                }
                .scrollTargetLayout()
                .padding(.top, 30)
            }
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $selection, anchor: .center)
            // The wallet's card width leaves 26 pt each side of the screen.
            .contentMargins(.horizontal, max(0, (cardWidth + 52 - width) / 2), for: .scrollContent)
            .padding(.horizontal, -16)
            .frame(height: height + 30)
            if let caption {
                Text(caption)
                    .font(.system(size: 13.5, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, -8)
            }
            HStack(spacing: 7) {
                ForEach(ids, id: \.self) { id in
                    Circle()
                        .fill(id == selection ? Color.primary : Color(uiColor: .separator))
                        .frame(width: 7, height: 7)
                        .scaleEffect(id == selection ? 1.15 : 1)
                }
            }
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
        }
        .padding(.bottom, 16)
    }
}
