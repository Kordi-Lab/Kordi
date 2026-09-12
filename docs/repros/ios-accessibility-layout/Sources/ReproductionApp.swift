import SwiftUI
import Foundation

enum Trace {
    static let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("result.txt")
    static func log(_ s: String) {
        let old = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        try? (old + s + "\n").write(to: url, atomically: true, encoding: .utf8)
    }
}
struct RichText: View {
    let long: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(0..<(long ? 12 : 1), id: \.self) { index in
                Text(long ? "Reading sample \(index)" : "Rendered message").font(.title2.bold())
                Text(long ? "This is a long formatted message. Open its menu, scroll the preview, and return to the conversation. The text should keep the same size and line breaks." : "Bold stays bold and italic stays italic.")
                    .fixedSize(horizontal: false, vertical: true)
                Text("A waving blob 👋").fixedSize(horizontal: false, vertical: true)
                Text("• First formatted item\n• Second formatted item").fixedSize(horizontal: false, vertical: true)
                Text("let value = 42").font(.body.monospaced())
                Text("Rich message end marker.").fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
struct ProbeRow: Identifiable { let index: Int; var id: String { "row-\(index)" } }
struct ProbeView: View {
    @State private var menu = false
    @State private var draft = ""
    @State private var done = false
    @FocusState private var focused: Bool
    var body: some View {
        ScrollViewReader { proxy in
        VStack {
            Text(done ? "Probe complete" : "Menu layout reduction").font(.headline).padding()
            GeometryReader { geometry in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach((0..<6).map { ProbeRow(index: $0) }) { row in
                            let index = row.index
                            HStack(alignment: .bottom, spacing: 8) {
                                if index.isMultiple(of: 2) { Spacer(minLength: 44) }
                                else { Circle().fill(.gray).frame(width: 28, height: 28) }
                                VStack(spacing: 0) {
                                    if index == 3 || index == 4 {
                                        VStack {
                                            Rectangle().fill(.pink).frame(width: 180, height: 150)
                                            if index == 4 { Rectangle().fill(.blue).frame(width: 155, height: 236).opacity(menu ? 0 : 1) }
                                        }
                                    }
                                    VStack(alignment: .leading, spacing: 0) {
                                        Group {
                                            if index == 0 { Text(String(repeating: "Paragraph. This longer plain-text sample lets you compare wrapping and scrolling without Markdown. ", count: 28)).fixedSize(horizontal: false, vertical: true) }
                                            else if index == 1 || index == 5 { RichText(long: index == 1) }
                                            else { Text("A photo caption or voice transcript that remains readable.").fixedSize(horizontal: false, vertical: true) }
                                        }.padding(.horizontal, 12).padding(.vertical, 8)
                                    }.background(.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                                }
                                if !index.isMultiple(of: 2) { Spacer(minLength: 44) }
                                else { Circle().fill(.gray).frame(width: 28, height: 28) }
                            }.padding(.bottom, 12).id(row.id).accessibilityElement(children: .contain).accessibilityIdentifier("row-\(index)")
                        }
                    }
                    .scrollTargetLayout()
                    .frame(minHeight: geometry.size.height, alignment: .bottom)
                    .padding(.horizontal, 12)
                }
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.bottom, for: .sizeChanges)
                .defaultScrollAnchor(.bottom, for: .alignment)
                .overlay {
                    if menu { Color.gray.opacity(0.15).overlay { Text("Reply / Select / Delete").padding(30).background(.regularMaterial) } }
                }
            }
            TextField("Message", text: $draft).focused($focused).textFieldStyle(.roundedBorder).padding()
        }
        .task {
            try? FileManager.default.removeItem(at: Trace.url)
            func pause() async { try? await Task.sleep(for: .milliseconds(700)) }
            await pause()
            for iteration in 0..<4 {
                Trace.log("start \(iteration)")
                focused = false
                await pause()
                proxy.scrollTo("row-4", anchor: .center)
                await pause()
                menu = true; await pause(); menu = false; await pause()
                proxy.scrollTo("row-3", anchor: .center)
                await pause()
                menu = true; await pause(); menu = false; await pause()
                focused = true; await pause()
                Trace.log("finished \(iteration)")
            }
            Trace.log("PASS")
            done = true
        }
        }
    }
}
@main struct ProbeApp: App { var body: some Scene { WindowGroup { ProbeView() } } }
