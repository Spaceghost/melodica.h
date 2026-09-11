import Melodica

let jsonString = "{\"authToken\":\"auth-123\",\"username\":\"listener@example.com\",\"webName\":\"listener\",\"userId\":\"u-42\"}"
let json = jsonString.utf8.map { CChar(bitPattern: $0) }
var login = melodica_login_view()

if melodica_version() == 0 {
    fatalError("invalid melodica version")
}

let rc = json.withUnsafeBufferPointer { buffer in
    melodica_parse_login(buffer.baseAddress, buffer.count, &login)
}
if rc != 0 { fatalError("melodica_parse_login failed") }
if login.present != 15 { fatalError("bad login present mask") }

func text(_ slice: melodica_slice) -> String {
    let start = Int(slice.offset)
    let end = start + Int(slice.length)
    let bytes = json[start..<end].map { UInt8(bitPattern: $0) }
    return String(decoding: bytes, as: UTF8.self)
}

if text(login.auth_token) != "auth-123" { fatalError("bad auth token slice") }
if text(login.username) != "listener@example.com" { fatalError("bad username slice") }
if text(login.web_name) != "listener" { fatalError("bad web name slice") }
if text(login.user_id) != "u-42" { fatalError("bad user id slice") }
