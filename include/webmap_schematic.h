/**
 * @file webmap_schematic.h
 * @brief Pure geometry layout for fiber meet-point schematics (ADR-020 / P4.10).
 *
 * Host interaction (click/hold, pan, zoom, Canvas paint) stays JS. This module
 * turns splice_detail JSON into a packed binary layout: cable hubs, strand
 * chip positions, fuse bridge endpoints — at true geographic approaches.
 *
 * Syscall-free; freestanding-safe (no FILE I/O).
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef WEBMAP_SCHEMATIC_H
#define WEBMAP_SCHEMATIC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Little-endian 'WSCH' */
#define WEBMAP_SCHEMATIC_MAGIC   0x48435357u
#define WEBMAP_SCHEMATIC_VERSION 1u

#define WEBMAP_SCHEMATIC_MAX_CABLES           24u
#define WEBMAP_SCHEMATIC_MAX_FIBERS           512u
#define WEBMAP_SCHEMATIC_MAX_FUSES            256u
#define WEBMAP_SCHEMATIC_MAX_FIBERS_PER_CABLE 288u
#define WEBMAP_SCHEMATIC_GUID_LEN             40u

/**
 * Binary blob layout (little-endian, packed):
 *   header (webmap_schematic_header_t)
 *   cable[n_cables]  (webmap_schematic_cable_t)
 *   fiber[n_fibers]  (webmap_schematic_fiber_t)
 *   fuse[n_fuses]    (webmap_schematic_fuse_t)
 *
 * Coordinates are layout-space floats (same convention as Canvas CSS px
 * when cx/cy/radius match the magnifier body).
 */
typedef struct {
    uint32_t magic;
    uint32_t version;
    float    cx;
    float    cy;
    float    radius;
    uint32_t n_cables;
    uint32_t n_fibers;
    uint32_t n_fuses;
    uint32_t flags; /* bit0: kind was tap */
} webmap_schematic_header_t;

typedef struct {
    char     guid[WEBMAP_SCHEMATIC_GUID_LEN];
    float    approach_deg; /* true degrees 0=N … 360 (not snapped) */
    float    ux;
    float    uy;
    float    x; /* hub on ring */
    float    y;
    uint8_t  is_drop;
    uint8_t  _pad0;
    uint16_t size; /* cable fiber count from detail, 0 if unknown */
    uint16_t fiber_count;
    uint16_t fiber_start; /* index into fiber table */
} webmap_schematic_cable_t;

typedef struct {
    uint16_t cable_index;
    uint16_t fiber_num; /* 1-based */
    float    x;
    float    y;
    float    chip_r;
} webmap_schematic_fiber_t;

typedef struct {
    uint16_t a_cable;
    uint16_t a_fiber;
    uint16_t b_cable;
    uint16_t b_fiber;
    float    ax;
    float    ay;
    float    bx;
    float    by;
    float    mx; /* bridge midpoint (label) */
    float    my;
} webmap_schematic_fuse_t;

/**
 * Compute schematic layout from splice_detail JSON bytes.
 *
 * @param json      UTF-8 splice_detail document (v1/v2 shape)
 * @param json_len  byte length
 * @param cx,cy     layout origin (e.g. 0,0)
 * @param radius    approach ring radius; if <= 0 uses 100.f
 * @param out       destination buffer
 * @param out_cap   capacity in bytes
 * @return bytes written on success, 0 on failure (bad JSON, overflow, empty)
 */
size_t webmap_schematic_layout(const uint8_t *json, size_t json_len,
                               float cx, float cy, float radius,
                               uint8_t *out, size_t out_cap);

/** Bytes needed for a layout with the given counts (header + tables). */
size_t webmap_schematic_blob_size(uint32_t n_cables, uint32_t n_fibers,
                                  uint32_t n_fuses);

/** Snap degrees to nearest 45° in [0, 360). Kept for tests/tools; layout uses true bearings. */
float webmap_schematic_snap_deg45(float deg);

/**
 * Approach unit vector: 0°=N (up, −y), 90°=E (+x). Canvas-style +y down.
 */
void webmap_schematic_approach_unit(float deg, float *ux, float *uy);

#ifdef __cplusplus
}
#endif

#endif /* WEBMAP_SCHEMATIC_H */
