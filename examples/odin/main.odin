package main

import m "../../bindings/odin"

LOGIN_JSON :: "{\"authToken\":\"auth-123\",\"username\":\"listener@example.com\",\"webName\":\"listener\",\"userId\":\"u-42\"}"

main :: proc() {
    if m.melodica_version() == 0 do panic("invalid melodica version")

    login: m.Login_View
    json := LOGIN_JSON
    rc := m.parse_login(json, &login)
    if rc != m.OK do panic("melodica_parse_login failed")
    if login.present != m.LOGIN_ALL do panic("bad login present mask")

    if m.slice_string(json, login.auth_token) != "auth-123" do panic("bad auth token slice")
    if m.slice_string(json, login.username) != "listener@example.com" do panic("bad username slice")
    if m.slice_string(json, login.web_name) != "listener" do panic("bad web name slice")
    if m.slice_string(json, login.user_id) != "u-42" do panic("bad user id slice")
}
