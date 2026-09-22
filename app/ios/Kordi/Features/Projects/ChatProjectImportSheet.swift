import SwiftUI

struct ChatProjectImportSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let device: ChatProjectDevice
    let onImported: (ChatProject) -> Void
    @State private var github = false
    @State private var repository = ""
    @State private var repositories: [ChatProjectRepository] = []
    @State private var page = 1
    @State private var hasMore = false
    @State private var busy = false
    @State private var status = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { importFolder() } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Local folder").foregroundStyle(.primary)
                                Text("Choose a folder on \(device.name)").font(.caption).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "folder").foregroundStyle(.secondary) }
                        .padding(.vertical, 6)
                    }
                    Button { github = true; loadRepositories() } label: {
                        Label {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("GitHub repository").foregroundStyle(.primary)
                                Text("Clone to \(device.name)").font(.caption).foregroundStyle(.secondary)
                            }
                        } icon: { Image(systemName: "chevron.left.forwardslash.chevron.right").foregroundStyle(.secondary) }
                        .padding(.vertical, 6)
                    }
                } footer: { Text("Keep Kordi open on your Mac while importing.") }
                if github {
                    Section("Repository") {
                        TextField("owner/repository or GitHub URL", text: $repository)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .font(.subheadline)
                        ForEach(repositories.filter { repository.isEmpty || $0.fullName.localizedCaseInsensitiveContains(repository) }) { repo in
                            Button { repository = repo.fullName } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(repo.fullName).font(.subheadline).foregroundStyle(.primary)
                                    if let detail = repo.description { Text(detail).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                                }
                            }
                        }
                        if hasMore { Button("Load more repositories") { page += 1; loadRepositories() } }
                        Button("Clone and add project") { clone() }
                            .disabled(normalizedRepository == nil)
                    }
                }
                if busy { ProgressView(status).font(.subheadline) }
                if let error { Text(error).font(.footnote).foregroundStyle(KordiTheme.destructiveText) }
            }
            .font(.subheadline)
            .navigationTitle("New project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) } }
            .disabled(busy)
        }
        .interactiveDismissDisabled(busy)
    }

    private var normalizedRepository: String? {
        ChatProjectRepositoryInput.normalize(repository)
    }
    private func run(_ action: String, repository: String? = nil, progress: String, done: @escaping (ChatProjectResult) -> Void) {
        busy = true; error = nil; status = progress
        Task {
            do {
                let result = try await model.performProjectAction(.init(commandId: UUID().uuidString, deviceId: device.id, action: action, repository: repository, page: page))
                done(result)
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
    private func loadRepositories() {
        run("repositories", progress: "Loading from your Mac…") { result in
            let existing = Set(repositories.map(\.id))
            repositories += (result.repositories ?? []).filter { !existing.contains($0.id) }
            hasMore = result.hasMore ?? false
        }
    }
    private func importFolder() {
        run("importFolder", progress: "Choose a folder in the dialog on your Mac…", done: finish)
    }
    private func clone() {
        guard let repo = normalizedRepository else { return }
        run("cloneRepository", repository: repo, progress: "Cloning on your Mac…", done: finish)
    }
    private func finish(_ result: ChatProjectResult) {
        guard result.cancelled != true, let id = result.projectId,
              let project = model.projectDevices.first(where: { $0.id == device.id })?.projects.first(where: { $0.id == id }) else { return }
        dismiss()
        onImported(project)
    }
}

enum ChatProjectRepositoryInput {
    static func normalize(_ input: String) -> String? {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["https://github.com/", "git@github.com:"] where value.hasPrefix(prefix) { value.removeFirst(prefix.count) }
        if value.hasSuffix("/") { value.removeLast() }
        if value.hasSuffix(".git") { value.removeLast(4) }
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, parts.allSatisfy({ part in
            part != "." && part != ".." && part.range(of: "^[A-Za-z0-9_.][A-Za-z0-9_.-]*$", options: .regularExpression) != nil
        }) else { return nil }
        return value
    }
}
