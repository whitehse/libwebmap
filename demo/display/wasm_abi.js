/**
 * Expected wasm32 ABI packing (P4.4 / ADR-024).
 * Runtime must prefer values from webmap_wasm_abi_pack_ptr when present.
 */

/** @typedef {Record<string, number>} WasmAbiPack */

/** clang wasm32 freestanding baseline (verified against module export). */
export const WASM32_ABI_EXPECTED = Object.freeze({
  version: 1,
  ptr_size: 4,
  size_t_size: 4,
  size_vertex: 12,
  size_tile_id: 12,
  off_tile_z: 0,
  off_tile_x: 4,
  off_tile_y: 8,
  size_gpu_layer: 92,
  off_layer_vertices: 0,
  off_layer_vertex_count: 4,
  off_layer_indices: 8,
  off_layer_index_count: 12,
  off_layer_kind: 16,
  off_layer_feature_class: 20,
  off_layer_name: 24,
  off_layer_extent: 88,
  size_config: 16,
  off_cfg_event_queue: 0,
  off_cfg_max_tiles: 4,
  off_cfg_max_overlays: 8,
  off_cfg_max_layers: 12,
  size_layer_view: 4 + 4 + 4 + 4 + 4 + 4 + 4 + 64, /* 92 */
});

const PACK_FIELDS = [
  "version",
  "ptr_size",
  "size_t_size",
  "size_vertex",
  "size_tile_id",
  "off_tile_z",
  "off_tile_x",
  "off_tile_y",
  "size_gpu_layer",
  "off_layer_vertices",
  "off_layer_vertex_count",
  "off_layer_indices",
  "off_layer_index_count",
  "off_layer_kind",
  "off_layer_feature_class",
  "off_layer_name",
  "off_layer_extent",
  "size_config",
  "off_cfg_event_queue",
  "off_cfg_max_tiles",
  "off_cfg_max_overlays",
  "off_cfg_max_layers",
  "size_event",
  "off_ev_type",
  "off_ev_tile",
  "off_ev_overlay_id",
  "off_ev_reason",
  "size_layer_view",
];

/**
 * @param {WebAssembly.Memory} memory
 * @param {WebAssembly.Exports} exports
 * @returns {WasmAbiPack}
 */
export function readAbiPack(memory, exports) {
  const ptrFn = exports.webmap_wasm_abi_pack_ptr;
  const sizeFn = exports.webmap_wasm_abi_pack_size;
  if (typeof ptrFn !== "function") {
    return { ...WASM32_ABI_EXPECTED };
  }
  const ptr = Number(ptrFn());
  const nbytes =
    typeof sizeFn === "function"
      ? Number(sizeFn())
      : PACK_FIELDS.length * 4;
  const u32 = new Uint32Array(memory.buffer, ptr, Math.floor(nbytes / 4));
  /** @type {WasmAbiPack} */
  const pack = {};
  for (let i = 0; i < PACK_FIELDS.length && i < u32.length; i++) {
    pack[PACK_FIELDS[i]] = u32[i];
  }
  return pack;
}

/**
 * @param {WasmAbiPack} pack
 * @returns {string[]} mismatch messages
 */
export function validateAbiPack(pack) {
  const msgs = [];
  const keys = [
    "version",
    "ptr_size",
    "size_t_size",
    "size_vertex",
    "size_tile_id",
    "size_gpu_layer",
    "off_layer_vertices",
    "off_layer_vertex_count",
    "off_layer_name",
    "off_layer_extent",
  ];
  for (const k of keys) {
    if (pack[k] !== WASM32_ABI_EXPECTED[k]) {
      msgs.push(
        `${k}: module=${pack[k]} expected_wasm32=${WASM32_ABI_EXPECTED[k]}`
      );
    }
  }
  if (pack.ptr_size !== 4 || pack.size_t_size !== 4) {
    msgs.push("host must treat pointers and size_t as u32 on wasm32");
  }
  return msgs;
}

/** Flat layer view offsets (matches webmap_wasm_layer_view_t). */
export const LAYER_VIEW = Object.freeze({
  vertices_ptr: 0,
  vertex_count: 4,
  indices_ptr: 8,
  index_count: 12,
  kind: 16,
  feature_class: 20,
  extent: 24,
  name: 28,
  size: 92,
});
