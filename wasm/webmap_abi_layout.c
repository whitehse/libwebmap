/**
 * @file webmap_abi_layout.c
 * @brief wasm32 host ABI packing table (P4.4 / ADR-024).
 *
 * Offsets are compile-time for the active target. Browser host must use the
 * **wasm32** values (exported at runtime), not host-native sizeof.
 */

#include "webmap.h"

#include <stddef.h>
#include <stdint.h>

/**
 * Fixed little-endian table of u32 fields.
 * Layout version 1 — keep in sync with demo/display/wasm_abi.js expectations.
 */
typedef struct {
    uint32_t version; /* 1 */
    uint32_t ptr_size;
    uint32_t size_t_size;
    uint32_t size_vertex;
    uint32_t size_tile_id;
    uint32_t off_tile_z;
    uint32_t off_tile_x;
    uint32_t off_tile_y;
    uint32_t size_gpu_layer;
    uint32_t off_layer_vertices;
    uint32_t off_layer_vertex_count;
    uint32_t off_layer_indices;
    uint32_t off_layer_index_count;
    uint32_t off_layer_kind;
    uint32_t off_layer_feature_class;
    uint32_t off_layer_name;
    uint32_t off_layer_extent;
    uint32_t size_config;
    uint32_t off_cfg_event_queue;
    uint32_t off_cfg_max_tiles;
    uint32_t off_cfg_max_overlays;
    uint32_t off_cfg_max_layers;
    uint32_t size_event;
    uint32_t off_ev_type;
    uint32_t off_ev_tile;
    uint32_t off_ev_overlay_id;
    uint32_t off_ev_reason;
    uint32_t size_layer_view; /* flat host-friendly view */
} webmap_abi_pack_t;

/**
 * Flat layer view for hosts (no host-pointer width issues).
 * Pointers are linear-memory offsets as uint32_t (wasm32).
 */
typedef struct {
    uint32_t vertices_ptr;
    uint32_t vertex_count;
    uint32_t indices_ptr;
    uint32_t index_count;
    uint32_t kind;
    uint32_t feature_class;
    uint32_t extent;
    char     name[64];
} webmap_wasm_layer_view_t;

static const webmap_abi_pack_t g_abi_pack = {
    1u,
    (uint32_t)sizeof(void *),
    (uint32_t)sizeof(size_t),
    (uint32_t)sizeof(webmap_vertex_t),
    (uint32_t)sizeof(webmap_tile_id_t),
    (uint32_t)offsetof(webmap_tile_id_t, z),
    (uint32_t)offsetof(webmap_tile_id_t, x),
    (uint32_t)offsetof(webmap_tile_id_t, y),
    (uint32_t)sizeof(webmap_gpu_layer_t),
    (uint32_t)offsetof(webmap_gpu_layer_t, vertices),
    (uint32_t)offsetof(webmap_gpu_layer_t, vertex_count),
    (uint32_t)offsetof(webmap_gpu_layer_t, indices),
    (uint32_t)offsetof(webmap_gpu_layer_t, index_count),
    (uint32_t)offsetof(webmap_gpu_layer_t, kind),
    (uint32_t)offsetof(webmap_gpu_layer_t, feature_class),
    (uint32_t)offsetof(webmap_gpu_layer_t, name),
    (uint32_t)offsetof(webmap_gpu_layer_t, extent),
    (uint32_t)sizeof(webmap_config_t),
    (uint32_t)offsetof(webmap_config_t, event_queue_size),
    (uint32_t)offsetof(webmap_config_t, max_tiles),
    (uint32_t)offsetof(webmap_config_t, max_overlays),
    (uint32_t)offsetof(webmap_config_t, max_layers_per_tile),
    (uint32_t)sizeof(webmap_event_t),
    (uint32_t)offsetof(webmap_event_t, type),
    (uint32_t)offsetof(webmap_event_t, tile),
    (uint32_t)offsetof(webmap_event_t, overlay_id),
    (uint32_t)offsetof(webmap_event_t, reason),
    (uint32_t)sizeof(webmap_wasm_layer_view_t),
};

__attribute__((export_name("webmap_wasm_abi_pack_ptr")))
const webmap_abi_pack_t *webmap_wasm_abi_pack_ptr(void)
{
    return &g_abi_pack;
}

__attribute__((export_name("webmap_wasm_abi_pack_size")))
uint32_t webmap_wasm_abi_pack_size(void)
{
    return (uint32_t)sizeof(g_abi_pack);
}

__attribute__((export_name("webmap_create_with_config")))
webmap_ctx_t *wm_create_with_config(const webmap_config_t *cfg)
{
    return webmap_create_with_config(cfg);
}

/**
 * Fill a flat layer view for tile (z,x,y) at layer_index.
 * Returns 1 on success, 0 if missing tile/layer.
 */
__attribute__((export_name("webmap_wasm_get_layer")))
int webmap_wasm_get_layer(webmap_ctx_t *ctx, uint32_t z, uint32_t x, uint32_t y,
                         uint32_t layer_index, webmap_wasm_layer_view_t *out)
{
    webmap_tile_id_t id;
    webmap_gpu_layer_t layers[32];
    size_t n;
    const webmap_gpu_layer_t *L;
    size_t i;

    if (!ctx || !out) {
        return 0;
    }
    id.z = (uint8_t)z;
    id.x = x;
    id.y = y;
    n = webmap_get_tile_layers(ctx, id, layers, 32);
    if (layer_index >= n) {
        return 0;
    }
    L = &layers[layer_index];
    out->vertices_ptr = (uint32_t)(uintptr_t)L->vertices;
    out->vertex_count = (uint32_t)L->vertex_count;
    out->indices_ptr = (uint32_t)(uintptr_t)L->indices;
    out->index_count = (uint32_t)L->index_count;
    out->kind = (uint32_t)L->kind;
    out->feature_class = (uint32_t)L->feature_class;
    out->extent = L->extent;
    for (i = 0; i < 64; i++) {
        out->name[i] = L->name[i];
        if (L->name[i] == '\0') {
            break;
        }
    }
    if (i < 64) {
        /* already NUL terminated */
    } else {
        out->name[63] = '\0';
    }
    return 1;
}

/** Layer count for a loaded tile (0 if missing). */
__attribute__((export_name("webmap_wasm_layer_count")))
uint32_t webmap_wasm_layer_count(webmap_ctx_t *ctx, uint32_t z, uint32_t x,
                                uint32_t y)
{
    webmap_tile_id_t id;
    webmap_gpu_layer_t layers[32];
    if (!ctx) {
        return 0;
    }
    id.z = (uint8_t)z;
    id.x = x;
    id.y = y;
    return (uint32_t)webmap_get_tile_layers(ctx, id, layers, 32);
}
