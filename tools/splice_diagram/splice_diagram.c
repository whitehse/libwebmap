/*
 * splice_diagram.c — HTML splice diagram renderer
 *
 * Self-contained dark-theme HTML per splicepoint with:
 *   - Splicer view: side-by-side paired fiber matrices + tap pills
 *   - Trace view: cable rails + equipment node
 *   - Tube/strand labels from equipment_disp
 *   - Multi-SP paths from fiber_paths (when present)
 *   - Adjoining splicepoints with relative links
 */

#include "splice_diagram.h"
#include "sqlite3.h"

#include <ctype.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define NIL_GUID "00000000-0000-0000-0000-000000000000"
#define MAX_CABLES 64
#define MAX_EQUIP 16
#define MAX_ADJ 32
#define MAX_THROUGH 512
#define MAX_GROUPS 16
#define MAX_PATHS 48
#define MAX_HOPS 80
#define MAX_SEC_PAIRS 8

/* ---------- growable string buffer ---------- */

typedef struct {
    char *data;
    size_t len;
    size_t cap;
} sb_t;

static int sb_reserve(sb_t *b, size_t need) {
    if (need <= b->cap) return 0;
    size_t ncap = b->cap ? b->cap : 4096;
    while (ncap < need) ncap *= 2;
    char *p = (char *)realloc(b->data, ncap);
    if (!p) return -1;
    b->data = p;
    b->cap = ncap;
    return 0;
}

static int sb_append(sb_t *b, const char *s) {
    if (!s) return 0;
    size_t n = strlen(s);
    if (sb_reserve(b, b->len + n + 1) != 0) return -1;
    memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
    return 0;
}

static int sb_appendf(sb_t *b, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    char stack[512];
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(stack, sizeof(stack), fmt, ap);
    va_end(ap);
    if (n < 0) {
        va_end(ap2);
        return -1;
    }
    if ((size_t)n < sizeof(stack)) {
        va_end(ap2);
        return sb_append(b, stack);
    }
    char *heap = (char *)malloc((size_t)n + 1);
    if (!heap) {
        va_end(ap2);
        return -1;
    }
    vsnprintf(heap, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    int r = sb_append(b, heap);
    free(heap);
    return r;
}

static void sb_free(sb_t *b) {
    free(b->data);
    b->data = NULL;
    b->len = b->cap = 0;
}

/* ---------- error ---------- */

static char g_err[512];

const char *sd_last_error(void) { return g_err; }

static void set_err(const char *msg) {
    snprintf(g_err, sizeof(g_err), "%s", msg ? msg : "error");
}

static void set_errf(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_err, sizeof(g_err), fmt, ap);
    va_end(ap);
}

/* ---------- HTML / JSON escape ---------- */

static int html_escape_append(sb_t *b, const char *s) {
    if (!s) return sb_append(b, "");
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
        case '&':
            if (sb_append(b, "&amp;") != 0) return -1;
            break;
        case '<':
            if (sb_append(b, "&lt;") != 0) return -1;
            break;
        case '>':
            if (sb_append(b, "&gt;") != 0) return -1;
            break;
        case '"':
            if (sb_append(b, "&quot;") != 0) return -1;
            break;
        case '\'':
            if (sb_append(b, "&#39;") != 0) return -1;
            break;
        default:
            if (*p < 0x20 && *p != '\t' && *p != '\n' && *p != '\r') {
                if (sb_appendf(b, "&#%u;", (unsigned)*p) != 0) return -1;
            } else {
                char c[2] = {(char)*p, 0};
                if (sb_append(b, c) != 0) return -1;
            }
            break;
        }
    }
    return 0;
}

static int json_escape_append(sb_t *b, const char *s) {
    if (!s) return sb_append(b, "");
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
        case '\\':
            if (sb_append(b, "\\\\") != 0) return -1;
            break;
        case '"':
            if (sb_append(b, "\\\"") != 0) return -1;
            break;
        case '\n':
            if (sb_append(b, "\\n") != 0) return -1;
            break;
        case '\r':
            if (sb_append(b, "\\r") != 0) return -1;
            break;
        case '\t':
            if (sb_append(b, "\\t") != 0) return -1;
            break;
        default:
            if (*p < 0x20) {
                if (sb_appendf(b, "\\u%04x", (unsigned)*p) != 0) return -1;
            } else {
                char c[2] = {(char)*p, 0};
                if (sb_append(b, c) != 0) return -1;
            }
            break;
        }
    }
    return 0;
}

/* ---------- TIA colors ---------- */

static const char *TIA_NAMES[] = {
    "Blue", "Orange", "Green", "Brown", "Slate", "White",
    "Red", "Black", "Yellow", "Violet", "Rose", "Aqua"
};

static const char *TIA_HEX[] = {
    "#1e5aa8", "#e67e22", "#27ae60", "#8b4513", "#708090", "#e8e8e8",
    "#c0392b", "#2c2c2c", "#f1c40f", "#8e44ad", "#e91e8c", "#5dade2"
};

static void tia_for_fiber(int fiber, const char **name, const char **hex) {
    int i = fiber > 0 ? (fiber - 1) % 12 : 0;
    *name = TIA_NAMES[i];
    *hex = TIA_HEX[i];
}

static void tia_for_tube(int fiber, const char **name, const char **hex, int *tube_idx) {
    int t = fiber > 0 ? (fiber - 1) / 12 : 0;
    *tube_idx = t;
    *name = TIA_NAMES[t % 12];
    *hex = TIA_HEX[t % 12];
}

static const char *color_name_hex(const char *name) {
    if (!name || !*name) return NULL;
    for (int i = 0; i < 12; i++) {
        if (strcasecmp(name, TIA_NAMES[i]) == 0) return TIA_HEX[i];
    }
    if (strcasecmp(name, "pink") == 0) return "#e91e8c";
    if (strcasecmp(name, "gray") == 0 || strcasecmp(name, "grey") == 0)
        return "#708090";
    return NULL;
}

/* ---------- data model ---------- */

typedef struct {
    char name[64];
    char name_type[24];
    char type[32];
    int number;
    int side;
    int seq;
    double split_db;
    char patch_guid[48];
    int patch_number;
    int patch_side;
    int has_patch;
} sd_port;

typedef struct {
    char guid[48];
    int is_tap;
    int is_passive;
    int is_feature;
    int seq;
    double tap_loss_db;
    int tap_ports;
    char disp_name[64];
    char disp_type[64];
    char tube[24];
    char strand[24];
    char out_tube[24];
    char out_strand[24];
    int feed_fiber; /* IN fiber number, or 0 */
    sd_port ports[256];
    int n_ports;
} sd_equip;

typedef struct {
    char guid[48];
    int fiber_count;
    int cable_size;
    char work_order[64];
    char cable_type[32];
    char used_as[32];
    sd_port fibers[288];
    int n_fibers;
} sd_cable;

typedef struct {
    char a_cable[48];
    int a_f;
    char b_cable[48];
    int b_f;
} sd_through;

typedef struct {
    int left_ci;  /* cable index, -1 if none */
    int right_ci;
    int members[MAX_CABLES];
    int n_members;
    int n_through;
    int sec_left[MAX_SEC_PAIRS];
    int sec_right[MAX_SEC_PAIRS];
    int sec_n[MAX_SEC_PAIRS];
    int n_sec;
} sd_group;

typedef struct {
    char guid[48];
    char station_id[64];
    char work_order[64];
    char type[32];
    char via_cable[48];
    int via_size;
    int n_cables;
    int taps;
    char href[256];
} sd_adj;

typedef struct {
    char kind[16]; /* cable | equipment */
    char cable[48];
    int fiber;
    char equip[48];
    char port[48];
    char role[24];
    char sp[48];
    char station[64];
    double loss;
    char tube[24];
    char strand[24];
    char equip_name[64];
} sd_hop;

typedef struct {
    int path_id;
    int hop_count;
    int equip_count;
    double total_loss_db;
    int has_drop;
    char end_kind[24];
    char start_cable[48];
    int start_fiber;
    char end_cable[48];
    int end_fiber;
    char work_orders[128];
    sd_hop hops[MAX_HOPS];
    int n_hops;
} sd_path;

typedef struct {
    char guid[48];
    char station_id[64];
    char work_order[64];
    char type[32];
    char comments[256];
    int subtype;
    int status;
    int enabled;
    sd_equip equip[MAX_EQUIP];
    int n_equip;
    sd_cable cables[MAX_CABLES];
    int n_cables;
    sd_through through[MAX_THROUGH];
    int n_through;
    sd_group groups[MAX_GROUPS];
    int n_groups;
    sd_adj adj[MAX_ADJ];
    int n_adj;
    sd_path paths[MAX_PATHS];
    int n_paths;
    int has_paths_table;
} sd_splice;

struct sd_db {
    sqlite3 *db;
    int has_fiber_paths;
};

void sd_options_init(sd_options *opt) {
    if (!opt) return;
    memset(opt, 0, sizeof(*opt));
    opt->include_paths = 1;
    opt->default_view = SD_VIEW_SPLICER;
}

static int table_exists(sqlite3 *db, const char *name) {
    sqlite3_stmt *st = NULL;
    const char *sql =
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1";
    if (sqlite3_prepare_v2(db, sql, -1, &st, NULL) != SQLITE_OK) return 0;
    sqlite3_bind_text(st, 1, name, -1, SQLITE_STATIC);
    int ok = (sqlite3_step(st) == SQLITE_ROW);
    sqlite3_finalize(st);
    return ok;
}

sd_db *sd_open(const char *sqlite_path) {
    g_err[0] = '\0';
    if (!sqlite_path) {
        set_err("NULL path");
        return NULL;
    }
    sd_db *d = (sd_db *)calloc(1, sizeof(sd_db));
    if (!d) {
        set_err("oom");
        return NULL;
    }
    int rc = sqlite3_open_v2(sqlite_path, &d->db, SQLITE_OPEN_READONLY, NULL);
    if (rc != SQLITE_OK) {
        set_errf("sqlite open: %s", d->db ? sqlite3_errmsg(d->db) : "fail");
        if (d->db) sqlite3_close(d->db);
        free(d);
        return NULL;
    }
    if (!table_exists(d->db, "splicepoints")) {
        set_err("missing splicepoints table");
        sd_close(d);
        return NULL;
    }
    d->has_fiber_paths =
        table_exists(d->db, "fiber_paths") && table_exists(d->db, "fiber_path_hops");
    return d;
}

void sd_close(sd_db *db) {
    if (!db) return;
    if (db->db) sqlite3_close(db->db);
    free(db);
}

void sd_free(void *p) { free(p); }

int sd_diagram_filename(const char *station, const char *guid, char *out,
                        size_t outsz) {
    if (!out || outsz < 16) return -1;
    const char *src = (station && station[0]) ? station : (guid ? guid : "sp");
    size_t j = 0;
    if (j + 4 >= outsz) return -1;
    out[j++] = 's';
    out[j++] = 'p';
    out[j++] = '_';
    for (size_t i = 0; src[i] && j + 14 < outsz; i++) {
        unsigned char c = (unsigned char)src[i];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_') {
            out[j++] = (char)c;
        } else {
            out[j++] = '_';
        }
    }
    if (guid && j + 12 < outsz) {
        out[j++] = '_';
        for (int i = 0; i < 8 && guid[i]; i++) out[j++] = guid[i];
    }
    snprintf(out + j, outsz - j, ".html");
    return 0;
}

static int guid_is_nil(const char *g) {
    if (!g || !*g) return 1;
    return strcmp(g, NIL_GUID) == 0;
}

static void copy_text(char *dst, size_t dstsz, const unsigned char *src) {
    if (!src) {
        dst[0] = '\0';
        return;
    }
    snprintf(dst, dstsz, "%s", (const char *)src);
}

static int find_cable_idx(const sd_splice *sp, const char *guid) {
    if (!guid) return -1;
    for (int i = 0; i < sp->n_cables; i++) {
        if (strcmp(sp->cables[i].guid, guid) == 0) return i;
    }
    return -1;
}

static int find_equip_idx(const sd_splice *sp, const char *guid) {
    if (!guid) return -1;
    for (int i = 0; i < sp->n_equip; i++) {
        if (strcmp(sp->equip[i].guid, guid) == 0) return i;
    }
    return -1;
}

static int short_guid(const char *g, char *out, size_t outsz) {
    if (!g || !*g) {
        snprintf(out, outsz, "—");
        return 0;
    }
    snprintf(out, outsz, "%.8s", g);
    return 0;
}

/* ---------- load ---------- */

static int load_splice_core(sd_db *db, const char *guid, sd_splice *sp) {
    memset(sp, 0, sizeof(*sp));
    snprintf(sp->guid, sizeof(sp->guid), "%s", guid);

    sqlite3_stmt *st = NULL;
    const char *sql =
        "SELECT station_id, work_order, type, comments, subtype, status, enabled "
        "FROM splicepoints WHERE guid=?1";
    if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK) {
        set_errf("prepare SP: %s", sqlite3_errmsg(db->db));
        return -1;
    }
    sqlite3_bind_text(st, 1, guid, -1, SQLITE_STATIC);
    if (sqlite3_step(st) != SQLITE_ROW) {
        sqlite3_finalize(st);
        set_errf("splicepoint not found: %s", guid);
        return -1;
    }
    copy_text(sp->station_id, sizeof(sp->station_id), sqlite3_column_text(st, 0));
    copy_text(sp->work_order, sizeof(sp->work_order), sqlite3_column_text(st, 1));
    copy_text(sp->type, sizeof(sp->type), sqlite3_column_text(st, 2));
    copy_text(sp->comments, sizeof(sp->comments), sqlite3_column_text(st, 3));
    sp->subtype = sqlite3_column_int(st, 4);
    sp->status = sqlite3_column_int(st, 5);
    sp->enabled = sqlite3_column_int(st, 6);
    sqlite3_finalize(st);

    sql = "SELECT e.guid, e.is_tap, e.is_passive, e.is_feature, e.seq, "
          "e.tap_loss_db, e.tap_ports, "
          "d.name, d.type, d.fiber_tube_color, d.fiber_strand_color, "
          "d.out_tube_color, d.out_strand_color "
          "FROM equipment e "
          "LEFT JOIN equipment_disp d ON d.guid = e.guid "
          "WHERE e.splicepoint_guid=?1 ORDER BY e.seq, e.guid";
    if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK) {
        set_errf("prepare equip: %s", sqlite3_errmsg(db->db));
        return -1;
    }
    sqlite3_bind_text(st, 1, guid, -1, SQLITE_STATIC);
    while (sqlite3_step(st) == SQLITE_ROW && sp->n_equip < MAX_EQUIP) {
        sd_equip *eq = &sp->equip[sp->n_equip++];
        copy_text(eq->guid, sizeof(eq->guid), sqlite3_column_text(st, 0));
        eq->is_tap = sqlite3_column_int(st, 1);
        eq->is_passive = sqlite3_column_int(st, 2);
        eq->is_feature = sqlite3_column_int(st, 3);
        eq->seq = sqlite3_column_int(st, 4);
        eq->tap_loss_db = sqlite3_column_double(st, 5);
        eq->tap_ports = sqlite3_column_int(st, 6);
        copy_text(eq->disp_name, sizeof(eq->disp_name), sqlite3_column_text(st, 7));
        copy_text(eq->disp_type, sizeof(eq->disp_type), sqlite3_column_text(st, 8));
        copy_text(eq->tube, sizeof(eq->tube), sqlite3_column_text(st, 9));
        copy_text(eq->strand, sizeof(eq->strand), sqlite3_column_text(st, 10));
        copy_text(eq->out_tube, sizeof(eq->out_tube), sqlite3_column_text(st, 11));
        copy_text(eq->out_strand, sizeof(eq->out_strand), sqlite3_column_text(st, 12));
    }
    sqlite3_finalize(st);

    for (int i = 0; i < sp->n_equip; i++) {
        sd_equip *eq = &sp->equip[i];
        sql = "SELECT number, name, port_name_type, side, type, seq, split_db, "
              "patch_guid, patch_number, patch_side "
              "FROM ports WHERE parent_type='equipment' AND parent_guid=?1 "
              "ORDER BY side, seq, number";
        if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK) {
            set_errf("prepare eports: %s", sqlite3_errmsg(db->db));
            return -1;
        }
        sqlite3_bind_text(st, 1, eq->guid, -1, SQLITE_STATIC);
        while (sqlite3_step(st) == SQLITE_ROW &&
               eq->n_ports < (int)(sizeof(eq->ports) / sizeof(eq->ports[0]))) {
            sd_port *p = &eq->ports[eq->n_ports++];
            p->number = sqlite3_column_int(st, 0);
            copy_text(p->name, sizeof(p->name), sqlite3_column_text(st, 1));
            copy_text(p->name_type, sizeof(p->name_type), sqlite3_column_text(st, 2));
            p->side = sqlite3_column_int(st, 3);
            copy_text(p->type, sizeof(p->type), sqlite3_column_text(st, 4));
            p->seq = sqlite3_column_int(st, 5);
            p->split_db = sqlite3_column_double(st, 6);
            copy_text(p->patch_guid, sizeof(p->patch_guid), sqlite3_column_text(st, 7));
            p->patch_number = sqlite3_column_int(st, 8);
            p->patch_side = sqlite3_column_int(st, 9);
            p->has_patch = !guid_is_nil(p->patch_guid);
            if (p->has_patch &&
                (strcmp(p->name_type, "input") == 0 ||
                 (p->name[0] && strncasecmp(p->name, "input", 5) == 0))) {
                if (!eq->feed_fiber) eq->feed_fiber = p->patch_number;
            }
        }
        sqlite3_finalize(st);
    }

    sql = "SELECT cas.cable_guid, cas.fiber_count, c.cable_size, c.work_order, "
          "c.cable_type, c.used_as "
          "FROM cable_at_splice cas "
          "LEFT JOIN cables c ON c.guid = cas.cable_guid "
          "WHERE cas.splicepoint_guid=?1 ORDER BY cas.fiber_count DESC, cas.cable_guid";
    if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK) {
        set_errf("prepare cables: %s", sqlite3_errmsg(db->db));
        return -1;
    }
    sqlite3_bind_text(st, 1, guid, -1, SQLITE_STATIC);
    while (sqlite3_step(st) == SQLITE_ROW && sp->n_cables < MAX_CABLES) {
        sd_cable *cb = &sp->cables[sp->n_cables++];
        copy_text(cb->guid, sizeof(cb->guid), sqlite3_column_text(st, 0));
        cb->fiber_count = sqlite3_column_int(st, 1);
        cb->cable_size = sqlite3_column_int(st, 2);
        if (cb->cable_size <= 0) cb->cable_size = cb->fiber_count;
        copy_text(cb->work_order, sizeof(cb->work_order), sqlite3_column_text(st, 3));
        copy_text(cb->cable_type, sizeof(cb->cable_type), sqlite3_column_text(st, 4));
        copy_text(cb->used_as, sizeof(cb->used_as), sqlite3_column_text(st, 5));
    }
    sqlite3_finalize(st);

    for (int i = 0; i < sp->n_cables; i++) {
        sd_cable *cb = &sp->cables[i];
        sql = "SELECT number, name, port_name_type, side, type, seq, split_db, "
              "patch_guid, patch_number, patch_side "
              "FROM ports WHERE parent_type='cable' AND parent_guid=?1 "
              "AND splicepoint_guid=?2 ORDER BY number";
        if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK) {
            set_errf("prepare cports: %s", sqlite3_errmsg(db->db));
            return -1;
        }
        sqlite3_bind_text(st, 1, cb->guid, -1, SQLITE_STATIC);
        sqlite3_bind_text(st, 2, guid, -1, SQLITE_STATIC);
        while (sqlite3_step(st) == SQLITE_ROW &&
               cb->n_fibers < (int)(sizeof(cb->fibers) / sizeof(cb->fibers[0]))) {
            sd_port *p = &cb->fibers[cb->n_fibers++];
            p->number = sqlite3_column_int(st, 0);
            copy_text(p->name, sizeof(p->name), sqlite3_column_text(st, 1));
            copy_text(p->name_type, sizeof(p->name_type), sqlite3_column_text(st, 2));
            p->side = sqlite3_column_int(st, 3);
            copy_text(p->type, sizeof(p->type), sqlite3_column_text(st, 4));
            p->seq = sqlite3_column_int(st, 5);
            p->split_db = sqlite3_column_double(st, 6);
            copy_text(p->patch_guid, sizeof(p->patch_guid), sqlite3_column_text(st, 7));
            p->patch_number = sqlite3_column_int(st, 8);
            p->patch_side = sqlite3_column_int(st, 9);
            p->has_patch = !guid_is_nil(p->patch_guid);
        }
        sqlite3_finalize(st);
    }

    return 0;
}

static int load_adjoining(sd_db *db, sd_splice *sp, int max_adj,
                          const char *link_prefix) {
    sp->n_adj = 0;
    if (max_adj <= 0) max_adj = 24;
    if (max_adj > MAX_ADJ) max_adj = MAX_ADJ;

    for (int ci = 0; ci < sp->n_cables && sp->n_adj < max_adj; ci++) {
        const sd_cable *cb = &sp->cables[ci];
        sqlite3_stmt *st = NULL;
        const char *sql =
            "SELECT s.guid, s.station_id, s.work_order, s.type, "
            "(SELECT COUNT(*) FROM equipment e WHERE e.splicepoint_guid=s.guid "
            " AND e.is_tap=1), "
            "(SELECT COUNT(DISTINCT cable_guid) FROM cable_at_splice "
            " WHERE splicepoint_guid=s.guid) "
            "FROM cable_at_splice cas "
            "JOIN splicepoints s ON s.guid=cas.splicepoint_guid "
            "WHERE cas.cable_guid=?1 AND cas.splicepoint_guid!=?2";
        if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK)
            continue;
        sqlite3_bind_text(st, 1, cb->guid, -1, SQLITE_STATIC);
        sqlite3_bind_text(st, 2, sp->guid, -1, SQLITE_STATIC);
        while (sqlite3_step(st) == SQLITE_ROW && sp->n_adj < max_adj) {
            const char *ag = (const char *)sqlite3_column_text(st, 0);
            if (!ag) continue;
            int dup = 0;
            for (int j = 0; j < sp->n_adj; j++) {
                if (strcmp(sp->adj[j].guid, ag) == 0) {
                    dup = 1;
                    break;
                }
            }
            if (dup) continue;
            sd_adj *a = &sp->adj[sp->n_adj++];
            copy_text(a->guid, sizeof(a->guid), sqlite3_column_text(st, 0));
            copy_text(a->station_id, sizeof(a->station_id),
                      sqlite3_column_text(st, 1));
            copy_text(a->work_order, sizeof(a->work_order),
                      sqlite3_column_text(st, 2));
            copy_text(a->type, sizeof(a->type), sqlite3_column_text(st, 3));
            a->taps = sqlite3_column_int(st, 4);
            a->n_cables = sqlite3_column_int(st, 5);
            snprintf(a->via_cable, sizeof(a->via_cable), "%s", cb->guid);
            a->via_size = cb->cable_size > 0 ? cb->cable_size : cb->fiber_count;
            char fname[200];
            sd_diagram_filename(a->station_id, a->guid, fname, sizeof(fname));
            if (link_prefix && link_prefix[0])
                snprintf(a->href, sizeof(a->href), "%s%s", link_prefix, fname);
            else
                snprintf(a->href, sizeof(a->href), "%s", fname);
        }
        sqlite3_finalize(st);
    }
    return 0;
}

static int load_paths(sd_db *db, sd_splice *sp, int max_paths) {
    sp->n_paths = 0;
    sp->has_paths_table = db->has_fiber_paths;
    if (!db->has_fiber_paths || max_paths <= 0) return 0;
    if (max_paths > MAX_PATHS) max_paths = MAX_PATHS;

    sqlite3_stmt *st = NULL;
    const char *sql =
        "SELECT DISTINCT path_id FROM fiber_path_hops "
        "WHERE splicepoint_guid=?1 LIMIT ?2";
    if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK) return 0;
    sqlite3_bind_text(st, 1, sp->guid, -1, SQLITE_STATIC);
    sqlite3_bind_int(st, 2, max_paths);
    int pids[MAX_PATHS];
    int n_pids = 0;
    while (sqlite3_step(st) == SQLITE_ROW && n_pids < max_paths) {
        pids[n_pids++] = sqlite3_column_int(st, 0);
    }
    sqlite3_finalize(st);

    /* If none touch this SP, try starts on local cables */
    if (n_pids == 0 && sp->n_cables > 0) {
        for (int ci = 0; ci < sp->n_cables && n_pids < max_paths; ci++) {
            sql = "SELECT path_id FROM fiber_paths WHERE start_cable_guid=?1 "
                  "ORDER BY hop_count DESC LIMIT 4";
            if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK)
                continue;
            sqlite3_bind_text(st, 1, sp->cables[ci].guid, -1, SQLITE_STATIC);
            while (sqlite3_step(st) == SQLITE_ROW && n_pids < max_paths) {
                int pid = sqlite3_column_int(st, 0);
                int dup = 0;
                for (int k = 0; k < n_pids; k++)
                    if (pids[k] == pid) {
                        dup = 1;
                        break;
                    }
                if (!dup) pids[n_pids++] = pid;
            }
            sqlite3_finalize(st);
        }
    }

    for (int i = 0; i < n_pids && sp->n_paths < max_paths; i++) {
        sd_path *path = &sp->paths[sp->n_paths];
        memset(path, 0, sizeof(*path));
        sql = "SELECT path_id, start_cable_guid, start_fiber, end_cable_guid, "
              "end_fiber, end_kind, hop_count, equip_count, total_loss_db, "
              "has_drop, work_orders FROM fiber_paths WHERE path_id=?1";
        if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK)
            continue;
        sqlite3_bind_int(st, 1, pids[i]);
        if (sqlite3_step(st) != SQLITE_ROW) {
            sqlite3_finalize(st);
            continue;
        }
        path->path_id = sqlite3_column_int(st, 0);
        copy_text(path->start_cable, sizeof(path->start_cable),
                  sqlite3_column_text(st, 1));
        path->start_fiber = sqlite3_column_int(st, 2);
        copy_text(path->end_cable, sizeof(path->end_cable),
                  sqlite3_column_text(st, 3));
        path->end_fiber = sqlite3_column_int(st, 4);
        copy_text(path->end_kind, sizeof(path->end_kind),
                  sqlite3_column_text(st, 5));
        path->hop_count = sqlite3_column_int(st, 6);
        path->equip_count = sqlite3_column_int(st, 7);
        path->total_loss_db = sqlite3_column_double(st, 8);
        path->has_drop = sqlite3_column_int(st, 9);
        copy_text(path->work_orders, sizeof(path->work_orders),
                  sqlite3_column_text(st, 10));
        sqlite3_finalize(st);

        sql = "SELECT seq, hop_kind, cable_guid, fiber_number, equipment_guid, "
              "port_name, port_name_type, splicepoint_guid, station_id, split_db "
              "FROM fiber_path_hops WHERE path_id=?1 ORDER BY seq";
        if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK) {
            sp->n_paths++;
            continue;
        }
        sqlite3_bind_int(st, 1, pids[i]);
        while (sqlite3_step(st) == SQLITE_ROW && path->n_hops < MAX_HOPS) {
            sd_hop *h = &path->hops[path->n_hops++];
            copy_text(h->kind, sizeof(h->kind), sqlite3_column_text(st, 1));
            copy_text(h->cable, sizeof(h->cable), sqlite3_column_text(st, 2));
            h->fiber = sqlite3_column_int(st, 3);
            copy_text(h->equip, sizeof(h->equip), sqlite3_column_text(st, 4));
            copy_text(h->port, sizeof(h->port), sqlite3_column_text(st, 5));
            copy_text(h->role, sizeof(h->role), sqlite3_column_text(st, 6));
            copy_text(h->sp, sizeof(h->sp), sqlite3_column_text(st, 7));
            copy_text(h->station, sizeof(h->station), sqlite3_column_text(st, 8));
            h->loss = sqlite3_column_double(st, 9);
            if (h->equip[0]) {
                sqlite3_stmt *st2 = NULL;
                if (sqlite3_prepare_v2(
                        db->db,
                        "SELECT fiber_tube_color, fiber_strand_color, name, type "
                        "FROM equipment_disp WHERE guid=?1",
                        -1, &st2, NULL) == SQLITE_OK) {
                    sqlite3_bind_text(st2, 1, h->equip, -1, SQLITE_STATIC);
                    if (sqlite3_step(st2) == SQLITE_ROW) {
                        copy_text(h->tube, sizeof(h->tube),
                                  sqlite3_column_text(st2, 0));
                        copy_text(h->strand, sizeof(h->strand),
                                  sqlite3_column_text(st2, 1));
                        const unsigned char *nm = sqlite3_column_text(st2, 2);
                        const unsigned char *tp = sqlite3_column_text(st2, 3);
                        if (nm && nm[0])
                            copy_text(h->equip_name, sizeof(h->equip_name), nm);
                        else
                            copy_text(h->equip_name, sizeof(h->equip_name), tp);
                    }
                    sqlite3_finalize(st2);
                }
            }
        }
        sqlite3_finalize(st);
        sp->n_paths++;
    }
    return 0;
}

/* ---------- topology: through pairs + groups ---------- */

static int uf_find(int *parent, int x) {
    while (parent[x] != x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
    }
    return x;
}

static void uf_union(int *parent, int a, int b) {
    int ra = uf_find(parent, a), rb = uf_find(parent, b);
    if (ra != rb) parent[rb] = ra;
}

static void build_topology(sd_splice *sp) {
    sp->n_through = 0;
    /* undirected cable↔cable patches */
    for (int ci = 0; ci < sp->n_cables; ci++) {
        const sd_cable *cb = &sp->cables[ci];
        for (int fi = 0; fi < cb->n_fibers; fi++) {
            const sd_port *p = &cb->fibers[fi];
            if (!p->has_patch) continue;
            if (find_equip_idx(sp, p->patch_guid) >= 0) continue;
            int cj = find_cable_idx(sp, p->patch_guid);
            if (cj < 0) continue;
            /* dedupe undirected */
            int seen = 0;
            for (int t = 0; t < sp->n_through; t++) {
                sd_through *th = &sp->through[t];
                if ((strcmp(th->a_cable, cb->guid) == 0 && th->a_f == p->number &&
                     strcmp(th->b_cable, p->patch_guid) == 0 &&
                     th->b_f == p->patch_number) ||
                    (strcmp(th->b_cable, cb->guid) == 0 && th->b_f == p->number &&
                     strcmp(th->a_cable, p->patch_guid) == 0 &&
                     th->a_f == p->patch_number)) {
                    seen = 1;
                    break;
                }
            }
            if (seen) continue;
            if (sp->n_through >= MAX_THROUGH) break;
            sd_through *th = &sp->through[sp->n_through++];
            /* store ordered by cable guid for stability */
            if (strcmp(cb->guid, p->patch_guid) <= 0) {
                snprintf(th->a_cable, sizeof(th->a_cable), "%s", cb->guid);
                th->a_f = p->number;
                snprintf(th->b_cable, sizeof(th->b_cable), "%s", p->patch_guid);
                th->b_f = p->patch_number;
            } else {
                snprintf(th->a_cable, sizeof(th->a_cable), "%s", p->patch_guid);
                th->a_f = p->patch_number;
                snprintf(th->b_cable, sizeof(th->b_cable), "%s", cb->guid);
                th->b_f = p->number;
            }
        }
    }

    int parent[MAX_CABLES];
    for (int i = 0; i < sp->n_cables; i++) parent[i] = i;
    for (int t = 0; t < sp->n_through; t++) {
        int a = find_cable_idx(sp, sp->through[t].a_cable);
        int b = find_cable_idx(sp, sp->through[t].b_cable);
        if (a >= 0 && b >= 0) uf_union(parent, a, b);
    }
    for (int ei = 0; ei < sp->n_equip; ei++) {
        const sd_equip *eq = &sp->equip[ei];
        int first = -1;
        for (int pi = 0; pi < eq->n_ports; pi++) {
            if (!eq->ports[pi].has_patch) continue;
            int cj = find_cable_idx(sp, eq->ports[pi].patch_guid);
            if (cj < 0) continue;
            if (first < 0)
                first = cj;
            else
                uf_union(parent, first, cj);
        }
    }

    sp->n_groups = 0;
    int assigned[MAX_CABLES];
    memset(assigned, 0, sizeof(assigned));
    for (int i = 0; i < sp->n_cables && sp->n_groups < MAX_GROUPS; i++) {
        if (assigned[i]) continue;
        int root = uf_find(parent, i);
        sd_group *g = &sp->groups[sp->n_groups++];
        memset(g, 0, sizeof(*g));
        g->left_ci = g->right_ci = -1;
        for (int j = 0; j < sp->n_cables; j++) {
            if (uf_find(parent, j) != root) continue;
            assigned[j] = 1;
            if (g->n_members < MAX_CABLES) g->members[g->n_members++] = j;
        }
        /* sort members by cable size desc */
        for (int a = 0; a < g->n_members; a++) {
            for (int b = a + 1; b < g->n_members; b++) {
                int sa = sp->cables[g->members[a]].cable_size;
                int sb = sp->cables[g->members[b]].cable_size;
                if (sb > sa) {
                    int tmp = g->members[a];
                    g->members[a] = g->members[b];
                    g->members[b] = tmp;
                }
            }
        }
        /* busiest through pair within group */
        int best_n = 0, best_a = -1, best_b = -1;
        for (int t = 0; t < sp->n_through; t++) {
            int a = find_cable_idx(sp, sp->through[t].a_cable);
            int b = find_cable_idx(sp, sp->through[t].b_cable);
            if (a < 0 || b < 0) continue;
            int ina = 0, inb = 0;
            for (int m = 0; m < g->n_members; m++) {
                if (g->members[m] == a) ina = 1;
                if (g->members[m] == b) inb = 1;
            }
            if (!ina || !inb) continue;
            g->n_through++;
            /* count pair volume */
            int n = 0;
            for (int u = 0; u < sp->n_through; u++) {
                int ua = find_cable_idx(sp, sp->through[u].a_cable);
                int ub = find_cable_idx(sp, sp->through[u].b_cable);
                if ((ua == a && ub == b) || (ua == b && ub == a)) n++;
            }
            if (n > best_n) {
                best_n = n;
                best_a = a;
                best_b = b;
            }
        }
        if (best_a >= 0) {
            g->left_ci = best_a;
            g->right_ci = best_b;
        } else if (g->n_members >= 2) {
            g->left_ci = g->members[0];
            g->right_ci = g->members[1];
        } else if (g->n_members == 1) {
            g->left_ci = g->members[0];
        }

        /* secondary pairs among remaining */
        int used[MAX_CABLES];
        memset(used, 0, sizeof(used));
        if (g->left_ci >= 0) used[g->left_ci] = 1;
        if (g->right_ci >= 0) used[g->right_ci] = 1;
        while (g->n_sec < MAX_SEC_PAIRS) {
            int ba = -1, bb = -1, bn = 0;
            for (int m = 0; m < g->n_members; m++) {
                int a = g->members[m];
                if (used[a]) continue;
                for (int n = m + 1; n < g->n_members; n++) {
                    int b = g->members[n];
                    if (used[b]) continue;
                    int cnt = 0;
                    for (int t = 0; t < sp->n_through; t++) {
                        int ta = find_cable_idx(sp, sp->through[t].a_cable);
                        int tb = find_cable_idx(sp, sp->through[t].b_cable);
                        if ((ta == a && tb == b) || (ta == b && tb == a)) cnt++;
                    }
                    if (cnt > bn) {
                        bn = cnt;
                        ba = a;
                        bb = b;
                    }
                }
            }
            if (ba < 0 || bn == 0) break;
            g->sec_left[g->n_sec] = ba;
            g->sec_right[g->n_sec] = bb;
            g->sec_n[g->n_sec] = bn;
            g->n_sec++;
            used[ba] = used[bb] = 1;
        }
    }
    /* sort groups by n_through desc */
    for (int a = 0; a < sp->n_groups; a++) {
        for (int b = a + 1; b < sp->n_groups; b++) {
            if (sp->groups[b].n_through > sp->groups[a].n_through) {
                sd_group tmp = sp->groups[a];
                sp->groups[a] = sp->groups[b];
                sp->groups[b] = tmp;
            }
        }
    }
}

static int load_all(sd_db *db, const char *guid, const sd_options *opt,
                    sd_splice *sp) {
    if (load_splice_core(db, guid, sp) != 0) return -1;
    build_topology(sp);
    int max_adj = opt && opt->max_adjoining > 0 ? opt->max_adjoining : 24;
    load_adjoining(db, sp, max_adj, opt ? opt->link_prefix : NULL);
    if (!opt || opt->include_paths) {
        int max_p = opt && opt->max_paths > 0 ? opt->max_paths : 40;
        load_paths(db, sp, max_p);
    }
    return 0;
}

/* ---------- CSS / JS ---------- */

static const char *BASE_CSS =
    ":root{--bg:#0c1016;--card:#141a24;--card2:#1a2230;--border:#2a3544;"
    "--text:#e7ecf1;--muted:#9aa7b5;--accent:#6ab0ff;--tap:#e67e22;"
    "--drop:#c0392b;--fuse:#5dade2;--hi:rgba(106,176,255,.18)}\n"
    "*{box-sizing:border-box}\n"
    "body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;"
    "background:var(--bg);color:var(--text)}\n"
    "header.top{position:sticky;top:0;z-index:30;background:rgba(12,16,22,.94);"
    "backdrop-filter:blur(8px);border-bottom:1px solid var(--border);padding:10px 16px}\n"
    "header.top h1{margin:0;font-size:1.15rem}\n"
    ".controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:8px}\n"
    ".seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}\n"
    ".seg button,.btn{background:var(--card);color:var(--text);border:1px solid var(--border);"
    "border-radius:8px;padding:5px 12px;font:inherit;cursor:pointer}\n"
    ".seg button{border:0;border-radius:0}\n"
    ".seg button.active{background:#1a3358;color:#9ecbff;font-weight:600}\n"
    ".btn:hover,.seg button:hover{border-color:var(--accent)}\n"
    "main{padding:16px;max-width:1400px;margin:0 auto}\n"
    ".meta{color:var(--muted);font-size:12px;margin-bottom:10px}\n"
    ".meta code{background:#1c2430;padding:1px 6px;border-radius:4px;font-size:11px}\n"
    ".badge{display:inline-flex;align-items:center;gap:4px;background:#1c2430;"
    "border:1px solid var(--border);border-radius:999px;padding:2px 10px;"
    "font-size:12px;margin:2px 4px 2px 0}\n"
    ".badge.tap{border-color:var(--tap);color:#f0c090}\n"
    ".badge.drop{border-color:var(--drop);color:#f5a8a0}\n"
    ".chip{display:inline-block;width:11px;height:11px;border-radius:50%;"
    "border:1px solid rgba(255,255,255,.35);vertical-align:middle;margin-right:3px}\n"
    ".chip.light{border-color:#666}\n"
    ".tube-dot{display:inline-block;width:10px;height:10px;border-radius:2px;"
    "border:1px solid rgba(255,255,255,.3);vertical-align:middle;margin-right:4px}\n"
    ".lbl-pill{display:inline-flex;align-items:center;gap:3px;font-size:10px;"
    "background:#2a2010;border:1px solid #6a4a20;color:#f0c090;border-radius:4px;"
    "padding:0 5px;margin-left:4px}\n"
    ".path-box{margin:0 0 14px;padding:12px 14px;background:#10161f;"
    "border:1px solid var(--border);border-radius:12px;font-size:12px}\n"
    ".path-box h3{margin:0 0 6px;font-size:12px;color:#9ecbff;text-transform:uppercase;"
    "letter-spacing:.04em}\n"
    ".path-picker{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}\n"
    ".path-picker button{font-size:11px;padding:4px 8px;background:var(--card);"
    "color:var(--text);border:1px solid var(--border);border-radius:6px;cursor:pointer}\n"
    ".path-picker button.active{border-color:var(--accent);background:#1a3358}\n"
    ".hops{display:flex;flex-wrap:wrap;gap:4px;align-items:center}\n"
    ".hop{background:var(--card2);border:1px solid var(--border);border-radius:6px;"
    "padding:3px 8px}\n"
    ".hop.tap{border-color:var(--tap);color:#f0c090}\n"
    ".hop.drop{border-color:var(--drop);color:#f5a8a0}\n"
    ".hop.station{border-color:#3d7ea6;color:#9ecbff}\n"
    ".hop.arrow{border:0;background:transparent;color:var(--accent);padding:0 2px}\n"
    ".hop.hi{box-shadow:0 0 0 1px var(--accent);background:var(--hi)}\n"
    ".hop.clickable{cursor:pointer}\n"
    ".group{background:var(--card);border:1px solid var(--border);border-radius:14px;"
    "padding:14px;margin-bottom:16px;overflow-x:auto}\n"
    ".group-title{font-size:12px;color:var(--muted);margin-bottom:10px;"
    "display:flex;flex-wrap:wrap;gap:8px}\n"
    ".pair-table{border-collapse:collapse;width:100%;font-size:12px;min-width:480px}\n"
    ".pair-table th{color:var(--muted);font-weight:600;text-align:left;padding:8px;"
    "border-bottom:1px solid var(--border);background:var(--card)}\n"
    ".pair-table td{padding:0;border-bottom:1px solid #1a2330;vertical-align:middle}\n"
    ".pair-table .fiber-hit{display:flex;align-items:center;gap:6px;padding:4px 8px;"
    "cursor:pointer;min-height:26px}\n"
    ".pair-table .fiber-hit:hover{background:rgba(106,176,255,.07)}\n"
    ".pair-table tr.hi .fiber-hit,.pair-table tr.hi td.mid{background:var(--hi)}\n"
    ".pair-table tr.dim{opacity:.28}\n"
    ".pair-table tr.tap-row td{background:rgba(230,126,34,.07)}\n"
    ".pair-table tr.feed-row td{box-shadow:inset 3px 0 0 var(--tap)}\n"
    ".pair-table .mid{text-align:center;width:110px;padding:4px 6px;"
    "font-family:ui-monospace,monospace}\n"
    ".pair-table .mid .fuse{color:var(--fuse);font-size:14px}\n"
    ".pair-table .mid .tap-pill{display:inline-block;background:#3a2810;"
    "border:1px solid var(--tap);color:#f0c090;border-radius:6px;padding:2px 7px;"
    "font-size:10px;font-weight:600}\n"
    ".cable-hdr{font-weight:700}\n"
    ".cable-hdr code{font-weight:500;color:var(--muted);font-size:11px}\n"
    ".cable-hdr .size{color:var(--accent)}\n"
    ".tube-band{display:flex;align-items:center;gap:6px;padding:3px 8px;font-size:10px;"
    "color:var(--muted);background:rgba(0,0,0,.2);border-left:3px solid var(--tube-c,#555);"
    "text-transform:uppercase;letter-spacing:.03em}\n"
    ".tube-band .real{text-transform:none;color:#f0c090;font-weight:600;margin-left:6px}\n"
    ".n{font-variant-numeric:tabular-nums;font-weight:600;min-width:1.4em;"
    "display:inline-block}\n"
    ".drop-block{margin-top:12px;padding:10px;border:1px dashed #5a3a20;"
    "border-radius:10px;background:#1a1510}\n"
    ".drop-block h4{margin:0 0 8px;font-size:12px;color:#f0c090}\n"
    ".drop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));"
    "gap:6px}\n"
    ".drop-card{background:#221810;border:1px solid #5a3a20;border-radius:8px;"
    "padding:8px;cursor:pointer;font-size:12px}\n"
    ".drop-card:hover,.drop-card.hi{border-color:var(--tap)}\n"
    ".stub-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}\n"
    ".stub{background:var(--card2);border:1px solid var(--border);border-radius:8px;"
    "padding:6px 8px;font-size:11px}\n"
    ".schematic{display:grid;grid-template-columns:1fr auto 1fr;gap:12px;"
    "background:var(--card);border:1px solid var(--border);border-radius:14px;"
    "padding:16px;margin-bottom:16px}\n"
    ".rail h3{margin:0 0 6px;font-size:.95rem}\n"
    ".rail .sub{font-size:11px;color:var(--muted);word-break:break-all;margin-bottom:8px}\n"
    ".fiber-list{list-style:none;margin:0;padding:0}\n"
    ".fiber-list li{display:flex;align-items:center;gap:5px;padding:2px 6px;"
    "border-radius:5px;cursor:pointer;font-size:12px;border:1px solid transparent}\n"
    ".fiber-list li:hover{background:rgba(106,176,255,.08)}\n"
    ".fiber-list li.hi{background:var(--hi);border-color:#3d6a9a}\n"
    ".fiber-list li.dim{opacity:.3}\n"
    ".fiber-list li.tube-start{margin-top:4px;border-top:2px solid var(--tube-c,#3a4a5c)}\n"
    ".fiber-list li.feed-fiber{box-shadow:inset 3px 0 0 var(--tap)}\n"
    ".fiber-list .fnum{width:22px;text-align:right;font-variant-numeric:tabular-nums;"
    "font-weight:600}\n"
    ".fiber-list .peer{margin-left:auto;color:var(--muted);font-family:ui-monospace,monospace;"
    "font-size:10px}\n"
    ".center-col{width:220px}\n"
    ".equip-node{border:2px solid #3d7ea6;border-radius:14px;padding:12px;"
    "background:linear-gradient(180deg,#1a2836,#121820);text-align:center}\n"
    ".equip-node.tap{border-color:var(--tap)}\n"
    ".equip-node h4{margin:0 0 4px;font-size:13px}\n"
    ".equip-node .loss{color:#f0c090;font-size:12px}\n"
    ".equip-node .feed{font-size:11px;color:var(--muted);margin:4px 0 8px}\n"
    ".port-lines{text-align:left;font-size:11px;color:var(--muted)}\n"
    ".port-lines .pl{padding:3px 0;border-bottom:1px solid #243041;cursor:pointer}\n"
    ".port-lines .pl.hi{background:var(--hi);color:var(--text)}\n"
    ".port-lines .role{color:#9ecbff;font-weight:700;display:inline-block;width:28px}\n"
    ".fuse-node{border:2px dashed #3d7ea6;border-radius:14px;padding:16px;text-align:center;"
    "color:var(--muted)}\n"
    ".adj{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}\n"
    ".adj a{display:block;background:var(--card);border:1px solid var(--border);"
    "border-radius:12px;padding:12px;color:inherit;text-decoration:none}\n"
    ".adj a:hover,.adj a.on-path{border-color:var(--accent)}\n"
    ".adj .st{font-weight:700;color:#9ecbff}\n"
    ".adj .via{font-size:11px;color:var(--muted);margin-top:4px}\n"
    "h2.sec{color:#9ecbff;font-size:1.05rem;margin:20px 0 8px}\n"
    ".legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--muted);"
    "margin:16px 0;padding-top:10px;border-top:1px solid var(--border)}\n"
    ".footer{margin-top:16px;color:#6b7785;font-size:11px}\n"
    ".view{display:none}\n"
    ".view.active{display:block}\n"
    "tr.dark-fiber,li.dark-fiber{display:none}\n"
    "body.show-dark tr.dark-fiber,body.show-dark li.dark-fiber{display:table-row}\n"
    "body.show-dark li.dark-fiber{display:flex}\n"
    ".print-only{display:none}\n"
    ".no-print{}\n"
    "@media print{\n"
    "  @page{size:letter;margin:.45in}\n"
    "  body{background:#fff!important;color:#111!important;font-size:10pt}\n"
    "  header.top .controls,.no-print,.legend,.footer{display:none!important}\n"
    "  header.top{position:static;background:#fff;border:0;padding:0 0 6px;"
    "border-bottom:2px solid #222}\n"
    "  .print-only{display:block!important}\n"
    "  .print-banner{border:1px solid #333;padding:6px 8px;margin-bottom:8px;font-size:9pt}\n"
    "  .print-banner strong{font-size:12pt}\n"
    "  .meta,.via{color:#333!important}\n"
    "  .meta code,code{background:#eee!important;color:#111!important}\n"
    "  .badge{background:#f5f5f5!important;border-color:#999!important;color:#111!important}\n"
    "  .badge.tap{border-color:#c60!important;color:#840!important}\n"
    "  .path-box,.group,.drop-block,.schematic,.adj a{background:#fff!important;"
    "border-color:#333!important;break-inside:avoid;page-break-inside:avoid}\n"
    "  .pair-table th{background:#eee!important;color:#333!important}\n"
    "  .pair-table td{border-bottom:1px solid #ccc}\n"
    "  .pair-table tr.dim{opacity:1}\n"
    "  .pair-table tr.tap-row td,.pair-table tr.feed-row td{background:#fff5e6!important;"
    "-webkit-print-color-adjust:exact;print-color-adjust:exact}\n"
    "  .pair-table tr.hi .fiber-hit{background:#e8f0ff!important;"
    "-webkit-print-color-adjust:exact;print-color-adjust:exact}\n"
    "  .tube-band{background:#f0f0f0!important;color:#333!important;"
    "-webkit-print-color-adjust:exact;print-color-adjust:exact}\n"
    "  .chip,.tube-dot{-webkit-print-color-adjust:exact;print-color-adjust:exact}\n"
    "  .view{display:none!important}\n"
    "  .view.view-splicer,.view#view-splicer{display:block!important}\n"
    "  h2.sec,.adj .st{color:#06c!important}\n"
    "  a{color:#06c!important;text-decoration:none}\n"
    "}\n";

static const char *PAGE_JS =
    "const TIA=['Blue','Orange','Green','Brown','Slate','White','Red','Black',"
    "'Yellow','Violet','Rose','Aqua'];\n"
    "const TIAH=['#1e5aa8','#e67e22','#27ae60','#8b4513','#708090','#e8e8e8',"
    "'#c0392b','#2c2c2c','#f1c40f','#8e44ad','#e91e8c','#5dade2'];\n"
    "function tia(n){const i=((n||1)-1)%12;return{name:TIA[i],hex:TIAH[i],light:i===5};}\n"
    "function chip(n){const t=tia(n);return '<span class=\"chip'+(t.light?' light':'')+"
    "'\" style=\"background:'+t.hex+'\" title=\"'+t.name+'\"></span>';}\n"
    "function short(g){return g?String(g).slice(0,8):'—';}\n"
    "function esc(s){return String(s==null?'':s).replace(/[&<>\"']/g,c=>({"
    "'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));}\n"
    "const state={view:SD.defaultView||'splicer',hi:null,pathId:null,showDark:SD.showDark};\n"
    "function setView(v){state.view=v;try{localStorage.setItem('sd_view',v);}catch(e){}"
    "document.querySelectorAll('.seg button').forEach(b=>b.classList.toggle('active',"
    "b.dataset.view===v));"
    "document.querySelectorAll('.view').forEach(el=>el.classList.toggle('active',"
    "el.id==='view-'+v));}\n"
    "function pathById(id){return (SD.paths||[]).find(p=>p.path_id===id);}\n"
    "function hiSet(){\n"
    "  const s=new Set();\n"
    "  if(!state.hi) return s;\n"
    "  s.add(state.hi.c+'#'+state.hi.f);\n"
    "  const p=state.pathId?pathById(state.pathId):null;\n"
    "  if(p){p.hops.forEach(h=>{if(h.kind==='cable'&&h.cable&&h.fiber!=null)"
    "s.add(h.cable+'#'+h.fiber);});}\n"
    "  return s;\n"
    "}\n"
    "function applyHi(){\n"
    "  const H=hiSet();\n"
    "  document.querySelectorAll('[data-c][data-f]').forEach(el=>{\n"
    "    const k=el.dataset.c+'#'+el.dataset.f;\n"
    "    const row=el.closest('tr')||el.closest('li')||el;\n"
    "    if(!state.hi){row.classList.remove('hi','dim');el.classList.remove('hi');return;}\n"
    "    if(H.has(k)){row.classList.add('hi');row.classList.remove('dim');el.classList.add('hi');}\n"
    "    else{row.classList.add('dim');row.classList.remove('hi');el.classList.remove('hi');}\n"
    "  });\n"
    "  document.querySelectorAll('.drop-card[data-c]').forEach(el=>{\n"
    "    const k=el.dataset.c+'#'+el.dataset.f;\n"
    "    el.classList.toggle('hi',!!(state.hi&&H.has(k)));\n"
    "  });\n"
    "  const onPath=new Set();\n"
    "  const p=state.pathId?pathById(state.pathId):null;\n"
    "  if(p) p.hops.forEach(h=>{if(h.sp) onPath.add(h.sp);});\n"
    "  document.querySelectorAll('.adj a[data-guid]').forEach(a=>{\n"
    "    a.classList.toggle('on-path', onPath.has(a.dataset.guid) ||\n"
    "      (state.hi && a.dataset.via===state.hi.c));\n"
    "  });\n"
    "  renderPath();\n"
    "}\n"
    "function setHi(c,f){\n"
    "  if(state.hi&&state.hi.c===c&&state.hi.f===f){state.hi=null;state.pathId=null;}\n"
    "  else{\n"
    "    state.hi={c,f};\n"
    "    const ids=(SD.pathIndex&&SD.pathIndex[c+'|'+f])||[];\n"
    "    if(ids.length){\n"
    "      let best=ids[0],bestH=-1;\n"
    "      ids.forEach(id=>{const p=pathById(id);if(p&&p.hop_count>bestH)"
    "{bestH=p.hop_count;best=id;}});\n"
    "      state.pathId=best;\n"
    "    } else state.pathId=null;\n"
    "  }\n"
    "  applyHi();\n"
    "}\n"
    "function renderPath(){\n"
    "  const slot=document.getElementById('pathSlot');\n"
    "  if(!slot) return;\n"
    "  if(!state.hi){slot.innerHTML='';return;}\n"
    "  const key=state.hi.c+'|'+state.hi.f;\n"
    "  const ids=(SD.pathIndex&&SD.pathIndex[key])||[];\n"
    "  let html='';\n"
    "  if(ids.length){\n"
    "    html+='<div class=\"path-picker no-print\">';\n"
    "    ids.forEach(id=>{const p=pathById(id);if(!p)return;\n"
    "      html+='<button type=\"button\" class=\"'+(state.pathId===id?'active':'')+"
    "'\" data-pid=\"'+id+'\">path #'+id+' · '+p.hop_count+' hops · '+\n"
    "        esc(p.end_kind)+(p.total_loss_db!=null?' · '+p.total_loss_db+' dB':'')+\n"
    "        (p.has_drop?' · drop':'')+'</button>';});\n"
    "    html+='</div>';\n"
    "  }\n"
    "  const p=state.pathId?pathById(state.pathId):null;\n"
    "  if(p){\n"
    "    const parts=[];\n"
    "    p.hops.forEach((h,i)=>{\n"
    "      if(i) parts.push('<span class=\"hop arrow\">→</span>');\n"
    "      if(h.kind==='cable'){\n"
    "        const here=h.sp===SD.guid||(!h.sp&&(SD.cables||[]).indexOf(h.cable)>=0);\n"
    "        parts.push('<span class=\"hop clickable'+(here?' hi':'')+'\""
    " data-c=\"'+esc(h.cable)+'\" data-f=\"'+h.fiber+'\">'+chip(h.fiber)+\n"
    "          ' <code>'+short(h.cable)+'</code> f'+h.fiber+\n"
    "          (h.station?' @ '+esc(h.station):'')+'</span>');\n"
    "      } else {\n"
    "        const isDrop=/drop/i.test(h.role||h.port||'');\n"
    "        const role=(h.role||'').replace('pass_through','PT').replace('input','IN')"
    ".replace('drop','DROP');\n"
    "        const feed=(h.tube||h.strand)?(' · '+esc(h.tube)+'/'+esc(h.strand)):'';\n"
    "        parts.push('<span class=\"hop '+(isDrop?'drop':'tap')+'\">'+esc(h.equip_name||h.port||'equip')+\n"
    "          ' '+esc(role)+(h.loss!=null?' ('+h.loss+' dB)':'')+feed+\n"
    "          (h.station?' · '+esc(h.station):'')+'</span>');\n"
    "      }\n"
    "    });\n"
    "    html+='<div class=\"path-box\"><h3>Optical path #'+p.path_id+\n"
    "      ' <span style=\"font-weight:500;text-transform:none;letter-spacing:0;color:var(--muted)\">'+\n"
    "      p.hop_count+' hops · '+(p.total_loss_db!=null?p.total_loss_db:'?')+' dB · '+esc(p.end_kind)+'</span></h3>'+\n"
    "      '<div class=\"meta\">Start <code>'+short(p.start_cable)+'</code> f'+p.start_fiber+\n"
    "      ' → end <code>'+short(p.end_cable)+'</code> f'+p.end_fiber+'</div>'+\n"
    "      '<div class=\"hops\">'+parts.join('')+'</div></div>';\n"
    "  } else {\n"
    "    html+='<div class=\"path-box\"><h3>Local fiber</h3><div class=\"meta\">'+\n"
    "      'No fiber_paths row indexed for this endpoint. Highlight shows local patches.</div>'+\n"
    "      '<div class=\"hops\"><span class=\"hop hi\">'+chip(state.hi.f)+' <code>'+\n"
    "      short(state.hi.c)+'</code> f'+state.hi.f+'</span></div></div>';\n"
    "  }\n"
    "  slot.innerHTML=html;\n"
    "  slot.querySelectorAll('.path-picker button').forEach(b=>b.addEventListener('click',()=>{\n"
    "    state.pathId=+b.dataset.pid;applyHi();\n"
    "  }));\n"
    "  slot.querySelectorAll('.clickable[data-c]').forEach(el=>el.addEventListener('click',()=>{\n"
    "    setHi(el.dataset.c,+el.dataset.f);\n"
    "  }));\n"
    "}\n"
    "document.getElementById('viewSeg').addEventListener('click',e=>{\n"
    "  const b=e.target.closest('button[data-view]'); if(b) setView(b.dataset.view);\n"
    "});\n"
    "document.getElementById('btnClear')&&document.getElementById('btnClear')"
    ".addEventListener('click',()=>{state.hi=null;state.pathId=null;applyHi();});\n"
    "document.getElementById('btnPrint')&&document.getElementById('btnPrint')"
    ".addEventListener('click',()=>{setView('splicer');setTimeout(()=>window.print(),40);});\n"
    "document.getElementById('chkDark')&&document.getElementById('chkDark')"
    ".addEventListener('change',e=>{document.body.classList.toggle('show-dark',e.target.checked);});\n"
    "document.body.addEventListener('click',e=>{\n"
    "  const el=e.target.closest('[data-c][data-f]');\n"
    "  if(!el||el.closest('#pathSlot')) return;\n"
    "  setHi(el.dataset.c,+el.dataset.f);\n"
    "});\n"
    "document.addEventListener('keydown',e=>{\n"
    "  if(e.target.matches('input,select,textarea')) return;\n"
    "  if(e.key==='Escape'){state.hi=null;state.pathId=null;applyHi();}\n"
    "  if(e.key==='1') setView('splicer');\n"
    "  if(e.key==='2') setView('trace');\n"
    "});\n"
    "(function(){\n"
    "  let v=SD.defaultView||'splicer';\n"
    "  try{const s=localStorage.getItem('sd_view'); if(s==='splicer'||s==='trace') v=s;}catch(e){}\n"
    "  setView(v);\n"
    "  if(SD.showDark){const c=document.getElementById('chkDark'); if(c){c.checked=true;"
    "document.body.classList.add('show-dark');}}\n"
    "})();\n";

/* ---------- render helpers ---------- */

static int render_chip(sb_t *b, int fiber) {
    const char *name, *hex;
    tia_for_fiber(fiber, &name, &hex);
    int light = (fiber - 1) % 12 == 5;
    return sb_appendf(b,
                      "<span class=\"chip%s\" style=\"background:%s\" "
                      "title=\"%s\"></span>",
                      light ? " light" : "", hex, name);
}

static int render_tube_dot_name(sb_t *b, const char *name) {
    const char *hex = color_name_hex(name);
    if (!hex) hex = "#666";
    int light = name && (strcasecmp(name, "White") == 0 ||
                         strcasecmp(name, "Slate") == 0 ||
                         strcasecmp(name, "Yellow") == 0 ||
                         strcasecmp(name, "Aqua") == 0);
    return sb_appendf(b,
                      "<span class=\"tube-dot%s\" style=\"background:%s\" "
                      "title=\"%s\"></span>",
                      light ? " light" : "", hex, name ? name : "");
}

static const char *equip_title(const sd_equip *eq) {
    if (eq->disp_name[0]) return eq->disp_name;
    if (eq->disp_type[0]) return eq->disp_type;
    return eq->is_tap ? "Tap" : "Equipment";
}

static int port_is_role(const sd_port *p, const char *role) {
    if (p->name_type[0] && strcmp(p->name_type, role) == 0) return 1;
    if (role[0] && p->name[0]) {
        if (strcmp(role, "input") == 0 && strncasecmp(p->name, "input", 5) == 0)
            return 1;
        if (strcmp(role, "pass_through") == 0 &&
            strstr(p->name, "ass") != NULL)
            return 1;
        if (strcmp(role, "drop") == 0 && strncasecmp(p->name, "drop", 4) == 0)
            return 1;
    }
    return 0;
}

static int render_label_pill(sb_t *b, const sd_equip *eq) {
    if (!eq->tube[0] && !eq->strand[0]) return 0;
    if (sb_append(b, "<span class=\"lbl-pill\" title=\"equipment_disp\">") != 0)
        return -1;
    if (eq->tube[0]) {
        if (render_tube_dot_name(b, eq->tube) != 0) return -1;
        if (html_escape_append(b, eq->tube) != 0) return -1;
    }
    if (eq->tube[0] && eq->strand[0] && sb_append(b, " / ") != 0) return -1;
    if (eq->strand[0]) {
        const char *hx = color_name_hex(eq->strand);
        if (!hx) hx = "#666";
        if (sb_appendf(b, "<span class=\"chip\" style=\"background:%s\"></span>",
                       hx) != 0)
            return -1;
        if (html_escape_append(b, eq->strand) != 0) return -1;
    }
    return sb_append(b, "</span>");
}

static int fiber_has_equip_label(const sd_splice *sp, int fiber,
                                 const sd_equip **out_eq) {
    for (int i = 0; i < sp->n_equip; i++) {
        if (sp->equip[i].feed_fiber == fiber &&
            (sp->equip[i].tube[0] || sp->equip[i].strand[0])) {
            if (out_eq) *out_eq = &sp->equip[i];
            return 1;
        }
    }
    if (out_eq) *out_eq = NULL;
    return 0;
}

static int render_tube_band(sb_t *b, const sd_splice *sp, int fiber,
                            int colspan) {
    const char *tname, *thex;
    int tidx;
    tia_for_tube(fiber, &tname, &thex, &tidx);
    if (sb_appendf(b,
                   "<tr><td colspan=\"%d\" class=\"tube-band\" "
                   "style=\"--tube-c:%s\">",
                   colspan, thex) != 0)
        return -1;
    if (sb_appendf(b,
                   "<span class=\"tube-dot\" style=\"background:%s\"></span>"
                   " Tube %d · %s · f%d–%d",
                   thex, tidx + 1, tname, tidx * 12 + 1, tidx * 12 + 12) != 0)
        return -1;
    /* real label if feed fiber in this tube */
    for (int f = tidx * 12 + 1; f <= tidx * 12 + 12; f++) {
        const sd_equip *eq = NULL;
        if (fiber_has_equip_label(sp, f, &eq) && eq) {
            if (sb_append(b, "<span class=\"real\">") != 0) return -1;
            if (render_tube_dot_name(b, eq->tube) != 0) return -1;
            if (html_escape_append(b, eq->tube) != 0) return -1;
            if (sb_append(b, "/") != 0) return -1;
            if (html_escape_append(b, eq->strand) != 0) return -1;
            if (sb_append(b, " · equipment_disp</span>") != 0) return -1;
            break;
        }
    }
    return sb_append(b, "</td></tr>\n");
}

static int find_through_peer(const sd_splice *sp, const char *cable, int fiber,
                             char *peer_c, size_t pcsz, int *peer_f) {
    for (int t = 0; t < sp->n_through; t++) {
        const sd_through *th = &sp->through[t];
        if (strcmp(th->a_cable, cable) == 0 && th->a_f == fiber) {
            snprintf(peer_c, pcsz, "%s", th->b_cable);
            *peer_f = th->b_f;
            return 1;
        }
        if (strcmp(th->b_cable, cable) == 0 && th->b_f == fiber) {
            snprintf(peer_c, pcsz, "%s", th->a_cable);
            *peer_f = th->a_f;
            return 1;
        }
    }
    /* also direct patch that wasn't through (to equip handled elsewhere) */
    int ci = find_cable_idx(sp, cable);
    if (ci < 0) return 0;
    const sd_cable *cb = &sp->cables[ci];
    for (int i = 0; i < cb->n_fibers; i++) {
        if (cb->fibers[i].number == fiber && cb->fibers[i].has_patch) {
            if (find_cable_idx(sp, cb->fibers[i].patch_guid) >= 0) {
                snprintf(peer_c, pcsz, "%s", cb->fibers[i].patch_guid);
                *peer_f = cb->fibers[i].patch_number;
                return 1;
            }
        }
    }
    return 0;
}

static int render_pair_table(sb_t *b, const sd_splice *sp, int left_ci,
                             int right_ci, const sd_options *opt) {
    (void)opt;
    if (left_ci < 0) return 0;
    const sd_cable *Lc = &sp->cables[left_ci];
    const sd_cable *Rc = right_ci >= 0 ? &sp->cables[right_ci] : NULL;
    char lsg[16], rsg[16];
    short_guid(Lc->guid, lsg, sizeof(lsg));
    if (Rc) short_guid(Rc->guid, rsg, sizeof(rsg));

    if (sb_append(b, "<table class=\"pair-table\"><thead><tr>\n") != 0)
        return -1;
    if (sb_appendf(b,
                   "<th class=\"cable-hdr\">Cable <code>%s</code> "
                   "<span class=\"size\">%dF</span>",
                   lsg, Lc->cable_size > 0 ? Lc->cable_size : Lc->fiber_count) !=
        0)
        return -1;
    if (Lc->work_order[0]) {
        if (sb_append(b, "<div style=\"font-weight:500;font-size:11px\">WO ") !=
            0)
            return -1;
        if (html_escape_append(b, Lc->work_order) != 0) return -1;
        if (sb_append(b, "</div>") != 0) return -1;
    }
    if (sb_append(b, "</th><th class=\"mid\">splice</th><th class=\"cable-hdr\">") !=
        0)
        return -1;
    if (Rc) {
        if (sb_appendf(b, "Cable <code>%s</code> <span class=\"size\">%dF</span>",
                       rsg,
                       Rc->cable_size > 0 ? Rc->cable_size : Rc->fiber_count) !=
            0)
            return -1;
        if (Rc->work_order[0]) {
            if (sb_append(
                    b, "<div style=\"font-weight:500;font-size:11px\">WO ") != 0)
                return -1;
            if (html_escape_append(b, Rc->work_order) != 0) return -1;
            if (sb_append(b, "</div>") != 0) return -1;
        }
    } else {
        if (sb_append(b, "Peer") != 0) return -1;
    }
    if (sb_append(b, "</th></tr></thead><tbody>\n") != 0) return -1;

    int last_tube = -1;
    for (int fi = 0; fi < Lc->n_fibers; fi++) {
        const sd_port *p = &Lc->fibers[fi];
        int fn = p->number;
        char peer_c[48];
        int peer_f = 0;
        int has_peer = find_through_peer(sp, Lc->guid, fn, peer_c, sizeof(peer_c),
                                         &peer_f);

        /* tap express on this fiber? */
        const sd_equip *tap_eq = NULL;
        const sd_port *tap_port = NULL;
        const sd_port *tap_other = NULL;
        int tap_role_in = 0;
        for (int ei = 0; ei < sp->n_equip && !tap_eq; ei++) {
            const sd_equip *eq = &sp->equip[ei];
            for (int pi = 0; pi < eq->n_ports; pi++) {
                const sd_port *ep = &eq->ports[pi];
                if (!ep->has_patch) continue;
                if (strcmp(ep->patch_guid, Lc->guid) != 0 ||
                    ep->patch_number != fn)
                    continue;
                if (port_is_role(ep, "input") ||
                    port_is_role(ep, "pass_through")) {
                    tap_eq = eq;
                    tap_port = ep;
                    tap_role_in = port_is_role(ep, "input");
                    /* find other express port */
                    for (int qi = 0; qi < eq->n_ports; qi++) {
                        const sd_port *oq = &eq->ports[qi];
                        if (!oq->has_patch || oq == ep) continue;
                        if (tap_role_in && port_is_role(oq, "pass_through")) {
                            tap_other = oq;
                            break;
                        }
                        if (!tap_role_in && port_is_role(oq, "input")) {
                            tap_other = oq;
                            break;
                        }
                    }
                    break;
                }
                if (find_equip_idx(sp, p->patch_guid) >= 0) {
                    /* cable patches to this equip */
                    tap_eq = eq;
                    tap_port = ep;
                }
            }
        }
        /* also: this fiber patches to equip */
        if (!tap_eq && p->has_patch) {
            int ei = find_equip_idx(sp, p->patch_guid);
            if (ei >= 0) {
                tap_eq = &sp->equip[ei];
                for (int pi = 0; pi < tap_eq->n_ports; pi++) {
                    if (tap_eq->ports[pi].number == p->patch_number) {
                        tap_port = &tap_eq->ports[pi];
                        break;
                    }
                }
                for (int pi = 0; pi < tap_eq->n_ports; pi++) {
                    const sd_port *oq = &tap_eq->ports[pi];
                    if (!oq->has_patch) continue;
                    if (port_is_role(oq, "pass_through") ||
                        port_is_role(oq, "input")) {
                        if (strcmp(oq->patch_guid, Lc->guid) != 0 ||
                            oq->patch_number != fn)
                            tap_other = oq;
                    }
                }
            }
        }

        const sd_equip *feed_eq = NULL;
        int is_feed = fiber_has_equip_label(sp, fn, &feed_eq);
        int is_dark = !has_peer && !tap_eq && !p->has_patch;

        int tidx = (fn - 1) / 12;
        if (tidx != last_tube) {
            if (render_tube_band(b, sp, fn, 3) != 0) return -1;
            last_tube = tidx;
        }

        char rowbuf[80];
        rowbuf[0] = '\0';
        if (tap_eq)
            strcat(rowbuf, "tap-row ");
        if (is_feed)
            strcat(rowbuf, "feed-row ");
        if (is_dark)
            strcat(rowbuf, "dark-fiber ");
        const char *row_class = rowbuf;

        if (sb_appendf(b, "<tr class=\"%s\">", row_class) != 0) return -1;
        if (sb_appendf(b,
                       "<td><span class=\"fiber-hit\" data-c=\"%s\" data-f=\"%d\">",
                       Lc->guid, fn) != 0)
            return -1;
        if (render_chip(b, fn) != 0) return -1;
        const char *cname, *chex;
        tia_for_fiber(fn, &cname, &chex);
        if (sb_appendf(b, "<span class=\"n\">%d</span> %s", fn, cname) != 0)
            return -1;
        if (feed_eq && render_label_pill(b, feed_eq) != 0) return -1;
        if (sb_append(b, "</span></td><td class=\"mid\">") != 0) return -1;

        if (tap_eq) {
            double loss = tap_port ? tap_port->split_db : tap_eq->tap_loss_db;
            if (sb_append(b, "<span class=\"tap-pill\">") != 0) return -1;
            if (html_escape_append(b, equip_title(tap_eq)) != 0) return -1;
            if (sb_appendf(b, " %.2fdB</span>", loss) != 0) return -1;
        } else {
            if (sb_append(b, "<span class=\"fuse\">⟷</span>") != 0) return -1;
        }
        if (sb_append(b, "</td><td>") != 0) return -1;

        if (tap_eq && tap_other && tap_other->has_patch) {
            char psg[16];
            short_guid(tap_other->patch_guid, psg, sizeof(psg));
            int off = Rc && strcmp(tap_other->patch_guid, Rc->guid) != 0;
            if (sb_appendf(b,
                           "<span class=\"fiber-hit\" data-c=\"%s\" data-f=\"%d\">",
                           tap_other->patch_guid, tap_other->patch_number) != 0)
                return -1;
            if (render_chip(b, tap_other->patch_number) != 0) return -1;
            const char *pn, *ph;
            tia_for_fiber(tap_other->patch_number, &pn, &ph);
            if (sb_appendf(b, "<span class=\"n\">%d</span> %s",
                           tap_other->patch_number, pn) != 0)
                return -1;
            if (off && sb_appendf(b, " <code>%s</code>", psg) != 0) return -1;
            if (sb_append(b, "</span>") != 0) return -1;
        } else if (has_peer) {
            char psg[16];
            short_guid(peer_c, psg, sizeof(psg));
            int off = Rc && strcmp(peer_c, Rc->guid) != 0;
            if (sb_appendf(b,
                           "<span class=\"fiber-hit\" data-c=\"%s\" data-f=\"%d\">",
                           peer_c, peer_f) != 0)
                return -1;
            if (render_chip(b, peer_f) != 0) return -1;
            const char *pn, *ph;
            tia_for_fiber(peer_f, &pn, &ph);
            if (sb_appendf(b, "<span class=\"n\">%d</span> %s", peer_f, pn) != 0)
                return -1;
            if (off && sb_appendf(b, " <code>%s</code>", psg) != 0) return -1;
            if (sb_append(b, "</span>") != 0) return -1;
        } else if (p->has_patch && find_equip_idx(sp, p->patch_guid) >= 0) {
            if (sb_append(b, "<span class=\"meta\" style=\"padding:4px 8px;"
                             "display:block\">→ equip</span>") != 0)
                return -1;
        } else {
            if (sb_append(b, "<span style=\"opacity:.45;padding:4px 8px;"
                             "display:block\">dark</span>") != 0)
                return -1;
        }
        if (sb_append(b, "</td></tr>\n") != 0) return -1;
    }
    return sb_append(b, "</tbody></table>\n");
}

static int render_drops(sb_t *b, const sd_splice *sp, const sd_equip *eq) {
    int any = 0;
    for (int i = 0; i < eq->n_ports; i++) {
        if (eq->ports[i].has_patch && port_is_role(&eq->ports[i], "drop")) {
            any = 1;
            break;
        }
    }
    if (!any) return 0;
    if (sb_append(b, "<div class=\"drop-block\"><h4>↘ ") != 0) return -1;
    if (html_escape_append(b, equip_title(eq)) != 0) return -1;
    if (sb_append(b, " drops ") != 0) return -1;
    if ((eq->tube[0] || eq->strand[0]) && render_label_pill(b, eq) != 0)
        return -1;
    if (sb_append(b, "</h4><div class=\"drop-grid\">\n") != 0) return -1;
    for (int i = 0; i < eq->n_ports; i++) {
        const sd_port *p = &eq->ports[i];
        if (!p->has_patch || !port_is_role(p, "drop")) continue;
        char psg[16];
        short_guid(p->patch_guid, psg, sizeof(psg));
        int ci = find_cable_idx(sp, p->patch_guid);
        int sz = ci >= 0 ? sp->cables[ci].cable_size : 0;
        if (sb_appendf(b,
                       "<div class=\"drop-card\" data-c=\"%s\" data-f=\"%d\">"
                       "<div style=\"font-weight:600;color:#f0c090\">",
                       p->patch_guid, p->patch_number) != 0)
            return -1;
        if (html_escape_append(b, p->name[0] ? p->name : "Drop") != 0) return -1;
        if (sb_appendf(b, " · %.2f dB</div>", p->split_db) != 0) return -1;
        if (render_chip(b, p->patch_number) != 0) return -1;
        if (sb_appendf(b, " f%d on <code>%s</code>%s", p->patch_number, psg,
                       sz > 0 ? "" : "") != 0)
            return -1;
        if (sz > 0 && sb_appendf(b, " · %dF", sz) != 0) return -1;
        if (p->type[0]) {
            if (sb_append(b, "<div class=\"meta\" style=\"margin:2px 0 0\">") !=
                0)
                return -1;
            if (html_escape_append(b, p->type) != 0) return -1;
            if (sb_append(b, "</div>") != 0) return -1;
        }
        if (sb_append(b, "</div>\n") != 0) return -1;
    }
    return sb_append(b, "</div></div>\n");
}

static int render_splicer_view(sb_t *b, const sd_splice *sp,
                               const sd_options *opt) {
    if (sb_append(b, "<div class=\"view view-splicer\" id=\"view-splicer\">\n") !=
        0)
        return -1;
    if (sp->n_groups == 0) {
        if (sb_append(b, "<div class=\"group\"><div class=\"meta\">No cables "
                         "at this splicepoint.</div></div>\n") != 0)
            return -1;
    }
    for (int gi = 0; gi < sp->n_groups; gi++) {
        const sd_group *g = &sp->groups[gi];
        if (sb_appendf(b,
                       "<div class=\"group\"><div class=\"group-title\">"
                       "<strong style=\"color:var(--text)\">Group %d</strong>"
                       "<span>%d cables</span><span>%d through</span></div>\n",
                       gi + 1, g->n_members, g->n_through) != 0)
            return -1;
        if (render_pair_table(b, sp, g->left_ci, g->right_ci, opt) != 0)
            return -1;
        for (int s = 0; s < g->n_sec; s++) {
            if (sb_appendf(b,
                           "<div class=\"meta\" style=\"margin-top:12px\">"
                           "Secondary pair · %d splices</div>\n",
                           g->sec_n[s]) != 0)
                return -1;
            if (render_pair_table(b, sp, g->sec_left[s], g->sec_right[s],
                                  opt) != 0)
                return -1;
        }
        for (int ei = 0; ei < sp->n_equip; ei++) {
            /* drops for equip connected to this group */
            int in_group = 0;
            for (int pi = 0; pi < sp->equip[ei].n_ports && !in_group; pi++) {
                if (!sp->equip[ei].ports[pi].has_patch) continue;
                int cj = find_cable_idx(sp, sp->equip[ei].ports[pi].patch_guid);
                for (int m = 0; m < g->n_members; m++)
                    if (g->members[m] == cj) in_group = 1;
            }
            if (in_group && render_drops(b, sp, &sp->equip[ei]) != 0) return -1;
        }
        /* stubs */
        int used[MAX_CABLES];
        memset(used, 0, sizeof(used));
        if (g->left_ci >= 0) used[g->left_ci] = 1;
        if (g->right_ci >= 0) used[g->right_ci] = 1;
        for (int s = 0; s < g->n_sec; s++) {
            used[g->sec_left[s]] = 1;
            used[g->sec_right[s]] = 1;
        }
        int any_stub = 0;
        for (int m = 0; m < g->n_members; m++)
            if (!used[g->members[m]]) any_stub = 1;
        if (any_stub) {
            if (sb_append(b, "<div class=\"stub-row\">\n") != 0) return -1;
            for (int m = 0; m < g->n_members; m++) {
                int ci = g->members[m];
                if (used[ci]) continue;
                const sd_cable *cb = &sp->cables[ci];
                char sg[16];
                short_guid(cb->guid, sg, sizeof(sg));
                int patched = 0;
                for (int f = 0; f < cb->n_fibers; f++)
                    if (cb->fibers[f].has_patch) patched++;
                if (sb_appendf(b,
                               "<div class=\"stub\"><code>%s</code> · %dF · "
                               "%d patched</div>\n",
                               sg,
                               cb->cable_size > 0 ? cb->cable_size
                                                  : cb->fiber_count,
                               patched) != 0)
                    return -1;
            }
            if (sb_append(b, "</div>\n") != 0) return -1;
        }
        if (sb_append(b, "</div>\n") != 0) return -1;
    }
    return sb_append(b, "</div>\n");
}

static int render_rail(sb_t *b, const sd_splice *sp, int ci,
                       const sd_options *opt) {
    if (ci < 0) {
        return sb_append(b, "<div class=\"rail\"><div class=\"meta\">—</div>"
                            "</div>\n");
    }
    const sd_cable *cb = &sp->cables[ci];
    char sg[16];
    short_guid(cb->guid, sg, sizeof(sg));
    if (sb_appendf(b,
                   "<div class=\"rail\"><h3>Cable <code>%s</code> · %dF</h3>"
                   "<div class=\"sub\">",
                   sg, cb->cable_size > 0 ? cb->cable_size : cb->fiber_count) !=
        0)
        return -1;
    if (html_escape_append(b, cb->guid) != 0) return -1;
    if (cb->work_order[0]) {
        if (sb_append(b, "<br>WO ") != 0) return -1;
        if (html_escape_append(b, cb->work_order) != 0) return -1;
    }
    if (sb_append(b, "</div><ul class=\"fiber-list\">\n") != 0) return -1;
    int last_tube = -1;
    for (int i = 0; i < cb->n_fibers; i++) {
        const sd_port *p = &cb->fibers[i];
        (void)opt;
        int tidx = (p->number - 1) / 12;
        const char *tname, *thex;
        int ti;
        tia_for_tube(p->number, &tname, &thex, &ti);
        char clsbuf[80];
        clsbuf[0] = '\0';
        if (tidx != last_tube) {
            strcat(clsbuf, "tube-start ");
            last_tube = tidx;
        }
        const sd_equip *fe = NULL;
        if (fiber_has_equip_label(sp, p->number, &fe))
            strcat(clsbuf, "feed-fiber ");
        if (!p->has_patch)
            strcat(clsbuf, "dark-fiber ");
        const char *cls = clsbuf;
        if (sb_appendf(b,
                       "<li class=\"%s\" style=\"--tube-c:%s\" data-c=\"%s\" "
                       "data-f=\"%d\">",
                       cls, thex, cb->guid, p->number) != 0)
            return -1;
        if (render_chip(b, p->number) != 0) return -1;
        const char *cn, *ch;
        tia_for_fiber(p->number, &cn, &ch);
        if (sb_appendf(b, "<span class=\"fnum\">%d</span><span>%s", p->number,
                       cn) != 0)
            return -1;
        if (fe && render_label_pill(b, fe) != 0) return -1;
        if (sb_append(b, "</span><span class=\"peer\">") != 0) return -1;
        if (p->has_patch) {
            char psg[16];
            short_guid(p->patch_guid, psg, sizeof(psg));
            int ei = find_equip_idx(sp, p->patch_guid);
            if (ei >= 0) {
                if (html_escape_append(b, equip_title(&sp->equip[ei])) != 0)
                    return -1;
            } else {
                if (sb_appendf(b, "%s f%d", psg, p->patch_number) != 0)
                    return -1;
            }
        } else {
            if (sb_append(b, "dark") != 0) return -1;
        }
        if (sb_append(b, "</span></li>\n") != 0) return -1;
    }
    return sb_append(b, "</ul></div>\n");
}

static int render_trace_view(sb_t *b, const sd_splice *sp,
                             const sd_options *opt) {
    if (sb_append(b, "<div class=\"view view-trace\" id=\"view-trace\">\n") != 0)
        return -1;
    int L = sp->n_groups > 0 ? sp->groups[0].left_ci : -1;
    int R = sp->n_groups > 0 ? sp->groups[0].right_ci : -1;
    if (sb_append(b, "<div class=\"schematic\">\n") != 0) return -1;
    if (render_rail(b, sp, L, opt) != 0) return -1;
    if (sb_append(b, "<div class=\"center-col\">\n") != 0) return -1;
    if (sp->n_equip > 0) {
        const sd_equip *eq = &sp->equip[0];
        if (sb_appendf(b, "<div class=\"equip-node%s\">",
                       eq->is_tap ? " tap" : "") != 0)
            return -1;
        if (sb_append(b, "<h4>") != 0) return -1;
        if (html_escape_append(b, equip_title(eq)) != 0) return -1;
        if (sb_append(b, "</h4>\n") != 0) return -1;
        if (eq->is_tap &&
            sb_appendf(b, "<div class=\"loss\">drop %.2f dB</div>\n",
                       eq->tap_loss_db) != 0)
            return -1;
        if (eq->tube[0] || eq->strand[0]) {
            if (sb_append(b, "<div class=\"feed\">") != 0) return -1;
            if (eq->tube[0] && render_tube_dot_name(b, eq->tube) != 0) return -1;
            if (html_escape_append(b, eq->tube) != 0) return -1;
            if (sb_append(b, " / ") != 0) return -1;
            if (eq->strand[0]) {
                const char *hx = color_name_hex(eq->strand);
                if (!hx) hx = "#666";
                if (sb_appendf(b,
                               "<span class=\"chip\" style=\"background:%s\">"
                               "</span>",
                               hx) != 0)
                    return -1;
                if (html_escape_append(b, eq->strand) != 0) return -1;
            }
            if (eq->feed_fiber > 0 &&
                sb_appendf(b, " · feed f%d", eq->feed_fiber) != 0)
                return -1;
            if (sb_append(b, " <span class=\"badge\">equipment_disp</span>"
                             "</div>\n") != 0)
                return -1;
        }
        if (sb_append(b, "<div class=\"port-lines\">\n") != 0) return -1;
        for (int i = 0; i < eq->n_ports; i++) {
            const sd_port *p = &eq->ports[i];
            if (!p->has_patch) continue;
            const char *role = "·";
            if (port_is_role(p, "input"))
                role = "IN";
            else if (port_is_role(p, "pass_through"))
                role = "PT";
            else if (port_is_role(p, "drop"))
                role = "DR";
            char psg[16];
            short_guid(p->patch_guid, psg, sizeof(psg));
            if (sb_appendf(b,
                           "<div class=\"pl\" data-c=\"%s\" data-f=\"%d\">"
                           "<span class=\"role\">%s</span> %s f%d · %.2fdB</div>\n",
                           p->patch_guid, p->patch_number, role, psg,
                           p->patch_number, p->split_db) != 0)
                return -1;
        }
        if (sb_append(b, "</div></div>\n") != 0) return -1;
    } else {
        if (sb_append(b, "<div class=\"fuse-node\"><strong style=\"color:var(--fuse);"
                         "display:block;margin-bottom:4px\">Fusion</strong>"
                         "cable ↔ cable</div>\n") != 0)
            return -1;
    }
    if (sb_append(b, "</div>\n") != 0) return -1;
    if (render_rail(b, sp, R, opt) != 0) return -1;
    if (sb_append(b, "</div>\n") != 0) return -1; /* schematic */

    if (sp->n_groups > 1) {
        for (int gi = 1; gi < sp->n_groups; gi++) {
            if (sb_appendf(b,
                           "<div class=\"group\"><div class=\"group-title\">"
                           "Group %d · %d cables · %d through</div></div>\n",
                           gi + 1, sp->groups[gi].n_members,
                           sp->groups[gi].n_through) != 0)
                return -1;
        }
    }
    return sb_append(b, "</div>\n");
}

static int emit_paths_json(sb_t *b, const sd_splice *sp) {
    if (sb_append(b, "\"paths\":[") != 0) return -1;
    for (int i = 0; i < sp->n_paths; i++) {
        const sd_path *p = &sp->paths[i];
        if (i && sb_append(b, ",") != 0) return -1;
        if (sb_appendf(b,
                       "{\"path_id\":%d,\"hop_count\":%d,\"equip_count\":%d,"
                       "\"total_loss_db\":%.4f,\"has_drop\":%d,\"end_kind\":\"",
                       p->path_id, p->hop_count, p->equip_count, p->total_loss_db,
                       p->has_drop) != 0)
            return -1;
        if (json_escape_append(b, p->end_kind) != 0) return -1;
        if (sb_appendf(b,
                       "\",\"start_cable\":\"%s\",\"start_fiber\":%d,"
                       "\"end_cable\":\"%s\",\"end_fiber\":%d,\"hops\":[",
                       p->start_cable, p->start_fiber, p->end_cable,
                       p->end_fiber) != 0)
            return -1;
        for (int h = 0; h < p->n_hops; h++) {
            const sd_hop *hp = &p->hops[h];
            if (h && sb_append(b, ",") != 0) return -1;
            if (sb_append(b, "{\"kind\":\"") != 0) return -1;
            if (json_escape_append(b, hp->kind) != 0) return -1;
            if (sb_append(b, "\",\"cable\":\"") != 0) return -1;
            if (json_escape_append(b, hp->cable) != 0) return -1;
            if (sb_appendf(b, "\",\"fiber\":%d,\"port\":\"", hp->fiber) != 0)
                return -1;
            if (json_escape_append(b, hp->port) != 0) return -1;
            if (sb_append(b, "\",\"role\":\"") != 0) return -1;
            if (json_escape_append(b, hp->role) != 0) return -1;
            if (sb_append(b, "\",\"sp\":\"") != 0) return -1;
            if (json_escape_append(b, hp->sp) != 0) return -1;
            if (sb_append(b, "\",\"station\":\"") != 0) return -1;
            if (json_escape_append(b, hp->station) != 0) return -1;
            if (sb_appendf(b, "\",\"loss\":%.4f,\"tube\":\"", hp->loss) != 0)
                return -1;
            if (json_escape_append(b, hp->tube) != 0) return -1;
            if (sb_append(b, "\",\"strand\":\"") != 0) return -1;
            if (json_escape_append(b, hp->strand) != 0) return -1;
            if (sb_append(b, "\",\"equip_name\":\"") != 0) return -1;
            if (json_escape_append(b, hp->equip_name) != 0) return -1;
            if (sb_append(b, "\"}") != 0) return -1;
        }
        if (sb_append(b, "]}") != 0) return -1;
    }
    if (sb_append(b, "],\"pathIndex\":{") != 0) return -1;
    /* build path index: cable|fiber -> [path_ids] for hops at this SP or local
     * cables */
    int first_key = 1;
    for (int ci = 0; ci < sp->n_cables; ci++) {
        const sd_cable *cb = &sp->cables[ci];
        for (int fi = 0; fi < cb->n_fibers; fi++) {
            int fn = cb->fibers[fi].number;
            int ids[MAX_PATHS];
            int n_ids = 0;
            for (int pi = 0; pi < sp->n_paths; pi++) {
                const sd_path *p = &sp->paths[pi];
                int hit = 0;
                if (strcmp(p->start_cable, cb->guid) == 0 &&
                    p->start_fiber == fn)
                    hit = 1;
                for (int h = 0; h < p->n_hops && !hit; h++) {
                    if (strcmp(p->hops[h].kind, "cable") == 0 &&
                        strcmp(p->hops[h].cable, cb->guid) == 0 &&
                        p->hops[h].fiber == fn)
                        hit = 1;
                }
                if (hit && n_ids < MAX_PATHS) ids[n_ids++] = p->path_id;
            }
            if (n_ids == 0) continue;
            if (!first_key && sb_append(b, ",") != 0) return -1;
            first_key = 0;
            if (sb_appendf(b, "\"%s|%d\":[", cb->guid, fn) != 0) return -1;
            for (int k = 0; k < n_ids; k++) {
                if (k && sb_append(b, ",") != 0) return -1;
                if (sb_appendf(b, "%d", ids[k]) != 0) return -1;
            }
            if (sb_append(b, "]") != 0) return -1;
        }
    }
    return sb_append(b, "}");
}

static int render_splice_html(const sd_splice *sp, const sd_options *opt,
                              char **out_html, size_t *out_len) {
    sd_options def;
    if (!opt) {
        sd_options_init(&def);
        opt = &def;
    }

    sb_t b = {0};
    const char *prefix = opt->title_prefix ? opt->title_prefix : "Splice";
    const char *station =
        sp->station_id[0] ? sp->station_id : "(no station id)";
    const char *def_view =
        opt->default_view == SD_VIEW_TRACE ? "trace" : "splicer";

    if (sb_append(&b, "<!DOCTYPE html>\n<html lang=\"en\"><head>\n"
                      "<meta charset=\"utf-8\">\n"
                      "<meta name=\"viewport\" content=\"width=device-width,"
                      "initial-scale=1\">\n<title>") != 0)
        goto oom;
    if (html_escape_append(&b, prefix) != 0) goto oom;
    if (sb_append(&b, " · ") != 0) goto oom;
    if (html_escape_append(&b, station) != 0) goto oom;
    if (sb_append(&b, "</title>\n<style>\n") != 0) goto oom;
    if (sb_append(&b, BASE_CSS) != 0) goto oom;
    if (opt->css_extra && sb_append(&b, opt->css_extra) != 0) goto oom;
    if (opt->compact &&
        sb_append(&b, "body{font-size:12px}th,td,.fiber-hit{padding:2px 4px}\n") !=
            0)
        goto oom;
    /* hide dark fibers via CSS when not show-dark */
    if (!opt->show_dark_fibers) {
        if (sb_append(&b,
                      "body:not(.show-dark) .fiber-list li .peer:only-of-type"
                      "{}\n") != 0)
            goto oom;
    }
    if (sb_append(&b, "</style>\n</head><body>\n") != 0) goto oom;

    /* header */
    if (sb_append(&b, "<header class=\"top\">\n<h1>") != 0) goto oom;
    if (html_escape_append(&b, prefix) != 0) goto oom;
    if (sb_append(&b, ": ") != 0) goto oom;
    if (html_escape_append(&b, station) != 0) goto oom;
    if (sb_append(&b, "</h1>\n<div class=\"controls no-print\">\n"
                      "<div class=\"seg\" id=\"viewSeg\" role=\"tablist\">"
                      "<button type=\"button\" data-view=\"splicer\">Splicer"
                      "</button>"
                      "<button type=\"button\" data-view=\"trace\">Trace"
                      "</button></div>\n"
                      "<label style=\"color:var(--muted);font-size:12px\">"
                      "<input type=\"checkbox\" id=\"chkDark\"> Dark fibers"
                      "</label>\n"
                      "<button type=\"button\" class=\"btn\" id=\"btnClear\">"
                      "Clear</button>\n"
                      "<button type=\"button\" class=\"btn\" id=\"btnPrint\">"
                      "Print sheet</button>\n"
                      "</div></header>\n<main>\n") != 0)
        goto oom;

    /* print banner */
    if (sb_append(&b, "<div class=\"print-only print-banner\"><strong>SPLICE "
                      "SHEET · ") != 0)
        goto oom;
    if (html_escape_append(&b, station) != 0) goto oom;
    if (sb_append(&b, "</strong><div>GUID ") != 0) goto oom;
    if (html_escape_append(&b, sp->guid) != 0) goto oom;
    if (sp->work_order[0]) {
        if (sb_append(&b, " · WO ") != 0) goto oom;
        if (html_escape_append(&b, sp->work_order) != 0) goto oom;
    }
    if (sb_appendf(&b, " · %d cables · %d equipment</div>", sp->n_cables,
                   sp->n_equip) != 0)
        goto oom;
    for (int i = 0; i < sp->n_equip; i++) {
        const sd_equip *eq = &sp->equip[i];
        if (!eq->tube[0] && !eq->strand[0]) continue;
        if (sb_append(&b, "<div>Feed tube/strand: <strong>") != 0) goto oom;
        if (html_escape_append(&b, eq->tube) != 0) goto oom;
        if (sb_append(&b, "</strong> / <strong>") != 0) goto oom;
        if (html_escape_append(&b, eq->strand) != 0) goto oom;
        if (sb_append(&b, "</strong> (") != 0) goto oom;
        if (html_escape_append(&b, equip_title(eq)) != 0) goto oom;
        if (sb_append(&b, ")</div>") != 0) goto oom;
    }
    if (sb_append(&b, "</div>\n") != 0) goto oom;

    /* meta */
    if (sb_append(&b, "<div class=\"meta\">GUID <code>") != 0) goto oom;
    if (html_escape_append(&b, sp->guid) != 0) goto oom;
    if (sb_append(&b, "</code>") != 0) goto oom;
    if (sp->work_order[0]) {
        if (sb_append(&b, " · WO ") != 0) goto oom;
        if (html_escape_append(&b, sp->work_order) != 0) goto oom;
    }
    if (sb_appendf(&b,
                   " · %d cable(s) · %d equipment · %d through · %d path(s) · "
                   "%d adjoining</div>\n",
                   sp->n_cables, sp->n_equip, sp->n_through, sp->n_paths,
                   sp->n_adj) != 0)
        goto oom;

    if (sb_append(&b, "<div>") != 0) goto oom;
    for (int i = 0; i < sp->n_equip; i++) {
        const sd_equip *eq = &sp->equip[i];
        if (sb_append(&b, "<span class=\"badge tap\">") != 0) goto oom;
        if (html_escape_append(&b, equip_title(eq)) != 0) goto oom;
        if (eq->is_tap &&
            sb_appendf(&b, " · drop %.2f dB", eq->tap_loss_db) != 0)
            goto oom;
        if (sb_append(&b, "</span>") != 0) goto oom;
        if (eq->tube[0] || eq->strand[0]) {
            if (sb_append(&b, "<span class=\"badge tap\">") != 0) goto oom;
            if (eq->tube[0] && render_tube_dot_name(&b, eq->tube) != 0) goto oom;
            if (html_escape_append(&b, eq->tube[0] ? eq->tube : "?") != 0)
                goto oom;
            if (sb_append(&b, " / ") != 0) goto oom;
            if (eq->strand[0]) {
                const char *hx = color_name_hex(eq->strand);
                if (!hx) hx = "#666";
                if (sb_appendf(&b,
                               "<span class=\"chip\" style=\"background:%s\">"
                               "</span>",
                               hx) != 0)
                    goto oom;
                if (html_escape_append(&b, eq->strand) != 0) goto oom;
            }
            if (eq->feed_fiber > 0 &&
                sb_appendf(&b, " · feed f%d", eq->feed_fiber) != 0)
                goto oom;
            if (sb_append(&b, "</span>") != 0) goto oom;
        }
    }
    if (sb_append(&b, "</div>\n<div id=\"pathSlot\"></div>\n") != 0) goto oom;

    if (render_splicer_view(&b, sp, opt) != 0) goto oom;
    if (render_trace_view(&b, sp, opt) != 0) goto oom;

    /* adjoining */
    if (sb_append(&b, "<h2 class=\"sec\">Adjoining splicepoints</h2>\n"
                      "<div class=\"meta\">Other ends of cables at this SP — "
                      "follow the path along a cable.</div>\n"
                      "<div class=\"adj\">\n") != 0)
        goto oom;
    if (sp->n_adj == 0) {
        if (sb_append(&b, "<div class=\"meta\">No adjoining splicepoints in "
                          "export.</div>\n") != 0)
            goto oom;
    }
    for (int i = 0; i < sp->n_adj; i++) {
        const sd_adj *a = &sp->adj[i];
        char via_sg[16];
        short_guid(a->via_cable, via_sg, sizeof(via_sg));
        const char *st = a->station_id[0] ? a->station_id : via_sg;
        if (sb_appendf(&b,
                       "<a href=\"") != 0)
            goto oom;
        if (html_escape_append(&b, a->href) != 0) goto oom;
        if (sb_appendf(&b,
                       "\" data-guid=\"%s\" data-via=\"%s\"><div class=\"st\">",
                       a->guid, a->via_cable) != 0)
            goto oom;
        if (html_escape_append(&b, a->station_id[0] ? a->station_id : st) != 0)
            goto oom;
        if (sb_appendf(&b,
                       "</div><div class=\"via\">via <code>%s</code> · %dF<br>"
                       "%d cables",
                       via_sg, a->via_size, a->n_cables) != 0)
            goto oom;
        if (a->taps > 0 && sb_appendf(&b, " · %d tap(s)", a->taps) != 0)
            goto oom;
        if (a->work_order[0]) {
            if (sb_append(&b, " · WO ") != 0) goto oom;
            if (html_escape_append(&b, a->work_order) != 0) goto oom;
        }
        if (sb_append(&b, "</div></a>\n") != 0) goto oom;
    }
    if (sb_append(&b, "</div>\n") != 0) goto oom;

    if (sb_append(&b,
                  "<div class=\"legend no-print\">"
                  "<span><span class=\"chip\" style=\"background:#1e5aa8\">"
                  "</span>TIA fiber</span>"
                  "<span><span class=\"tube-dot\" style=\"background:#e67e22\">"
                  "</span>tube band / feed label</span>"
                  "<span style=\"color:var(--fuse)\">⟷ through splice</span>"
                  "<span class=\"badge tap\">TAP</span>"
                  "<span>click fiber → path highlight</span>"
                  "</div>\n"
                  "<div class=\"footer\">Generated by splice_diagram · "
                  "CrescentLink / SDM fiber design export</div>\n"
                  "</main>\n") != 0)
        goto oom;

    /* SD config + paths JSON + JS */
    if (sb_append(&b, "<script>\nconst SD={") != 0) goto oom;
    if (sb_appendf(&b, "\"guid\":\"%s\",\"defaultView\":\"%s\",\"showDark\":%s,",
                   sp->guid, def_view,
                   opt->show_dark_fibers ? "true" : "false") != 0)
        goto oom;
    if (sb_append(&b, "\"cables\":[") != 0) goto oom;
    for (int i = 0; i < sp->n_cables; i++) {
        if (i && sb_append(&b, ",") != 0) goto oom;
        if (sb_appendf(&b, "\"%s\"", sp->cables[i].guid) != 0) goto oom;
    }
    if (sb_append(&b, "],") != 0) goto oom;
    if (emit_paths_json(&b, sp) != 0) goto oom;
    if (sb_append(&b, "};\n") != 0) goto oom;
    if (sb_append(&b, PAGE_JS) != 0) goto oom;
    if (sb_append(&b, "</script>\n</body></html>\n") != 0) goto oom;

    *out_html = b.data;
    if (out_len) *out_len = b.len;
    return 0;

oom:
    sb_free(&b);
    set_err("out of memory building HTML");
    return -1;
}

int sd_render(sd_db *db, const char *splicepoint_guid, const sd_options *opt,
              char **out_html, size_t *out_len) {
    g_err[0] = '\0';
    if (!db || !db->db || !splicepoint_guid || !out_html) {
        set_err("invalid arguments");
        return -1;
    }
    *out_html = NULL;
    if (out_len) *out_len = 0;

    sd_options def;
    if (!opt) {
        sd_options_init(&def);
        opt = &def;
    }

    sd_splice sp;
    if (load_all(db, splicepoint_guid, opt, &sp) != 0) return -1;
    return render_splice_html(&sp, opt, out_html, out_len);
}

int sd_render_station(sd_db *db, const char *station_id, const sd_options *opt,
                      char **out_html, size_t *out_len) {
    g_err[0] = '\0';
    if (!db || !db->db || !station_id || !out_html) {
        set_err("invalid arguments");
        return -1;
    }
    sqlite3_stmt *st = NULL;
    const char *sql =
        "SELECT guid FROM splicepoints WHERE station_id=?1 LIMIT 1";
    if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK) {
        set_errf("%s", sqlite3_errmsg(db->db));
        return -1;
    }
    sqlite3_bind_text(st, 1, station_id, -1, SQLITE_STATIC);
    if (sqlite3_step(st) != SQLITE_ROW) {
        sqlite3_finalize(st);
        set_errf("station not found: %s", station_id);
        return -1;
    }
    const char *guid = (const char *)sqlite3_column_text(st, 0);
    char buf[64];
    snprintf(buf, sizeof(buf), "%s", guid ? guid : "");
    sqlite3_finalize(st);
    return sd_render(db, buf, opt, out_html, out_len);
}

int sd_foreach_splicepoint(sd_db *db, sd_foreach_fn fn, void *userdata) {
    if (!db || !db->db || !fn) {
        set_err("invalid arguments");
        return -1;
    }
    const char *sql =
        "SELECT s.guid, s.station_id, "
        "  (SELECT count(*) FROM ports p WHERE p.splicepoint_guid=s.guid) AS np "
        "FROM splicepoints s "
        "WHERE EXISTS (SELECT 1 FROM ports p WHERE p.splicepoint_guid=s.guid) "
        "   OR EXISTS (SELECT 1 FROM equipment e WHERE e.splicepoint_guid=s.guid) "
        "ORDER BY s.station_id, s.guid";
    sqlite3_stmt *st = NULL;
    if (sqlite3_prepare_v2(db->db, sql, -1, &st, NULL) != SQLITE_OK) {
        set_errf("%s", sqlite3_errmsg(db->db));
        return -1;
    }
    int n = 0;
    while (sqlite3_step(st) == SQLITE_ROW) {
        const char *guid = (const char *)sqlite3_column_text(st, 0);
        const char *station = (const char *)sqlite3_column_text(st, 1);
        int np = sqlite3_column_int(st, 2);
        n++;
        if (fn(guid ? guid : "", station ? station : "", np, userdata) != 0)
            break;
    }
    sqlite3_finalize(st);
    return n;
}
