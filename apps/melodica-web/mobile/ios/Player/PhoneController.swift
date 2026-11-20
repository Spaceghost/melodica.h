import UIKit
import WebKit
import AVFoundation
import AVKit
import MediaPlayer
import CoreLocation
import Network
import WidgetKit
import WatchConnectivity

final class PhoneController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, CLLocationManagerDelegate, UIDocumentPickerDelegate, WCSessionDelegate {
    static let shared = PhoneController()
    static let player = URL(string:"https://spacegho.st/melodica/app/")!
    let library = Result { try WalkStore() }
    let location = CLLocationManager()
    private let monitor = NWPathMonitor()
    private let speaker = AVSpeechSynthesizer()
    private var web: WKWebView!
    private var network = "offline"
    private var track = Record()
    private var pendingLocation: Int?
    private var exportID: Int?
    private var exportURL: URL?
    private var interrupted = false
    private var resumeCall = true
    private var speak = false
    private var spoken = ""
    private var artworkURL = ""
    private var artwork: MPMediaItemArtwork?
    private var artworkTask: URLSessionDataTask?
    private var pendingStation = ""
    private var pendingLink = ""
    private var visible: Bool { viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive }
    private var playing: Bool { track["playing"] as? Bool == true }
    var stations: [[String:String]] { StationDirectory.all }
    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        if let url = Bundle.main.url(forResource:"bridge",withExtension:"js"), let js = try? String(contentsOf:url,encoding:.utf8) {
            configuration.userContentController.addUserScript(WKUserScript(source:js,injectionTime:.atDocumentStart,forMainFrameOnly:true))
        }
        configuration.userContentController.add(self,name:"melodicaMobile")
        web = WKWebView(frame:.zero,configuration:configuration)
        web.navigationDelegate = self
        web.customUserAgent = nil
        view = web
        web.load(URLRequest(url:Self.player))
    }
    override func viewDidLoad() {
        super.viewDidLoad()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        location.distanceFilter = 3
        location.activityType = .fitness
        location.pausesLocationUpdatesAutomatically = false
        location.showsBackgroundLocationIndicator = true
        let audio = AVAudioSession.sharedInstance()
        try? audio.setCategory(.playback, mode:.default, options:[.allowAirPlay])
        let nc = NotificationCenter.default
        nc.addObserver(self,selector:#selector(interruption(_:)),name:AVAudioSession.interruptionNotification,object:audio)
        nc.addObserver(self,selector:#selector(route(_:)),name:AVAudioSession.routeChangeNotification,object:audio)
        nc.addObserver(self,selector:#selector(openShortcut),name:UIApplication.didBecomeActiveNotification,object:nil)
        nc.addObserver(self,selector:#selector(openShortcut),name:.melodicaStation,object:nil)
        monitor.pathUpdateHandler = { [weak self] path in DispatchQueue.main.async {
            guard let self else { return }
            self.network = path.status != .satisfied ? "offline" : path.usesInterfaceType(.cellular) ? "cellular" : "wifi"
            self.event("device",self.device())
        }}
        monitor.start(queue:DispatchQueue(label:"st.spacegho.melodica.network"))
        let center = MPRemoteCommandCenter.shared()
        for (command,action) in [(center.playCommand,"play"),(center.pauseCommand,"pause"),(center.nextTrackCommand,"skip"),(center.likeCommand,"love"),(center.dislikeCommand,"ban")] as [(MPRemoteCommand,String)] {
            command.isEnabled = true
            command.addTarget { [weak self] _ in
                DispatchQueue.main.async { self?.control(action) }
                return .success
            }
        }
        if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
        openShortcut()
    }
    func control(_ action: String) {
        guard ["play","pause","skip","love","ban"].contains(action) else { return }
        if action == "pause" { interrupted = false }
        event("media",["action":action])
    }
    @objc private func openShortcut() {
        if let id = StationDirectory.consume() { choose(id) }
    }
    func choose(_ id: String) {
        guard stations.contains(where: { $0["id"] == id }) else { return }
        pendingStation = id
        event("station",["id":id])
    }
    func openListenLink(_ url: URL) {
        let raw = url.absoluteString
        guard raw.utf8.count <= 1024 else { return }
        pendingLink = raw
        if let page = web?.url, !allowed(page) { web.load(URLRequest(url:Self.player)) }
        else { event("listenLink",["url":raw]) }
    }
    private func device() -> Record {
        let output = AVAudioSession.sharedInstance().currentRoute.outputs.first
        return ["network":network,"route":output?.uid ?? "speaker","label":output?.portName ?? "iPhone speaker","station":pendingStation,"listenLink":pendingLink]
    }
    private func allowed(_ url: URL?) -> Bool {
        guard let u = url, u.scheme == "https", u.host == "spacegho.st", u.user == nil, u.port == nil || u.port == 443 else { return false }
        guard let path = URLComponents(url:u,resolvingAgainstBaseURL:false)?.percentEncodedPath else { return false }
        return path.range(of:#"^/melodica(?:/(?:app|track|rooms|garden|listens|leaderboard|map|account|aquarium|apps|extension|rooms/[A-Za-z0-9_-]{16,64}))?/?$"#,options:.regularExpression) != nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard action.targetFrame?.isMainFrame != false, let url = action.request.url else { decisionHandler(.allow); return }
        if url.scheme == "https" && (url.host == "spacegho.st" || url.host == "github.com") { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        if url.scheme == "https" { UIApplication.shared.open(url) }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "https", origin.host == "spacegho.st",
              origin.port == 0 || origin.port == 443, allowed(message.frameInfo.request.url), allowed(web.url),
              let packet = message.body as? Record, let id = packet["id"] as? Int, let action = packet["action"] as? String else { return }
        let value = packet["value"] as? Record ?? [:]
        do {
            var result: Any = true
            switch action {
            case "state": result = device()
            case "now": try updateTrack(value)
            case "options": resumeCall = value["resumeCall"] as? Bool ?? true; speak = value["speak"] as? Bool ?? false
            case "userPause": interrupted = false
            case "stations": StationDirectory.save(value["stations"] as? [[String:String]] ?? []); WidgetCenter.shared.reloadAllTimelines()
            case "stationHandled": if value["id"] as? String == pendingStation { pendingStation = "" }
            case "linkHandled": if value["url"] as? String == pendingLink { pendingLink = "" }
            case "pin":
                guard let station = value["id"] as? String, stations.contains(where: { $0["id"] == station }) else { throw MobileError.message("Choose a station first.") }
                StationDirectory.favorite = station
                WidgetCenter.shared.reloadAllTimelines()
                result = false
            case "output":
                guard visible else { throw MobileError.message("Open the player to choose an audio output.") }
                let sheet = UIViewController()
                sheet.title = "Audio output"
                sheet.view.backgroundColor = .systemBackground
                let picker = AVRoutePickerView()
                picker.isAccessibilityElement = true
                picker.accessibilityLabel = "Choose headphones, speakers or AirPlay"
                let label = UILabel()
                label.text = "Choose headphones, speakers or AirPlay"
                label.textAlignment = .center
                label.numberOfLines = 0
                let group = UIStackView(arrangedSubviews:[picker,label])
                group.axis = .vertical; group.spacing = 12; group.translatesAutoresizingMaskIntoConstraints = false
                sheet.view.addSubview(group)
                NSLayoutConstraint.activate([group.centerXAnchor.constraint(equalTo:sheet.view.centerXAnchor),
                    group.centerYAnchor.constraint(equalTo:sheet.view.centerYAnchor),
                    group.widthAnchor.constraint(lessThanOrEqualTo:sheet.view.widthAnchor,multiplier:0.85),
                    picker.heightAnchor.constraint(equalToConstant:60)])
                sheet.navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem:.done,primaryAction:UIAction { [weak sheet] _ in sheet?.dismiss(animated:true) })
                let navigation = UINavigationController(rootViewController:sheet)
                navigation.modalPresentationStyle = .pageSheet; navigation.sheetPresentationController?.detents = [.medium()]
                present(navigation,animated:true)
            case "walkList": result = try library.get().list()
            case "walkRead": result = try library.get().page(value["id"] as? String ?? "",value["cursor"] as? Int64 ?? 0)
            case "walkAck": try library.get().acknowledge(value["id"] as? String ?? "")
            case "walkStart": try requestWalk(id); return
            case "walkPause":
                if value["paused"] as? Bool == false { try requestWalk(id); return }
                location.stopUpdatingLocation(); try library.get().pause(true)
            case "walkFinish":
                if let expected = value["id"] as? String, try library.get().active()?["id"] as? String != expected { throw MobileError.message("This walk is already finished.") }
                location.stopUpdatingLocation(); try library.get().finish()
            case "share":
                guard visible, let valueURL = value["url"] as? String, let url = URL(string:valueURL), url.scheme == "https" else { throw MobileError.message("Open the player to share.") }
                let share = UIActivityViewController(activityItems:[value["text"] as? String ?? "",url],applicationActivities:nil)
                share.popoverPresentationController?.sourceView = view
                share.popoverPresentationController?.sourceRect = CGRect(x:view.bounds.midX,y:view.bounds.midY,width:1,height:1)
                present(share,animated:true)
            case "saveFile": try export(value,id); return
            default: throw MobileError.message("Unknown phone action.")
            }
            reply(id,result)
        } catch { reply(id,NSNull(),error.localizedDescription) }
    }
    private func requestWalk(_ id: Int) throws {
        guard visible, pendingLocation == nil else { throw MobileError.message("Open the walk screen to start GPS.") }
        pendingLocation = id
        if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
        else { locationManagerDidChangeAuthorization(location) }
    }
    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let authorized = manager.authorizationStatus == .authorizedWhenInUse || manager.authorizationStatus == .authorizedAlways
        if !authorized && manager.authorizationStatus != .notDetermined {
            manager.stopUpdatingLocation(); try? library.get().pause(true); event("walkUpdate",[:])
        }
        guard manager.authorizationStatus != .notDetermined, let id = pendingLocation else { return }
        pendingLocation = nil
        do {
            guard authorized else { throw MobileError.message("Allow location in Settings to record a walk.") }
            let store = try library.get()
            let row = try store.start()
            try store.song(track)
            manager.allowsBackgroundLocationUpdates = true
            manager.startUpdatingLocation()
            reply(id,row)
        } catch { reply(id,NSNull(),error.localizedDescription) }
    }
    func locationManager(_ manager: CLLocationManager,didUpdateLocations locations: [CLLocation]) {
        do { let store = try library.get(); for fix in locations { try store.point(fix) }; event("walkUpdate",[:]) }
        catch { event("walkError",["message":error.localizedDescription]) }
    }
    func locationManager(_ manager: CLLocationManager,didFailWithError error: Error) {
        event("walkError",["message":error.localizedDescription])
    }
    private func updateTrack(_ value: Record) throws {
        let wasPlaying = playing
        track = value
        if case .success(let store) = library { try store.song(value) }
        if playing && !wasPlaying { try AVAudioSession.sharedInstance().setActive(true) }
        var info: [String:Any] = [:]
        info[MPMediaItemPropertyTitle] = value["title"]
        info[MPMediaItemPropertyArtist] = value["artist"]
        info[MPMediaItemPropertyAlbumTitle] = value["album"]
        info[MPMediaItemPropertyPlaybackDuration] = value["duration"]
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = value["position"]
        info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1.0 : 0.0
        let art = value["art"] as? String ?? ""
        if artworkURL != art {
            artworkURL = art; artworkTask?.cancel(); artwork = nil
            if let url = URL(string:art), url.scheme == "https", url.host == "spacegho.st",
               url.path.range(of:"^/scrobble/art/[0-9a-f]{64}$",options:.regularExpression) != nil {
                artworkTask = URLSession.shared.dataTask(with:url) { [weak self] bytes,_,_ in
                    guard let bytes, bytes.count <= 4000000, let image = UIImage(data:bytes) else { return }
                    DispatchQueue.main.async {
                        guard let self, self.artworkURL == art else { return }
                        self.artwork = MPMediaItemArtwork(boundsSize:image.size) { _ in image }
                        var current = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                        current[MPMediaItemPropertyArtwork] = self.artwork
                        MPNowPlayingInfoCenter.default().nowPlayingInfo = current
                    }
                }
                artworkTask?.resume()
            }
        }
        info[MPMediaItemPropertyArtwork] = artwork
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        let name = [value["title"] as? String,value["artist"] as? String].compactMap { $0 }.joined(separator:" by ")
        if playing && spoken != name { spoken = name; if speak { speaker.speak(AVSpeechUtterance(string:name)) } }
        if WCSession.isSupported(), WCSession.default.activationState == .activated {
            try? WCSession.default.updateApplicationContext(["title":value["title"] ?? "", "artist":value["artist"] ?? "", "playing":playing])
        }
    }
    @objc private func interruption(_ note: Notification) {
        guard let n = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt else { return }
        if n == AVAudioSession.InterruptionType.began.rawValue {
            interrupted = playing; event("media",["action":"pause"])
        } else {
            let flags = AVAudioSession.InterruptionOptions(rawValue:note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            if interrupted && resumeCall && flags.contains(.shouldResume) { event("media",["action":"play"]) }
            interrupted = false
        }
    }
    @objc private func route(_ note: Notification) {
        let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { control("pause") }
        event("device",device())
    }
    private func send(_ packet: Record) {
        guard web != nil, allowed(web.url) else { return }
        // A binding keeps user-controlled text and file metadata outside the source string.
        web.callAsyncJavaScript("window.melodicaReceive?.(packet)",arguments:["packet":packet],in:nil,in:.page,completionHandler:nil)
    }
    func event(_ name: String,_ value: Record) { send(["event":name,"value":value]) }
    private func reply(_ id: Int,_ value: Any,_ error: String? = nil) {
        var packet: Record = ["id":id,"value":value]
        if let error { packet["error"] = error }; send(packet)
    }
    private func export(_ value: Record,_ id: Int) throws {
        guard exportID == nil, visible, let name = value["name"] as? String, name == (name as NSString).lastPathComponent,
              !name.isEmpty, name != ".", name != "..", let encoded = value["data"] as? String,
              encoded.utf8.count < 24000000, let bytes = Data(base64Encoded:encoded) else { throw MobileError.message("The file is unavailable.") }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString,isDirectory:true)
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        let url = folder.appendingPathComponent(name)
        try bytes.write(to:url,options:.completeFileProtection)
        exportURL = url; exportID = id
        let picker = UIDocumentPickerViewController(forExporting:[url],asCopy:true)
        picker.delegate = self; present(picker,animated:true)
    }
    private func exported(_ ok: Bool) {
        if let id = exportID { reply(id,ok) }
        if let folder = exportURL?.deletingLastPathComponent() { try? FileManager.default.removeItem(at:folder) }
        exportID = nil; exportURL = nil
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { exported(false) }
    func documentPicker(_ controller: UIDocumentPickerViewController,didPickDocumentsAt urls: [URL]) { exported(!urls.isEmpty) }
    func session(_ session: WCSession,activationDidCompleteWith state: WCSessionActivationState,error: Error?) {}
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    func session(_ session: WCSession,didReceiveMessage message: [String:Any]) {
        guard let action = message["action"] as? String else { return }
        DispatchQueue.main.async { self.control(action) }
    }
}
