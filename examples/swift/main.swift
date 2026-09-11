import Melodica

if melodica_version() != 768 {
    fatalError("unexpected melodica version")
}

var body = [CChar](repeating: 0, count: 128)
var written: Int = 0
let rc = body.withUnsafeMutableBufferPointer { buffer in
    melodica_stations_body(25, 0, buffer.baseAddress, buffer.count, &written)
}
if rc != 0 {
    fatalError("melodica_stations_body failed")
}

let bytes = body.prefix(written).map { UInt8(bitPattern: $0) }
print("Swift: \(String(decoding: bytes, as: UTF8.self))")
