import Cocoa
import FlutterMacOS

@NSApplicationMain
class AppDelegate: FlutterAppDelegate {
  // listen:// links from the system (Info.plist CFBundleURLTypes), kept until Dart takes them
  // over the "epimetheus/listen_links" channel (lib/listen/listen_links.dart).
  private var listenChannel: FlutterMethodChannel?
  private var pendingLinks: [String] = []

  override func applicationWillFinishLaunching(_ notification: Notification) {
    NSAppleEventManager.shared().setEventHandler(
      self, andSelector: #selector(handleGetURL(_:withReplyEvent:)),
      forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
  }

  override func applicationDidFinishLaunching(_ notification: Notification) {
    if let controller = mainFlutterWindow?.contentViewController as? FlutterViewController {
      let channel = FlutterMethodChannel(name: "epimetheus/listen_links", binaryMessenger: controller.engine.binaryMessenger)
      channel.setMethodCallHandler { [weak self] call, result in
        guard let self = self else { return result(nil) }
        if call.method == "takePending" {
          result(self.pendingLinks)
          self.pendingLinks = []
        } else {
          result(FlutterMethodNotImplemented)
        }
      }
      listenChannel = channel
    }
    super.applicationDidFinishLaunching(notification)
  }

  @objc func handleGetURL(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
    guard let link = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue else { return }
    pendingLinks.append(link)
    listenChannel?.invokeMethod("changed", arguments: nil)
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }
}
