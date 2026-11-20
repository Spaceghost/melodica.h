import WidgetKit
import SwiftUI
import AppIntents

struct WidgetStation: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Melodica station"
    @Parameter(title:"Station") var station: RadioStation?
}
struct StationEntry: TimelineEntry { let date: Date; let id: String; let name: String }
struct StationProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> StationEntry { StationEntry(date:Date(),id:"",name:"Melodica") }
    func snapshot(for configuration: WidgetStation,in context: Context) async -> StationEntry { entry(configuration) }
    func timeline(for configuration: WidgetStation,in context: Context) async -> Timeline<StationEntry> {
        Timeline(entries:[entry(configuration)],policy:.after(Date().addingTimeInterval(1800)))
    }
    func entry(_ config: WidgetStation) -> StationEntry {
        let id = config.station?.id ?? StationDirectory.favorite
        let station = StationDirectory.all.first { $0["id"] == id }
        return StationEntry(date:Date(),id:station?["id"] ?? "",name:station?["name"] ?? "Open Melodica")
    }
}
@main struct StationWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind:"MelodicaStation",intent:WidgetStation.self,provider:StationProvider()) { entry in
            var url = URLComponents(); url.scheme = "melodica-radio"; url.host = "station"; url.queryItems = [URLQueryItem(name:"id",value:entry.id)]
            return VStack(alignment:.leading,spacing:6) {
                Image(systemName:"radio").accessibilityHidden(true)
                Text(entry.name).font(.headline).lineLimit(3)
            }.widgetURL(url.url).containerBackground(for:.widget) { Color(red:0.12,green:0.17,blue:0.17) }.foregroundStyle(.white)
        }.configurationDisplayName("Melodica station").description("Open a chosen station.").supportedFamilies([.systemSmall,.systemMedium])
    }
}
