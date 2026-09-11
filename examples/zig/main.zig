const std = @import("std");
const c = @cImport({
    @cInclude("dist/melodica.h");
});

pub fn main() !void {
    if (c.melodica_version() != 768) return error.BadVersion;

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

    var out = std.fs.File.stdout().writer(&.{});
    try out.interface.print("Zig: {s}\n", .{body[0..written]});
}
