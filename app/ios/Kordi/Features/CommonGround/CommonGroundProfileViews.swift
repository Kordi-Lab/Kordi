import SwiftUI

// Profile controls on the Card screen: Rename, Edit focus and Delete.

/// What a profile action asks for: a new name, a new focus, or a confirm.
struct CommonGroundProfileEditTarget: Identifiable {
    enum Action { case rename, focus, delete }
    let action: Action
    let profile: CommonGroundProfileSummary
    var id: String { "\(action)|\(profile.profileId)" }
}

struct CommonGroundProfileMenuItems: View {
    let profile: CommonGroundProfileSummary
    @Binding var editing: CommonGroundProfileEditTarget?

    var body: some View {
        Button { editing = .init(action: .rename, profile: profile) } label: { Label("Rename", systemImage: "pencil") }
        Button { editing = .init(action: .focus, profile: profile) } label: { Label("Edit focus", systemImage: "scope") }
        Button(role: .destructive) { editing = .init(action: .delete, profile: profile) } label: { Label("Delete", systemImage: "trash") }
    }
}

extension View {
    /// Presents Rename, Edit focus and Delete for `target`.
    func commonGroundProfileEditor(_ target: Binding<CommonGroundProfileEditTarget?>, onDelete: (() -> Void)? = nil) -> some View {
        modifier(CommonGroundProfileEditor(target: target, onDelete: onDelete))
    }
}

private struct CommonGroundProfileEditor: ViewModifier {
    @EnvironmentObject private var model: CommonGroundModel
    @Binding var target: CommonGroundProfileEditTarget?
    let onDelete: (() -> Void)?
    @State private var text = ""

    private func shows(_ actions: CommonGroundProfileEditTarget.Action...) -> Binding<Bool> {
        Binding(
            get: { target.map { actions.contains($0.action) } ?? false },
            set: { if !$0 { target = nil } }
        )
    }

    func body(content: Content) -> some View {
        content
            .alert(target?.action == .rename ? "Rename profile" : "Edit focus", isPresented: shows(.rename, .focus), presenting: target) { target in
                TextField(target.action == .rename ? "Name" : "Focus", text: $text)
                Button("Save") { save(target) }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog(
                "Delete \(target?.profile.title ?? "profile")?",
                isPresented: shows(.delete),
                titleVisibility: .visible,
                presenting: target
            ) { target in
                Button("Delete", role: .destructive) {
                    Task { if await model.deleteProfile(target.profile.profileId) { onDelete?() } }
                }
            } message: { _ in
                Text("Its card and matches go too.")
            }
            .onChange(of: target?.id) { _, _ in
                guard let target else { return }
                text = target.action == .rename ? target.profile.title : (target.profile.focus ?? "")
            }
    }

    private func save(_ target: CommonGroundProfileEditTarget) {
        let value = text
        Task {
            if target.action == .rename {
                await model.updateProfile(target.profile.profileId, name: value)
            } else {
                await model.updateProfile(target.profile.profileId, focus: value)
            }
        }
    }
}
