#include "webmap.h"

#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

static void test_create_destroy(void)
{
    webmap_ctx_t *ctx = webmap_create();
    assert(ctx);
    assert(webmap_tile_count(ctx) == 0);
    assert(webmap_overlay_count(ctx) == 0);
    webmap_destroy(ctx);
    printf("  PASS: create/destroy\n");
}

static void test_projection(void)
{
    webmap_lonlat_t ll = {-97.5, 35.5};
    webmap_mercator_t m;
    webmap_lonlat_t back;
    webmap_tile_id_t tid;

    webmap_lonlat_to_mercator(ll, &m);
    webmap_mercator_to_lonlat(m, &back);
    assert(fabs(back.lon - ll.lon) < 1e-6);
    assert(fabs(back.lat - ll.lat) < 1e-6);

    webmap_lonlat_to_tile(ll, 10, &tid);
    assert(tid.z == 10);
    assert(webmap_tile_count_at_zoom(0) == 1);
    assert(webmap_tile_count_at_zoom(2) == 4);
    printf("  PASS: projection tile=%u/%u/%u\n", tid.z, tid.x, tid.y);
}

static void test_camera_need_tile(void)
{
    webmap_ctx_t *ctx = webmap_create();
    webmap_camera_t cam;
    webmap_event_t ev;
    int need;
    int saw_need = 0;

    webmap_get_camera(ctx, &cam);
    cam.zoom = 10;
    cam.center.lon = -97.5;
    cam.center.lat = 35.5;
    webmap_set_camera(ctx, &cam);

    assert(webmap_next_event(ctx, &ev) == 1);
    assert(ev.type == WEBMAP_EVENT_CAMERA_CHANGED);

    need = webmap_update_visible_tiles(ctx);
    assert(need > 0);
    while (webmap_next_event(ctx, &ev) == 1) {
        if (ev.type == WEBMAP_EVENT_NEED_TILE) {
            saw_need = 1;
            assert(ev.tile.z == 10);
        }
    }
    assert(saw_need);
    webmap_destroy(ctx);
    printf("  PASS: camera NEED_TILE\n");
}

static void test_overlay_status(void)
{
    webmap_ctx_t *ctx = webmap_create();
    webmap_lonlat_t line[2] = {{-97.51, 35.50}, {-97.49, 35.51}};
    webmap_overlay_desc_t d;
    webmap_gpu_layer_t layers[2];
    webmap_event_t ev;
    size_t n;

    memset(&d, 0, sizeof(d));
    d.id = 42;
    d.feature_class = WEBMAP_CLASS_FIBER_SPAN;
    d.status = WEBMAP_STATUS_DOWN;
    d.kind = WEBMAP_LAYER_LINE;
    d.points = line;
    d.n_points = 2;
    snprintf(d.label, sizeof(d.label), "span-42");

    assert(webmap_upsert_overlay(ctx, &d) == 0);
    assert(webmap_overlay_count(ctx) == 1);
    assert(webmap_next_event(ctx, &ev) == 1);
    assert(ev.type == WEBMAP_EVENT_OVERLAY_UPSERTED);
    assert(ev.overlay_id == 42);

    n = webmap_build_overlay_gpu(ctx, layers, 2);
    assert(n == 1);
    assert(layers[0].vertex_count == 2);
    assert(layers[0].index_count == 2);
    assert(layers[0].vertices[0].rgba == webmap_status_rgba(WEBMAP_STATUS_DOWN));

    assert(webmap_remove_overlay(ctx, 42) == 0);
    assert(webmap_overlay_count(ctx) == 0);
    webmap_destroy(ctx);
    printf("  PASS: fiber overlay status\n");
}

static void test_status_names(void)
{
    assert(strcmp(webmap_status_name(WEBMAP_STATUS_OK), "ok") == 0);
    assert(strcmp(webmap_feature_class_name(WEBMAP_CLASS_POWER_LINE),
                  "power_line") == 0);
    printf("  PASS: name helpers\n");
}

int main(void)
{
    printf("webmap_smoke:\n");
    test_create_destroy();
    test_projection();
    test_camera_need_tile();
    test_overlay_status();
    test_status_names();
    printf("ALL PASS\n");
    return 0;
}
