import UIKit
import CarPlay

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connecting: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let car = connecting.role == .carTemplateApplication
        let configuration = UISceneConfiguration(name:car ? "Car":"Phone",sessionRole:connecting.role)
        configuration.delegateClass = car ? CarScene.self : PhoneScene.self
        return configuration
    }
}
final class PhoneScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene:scene)
        window.rootViewController = PhoneController.shared
        self.window = window; window.makeKeyAndVisible()
        if let url = options.urlContexts.first?.url { open(url) }
    }
    func scene(_ scene: UIScene,openURLContexts urls: Set<UIOpenURLContext>) {
        if let url = urls.first?.url { open(url) }
    }
    private func open(_ url: URL) {
        if url.scheme == "listen" || url.scheme == "web+listen" {
            PhoneController.shared.openListenLink(url)
            return
        }
        if url.scheme == "melodica-radio", url.host == "station", let id = URLComponents(url:url,resolvingAgainstBaseURL:false)?.queryItems?.first(where: { $0.name == "id" })?.value {
            StationDirectory.request(id)
        }
    }
}
final class CarScene: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interface: CPInterfaceController?
    func templateApplicationScene(_ scene: CPTemplateApplicationScene,didConnect interface: CPInterfaceController) {
        self.interface = interface
        PhoneController.shared.loadViewIfNeeded()
        let stations = PhoneController.shared.stations.compactMap { station -> CPListItem? in
            guard let id = station["id"], let name = station["name"] else { return nil }
            let item = CPListItem(text:name,detailText:nil)
            item.handler = { [weak interface] _, done in
                PhoneController.shared.choose(id)
                interface?.pushTemplate(CPNowPlayingTemplate.shared,animated:true,completion:nil)
                done()
            }
            return item
        }
        let list = CPListTemplate(title:"Stations",sections:[CPListSection(items:stations)])
        list.emptyViewTitleVariants = ["Open Melodica on your phone to load stations."]
        interface.setRootTemplate(list,animated:false,completion:nil)
    }
    func templateApplicationScene(_ scene: CPTemplateApplicationScene,didDisconnectInterfaceController interface: CPInterfaceController) { self.interface = nil }
}
