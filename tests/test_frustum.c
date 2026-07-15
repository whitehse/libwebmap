#include "webmap.h"

#include <assert.h>
#include <stdio.h>

static void test_frustum_covers_multiple_tiles(void)
{
    webmap_camera_t cam;
    webmap_tile_id_t tmin, tmax;
    webmap_ctx_t *ctx;
    webmap_event_t ev;
    int need;
    int count = 0;

    cam.center.lon = -95.99;
    cam.center.lat = 36.15; /* Tulsa */
    cam.zoom = 10.0;
    cam.bearing = 0;
    cam.pitch = 0;
    cam.width_px = 1280;
    cam.height_px = 720;

    assert(webmap_visible_tile_range(&cam, &tmin, &tmax) == 0);
    assert(tmin.z == 10 && tmax.z == 10);
    assert(tmax.x >= tmin.x);
    assert(tmax.y >= tmin.y);
    /* At z10, a 1280x720 view should span more than 1x1 tiles */
    assert((tmax.x - tmin.x + 1) * (tmax.y - tmin.y + 1) >= 4);
    printf("  range z=%u x=%u..%u y=%u..%u\n", tmin.z, tmin.x, tmax.x,
           tmin.y, tmax.y);

    ctx = webmap_create();
    webmap_set_camera(ctx, &cam);
    while (webmap_next_event(ctx, &ev) == 1) {
    }
    need = webmap_update_visible_tiles(ctx);
    assert(need >= 4);
    while (webmap_next_event(ctx, &ev) == 1) {
        if (ev.type == WEBMAP_EVENT_NEED_TILE) {
            count++;
            assert(ev.tile.z == 10);
        }
    }
    assert(count == need);
    webmap_destroy(ctx);
    printf("  PASS: frustum need=%d\n", need);
}

static void test_narrow_viewport(void)
{
    webmap_camera_t cam;
    webmap_tile_id_t tmin, tmax;

    cam.center.lon = -95.99;
    cam.center.lat = 36.15;
    cam.zoom = 12.0;
    cam.bearing = 0;
    cam.pitch = 0;
    cam.width_px = 256;
    cam.height_px = 256;

    assert(webmap_visible_tile_range(&cam, &tmin, &tmax) == 0);
    assert(tmin.x == tmax.x || tmax.x == tmin.x + 1);
    printf("  PASS: narrow viewport tiles=%u\n",
           (tmax.x - tmin.x + 1) * (tmax.y - tmin.y + 1));
}

int main(void)
{
    printf("webmap_frustum:\n");
    test_frustum_covers_multiple_tiles();
    test_narrow_viewport();
    printf("ALL PASS\n");
    return 0;
}
