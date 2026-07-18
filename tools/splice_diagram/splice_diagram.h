/*
 * splice_diagram.h — generate self-contained HTML splice diagrams
 * from a fiber_design.sqlite database (export_fiber_design output).
 *
 * Designed for CLI use today and embedding later (web server / WASM):
 *   - Core API renders into a malloc'd buffer (no FILE* required)
 *   - No dependencies beyond SQLite (link sqlite3 amalgamation or libsqlite3)
 *   - Pure C99, no network, no threads required
 *
 * Diagram features:
 *   - Dual views: Splicer (concise paired matrix) and Trace (explanatory)
 *   - Side-by-side cables for through-splices; mid-span taps as center pills
 *   - Tube/strand labels from equipment_disp when present
 *   - Multi-SP optical paths when fiber_paths / fiber_path_hops exist
 *   - Adjoining splicepoints (other ends of cables) with relative links
 *   - Clickable fibers, view toggle, print stylesheet for field sheets
 *
 * Example:
 *   sd_db *db = sd_open("fiber_design.sqlite");
 *   char *html = NULL; size_t n = 0;
 *   if (sd_render(db, guid, NULL, &html, &n) == 0) {
 *       // use html[0..n)
 *       sd_free(html);
 *   }
 *   sd_close(db);
 */

#ifndef SPLICE_DIAGRAM_H
#define SPLICE_DIAGRAM_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct sd_db sd_db;

/* Default view when the page loads (user can still toggle). */
typedef enum sd_view {
    SD_VIEW_SPLICER = 0, /* concise field view (default) */
    SD_VIEW_TRACE = 1    /* explanatory office / path view */
} sd_view;

typedef struct sd_options {
    int show_dark_fibers;   /* 0 = hide unpatched cable fibers (default) */
    int compact;            /* denser CSS */
    int include_paths;      /* 1 = embed fiber_paths when table exists (default 1) */
    int max_paths;          /* max paths to embed per SP (0 = default 40) */
    int max_adjoining;      /* max adjoining SP cards (0 = default 24) */
    sd_view default_view;   /* initial view toggle state */
    const char *css_extra;  /* optional extra CSS rules (may be NULL) */
    const char *title_prefix; /* default "Splice" */
    const char *link_prefix;  /* optional prefix for relative diagram links */
} sd_options;

/* Open fiber_design.sqlite (read-only). Returns NULL on failure. */
sd_db *sd_open(const char *sqlite_path);

void sd_close(sd_db *db);

/* Default options (sensible defaults: paths on, splicer view). */
void sd_options_init(sd_options *opt);

/*
 * Render one splicepoint HTML document into *out_html (NUL-terminated).
 * Caller frees with sd_free(). *out_len is strlen(*out_html) if non-NULL.
 * Returns 0 on success, nonzero on error (see sd_last_error()).
 */
int sd_render(sd_db *db, const char *splicepoint_guid,
              const sd_options *opt, char **out_html, size_t *out_len);

/* First splicepoint whose station_id matches (case-sensitive). */
int sd_render_station(sd_db *db, const char *station_id,
                      const sd_options *opt, char **out_html, size_t *out_len);

/* Free a buffer returned by sd_render*. */
void sd_free(void *p);

/*
 * Build the same filename used by the CLI / adjoining links:
 *   sp_<station_or_guid>_<guid8>.html
 * out must be at least outsz bytes. Returns 0 on success.
 */
int sd_diagram_filename(const char *station_id, const char *guid,
                        char *out, size_t outsz);

/*
 * Visit every splicepoint that has equipment and/or ports.
 * Callback: return 0 to continue, nonzero to stop.
 * Returns count visited, or -1 on error.
 */
typedef int (*sd_foreach_fn)(const char *guid, const char *station_id,
                             int n_ports, void *userdata);
int sd_foreach_splicepoint(sd_db *db, sd_foreach_fn fn, void *userdata);

/* Thread-local-ish static last error message (not re-entrant). */
const char *sd_last_error(void);

#ifdef __cplusplus
}
#endif

#endif /* SPLICE_DIAGRAM_H */
