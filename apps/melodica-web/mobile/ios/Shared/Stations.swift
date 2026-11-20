import Foundation
import AppIntents

extension Notification.Name { static let melodicaStation = Notification.Name("MelodicaStationSelected") }
enum StationDirectory {
    static let store = UserDefaults(suiteName:"group.st.spacegho.melodica.mobile")!
    static var all: [[String:String]] { store.array(forKey:"stations") as? [[String:String]] ?? [] }
    static var favorite: String {
        get { store.string(forKey:"favorite") ?? "" }
        set { store.set(newValue,forKey:"favorite") }
    }
    static func save(_ items: [[String:String]]) {
        store.set(items,forKey:"stations")
        if !items.contains(where: { $0["id"] == favorite }) { favorite = "" }
    }
    static func request(_ id: String) { store.set(id,forKey:"request"); NotificationCenter.default.post(name:.melodicaStation,object:nil) }
    static func consume() -> String? {
        guard let id = store.string(forKey:"request") else { return nil }
        store.removeObject(forKey:"request"); return id
    }
}
struct RadioStation: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name:"Station")
    static var defaultQuery = StationQuery()
    let id: String
    let name: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title:"\(name)") }
}
struct StationQuery: EntityStringQuery {
    private var stations: [RadioStation] { StationDirectory.all.compactMap { item in
        guard let id = item["id"], let name = item["name"] else { return nil }
        return RadioStation(id:id,name:name)
    }}
    func entities(for identifiers: [String]) async throws -> [RadioStation] { stations.filter { identifiers.contains($0.id) } }
    func entities(matching string: String) async throws -> [RadioStation] { stations.filter { $0.name.localizedCaseInsensitiveContains(string) } }
    func suggestedEntities() async throws -> [RadioStation] { stations }
}
struct PlayStation: AppIntent {
    static var title: LocalizedStringResource = "Play a Melodica station"
    static var openAppWhenRun = true
    @Parameter(title:"Station") var station: RadioStation
    func perform() async throws -> some IntentResult { StationDirectory.request(station.id); return .result() }
}
struct RadioShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent:PlayStation(),phrases:["Play a station in \(.applicationName)","Play \(.$station) in \(.applicationName)"],
            shortTitle:"Play station",systemImageName:"radio")
    }
}
