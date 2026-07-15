/**
 * @file status_map_sketch.c
 * @brief Example: rural fiber + electric status overlays on a basemap tile.
 *
 * Compile via CMake (add as needed) or:
 *   cc -Iinclude examples/status_map_sketch.c -Lbuild -lwebmap -lm
 */

#include "webmap.h"

#include <stdio.h>
#include <string.h>

int main(void)
{
    webmap_ctx_t *ctx = webmap_create();
    webmap_camera_t cam;
    webmap_lonlat_t fiber[2] = {{-97.52, 35.48}, {-97.48, 35.52}};
    webmap_lonlat_t pole = {-97.50, 35.50};
    webmap_overlay_desc_t d;
    webmap_gpu_layer_t gpu;
    webmap_event_t ev;

    webmap_get_camera(ctx, &cam);
    cam.center.lon = -97.5;
    cam.center.lat = 35.5;
    cam.zoom = 12;
    webmap_set_camera(ctx, &cam);
    webmap_update_visible_tiles(ctx);

    memset(&d, 0, sizeof(d));
    d.id = 1001;
    d.feature_class = WEBMAP_CLASS_FIBER_SPAN;
    d.status = WEBMAP_STATUS_OK;
    d.kind = WEBMAP_LAYER_LINE;
    d.points = fiber;
    d.n_points = 2;
    snprintf(d.label, sizeof(d.label), "feeder-A");
    webmap_upsert_overlay(ctx, &d);

    d.id = 2001;
    d.feature_class = WEBMAP_CLASS_POWER_POLE;
    d.status = WEBMAP_STATUS_DEGRADED;
    d.kind = WEBMAP_LAYER_POINT;
    d.points = &pole;
    d.n_points = 1;
    snprintf(d.label, sizeof(d.label), "pole-42");
    webmap_upsert_overlay(ctx, &d);

    while (webmap_next_event(ctx, &ev) == 1) {
        printf("event %s", webmap_event_type_name(ev.type));
        if (ev.type == WEBMAP_EVENT_NEED_TILE) {
            printf(" tile %u/%u/%u", ev.tile.z, ev.tile.x, ev.tile.y);
        }
        if (ev.overlay_id) {
            printf(" overlay=%llu", (unsigned long long)ev.overlay_id);
        }
        printf("\n");
    }

    if (webmap_build_overlay_gpu(ctx, &gpu, 1) == 1) {
        printf("overlay GPU: %zu verts %zu inds\n", gpu.vertex_count,
               gpu.index_count);
    }

    webmap_destroy(ctx);
    return 0;
}
