import SwiftUI

struct CommonGroundHome: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var path: [CommonGroundRoute]
    var onClose: (() -> Void)? = nil
    @State private var theirCode = ""
    @State private var asksSharing = false
    @FocusState private var codeFocused: Bool

    var body: some View {
        CommonGroundPage(showsBack: onClose != nil, onBack: onClose) {
            CommonGroundHero(title: "Common ground", status: model.me.displayName) {
                CommonGroundAvatar(person: model.me, size: 92)
            } actions: {
                CommonGroundActions(columns: 2) {
                    SessionProfileActionButton(title: "Pair code", symbol: "circle.grid.3x3", tint: commonGroundTint) {
                        if model.sharing { path.append(.code) } else { asksSharing = true }
                    }
                    SessionProfileActionButton(title: "Your card", symbol: "person.text.rectangle", tint: commonGroundTint) {
                        path.append(.card)
                    }
                }
            }

            VStack(spacing: 16) {
                cardSection
                pairSection
                recentSection
            }
            .padding(.horizontal, 16)
        }
        .task { await model.loadHome() }
        .task(id: model.isBuilding) { await model.waitForBuild() }
        .alert("Turn on sharing?", isPresented: $asksSharing) {
            Button("Turn on") {
                Task {
                    await model.setSharing(true)
                    if model.sharing { path.append(.code) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Others in a room see your topics.")
        }
    }

    private var cardSection: some View {
        CommonGroundSection(title: "Your card") {
            if model.isBuilding {
                CommonGroundRow(title: "Building your card")
            } else {
                Button { path.append(.card) } label: {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 12) {
                            Text(model.loaded ? "\(model.myTopics.count) topics shared" : "Loading")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        if !model.myTopics.isEmpty {
                            FlowLayout(spacing: 6) {
                                ForEach(model.myTopics.prefix(8), id: \.self) { CommonGroundTopicPill(topic: $0) }
                            }
                        }
                    }
                    .padding(SessionDetailMetrics.rowHorizontalInset)
                    .contentShape(Rectangle())
                }
                .buttonStyle(SessionRowButtonStyle())
            }
        }
    }

    // MARK: Pair

    private var pairSection: some View {
        CommonGroundSection(title: "Pair") {
            if !model.sharing {
                HStack(spacing: 12) {
                    Text("Sharing is off").font(.body)
                    Spacer(minLength: 8)
                    Button("Turn on") { Task { await model.setSharing(true) } }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(model.busy == "sharing")
                }
                .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
                .frame(minHeight: SessionDetailMetrics.rowMinHeight)
            } else {
                myCodeRow
                SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset)
                theirCodeRow
            }
        }
    }

    private var myCodeRow: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.pairCode?.code ?? "No code")
                    .font(.system(.title2, design: .monospaced).weight(.semibold))
                    .textSelection(.enabled)
                    .accessibilityLabel(model.pairCode.map { "Your code \($0.code)" } ?? "No code")
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(expiryLine(at: context.date))
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Button("New code") { Task { await model.newPairCode() } }
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .padding(.vertical, 10)
        .frame(minHeight: SessionDetailMetrics.rowMinHeight)
    }

    private var theirCodeRow: some View {
        HStack(spacing: 12) {
            TextField("Their code", text: $theirCode)
                .font(.system(.body, design: .monospaced))
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .focused($codeFocused)
                .onSubmit(pair)
            Button("Pair", action: pair)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(theirCode.trimmingCharacters(in: .whitespaces).count < 8 || model.busy == "redeem")
        }
        .padding(.horizontal, SessionDetailMetrics.rowHorizontalInset)
        .frame(minHeight: SessionDetailMetrics.rowMinHeight)
    }

    private func expiryLine(at now: Date) -> String {
        guard let expiry = model.pairCode?.expiry else { return "Show this code to pair" }
        let seconds = Int(expiry.timeIntervalSince(now).rounded(.up))
        guard seconds > 0 else { return "Expired" }
        return String(format: "Expires in %d:%02d", seconds / 60, seconds % 60)
    }

    private func pair() {
        let code = theirCode
        Task {
            guard let id = await model.redeem(code) else { return }
            theirCode = ""
            codeFocused = false
            path.append(.person(id, paired: true))
        }
    }

    // MARK: Recent

    private var recentSection: some View {
        CommonGroundSection(title: "Recent") {
            if model.recent.isEmpty {
                CommonGroundRow(title: "No matches yet")
            } else {
                CommonGroundPeopleRows(
                    entries: model.recent.map { .init(person: $0.person, subtitle: $0.headline ?? "", score: $0.score) }
                ) { path.append(.match($0.accountId)) }
            }
        }
    }
}
