package main

import "core:c"
import "core:fmt"

foreign import melodica "../../build/languages/libmelodica.a"

foreign melodica {
    melodica_version :: proc() -> c.uint ---
    melodica_stations_body :: proc(
        page_size, start_index: c.uint,
        output: rawptr,
        output_cap: c.size_t,
        output_len: ^c.size_t,
    ) -> c.int ---
}

main :: proc() {
    if melodica_version() == 0 {
        panic("invalid melodica version")
    }

    body: [128]u8
    written: c.size_t
    rc := melodica_stations_body(25, 0, rawptr(&body[0]), c.size_t(len(body)), &written)
    if rc != 0 {
        panic("melodica_stations_body failed")
    }

    fmt.printf("Odin: %s\n", body[:int(written)])
}
