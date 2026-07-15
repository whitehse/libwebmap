/**
 * @file webmap_wasm_entry.c
 * @brief Freestanding WASM exports for browser host (no Emscripten).
 */

#include "webmap.h"

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
