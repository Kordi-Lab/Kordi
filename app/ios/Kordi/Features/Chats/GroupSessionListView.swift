import SwiftUI

struct GroupSessionListView: View {
    let space: GroupSpaceSummary

    var body: some View {
        List {
            Section {
                ForEach(space.sessions) { session in
                    NavigationLink(value: session) {
                        ConversationRow(conversation: session)
                    }
                    .kordiListRow()
                }
            } header: {
                Text(space.sessions.count == 1 ? "1 session" : "\(space.sessions.count) sessions")
            }
        }
        .listStyle(.plain)
        .navigationTitle(space.displayName)
        .navigationBarTitleDisplayMode(.inline)
    }
}
