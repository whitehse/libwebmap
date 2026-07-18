/*
 * splice_diagram_cli.c — CLI for HTML splice diagram export
 *
 * Usage:
 *   ./splice_diagram -o diagrams/ fiber_design.sqlite
 *   ./splice_diagram -g <guid> -o out.html fiber_design.sqlite
 *   ./splice_diagram -s 78-05-14 -o out.html fiber_design.sqlite
 *   ./splice_diagram --all --limit 20 -o diagrams/ fiber_design.sqlite
 */

#include "splice_diagram.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <errno.h>

#ifdef _WIN32
#include <direct.h>
#define mkdir_one(p) _mkdir(p)
#else
#include <sys/types.h>
#define mkdir_one(p) mkdir((p), 0755)
#endif

static void usage(const char *argv0) {
    fprintf(stderr,
            "Usage: %s [options] FIBER_DESIGN.sqlite\n"
            "\n"
            "Generate self-contained HTML splice diagrams from export output.\n"
            "Dual views (Splicer / Trace), tube labels, multi-SP paths when\n"
            "fiber_paths tables exist, adjoining splicepoint links.\n"
            "\n"
            "Options:\n"
            "  -o, --output PATH   Output file (single) or directory (--all)\n"
            "  -g, --guid GUID     Render one splicepoint by GUID\n"
            "  -s, --station ID    Render one splicepoint by station_id\n"
            "  --all               Render all splicepoints with ports/equipment\n"
            "  --limit N           With --all, stop after N diagrams\n"
            "  --show-dark         Include unpatched (dark) cable fibers\n"
            "  --compact           Denser CSS\n"
            "  --view splicer|trace  Default page view (default: splicer)\n"
            "  --no-paths          Do not embed fiber_paths even if present\n"
            "  --max-paths N       Cap embedded paths per SP (default 40)\n"
            "  -h, --help          This help\n"
            "\n"
            "Library API: see splice_diagram.h\n"
            "  sd_open / sd_render / sd_diagram_filename / sd_free / sd_close\n",
            argv0);
}

static int ensure_dir(const char *path) {
    struct stat st;
    if (stat(path, &st) == 0) {
        if (S_ISDIR(st.st_mode)) return 0;
        fprintf(stderr, "Not a directory: %s\n", path);
        return -1;
    }
    if (mkdir_one(path) != 0 && errno != EEXIST) {
        fprintf(stderr, "mkdir %s: %s\n", path, strerror(errno));
        return -1;
    }
    return 0;
}

static int write_file(const char *path, const char *data, size_t len) {
    FILE *f = fopen(path, "wb");
    if (!f) {
        fprintf(stderr, "Cannot write %s: %s\n", path, strerror(errno));
        return -1;
    }
    if (fwrite(data, 1, len, f) != len) {
        fprintf(stderr, "Short write: %s\n", path);
        fclose(f);
        return -1;
    }
    fclose(f);
    return 0;
}

typedef struct {
    sd_db *db;
    sd_options opt;
    const char *outdir;
    int limit;
    int count;
    int errors;
    FILE *index;
} batch_ctx;

static int batch_cb(const char *guid, const char *station_id, int n_ports,
                    void *userdata) {
    batch_ctx *bx = (batch_ctx *)userdata;
    if (bx->limit > 0 && bx->count >= bx->limit) return 1;

    char *html = NULL;
    size_t n = 0;
    if (sd_render(bx->db, guid, &bx->opt, &html, &n) != 0) {
        fprintf(stderr, "  skip %s: %s\n", guid, sd_last_error());
        bx->errors++;
        return 0;
    }

    char fname[256];
    if (sd_diagram_filename(station_id, guid, fname, sizeof(fname)) != 0) {
        fprintf(stderr, "  skip %s: filename\n", guid);
        sd_free(html);
        bx->errors++;
        return 0;
    }
    char path[1024];
    snprintf(path, sizeof(path), "%s/%s", bx->outdir, fname);

    if (write_file(path, html, n) != 0) {
        sd_free(html);
        bx->errors++;
        return 0;
    }
    sd_free(html);
    bx->count++;

    if (bx->index) {
        fprintf(bx->index,
                "<li><a href=\"%s\">%s</a> "
                "<code>%.8s…</code> · %d ports</li>\n",
                fname,
                (station_id && station_id[0]) ? station_id : "(no station)",
                guid, n_ports);
    }

    if ((bx->count % 500) == 0) {
        fprintf(stderr, "  wrote %d diagrams...\n", bx->count);
    }
    return 0;
}

int main(int argc, char **argv) {
    const char *dbpath = NULL;
    const char *out = NULL;
    const char *guid = NULL;
    const char *station = NULL;
    int do_all = 0;
    int limit = 0;
    sd_options opt;
    sd_options_init(&opt);

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
            usage(argv[0]);
            return 0;
        } else if ((strcmp(argv[i], "-o") == 0 ||
                    strcmp(argv[i], "--output") == 0) &&
                   i + 1 < argc) {
            out = argv[++i];
        } else if ((strcmp(argv[i], "-g") == 0 ||
                    strcmp(argv[i], "--guid") == 0) &&
                   i + 1 < argc) {
            guid = argv[++i];
        } else if ((strcmp(argv[i], "-s") == 0 ||
                    strcmp(argv[i], "--station") == 0) &&
                   i + 1 < argc) {
            station = argv[++i];
        } else if (strcmp(argv[i], "--all") == 0) {
            do_all = 1;
        } else if (strcmp(argv[i], "--limit") == 0 && i + 1 < argc) {
            limit = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--show-dark") == 0) {
            opt.show_dark_fibers = 1;
        } else if (strcmp(argv[i], "--compact") == 0) {
            opt.compact = 1;
        } else if (strcmp(argv[i], "--no-paths") == 0) {
            opt.include_paths = 0;
        } else if (strcmp(argv[i], "--max-paths") == 0 && i + 1 < argc) {
            opt.max_paths = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--view") == 0 && i + 1 < argc) {
            i++;
            if (strcmp(argv[i], "trace") == 0)
                opt.default_view = SD_VIEW_TRACE;
            else if (strcmp(argv[i], "splicer") == 0)
                opt.default_view = SD_VIEW_SPLICER;
            else {
                fprintf(stderr, "Unknown view: %s (use splicer|trace)\n",
                        argv[i]);
                return 1;
            }
        } else if (argv[i][0] == '-') {
            fprintf(stderr, "Unknown option: %s\n", argv[i]);
            usage(argv[0]);
            return 1;
        } else {
            dbpath = argv[i];
        }
    }

    if (!dbpath) {
        usage(argv[0]);
        return 1;
    }
    if (!guid && !station && !do_all) {
        do_all = 1;
    }

    sd_db *db = sd_open(dbpath);
    if (!db) {
        fprintf(stderr, "sd_open: %s\n", sd_last_error());
        return 1;
    }

    if (guid || station) {
        char *html = NULL;
        size_t n = 0;
        int rc = guid ? sd_render(db, guid, &opt, &html, &n)
                      : sd_render_station(db, station, &opt, &html, &n);
        if (rc != 0) {
            fprintf(stderr, "render failed: %s\n", sd_last_error());
            sd_close(db);
            return 1;
        }
        if (out) {
            if (write_file(out, html, n) != 0) {
                sd_free(html);
                sd_close(db);
                return 1;
            }
            fprintf(stderr, "Wrote %s (%zu bytes)\n", out, n);
        } else {
            fwrite(html, 1, n, stdout);
        }
        sd_free(html);
        sd_close(db);
        return 0;
    }

    if (!out) out = "splice_diagrams";
    if (ensure_dir(out) != 0) {
        sd_close(db);
        return 1;
    }

    char index_path[1024];
    snprintf(index_path, sizeof(index_path), "%s/index.html", out);
    FILE *index = fopen(index_path, "wb");
    if (index) {
        fprintf(index,
                "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">"
                "<title>Splice diagrams</title>"
                "<style>body{font:14px system-ui;background:#0f1419;color:#e7ecf1;"
                "padding:16px}a{color:#6ab0ff}code{font-size:11px;color:#9aa7b5}"
                "li{margin:4px 0}</style></head><body>"
                "<h1>Splice diagrams</h1>"
                "<p>Source: <code>%s</code> · dual-view (Splicer / Trace)</p><ul>\n",
                dbpath);
    }

    batch_ctx bx = {
        .db = db,
        .opt = opt,
        .outdir = out,
        .limit = limit,
        .count = 0,
        .errors = 0,
        .index = index,
    };

    fprintf(stderr, "Exporting diagrams to %s ...\n", out);
    int n = sd_foreach_splicepoint(db, batch_cb, &bx);
    if (n < 0) {
        fprintf(stderr, "foreach failed: %s\n", sd_last_error());
        if (index) fclose(index);
        sd_close(db);
        return 1;
    }

    if (index) {
        fprintf(index, "</ul><p>%d diagram(s), %d error(s)</p></body></html>\n",
                bx.count, bx.errors);
        fclose(index);
    }

    fprintf(stderr, "Done: %d diagrams, %d errors → %s\n", bx.count, bx.errors,
            out);
    if (index) fprintf(stderr, "Index: %s\n", index_path);
    sd_close(db);
    return bx.errors ? 2 : 0;
}
