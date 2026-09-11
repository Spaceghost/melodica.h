package main

import "core:c"

Melodica_Slice :: struct {
    offset: c.size_t,
    length: c.size_t,
}

Melodica_Login_View :: struct {
    present:    u32,
    auth_token: Melodica_Slice,
    username:   Melodica_Slice,
    web_name:   Melodica_Slice,
    user_id:    Melodica_Slice,
}

foreign import melodica "../../build/languages/libmelodica.a"

foreign melodica {
    melodica_version :: proc() -> c.uint ---
    melodica_parse_login :: proc(
        json: cstring,
        json_len: c.size_t,
        login: ^Melodica_Login_View,
    ) -> c.int ---
}

LOGIN_JSON :: "{\"authToken\":\"auth-123\",\"username\":\"listener@example.com\",\"webName\":\"listener\",\"userId\":\"u-42\"}"

main :: proc() {
    if melodica_version() == 0 do panic("invalid melodica version")

    login: Melodica_Login_View
    rc := melodica_parse_login(cstring(LOGIN_JSON), c.size_t(len(LOGIN_JSON)), &login)
    if rc != 0 do panic("melodica_parse_login failed")
    if login.present != 15 do panic("bad login present mask")

    // Odin keeps compile-time constants intentionally rigid. Copy the literal
    // into a runtime string before slicing with offsets returned by C.
    json := LOGIN_JSON
    auth_start := int(login.auth_token.offset)
    auth_end := auth_start + int(login.auth_token.length)
    if json[auth_start:auth_end] != "auth-123" do panic("bad auth token slice")

    user_start := int(login.username.offset)
    user_end := user_start + int(login.username.length)
    if json[user_start:user_end] != "listener@example.com" do panic("bad username slice")
}
