//
//  SceneDelegate.swift
//  melodica
//
//  Created by Anka on 11/7/26.
//

import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let _ = (scene as? UIWindowScene) else { return }
        openListen(connectionOptions.urlContexts)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        openListen(URLContexts)
    }

    // listen://<path> (melodica-scrobble docs/LISTEN-URI.md) opens its https form,
    // https://spacegho.st/listen/<path>, in Safari, where the extension and the site take it.
    // The site parses and checks the link; only the scheme and the 1024-character
    // limit are checked here.
    private func openListen(_ contexts: Set<UIOpenURLContext>) {
        guard let url = contexts.first?.url, url.scheme?.lowercased() == "listen" else { return }
        let raw = url.absoluteString
        guard raw.count <= 1024, let sep = raw.range(of: "://") else { return }
        let path = String(raw[sep.upperBound...])
        guard !path.contains("#"), let https = URL(string: "https://spacegho.st/listen/" + path) else { return }
        UIApplication.shared.open(https)
    }

}
