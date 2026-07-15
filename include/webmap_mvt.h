/**
 * @file webmap_mvt.h
 * @brief Minimal Mapbox Vector Tile (MVT) decoder for host-side conversion.
 *
 * Used by tools/gfvtile2wmap to ingest GeoFabrik experimental vector tiles
 * (.pbf / MVT). Not required at runtime by the WASM map core if tiles are
 * preconverted to .wmap.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef LIBWEBMAP_MVT_H
#define LIBWEBMAP_MVT_H

#include "webmap.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    WEBMAP_MVT_UNKNOWN = 0,
    WEBMAP_MVT_POINT   = 1,
    WEBMAP_MVT_LINE    = 2,
    WEBMAP_MVT_POLYGON = 3
} webmap_mvt_geom_type_t;

typedef struct {
    char                   name[64];
    webmap_mvt_geom_type_t geom_type;
    webmap_vertex_t       *vertices;
    size_t                 vertex_count;
    size_t                 vertex_cap;
    uint32_t              *indices;
    size_t                 index_count;
    size_t                 index_cap;
    uint32_t               extent;
} webmap_mvt_layer_t;

typedef struct {
    webmap_mvt_layer_t *layers;
    size_t              layer_count;
    size_t              layer_cap;
} webmap_mvt_tile_t;

/** Decode an MVT protobuf blob into tessellated GPU layers. */
int webmap_mvt_decode(const uint8_t *data, size_t len, webmap_mvt_tile_t *out);

void webmap_mvt_tile_free(webmap_mvt_tile_t *tile);

/**
 * Map common OSM / OpenMapTiles layer names to utility feature classes
 * when relevant; otherwise WEBMAP_CLASS_BASEMAP.
 */
webmap_feature_class_t webmap_mvt_layer_class(const char *name);

/**
 * Default basemap color for a Shortbread/OpenMapTiles layer name (RGBA packed).
 * Prefer webmap_mvt_feature_rgba when feature `kind` is available.
 */
uint32_t webmap_mvt_layer_rgba(const char *name);

/**
 * Shortbread-aware paint color for a layer + feature `kind` property
 * (VersaTiles Colorful palette). `kind` may be NULL.
 * Packed as 0xAABBGGRR.
 */
uint32_t webmap_mvt_feature_rgba(const char *layer, const char *kind);

#ifdef __cplusplus
}
#endif

#endif /* LIBWEBMAP_MVT_H */
