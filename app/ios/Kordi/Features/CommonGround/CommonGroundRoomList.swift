import SwiftUI

// Rooms the viewer can come back to: `GET rooms`, listed on Home.

private extension KeyedDecodingContainer {
    func cgListValue<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        ((try? decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
    }
}

struct CommonGroundRoomSummary: Decodable, Hashable, Identifiable {
    let code: String
    let name: String
    /// False once the room is closed; its results stay readable.
    let open: Bool
    let memberCount: Int
    let joinedAt: String?
    let lastActivityAt: String?
    let themeCount: Int
    var id: String { code }

    private enum CodingKeys: String, CodingKey { case code, name, open, memberCount, joinedAt, lastActivityAt, themeCount }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        name = c.cgListValue(.name, "")
        open = c.cgListValue(.open, true)
        memberCount = c.cgListValue(.memberCount, 0)
        joinedAt = c.cgListValue(.joinedAt, nil as String?)
        lastActivityAt = c.cgListValue(.lastActivityAt, nil as String?)
        themeCount = c.cgListValue(.themeCount, 0)
    }

    var title: String { name.trimmingCharacters(in: .whitespaces).isEmpty ? "Room \(code)" : name }

    /// "<n> people · <k> topics", with "Closed" when the room is closed.
    var subtitle: String {
        let people = memberCount == 1 ? "1 person" : "\(memberCount) people"
        let topics = themeCount == 1 ? "1 topic" : "\(themeCount) topics"
        return ([people, topics] + (open ? [] : ["Closed"])).joined(separator: " · ")
    }
}

struct CommonGroundRoomList: Decodable, Hashable {
    let rooms: [CommonGroundRoomSummary]

    private enum CodingKeys: String, CodingKey { case rooms }

    init(rooms: [CommonGroundRoomSummary]) { self.rooms = rooms }

    init(from decoder: Decoder) throws {
        rooms = try decoder.container(keyedBy: CodingKeys.self).cgListValue(.rooms, [])
    }
}

/// Home's "Rooms" section; hidden until the server lists rooms.
struct CommonGroundRoomsSection: View {
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var path: [CommonGroundRoute]

    var body: some View {
        if let rooms = model.roomList, !rooms.isEmpty {
            CommonGroundSection(title: "Rooms") {
                ForEach(Array(rooms.enumerated()), id: \.element.id) { index, room in
                    if index > 0 { SessionDetailSeparator(leading: SessionDetailMetrics.rowHorizontalInset) }
                    CommonGroundSwipeToRemove {
                        CommonGroundRow(title: room.title, subtitle: room.subtitle) { path.append(.results(room.code)) }
                    } remove: {
                        Task { await model.leaveRoom(room.code) }
                    }
                }
            }
        }
    }
}

/// A row that reveals Remove when swiped left; a full swipe removes it.
struct CommonGroundSwipeToRemove<Content: View>: View {
    @ViewBuilder let content: Content
    let remove: () -> Void
    @State private var offset: CGFloat = 0
    @State private var resting: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let revealWidth: CGFloat = 88

    var body: some View {
        ZStack(alignment: .trailing) {
            if offset < 0 {
                Button(role: .destructive, action: commit) {
                    Text("Remove")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(width: max(revealWidth, -offset))
                        .frame(maxHeight: .infinity)
                        .background(Color.red)
                }
                .buttonStyle(.plain)
            }
            content
                .background(Color(uiColor: .secondarySystemGroupedBackground))
                .offset(x: offset)
                .overlay { if resting != 0 { Color.clear.contentShape(Rectangle()).onTapGesture { settle(0) } } }
                .chatRowSwipeGesture(
                    onChanged: { offset = min(0, resting + $0) },
                    onEnded: { end in
                        let target = resting + end
                        if target < -revealWidth * 2.2 { commit() } else { settle(target < -revealWidth / 2 ? -revealWidth : 0) }
                    },
                    onCancelled: { settle(resting) }
                )
        }
        .clipped()
        .accessibilityAction(named: "Remove", commit)
    }

    private func settle(_ value: CGFloat) {
        withAnimation(ChatRowSwipeMotion.settlingAnimation(reduceMotion: reduceMotion)) { offset = value }
        resting = value
    }

    private func commit() {
        settle(0)
        remove()
    }
}
