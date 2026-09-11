const std = @import("std");
const c = @cImport({
    @cInclude("dist/melodica.h");
});

pub fn main() !void {
    if (c.melodica_version() == 0) return error.BadVersion;

    var body: [128]u8 = undefined;
    var written: usize = 0;
    const rc = c.melodica_stations_body(
        25,
        0,
        @ptrCast(&body),
        body.len,
        &written,
    );
    if (rc != 0) return error.Melodica;

    const expected = "{\"pageSize\":25,\"startIndex\":0}";
    if (!std.mem.eql(u8, body[0..written], expected)) return error.BadBody;
}
