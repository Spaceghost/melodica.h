import Foundation
import CoreLocation
import SQLite3

enum MobileError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        if case .message(let text) = self { return text }
        return nil
    }
}

typealias Record = [String: Any]
private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

final class WalkStore {
    private var db: OpaquePointer?
    private var lastPoint: CLLocation?
    private var lastSong = ""
    private var cut = true

    init() throws {
        var folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        folder.appendPathComponent("Walks", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
        guard sqlite3_open(folder.appendingPathComponent("journal.sqlite").path, &db) == SQLITE_OK else {
            throw MobileError.message("The private walk journal could not be opened.")
        }
        try execute("PRAGMA foreign_keys=ON")
        try execute("CREATE TABLE IF NOT EXISTS walks(id TEXT PRIMARY KEY, start INTEGER NOT NULL, ending INTEGER, paused INTEGER NOT NULL)")
        try execute("CREATE UNIQUE INDEX IF NOT EXISTS active_walk ON walks((1)) WHERE ending IS NULL")
        try execute("CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, walk TEXT REFERENCES walks(id) ON DELETE CASCADE, kind TEXT NOT NULL, data TEXT NOT NULL)")
        try execute("CREATE INDEX IF NOT EXISTS walk_events ON events(walk,seq)")
        if let active = try list().first(where: { $0["end"] is NSNull }), let id = active["id"] as? String {
            let last = try query("SELECT data FROM events WHERE walk=? ORDER BY seq DESC LIMIT 1",[id]) { try self.json($0,0) }.first
            if let at = last?["at"] as? Int64 { try append(id, "changes", ["at":at+1,"unknown":true]) }
        }
        try execute("UPDATE walks SET paused=1 WHERE ending IS NULL")
    }
    deinit { sqlite3_close(db) }
    private func query<T>(_ sql: String, _ args: [String], _ read: (OpaquePointer) throws -> T) throws -> [T] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db,sql,-1,&statement,nil) == SQLITE_OK, let st = statement else {
            throw MobileError.message("The walk journal could not read its records.")
        }
        defer { sqlite3_finalize(st) }
        for (index, value) in args.enumerated() { sqlite3_bind_text(st,Int32(index+1),value,-1,transient) }
        var rows: [T] = []
        var status = sqlite3_step(st)
        while status == SQLITE_ROW { rows.append(try read(st)); status = sqlite3_step(st) }
        guard status == SQLITE_DONE else { throw MobileError.message("The walk journal could not save this change.") }
        return rows
    }
    private func execute(_ sql: String, _ args: [String] = []) throws {
        _ = try query(sql,args) { _ in true }
    }
    private func text(_ s: OpaquePointer,_ i: Int32) -> String { String(cString: sqlite3_column_text(s,i)) }
    private func json(_ s: OpaquePointer,_ i: Int32) throws -> Record {
        guard let row = try JSONSerialization.jsonObject(with: Data(text(s,i).utf8)) as? Record else { throw MobileError.message("Invalid walk entry.") }
        return row
    }
    private var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    func list() throws -> [Record] {
        try query("SELECT id,start,ending,paused FROM walks ORDER BY start",[]) { s in
            let end: Any = sqlite3_column_type(s,2) == SQLITE_NULL ? NSNull() as Any : sqlite3_column_int64(s,2) as Any
            return ["id":text(s,0),"start":sqlite3_column_int64(s,1),"end":end,"paused":sqlite3_column_int(s,3) != 0]
        }
    }
    func active() throws -> Record? { try list().first { $0["end"] is NSNull } }
    func start() throws -> Record {
        if try active() == nil {
            try execute("INSERT INTO walks(id,start,paused) VALUES(?,?,0)",[UUID().uuidString,String(now)])
            lastSong = ""
        }
        try pause(false)
        guard let row = try active() else { throw MobileError.message("The walk could not start.") }
        return row
    }
    func pause(_ paused: Bool) throws {
        try execute("UPDATE walks SET paused=? WHERE ending IS NULL",[paused ? "1":"0"])
        cut = true; lastPoint = nil
    }
    func finish() throws {
        try execute("UPDATE walks SET ending=?,paused=1 WHERE ending IS NULL",[String(now)])
        cut = true; lastPoint = nil; lastSong = ""
    }
    func acknowledge(_ id: String) throws { try execute("DELETE FROM walks WHERE id=? AND ending IS NOT NULL",[id]) }
    func page(_ id: String,_ cursor: Int64) throws -> Record {
        var last = cursor
        let entries: [Record] = try query("SELECT seq,kind,data FROM events WHERE walk=? AND seq>? ORDER BY seq LIMIT 256",[id,String(cursor)]) { s in
            last = sqlite3_column_int64(s,0)
            return ["kind":text(s,1),"data":try json(s,2)]
        }
        return ["events":entries,"cursor":last]
    }
    private func append(_ id: String,_ kind: String,_ value: Record) throws {
        let data = try JSONSerialization.data(withJSONObject:value)
        try execute("INSERT INTO events(walk,kind,data) VALUES(?,?,?)",[id,kind,String(decoding:data,as:UTF8.self)])
    }
    func point(_ fix: CLLocation) throws {
        let at = Int64(fix.timestamp.timeIntervalSince1970 * 1000)
        guard let walk = try active(), let id = walk["id"] as? String, walk["paused"] as? Bool == false,
              fix.horizontalAccuracy >= 0 && fix.horizontalAccuracy <= 80, abs(now-at) < 30000,
              at >= (walk["start"] as? Int64 ?? now), CLLocationCoordinate2DIsValid(fix.coordinate) else { return }
        if let previous = lastPoint {
            let seconds = fix.timestamp.timeIntervalSince(previous.timestamp)
            if seconds <= 0 { return }
            let distance = fix.distance(from:previous)
            if seconds < 18 && distance < max(4,min(22,(fix.horizontalAccuracy+previous.horizontalAccuracy)*0.45)) { return }
            cut = cut || seconds > 90 || (distance > 100 && distance/seconds > 12)
        }
        try append(id,"points",["at":at,"lat":fix.coordinate.latitude,"lon":fix.coordinate.longitude,"accuracy":fix.horizontalAccuracy,"cut":cut])
        cut = false; lastPoint = fix
    }
    func song(_ value: Record) throws {
        guard let walk = try active(), let id = walk["id"] as? String else { return }
        var data = Record()
        if value["playing"] as? Bool == true && (value["audible"] as? Bool ?? true) {
            for key in ["title","artist","stationName","stationId"] {
                if let text = value[key] as? String, !text.isEmpty { data[key] = String(text.prefix(250)) }
            }
        }
        let identity = String(decoding:try JSONSerialization.data(withJSONObject:data,options:.sortedKeys),as:UTF8.self)
        if lastSong == identity { return }
        data["at"] = now
        try append(id,"changes",data)
        lastSong = identity
    }
}
