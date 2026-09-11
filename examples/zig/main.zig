const std = @import("std");
const c = @cImport({
    @cInclude("dist/melodica.h");
});

pub fn main() !void {
    const json = "{\"authToken\":\"auth-123\",\"username\":\"listener@example.com\",\"webName\":\"listener\",\"userId\":\"u-42\"}";
    var login = std.mem.zeroes(c.melodica_login_view);

    if (c.melodica_version() == 0) return error.BadVersion;
    const rc = c.melodica_parse_login(@ptrCast(json.ptr), json.len, &login);
    if (rc != 0) return error.Melodica;
    if (login.present != 15) return error.BadPresentMask;

    const auth_start: usize = @intCast(login.auth_token.offset);
    const auth_end = auth_start + @as(usize, @intCast(login.auth_token.length));
    if (!std.mem.eql(u8, json[auth_start..auth_end], "auth-123")) return error.BadAuthToken;

    const user_start: usize = @intCast(login.username.offset);
    const user_end = user_start + @as(usize, @intCast(login.username.length));
    if (!std.mem.eql(u8, json[user_start..user_end], "listener@example.com")) return error.BadUsername;
}
