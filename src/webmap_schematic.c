/**
 * @file webmap_schematic.c
 * @brief Meet-point schematic layout from splice_detail JSON (ADR-020).
 */

#include "webmap_schematic.h"

#include <stdint.h>

#ifdef WEBMAP_WASM_FREESTANDING
void *memcpy(void *dst, const void *src, size_t n);
void *memset(void *dst, int c, size_t n);
double sin(double x);
double cos(double x);
#else
#include <math.h>
#include <string.h>
#endif

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

/* ── Small helpers ─────────────────────────────────────────────────── */

float webmap_schematic_snap_deg45(float deg)
{
    float d = deg;
    while (d < 0.f) {
        d += 360.f;
    }
    while (d >= 360.f) {
        d -= 360.f;
    }
    return (float)((int)((d + 22.5f) / 45.f) % 8) * 45.f;
}

void webmap_schematic_approach_unit(float deg, float *ux, float *uy)
{
    double a = ((double)deg) * M_PI / 180.0;
    if (ux) {
        *ux = (float)sin(a);
    }
    if (uy) {
        *uy = (float)(-cos(a));
    }
}

size_t webmap_schematic_blob_size(uint32_t n_cables, uint32_t n_fibers,
                                  uint32_t n_fuses)
{
    return sizeof(webmap_schematic_header_t) +
           (size_t)n_cables * sizeof(webmap_schematic_cable_t) +
           (size_t)n_fibers * sizeof(webmap_schematic_fiber_t) +
           (size_t)n_fuses * sizeof(webmap_schematic_fuse_t);
}

static int streq_n(const char *a, const char *b, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++) {
        if (a[i] != b[i]) {
            return 0;
        }
    }
    return 1;
}

static float fabsf_local(float x)
{
    return x < 0.f ? -x : x;
}

/** Newton sqrt for freestanding; libm on host. */
static float sqrtf_local(float x)
{
#ifndef WEBMAP_WASM_FREESTANDING
    return (float)sqrt((double)x);
#else
    float y;
    int i;
    if (x <= 0.f) {
        return 0.f;
    }
    y = x;
    if (y > 1.f) {
        y = x * 0.5f + 0.5f;
    }
    for (i = 0; i < 8; i++) {
        y = 0.5f * (y + x / y);
    }
    return y;
#endif
}

static float hypot2f(float x, float y)
{
    return sqrtf_local(x * x + y * y);
}

/* ── Minimal JSON cursor ───────────────────────────────────────────── */

typedef struct {
    const char *p;
    const char *end;
} jcur_t;

static void j_skip_ws(jcur_t *c)
{
    while (c->p < c->end) {
        char ch = *c->p;
        if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
            c->p++;
        } else {
            break;
        }
    }
}

static int j_peek(const jcur_t *c)
{
    jcur_t t = *c;
    j_skip_ws(&t);
    return t.p < t.end ? (unsigned char)*t.p : -1;
}

static int j_eat(jcur_t *c, char ch)
{
    j_skip_ws(c);
    if (c->p < c->end && *c->p == ch) {
        c->p++;
        return 1;
    }
    return 0;
}

static int j_parse_string(jcur_t *c, char *out, size_t out_cap)
{
    size_t n = 0;
    j_skip_ws(c);
    if (c->p >= c->end || *c->p != '"') {
        return 0;
    }
    c->p++;
    while (c->p < c->end && *c->p != '"') {
        char ch = *c->p++;
        if (ch == '\\' && c->p < c->end) {
            ch = *c->p++;
            if (ch == 'n') {
                ch = '\n';
            } else if (ch == 't') {
                ch = '\t';
            } else if (ch == 'r') {
                ch = '\r';
            }
            /* else keep escaped char (\, ", /) */
        }
        if (out && n + 1 < out_cap) {
            out[n++] = ch;
        } else if (out) {
            /* overflow: still consume string */
        }
    }
    if (c->p >= c->end || *c->p != '"') {
        return 0;
    }
    c->p++;
    if (out && out_cap) {
        out[n < out_cap ? n : out_cap - 1] = '\0';
    }
    return 1;
}

static int j_parse_number(jcur_t *c, float *out)
{
    char buf[64];
    size_t n = 0;
    int neg = 0;
    float v = 0.f;
    float frac = 0.f;
    float place = 1.f;
    int in_frac = 0;
    j_skip_ws(c);
    if (c->p < c->end && *c->p == '-') {
        neg = 1;
        c->p++;
    }
    if (c->p >= c->end || !((*c->p >= '0' && *c->p <= '9') || *c->p == '.')) {
        return 0;
    }
    while (c->p < c->end && n + 1 < sizeof(buf)) {
        char ch = *c->p;
        if ((ch >= '0' && ch <= '9') || ch == '.' || ch == 'e' || ch == 'E' ||
            ch == '+' || ch == '-') {
            buf[n++] = ch;
            c->p++;
        } else {
            break;
        }
    }
    buf[n] = '\0';
    /* simple float (no scientific for approach_deg — still accept digits) */
    {
        const char *s = buf;
        if (*s == '-') {
            s++;
        }
        while (*s && *s != '.' && *s != 'e' && *s != 'E') {
            if (*s >= '0' && *s <= '9') {
                v = v * 10.f + (float)(*s - '0');
            }
            s++;
        }
        if (*s == '.') {
            s++;
            in_frac = 1;
            while (*s && *s != 'e' && *s != 'E') {
                if (*s >= '0' && *s <= '9') {
                    place *= 0.1f;
                    frac += (float)(*s - '0') * place;
                }
                s++;
            }
            (void)in_frac;
        }
        v += frac;
        if (neg) {
            v = -v;
        }
    }
    if (out) {
        *out = v;
    }
    return 1;
}

static int j_parse_bool(jcur_t *c, int *out)
{
    j_skip_ws(c);
    if (c->p + 4 <= c->end && streq_n(c->p, "true", 4)) {
        c->p += 4;
        if (out) {
            *out = 1;
        }
        return 1;
    }
    if (c->p + 5 <= c->end && streq_n(c->p, "false", 5)) {
        c->p += 5;
        if (out) {
            *out = 0;
        }
        return 1;
    }
    if (c->p + 4 <= c->end && streq_n(c->p, "null", 4)) {
        c->p += 4;
        if (out) {
            *out = 0;
        }
        return 1;
    }
    return 0;
}

static int j_skip_value(jcur_t *c);

static int j_skip_object(jcur_t *c)
{
    if (!j_eat(c, '{')) {
        return 0;
    }
    j_skip_ws(c);
    if (j_eat(c, '}')) {
        return 1;
    }
    for (;;) {
        char key[64];
        if (!j_parse_string(c, key, sizeof(key))) {
            return 0;
        }
        if (!j_eat(c, ':')) {
            return 0;
        }
        if (!j_skip_value(c)) {
            return 0;
        }
        j_skip_ws(c);
        if (j_eat(c, '}')) {
            return 1;
        }
        if (!j_eat(c, ',')) {
            return 0;
        }
    }
}

static int j_skip_array(jcur_t *c)
{
    if (!j_eat(c, '[')) {
        return 0;
    }
    j_skip_ws(c);
    if (j_eat(c, ']')) {
        return 1;
    }
    for (;;) {
        if (!j_skip_value(c)) {
            return 0;
        }
        j_skip_ws(c);
        if (j_eat(c, ']')) {
            return 1;
        }
        if (!j_eat(c, ',')) {
            return 0;
        }
    }
}

static int j_skip_value(jcur_t *c)
{
    int ch = j_peek(c);
    if (ch == '{') {
        return j_skip_object(c);
    }
    if (ch == '[') {
        return j_skip_array(c);
    }
    if (ch == '"') {
        return j_parse_string(c, NULL, 0);
    }
    if (ch == 't' || ch == 'f' || ch == 'n') {
        return j_parse_bool(c, NULL);
    }
    if (ch == '-' || (ch >= '0' && ch <= '9')) {
        return j_parse_number(c, NULL);
    }
    return 0;
}

/* ── Working arrays ────────────────────────────────────────────────── */

typedef struct {
    char  guid[WEBMAP_SCHEMATIC_GUID_LEN];
    float approach_deg;
    int   has_approach;
    int   is_drop;
    int   size;
} raw_cable_t;

typedef struct {
    char a_cable[WEBMAP_SCHEMATIC_GUID_LEN];
    char b_cable[WEBMAP_SCHEMATIC_GUID_LEN];
    int  a_fiber;
    int  b_fiber;
    int  is_fuse;
} raw_link_t;

typedef struct {
    raw_cable_t cables[WEBMAP_SCHEMATIC_MAX_CABLES];
    uint32_t    n_cables;
    raw_link_t  links[WEBMAP_SCHEMATIC_MAX_FUSES * 2];
    uint32_t    n_links;
    int         is_tap;
} detail_raw_t;

static int guid_eq(const char *a, const char *b)
{
    size_t i;
    for (i = 0; i < WEBMAP_SCHEMATIC_GUID_LEN; i++) {
        if (a[i] != b[i]) {
            return 0;
        }
        if (a[i] == '\0') {
            return 1;
        }
    }
    return 1;
}

static int find_cable(const detail_raw_t *d, const char *guid)
{
    uint32_t i;
    for (i = 0; i < d->n_cables; i++) {
        if (guid_eq(d->cables[i].guid, guid)) {
            return (int)i;
        }
    }
    return -1;
}

static int parse_endpoint_obj(jcur_t *c, char *guid, size_t gcap, int *fiber)
{
    if (!j_eat(c, '{')) {
        return 0;
    }
    j_skip_ws(c);
    if (j_eat(c, '}')) {
        return 1;
    }
    guid[0] = '\0';
    *fiber = 0;
    for (;;) {
        char key[32];
        if (!j_parse_string(c, key, sizeof(key))) {
            return 0;
        }
        if (!j_eat(c, ':')) {
            return 0;
        }
        if (streq_n(key, "cable", 5) && key[5] == '\0') {
            if (!j_parse_string(c, guid, gcap)) {
                return 0;
            }
        } else if (streq_n(key, "fiber", 5) && key[5] == '\0') {
            float f = 0.f;
            if (!j_parse_number(c, &f)) {
                return 0;
            }
            *fiber = (int)f;
        } else {
            if (!j_skip_value(c)) {
                return 0;
            }
        }
        j_skip_ws(c);
        if (j_eat(c, '}')) {
            return 1;
        }
        if (!j_eat(c, ',')) {
            return 0;
        }
    }
}

static int parse_cable_obj(jcur_t *c, raw_cable_t *out)
{
    memset(out, 0, sizeof(*out));
    if (!j_eat(c, '{')) {
        return 0;
    }
    j_skip_ws(c);
    if (j_eat(c, '}')) {
        return 1;
    }
    for (;;) {
        char key[32];
        if (!j_parse_string(c, key, sizeof(key))) {
            return 0;
        }
        if (!j_eat(c, ':')) {
            return 0;
        }
        if (streq_n(key, "guid", 4) && key[4] == '\0') {
            if (!j_parse_string(c, out->guid, sizeof(out->guid))) {
                return 0;
            }
        } else if (streq_n(key, "approach_deg", 12) && key[12] == '\0') {
            float f = 0.f;
            if (!j_parse_number(c, &f)) {
                return 0;
            }
            out->approach_deg = f;
            out->has_approach = 1;
        } else if (streq_n(key, "is_drop", 7) && key[7] == '\0') {
            if (!j_parse_bool(c, &out->is_drop)) {
                return 0;
            }
        } else if (streq_n(key, "size", 4) && key[4] == '\0') {
            float f = 0.f;
            if (!j_parse_number(c, &f)) {
                return 0;
            }
            out->size = (int)f;
        } else {
            if (!j_skip_value(c)) {
                return 0;
            }
        }
        j_skip_ws(c);
        if (j_eat(c, '}')) {
            return 1;
        }
        if (!j_eat(c, ',')) {
            return 0;
        }
    }
}

static int parse_link_obj(jcur_t *c, raw_link_t *out)
{
    memset(out, 0, sizeof(*out));
    if (!j_eat(c, '{')) {
        return 0;
    }
    j_skip_ws(c);
    if (j_eat(c, '}')) {
        return 1;
    }
    for (;;) {
        char key[32];
        if (!j_parse_string(c, key, sizeof(key))) {
            return 0;
        }
        if (!j_eat(c, ':')) {
            return 0;
        }
        if (streq_n(key, "role", 4) && key[4] == '\0') {
            char role[16];
            if (!j_parse_string(c, role, sizeof(role))) {
                return 0;
            }
            if (streq_n(role, "fuse", 4) && role[4] == '\0') {
                out->is_fuse = 1;
            }
        } else if (streq_n(key, "a", 1) && key[1] == '\0') {
            if (j_peek(c) == 'n') {
                j_parse_bool(c, NULL);
            } else if (!parse_endpoint_obj(c, out->a_cable, sizeof(out->a_cable),
                                           &out->a_fiber)) {
                return 0;
            }
        } else if (streq_n(key, "b", 1) && key[1] == '\0') {
            if (j_peek(c) == 'n') {
                j_parse_bool(c, NULL);
            } else if (!parse_endpoint_obj(c, out->b_cable, sizeof(out->b_cable),
                                           &out->b_fiber)) {
                return 0;
            }
        } else {
            if (!j_skip_value(c)) {
                return 0;
            }
        }
        j_skip_ws(c);
        if (j_eat(c, '}')) {
            return 1;
        }
        if (!j_eat(c, ',')) {
            return 0;
        }
    }
}

static int parse_cables_array(jcur_t *c, detail_raw_t *d)
{
    if (!j_eat(c, '[')) {
        return 0;
    }
    j_skip_ws(c);
    if (j_eat(c, ']')) {
        return 1;
    }
    for (;;) {
        raw_cable_t cab;
        if (!parse_cable_obj(c, &cab)) {
            return 0;
        }
        if (cab.guid[0] && d->n_cables < WEBMAP_SCHEMATIC_MAX_CABLES) {
            d->cables[d->n_cables++] = cab;
        }
        j_skip_ws(c);
        if (j_eat(c, ']')) {
            return 1;
        }
        if (!j_eat(c, ',')) {
            return 0;
        }
    }
}

static int parse_links_array(jcur_t *c, detail_raw_t *d)
{
    if (!j_eat(c, '[')) {
        return 0;
    }
    j_skip_ws(c);
    if (j_eat(c, ']')) {
        return 1;
    }
    for (;;) {
        raw_link_t link;
        if (!parse_link_obj(c, &link)) {
            return 0;
        }
        if (d->n_links < (uint32_t)(sizeof(d->links) / sizeof(d->links[0]))) {
            d->links[d->n_links++] = link;
        }
        j_skip_ws(c);
        if (j_eat(c, ']')) {
            return 1;
        }
        if (!j_eat(c, ',')) {
            return 0;
        }
    }
}

static int parse_detail(const uint8_t *json, size_t json_len, detail_raw_t *d)
{
    jcur_t c;
    memset(d, 0, sizeof(*d));
    if (!json || json_len == 0) {
        return 0;
    }
    c.p = (const char *)json;
    c.end = c.p + json_len;
    if (!j_eat(&c, '{')) {
        return 0;
    }
    j_skip_ws(&c);
    if (j_eat(&c, '}')) {
        return 1;
    }
    for (;;) {
        char key[32];
        if (!j_parse_string(&c, key, sizeof(key))) {
            return 0;
        }
        if (!j_eat(&c, ':')) {
            return 0;
        }
        if (streq_n(key, "cables", 6) && key[6] == '\0') {
            if (!parse_cables_array(&c, d)) {
                return 0;
            }
        } else if (streq_n(key, "links", 5) && key[5] == '\0') {
            if (!parse_links_array(&c, d)) {
                return 0;
            }
        } else if (streq_n(key, "kind", 4) && key[4] == '\0') {
            char kind[16];
            if (!j_parse_string(&c, kind, sizeof(kind))) {
                return 0;
            }
            if (streq_n(kind, "tap", 3) && kind[3] == '\0') {
                d->is_tap = 1;
            }
        } else if (streq_n(key, "tap", 3) && key[3] == '\0') {
            if (j_peek(&c) == '{') {
                d->is_tap = 1;
            }
            if (!j_skip_value(&c)) {
                return 0;
            }
        } else {
            if (!j_skip_value(&c)) {
                return 0;
            }
        }
        j_skip_ws(&c);
        if (j_eat(&c, '}')) {
            return 1;
        }
        if (!j_eat(&c, ',')) {
            return 0;
        }
    }
}

/* ── Layout (mirrors demo/display/fiber_schematic.js) ──────────────── */

static void strand_metrics(int fiber_count, float *slot, float *chip_r)
{
    int count = fiber_count;
    if (count < 0) {
        count = 0;
    }
    if (count > (int)WEBMAP_SCHEMATIC_MAX_FIBERS_PER_CABLE) {
        count = (int)WEBMAP_SCHEMATIC_MAX_FIBERS_PER_CABLE;
    }
    if (count <= 24) {
        *slot = 12.f;
        *chip_r = 5.f;
    } else if (count <= 48) {
        *slot = 8.f;
        *chip_r = 4.f;
    } else if (count <= 72) {
        *slot = 6.f;
        *chip_r = 3.4f;
    } else if (count <= 96) {
        *slot = 5.f;
        *chip_r = 3.f;
    } else if (count <= 144) {
        *slot = 3.8f;
        *chip_r = 2.5f;
    } else if (count <= 216) {
        *slot = 3.1f;
        *chip_r = 2.2f;
    } else {
        *slot = 2.55f;
        *chip_r = 1.9f;
    }
}

static void strand_cross_axis(float ux, float uy, float *px, float *py)
{
    float x = -uy;
    float y = ux;
    float len = hypot2f(x, y);
    if (len < 1e-6f) {
        len = 1.f;
    }
    x /= len;
    y /= len;
    if (fabsf_local(y) >= fabsf_local(x) - 1e-6f) {
        if (y < 0.f) {
            x = -x;
            y = -y;
        }
    } else {
        if (x < 0.f) {
            x = -x;
            y = -y;
        }
    }
    *px = x;
    *py = y;
}

static int collect_fibers_for_cable(const detail_raw_t *d, int ci, int *out,
                                    int max_out)
{
    int n = 0;
    uint32_t li;
    int fi, fj;
    for (li = 0; li < d->n_links; li++) {
        const raw_link_t *L = &d->links[li];
        int add = 0;
        int fnum = 0;
        if (L->a_fiber > 0 && guid_eq(L->a_cable, d->cables[ci].guid)) {
            add = 1;
            fnum = L->a_fiber;
        } else if (L->b_fiber > 0 && guid_eq(L->b_cable, d->cables[ci].guid)) {
            add = 1;
            fnum = L->b_fiber;
        }
        if (!add || fnum <= 0) {
            continue;
        }
        for (fi = 0; fi < n; fi++) {
            if (out[fi] == fnum) {
                add = 0;
                break;
            }
        }
        if (!add) {
            continue;
        }
        if (n < max_out) {
            out[n++] = fnum;
        }
    }
    /* sort ascending (insertion) */
    for (fi = 1; fi < n; fi++) {
        int v = out[fi];
        fj = fi - 1;
        while (fj >= 0 && out[fj] > v) {
            out[fj + 1] = out[fj];
            fj--;
        }
        out[fj + 1] = v;
    }
    if (n > (int)WEBMAP_SCHEMATIC_MAX_FIBERS_PER_CABLE) {
        n = (int)WEBMAP_SCHEMATIC_MAX_FIBERS_PER_CABLE;
    }
    return n;
}

size_t webmap_schematic_layout(const uint8_t *json, size_t json_len, float cx,
                               float cy, float radius, uint8_t *out,
                               size_t out_cap)
{
    detail_raw_t detail;
    webmap_schematic_header_t hdr;
    webmap_schematic_cable_t cables[WEBMAP_SCHEMATIC_MAX_CABLES];
    webmap_schematic_fiber_t fibers[WEBMAP_SCHEMATIC_MAX_FIBERS];
    webmap_schematic_fuse_t fuses[WEBMAP_SCHEMATIC_MAX_FUSES];
    uint32_t n_cables = 0;
    uint32_t n_fibers = 0;
    uint32_t n_fuses = 0;
    int used_spoke[8];
    uint32_t i;
    int max_fib = 0;
    float slot = 12.f;
    float chip_r = 5.f;
    float rail_r;
    size_t need;
    uint8_t *w;

    if (!out || out_cap < sizeof(webmap_schematic_header_t)) {
        return 0;
    }
    if (!parse_detail(json, json_len, &detail) || detail.n_cables == 0) {
        return 0;
    }

    if (radius <= 0.f) {
        radius = 100.f;
    }
    rail_r = radius * 0.58f;

    memset(used_spoke, 0, sizeof(used_spoke));
    memset(cables, 0, sizeof(cables));
    n_cables = detail.n_cables;
    if (n_cables > WEBMAP_SCHEMATIC_MAX_CABLES) {
        n_cables = WEBMAP_SCHEMATIC_MAX_CABLES;
    }

    for (i = 0; i < n_cables; i++) {
        raw_cable_t *rc = &detail.cables[i];
        float deg;
        int step;
        float ux, uy;
        if (rc->has_approach) {
            deg = webmap_schematic_snap_deg45(rc->approach_deg);
        } else {
            deg = webmap_schematic_snap_deg45(
                (float)i * 360.f / (float)(n_cables > 0 ? n_cables : 1));
        }
        for (step = 0; step < 8; step++) {
            int spoke = ((int)(deg / 45.f + 0.5f)) % 8;
            if (spoke < 0) {
                spoke += 8;
            }
            if (!used_spoke[spoke]) {
                used_spoke[spoke] = 1;
                deg = (float)spoke * 45.f;
                break;
            }
            deg = webmap_schematic_snap_deg45(deg + 45.f);
        }
        webmap_schematic_approach_unit(deg, &ux, &uy);
        memcpy(cables[i].guid, rc->guid, WEBMAP_SCHEMATIC_GUID_LEN);
        cables[i].approach_deg = deg;
        cables[i].ux = ux;
        cables[i].uy = uy;
        cables[i].x = cx + ux * rail_r;
        cables[i].y = cy + uy * rail_r;
        cables[i].is_drop = rc->is_drop ? 1u : 0u;
        cables[i].size =
            rc->size > 0 ? (uint16_t)rc->size : 0u;
        cables[i].fiber_count = 0;
        cables[i].fiber_start = 0;
    }

    /* Pass 1: max fiber count for shared pitch (recompute lists per cable). */
    for (i = 0; i < n_cables; i++) {
        int tmp[WEBMAP_SCHEMATIC_MAX_FIBERS_PER_CABLE];
        int n = collect_fibers_for_cable(
            &detail, (int)i, tmp, (int)WEBMAP_SCHEMATIC_MAX_FIBERS_PER_CABLE);
        if (n > max_fib) {
            max_fib = n;
        }
    }
    strand_metrics(max_fib, &slot, &chip_r);

    /* Pass 2: emit fiber chips */
    for (i = 0; i < n_cables; i++) {
        int tmp[WEBMAP_SCHEMATIC_MAX_FIBERS_PER_CABLE];
        float cross_x, cross_y;
        float out_x, out_y;
        int n;
        int k;
        n = collect_fibers_for_cable(
            &detail, (int)i, tmp, (int)WEBMAP_SCHEMATIC_MAX_FIBERS_PER_CABLE);
        strand_cross_axis(cables[i].ux, cables[i].uy, &cross_x, &cross_y);
        out_x = cables[i].x + cables[i].ux * 6.f;
        out_y = cables[i].y + cables[i].uy * 6.f;
        cables[i].fiber_start = (uint16_t)n_fibers;
        for (k = 0; k < n; k++) {
            float t;
            webmap_schematic_fiber_t *f;
            if (n_fibers >= WEBMAP_SCHEMATIC_MAX_FIBERS) {
                break;
            }
            t = n <= 1 ? 0.f : (float)k - (float)(n - 1) / 2.f;
            f = &fibers[n_fibers++];
            f->cable_index = (uint16_t)i;
            f->fiber_num = (uint16_t)tmp[k];
            f->x = out_x + cross_x * t * slot;
            f->y = out_y + cross_y * t * slot;
            f->chip_r = chip_r;
        }
        cables[i].fiber_count =
            (uint16_t)(n_fibers - cables[i].fiber_start);
    }

    /* fuse bridges */
    for (i = 0; i < detail.n_links; i++) {
        const raw_link_t *L = &detail.links[i];
        int ai, bi;
        uint32_t fi;
        float ax = 0, ay = 0, bx = 0, by = 0;
        int got_a = 0, got_b = 0;
        webmap_schematic_fuse_t *fu;
        if (!L->is_fuse || L->a_fiber <= 0 || L->b_fiber <= 0) {
            continue;
        }
        ai = find_cable(&detail, L->a_cable);
        bi = find_cable(&detail, L->b_cable);
        if (ai < 0 || bi < 0) {
            continue;
        }
        for (fi = 0; fi < n_fibers; fi++) {
            if (!got_a && fibers[fi].cable_index == (uint16_t)ai &&
                fibers[fi].fiber_num == (uint16_t)L->a_fiber) {
                ax = fibers[fi].x;
                ay = fibers[fi].y;
                got_a = 1;
            }
            if (!got_b && fibers[fi].cable_index == (uint16_t)bi &&
                fibers[fi].fiber_num == (uint16_t)L->b_fiber) {
                bx = fibers[fi].x;
                by = fibers[fi].y;
                got_b = 1;
            }
        }
        if (!got_a || !got_b) {
            continue;
        }
        if (n_fuses >= WEBMAP_SCHEMATIC_MAX_FUSES) {
            break;
        }
        fu = &fuses[n_fuses++];
        fu->a_cable = (uint16_t)ai;
        fu->a_fiber = (uint16_t)L->a_fiber;
        fu->b_cable = (uint16_t)bi;
        fu->b_fiber = (uint16_t)L->b_fiber;
        fu->ax = ax;
        fu->ay = ay;
        fu->bx = bx;
        fu->by = by;
        fu->mx = (ax + bx) * 0.5f;
        fu->my = (ay + by) * 0.5f;
    }

    need = webmap_schematic_blob_size(n_cables, n_fibers, n_fuses);
    if (need > out_cap) {
        return 0;
    }

    memset(&hdr, 0, sizeof(hdr));
    hdr.magic = WEBMAP_SCHEMATIC_MAGIC;
    hdr.version = WEBMAP_SCHEMATIC_VERSION;
    hdr.cx = cx;
    hdr.cy = cy;
    hdr.radius = radius;
    hdr.n_cables = n_cables;
    hdr.n_fibers = n_fibers;
    hdr.n_fuses = n_fuses;
    hdr.flags = detail.is_tap ? 1u : 0u;

    w = out;
    memcpy(w, &hdr, sizeof(hdr));
    w += sizeof(hdr);
    if (n_cables) {
        memcpy(w, cables, (size_t)n_cables * sizeof(cables[0]));
        w += (size_t)n_cables * sizeof(cables[0]);
    }
    if (n_fibers) {
        memcpy(w, fibers, (size_t)n_fibers * sizeof(fibers[0]));
        w += (size_t)n_fibers * sizeof(fibers[0]);
    }
    if (n_fuses) {
        memcpy(w, fuses, (size_t)n_fuses * sizeof(fuses[0]));
        w += (size_t)n_fuses * sizeof(fuses[0]);
    }
    return need;
}
