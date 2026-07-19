/**
 * @file webmap_wasm_entry.c
 * @brief Freestanding WASM exports for browser host (no Emscripten).
 */

#include "webmap.h"
#include "webmap_schematic.h"

/* Marker for host feature detection. */
const char webmap_wasm_build_id[] = "libwebmap-0.1.0-no-emscripten";

/* Explicit exports keep a stable ABI when linked with --export-dynamic. */
__attribute__((export_name("webmap_create")))
webmap_ctx_t *wm_create(void)
{
    return webmap_create();
}

__attribute__((export_name("webmap_destroy")))
void wm_destroy(webmap_ctx_t *ctx)
{
    webmap_destroy(ctx);
}

__attribute__((export_name("webmap_set_camera")))
void wm_set_camera(webmap_ctx_t *ctx, const webmap_camera_t *cam)
{
    webmap_set_camera(ctx, cam);
}

__attribute__((export_name("webmap_update_visible_tiles")))
int wm_update_visible_tiles(webmap_ctx_t *ctx)
{
    return webmap_update_visible_tiles(ctx);
}

__attribute__((export_name("webmap_load_wmap_tile")))
int wm_load_wmap_tile(webmap_ctx_t *ctx, const uint8_t *data, size_t len)
{
    return webmap_load_wmap_tile(ctx, data, len);
}

/* P4.13: host decode-and-drop — free C cache after layer extract / GPU upload */
__attribute__((export_name("webmap_drop_tile")))
int wm_drop_tile(webmap_ctx_t *ctx, uint32_t z, uint32_t x, uint32_t y)
{
    webmap_tile_id_t id;
    id.z = (uint8_t)z;
    id.x = x;
    id.y = y;
    return webmap_drop_tile(ctx, id);
}

__attribute__((export_name("webmap_tile_count")))
size_t wm_tile_count(const webmap_ctx_t *ctx)
{
    return webmap_tile_count(ctx);
}

__attribute__((export_name("webmap_next_event")))
int wm_next_event(webmap_ctx_t *ctx, webmap_event_t *ev)
{
    return webmap_next_event(ctx, ev);
}

__attribute__((export_name("webmap_get_tile_layers")))
size_t wm_get_tile_layers(const webmap_ctx_t *ctx, webmap_tile_id_t id,
                          webmap_gpu_layer_t *out, size_t max_layers)
{
    return webmap_get_tile_layers(ctx, id, out, max_layers);
}

__attribute__((export_name("webmap_build_overlay_gpu")))
size_t wm_build_overlay_gpu(const webmap_ctx_t *ctx, webmap_gpu_layer_t *out,
                            size_t max_layers)
{
    return webmap_build_overlay_gpu(ctx, out, max_layers);
}

__attribute__((export_name("webmap_upsert_overlay")))
int wm_upsert_overlay(webmap_ctx_t *ctx, const webmap_overlay_desc_t *desc)
{
    return webmap_upsert_overlay(ctx, desc);
}

__attribute__((export_name("webmap_wasm_build_id_ptr")))
const char *wm_build_id_ptr(void)
{
    return webmap_wasm_build_id;
}

/* P4.10 / ADR-020: pure geometry layout from splice_detail JSON */
__attribute__((export_name("webmap_schematic_layout")))
size_t wm_schematic_layout(const uint8_t *json, size_t json_len, float cx,
                           float cy, float radius, uint8_t *out, size_t out_cap)
{
    return webmap_schematic_layout(json, json_len, cx, cy, radius, out,
                                   out_cap);
}

__attribute__((export_name("webmap_schematic_blob_size")))
size_t wm_schematic_blob_size(uint32_t n_cables, uint32_t n_fibers,
                              uint32_t n_fuses)
{
    return webmap_schematic_blob_size(n_cables, n_fibers, n_fuses);
}
