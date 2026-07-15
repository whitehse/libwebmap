/**
 * @file main.c
 * @brief gfvtile2wmap — GeoFabrik MVT → .wmap converter.
 *
 * Usage:
 *   gfvtile2wmap -z Z -x X -y Y input.pbf -o out.wmap
 *   gfvtile2wmap --dir tiles_root --zmin 8 --zmax 12 -o out_dir
 *   gfvtile2wmap --dir tiles_root --bbox W,S,E,N --zmin 8 --zmax 12 -o out_dir
 *
 * Directory mode expects {z}/{x}/{y}.pbf (XYZ, gunzipped MVT).
 */

#include "webmap.h"
#include "webmap_mvt.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>

static uint8_t *read_file(const char *path, size_t *out_len)
{
    FILE *f = fopen(path, "rb");
    uint8_t *buf;
    long sz;
    if (!f) {
        fprintf(stderr, "open %s: %s\n", path, strerror(errno));
        return NULL;
    }
    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return NULL;
    }
    sz = ftell(f);
    if (sz < 0) {
        fclose(f);
        return NULL;
    }
    rewind(f);
    buf = malloc((size_t)sz);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) {
        free(buf);
        fclose(f);
        return NULL;
    }
    fclose(f);
    *out_len = (size_t)sz;
    return buf;
}

static int write_file(const char *path, const uint8_t *data, size_t len)
{
    FILE *f = fopen(path, "wb");
    if (!f) {
        fprintf(stderr, "write %s: %s\n", path, strerror(errno));
        return -1;
    }
    if (fwrite(data, 1, len, f) != len) {
        fclose(f);
        return -1;
    }
    fclose(f);
    return 0;
}

static int mkdirs_p(const char *path)
{
    char tmp[1024];
    size_t len = strlen(path);
    size_t i;
    if (len >= sizeof(tmp)) {
        return -1;
    }
    memcpy(tmp, path, len + 1);
    for (i = 1; i < len; i++) {
        if (tmp[i] == '/') {
            tmp[i] = '\0';
            if (mkdir(tmp, 0755) != 0 && errno != EEXIST) {
                return -1;
            }
            tmp[i] = '/';
        }
    }
    if (mkdir(tmp, 0755) != 0 && errno != EEXIST) {
        return -1;
    }
    return 0;
}

static webmap_layer_kind_t kind_from_mvt(webmap_mvt_geom_type_t g)
{
    switch (g) {
    case WEBMAP_MVT_POINT:
        return WEBMAP_LAYER_POINT;
    case WEBMAP_MVT_POLYGON:
        return WEBMAP_LAYER_FILL;
    case WEBMAP_MVT_LINE:
    default:
        return WEBMAP_LAYER_LINE;
    }
}

static int convert_buf(const uint8_t *in_data, size_t in_len,
                       webmap_tile_id_t id, const char *out_path, int quiet)
{
    webmap_mvt_tile_t mvt;
    webmap_gpu_layer_t *layers = NULL;
    uint8_t *out_buf = NULL;
    size_t i, enc_len, guess;
    int rc = -1;

    if (webmap_mvt_decode(in_data, in_len, &mvt) != 0) {
        fprintf(stderr, "MVT decode failed for %u/%u/%u\n", id.z, id.x, id.y);
        return -1;
    }

    layers = calloc(mvt.layer_count ? mvt.layer_count : 1, sizeof(*layers));
    if (!layers && mvt.layer_count > 0) {
        webmap_mvt_tile_free(&mvt);
        return -1;
    }

    for (i = 0; i < mvt.layer_count; i++) {
        layers[i].vertices = mvt.layers[i].vertices;
        layers[i].vertex_count = mvt.layers[i].vertex_count;
        layers[i].indices = mvt.layers[i].indices;
        layers[i].index_count = mvt.layers[i].index_count;
        layers[i].kind = kind_from_mvt(mvt.layers[i].geom_type);
        layers[i].feature_class = webmap_mvt_layer_class(mvt.layers[i].name);
        snprintf(layers[i].name, sizeof(layers[i].name), "%s",
                 mvt.layers[i].name);
        layers[i].extent = mvt.layers[i].extent;
    }

    guess = 64 + in_len * 8 + 65536;
    for (;;) {
        out_buf = malloc(guess);
        if (!out_buf) {
            goto done;
        }
        enc_len =
            webmap_wmap_encode(id, layers, mvt.layer_count, out_buf, guess);
        if (enc_len != 0) {
            break;
        }
        free(out_buf);
        out_buf = NULL;
        if (guess > 64u * 1024u * 1024u) {
            fprintf(stderr, "encode too large for %u/%u/%u\n", id.z, id.x,
                    id.y);
            goto done;
        }
        guess *= 2;
    }

    if (write_file(out_path, out_buf, enc_len) != 0) {
        goto done;
    }
    if (!quiet) {
        printf("wrote %s (%zu bytes, %zu layers) tile %u/%u/%u\n", out_path,
               enc_len, mvt.layer_count, id.z, id.x, id.y);
    }
    rc = 0;

done:
    free(out_buf);
    free(layers);
    webmap_mvt_tile_free(&mvt);
    return rc;
}

static int convert_one(const char *in_path, const char *out_path,
                       webmap_tile_id_t id, int quiet)
{
    size_t in_len = 0;
    uint8_t *in_data = read_file(in_path, &in_len);
    int rc;
    if (!in_data) {
        return -1;
    }
    rc = convert_buf(in_data, in_len, id, out_path, quiet);
    free(in_data);
    return rc;
}

static int is_digits(const char *s)
{
    if (!s || !*s) {
        return 0;
    }
    for (; *s; s++) {
        if (*s < '0' || *s > '9') {
            return 0;
        }
    }
    return 1;
}

static int ends_with(const char *s, const char *suf)
{
    size_t n = strlen(s), m = strlen(suf);
    if (n < m) {
        return 0;
    }
    return strcmp(s + n - m, suf) == 0;
}

typedef struct {
    double west, south, east, north;
    int enabled;
} bbox_t;

static int tile_in_bbox(webmap_tile_id_t id, const bbox_t *bb)
{
    webmap_lonlat_t sw, ne;
    if (!bb || !bb->enabled) {
        return 1;
    }
    webmap_tile_bounds_lonlat(id, &sw, &ne);
    /* reject if completely outside */
    if (ne.lon < bb->west || sw.lon > bb->east || ne.lat < bb->south ||
        sw.lat > bb->north) {
        return 0;
    }
    return 1;
}

static int convert_dir(const char *in_root, const char *out_root, int zmin,
                       int zmax, const bbox_t *bb, int quiet)
{
    DIR *zd;
    struct dirent *ze;
    int ok = 0, fail = 0, skip = 0;
    char zpath[1024], xpath[1024], ypath[1024], outpath[1200], outdir[1100];

    zd = opendir(in_root);
    if (!zd) {
        fprintf(stderr, "opendir %s: %s\n", in_root, strerror(errno));
        return -1;
    }
    while ((ze = readdir(zd)) != NULL) {
        DIR *xd;
        struct dirent *xe;
        int z;
        if (ze->d_name[0] == '.') {
            continue;
        }
        if (!is_digits(ze->d_name)) {
            continue;
        }
        z = atoi(ze->d_name);
        if (z < zmin || z > zmax || z > 255) {
            continue;
        }
        snprintf(zpath, sizeof(zpath), "%s/%s", in_root, ze->d_name);
        xd = opendir(zpath);
        if (!xd) {
            continue;
        }
        while ((xe = readdir(xd)) != NULL) {
            DIR *yd;
            struct dirent *ye;
            int x;
            if (xe->d_name[0] == '.' || !is_digits(xe->d_name)) {
                continue;
            }
            x = atoi(xe->d_name);
            snprintf(xpath, sizeof(xpath), "%s/%s", zpath, xe->d_name);
            yd = opendir(xpath);
            if (!yd) {
                continue;
            }
            while ((ye = readdir(yd)) != NULL) {
                webmap_tile_id_t id;
                int y;
                char yname[64];
                if (ye->d_name[0] == '.') {
                    continue;
                }
                if (!ends_with(ye->d_name, ".pbf")) {
                    continue;
                }
                {
                    size_t n = strlen(ye->d_name);
                    if (n < 5 || n >= sizeof(yname)) {
                        continue;
                    }
                    memcpy(yname, ye->d_name, n - 4);
                    yname[n - 4] = '\0';
                }
                if (!is_digits(yname)) {
                    continue;
                }
                y = atoi(yname);
                id.z = (uint8_t)z;
                id.x = (uint32_t)x;
                id.y = (uint32_t)y;
                if (!tile_in_bbox(id, bb)) {
                    skip++;
                    continue;
                }
                snprintf(ypath, sizeof(ypath), "%s/%s", xpath, ye->d_name);
                snprintf(outdir, sizeof(outdir), "%s/%u/%u", out_root, id.z,
                         id.x);
                if (mkdirs_p(outdir) != 0) {
                    fprintf(stderr, "mkdir %s failed\n", outdir);
                    fail++;
                    continue;
                }
                snprintf(outpath, sizeof(outpath), "%s/%u.wmap", outdir, id.y);
                if (convert_one(ypath, outpath, id, quiet) == 0) {
                    ok++;
                } else {
                    fail++;
                }
            }
            closedir(yd);
        }
        closedir(xd);
    }
    closedir(zd);
    printf("batch: ok=%d fail=%d skip_bbox=%d → %s\n", ok, fail, skip,
           out_root);
    return fail ? 1 : 0;
}

static void usage(const char *argv0)
{
    fprintf(stderr,
            "Usage:\n"
            "  %s -z Z -x X -y Y <input.pbf> -o <out.wmap>\n"
            "  %s --dir <tiles_root> -o <out_dir> [--zmin N] [--zmax N]\n"
            "      [--bbox W,S,E,N] [--quiet]\n"
            "\n"
            "Convert GeoFabrik / Shortbread MVT (.pbf) to WebGPU-friendly .wmap.\n"
            "Directory mode reads {z}/{x}/{y}.pbf and writes {z}/{x}/{y}.wmap.\n",
            argv0, argv0);
}

int main(int argc, char **argv)
{
    const char *in_path = NULL;
    const char *out_path = NULL;
    const char *dir_root = NULL;
    int z = -1, x = -1, y = -1;
    int zmin = 0, zmax = 14;
    int quiet = 0;
    int i;
    bbox_t bb;
    webmap_tile_id_t id;

    memset(&bb, 0, sizeof(bb));

    for (i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-z") == 0 && i + 1 < argc) {
            z = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-x") == 0 && i + 1 < argc) {
            x = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-y") == 0 && i + 1 < argc) {
            y = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-o") == 0 && i + 1 < argc) {
            out_path = argv[++i];
        } else if (strcmp(argv[i], "--dir") == 0 && i + 1 < argc) {
            dir_root = argv[++i];
        } else if (strcmp(argv[i], "--zmin") == 0 && i + 1 < argc) {
            zmin = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--zmax") == 0 && i + 1 < argc) {
            zmax = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--bbox") == 0 && i + 1 < argc) {
            if (sscanf(argv[++i], "%lf,%lf,%lf,%lf", &bb.west, &bb.south,
                       &bb.east, &bb.north) == 4) {
                bb.enabled = 1;
            } else {
                fprintf(stderr, "bad --bbox (want W,S,E,N)\n");
                return 1;
            }
        } else if (strcmp(argv[i], "--quiet") == 0) {
            quiet = 1;
        } else if (strcmp(argv[i], "-h") == 0 ||
                   strcmp(argv[i], "--help") == 0) {
            usage(argv[0]);
            return 0;
        } else if (argv[i][0] != '-') {
            in_path = argv[i];
        } else {
            fprintf(stderr, "unknown arg: %s\n", argv[i]);
            usage(argv[0]);
            return 1;
        }
    }

    if (dir_root) {
        if (!out_path) {
            usage(argv[0]);
            return 1;
        }
        if (mkdirs_p(out_path) != 0) {
            fprintf(stderr, "cannot create %s\n", out_path);
            return 1;
        }
        return convert_dir(dir_root, out_path, zmin, zmax, &bb, quiet);
    }

    if (!in_path || !out_path || z < 0 || x < 0 || y < 0) {
        usage(argv[0]);
        return 1;
    }
    if (z > 255) {
        fprintf(stderr, "zoom out of range\n");
        return 1;
    }
    id.z = (uint8_t)z;
    id.x = (uint32_t)x;
    id.y = (uint32_t)y;
    return convert_one(in_path, out_path, id, quiet) == 0 ? 0 : 1;
}
