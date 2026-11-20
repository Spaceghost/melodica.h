import SwiftUI
import WatchConnectivity

final class WristRemote: NSObject, ObservableObject, WCSessionDelegate {
    @Published var title = "Melodica"
    @Published var artist = ""
    @Published var playing = false
    @Published var reachable = false
    override init() { super.init(); if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() } }
    func update(_ context: [String:Any]) { DispatchQueue.main.async {
        self.title = context["title"] as? String ?? "Melodica"
        self.artist = context["artist"] as? String ?? ""
        self.playing = context["playing"] as? Bool ?? false
        self.reachable = WCSession.default.isReachable
    }}
    func session(_ session: WCSession,activationDidCompleteWith state: WCSessionActivationState,error: Error?) { update(session.receivedApplicationContext) }
    func sessionReachabilityDidChange(_ session: WCSession) { update(session.receivedApplicationContext) }
    func session(_ session: WCSession,didReceiveApplicationContext context: [String:Any]) { update(context) }
    func send(_ action: String) { if reachable { WCSession.default.sendMessage(["action":action],replyHandler:nil) } }
}
@main struct Wrist: App {
    @StateObject private var radio = WristRemote()
    var body: some Scene { WindowGroup {
        VStack {
            Text(radio.title).font(.headline)
            Text(radio.artist).font(.caption)
            if !radio.reachable { Text("Open Melodica on iPhone").font(.caption) }
            HStack {
                Button { radio.send(radio.playing ? "pause":"play") } label:{ Image(systemName:radio.playing ? "pause.fill":"play.fill") }.accessibilityLabel(radio.playing ? "Pause":"Play")
                Button { radio.send("skip") } label:{ Image(systemName:"forward.end.fill") }.accessibilityLabel("Skip")
                Button { radio.send("love") } label:{ Image(systemName:"hand.thumbsup") }.accessibilityLabel("Thumbs up")
            }.disabled(!radio.reachable)
        }
    }}
}
