# Source-language lab

This is a challenger league for implementation languages, separate from the release bake-off.

C, Nelua, Zig, and Odin implement the same `lab_find_string` C ABI, pass the same malformed-JSON conformance cases, and are benchmarked by the same C harness with interleaved median-of-seven trials.

The lab **does not directly promote an Odin or Zig binary into `dist/melodica.h`**. C99 is still the product. Instead, a language winner exposes better algorithms/codegen for us to port back into the C99-emitting release candidates. C and Nelua can be release-material directly; Zig's C backend can be explored separately; Odin is an algorithmic/native challenger.

Results are committed to `lab/BENCHMARK.tsv` and the fastest language to `lab/WINNER`. This is intentionally a speed league; release scoring remains stricter and includes header/object size plus full API conformance.
