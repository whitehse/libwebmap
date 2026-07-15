# Building libwebmap WASM (no Emscripten)

## Decision

ADR-009 forbids Emscripten. WASM is produced with **clang** + **wasm-ld** and
the freestanding runtime in `wasm/webmap_wasm_rt.c`.

## Chosen path: freestanding + bump allocator

| Concern | Solution |
|---------|----------|
| libc | Not linked (`-nostdlib -ffreestanding`) |
| `malloc` / `calloc` / `realloc` / `free` | Bump allocator in `webmap_wasm_rt.c` (`memory.grow`) |
| `memcpy` / `memset` / `strlen` / … | Local implementations in the same file |
| libm (`log`, `tan`, `cos`, …) | Soft-float approximations in `webmap_wasm_rt.c` |
| Entry | `--no-entry`; host instantiates and calls exports |
| Memory | Host imports linear memory (`--import-memory`) |

### Build

```bash
cmake -B build-wasm -S . \
  -DCMAKE_TOOLCHAIN_FILE=cmake/WasmToolchain.cmake \
  -DWEBMAP_BUILD_WASM=ON \
  -DWEBMAP_BUILD_TOOLS=OFF \
  -DWEBMAP_BUILD_TESTS=OFF \
  -DWEBMAP_BUILD_DEMO=OFF
cmake --build build-wasm
# → build-wasm/webmap.wasm
```

Copy into the demo (optional):

```bash
cp build-wasm/webmap.wasm demo/
```

### Host instantiation (sketch)

```js
const memory = new WebAssembly.Memory({ initial: 256, maximum: 2048 });
const { instance } = await WebAssembly.instantiateStreaming(fetch("webmap.wasm"), {
  env: { memory },
});
// instance.exports.webmap_create, webmap_load_wmap_tile, …
```

## Why not wasi-libc?

WASI is fine for CLI tools but pulls a larger ABI surface for a browser map
module. The freestanding path keeps the artifact minimal and matches ADR-009.

## Why not host-imported malloc?

Either approach is valid under ADR-009. Self-contained bump allocation avoids
host ABI drift; the tradeoff is that `free` is a no-op (acceptable for session
map state that lives until module teardown). Revisit if long-lived reload
cycles need a real free-list.
