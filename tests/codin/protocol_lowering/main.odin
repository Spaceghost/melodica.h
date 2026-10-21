package main

Node :: struct { next: ^Node, values: [3]u32 }
foreign import libc "system:c"
foreign libc {
    calloc :: proc "c" (count, size: uintptr) -> rawptr ---
    free :: proc "c" (value: rawptr) ---
}
with_default :: proc "contextless" (value: u32, extra: u32 = 5) -> u32 {
    return value + extra
}
owned_pair :: proc "contextless" () -> (u32, u32) {
    node := cast(^Node)calloc(1, size_of(Node))
    node.values[0] = 17
    node.values[1] = 29
    defer free(rawptr(node))
    return node.values[0], node.values[1]
}
@(export)
compiler_protocol_fixture :: proc "c" () -> u32 {
    _ = with_default(0)
    left, right := owned_pair()
    result := with_default(left) + right
    for i := u32(0); i < 6; i += 1 {
        if i == 2 { continue }
        result += i
    }
    node: Node
    node.values[0] = result
    node.values[1] = u32(offset_of(Node, values))
    node.values[2] = u32(align_of(Node))
    pointer := &node
    return pointer.values[0] + pointer.values[1] + pointer.values[2]
}
