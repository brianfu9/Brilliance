/* core/server/dashboard.cpp -- the web view of a running engine.
 *
 * `/` serves the page; `/stats`, `/sessions`, `/graph` and `/server_info` are what it shows of one
 * model. The page is a string literal (dashboard_page.h, generated from dashboard/), so there is
 * no asset directory and no network fetch; the engine runs on machines with no route to a CDN.
 * What the page draws every second it reads from /history (history.h), which the process answers
 * from its sampler's last read: an open page costs a running model nothing.
 *
 * /metrics serves Prometheus, but answering "what is this process doing right now" from it needs a
 * scrape config, a time-series database and a Grafana dashboard. This is the terminal view's
 * snapshot (liveview.h, spec §16) in a browser, viewable from another machine.
 */
#include "server.h"
#include "oai.h"
#include "dashboard_page.h"

#include "rad_internal.h"

#include "util/json.h"

#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <sstream>
#include <vector>

namespace rad {
namespace server {

/* ================================================================== /stats */
/* One polled object: the scheduler's metrics, the per-position draft table and whatever the
 * engine's snapshot function provides. Not a stable public API; automation should scrape /metrics.
 *
 * Derived rates are the page's job: they are counter differences over wall time, and only the
 * browser holds both ends of its poll interval. Computing them here would need per-client state. */

/* ------------------------------------------------------------------ generation jobs */
HttpResponse Server::run_job(const HttpRequest& q, HttpResponse (Server::*fn)(const HttpRequest&)) {
    const auto t0 = std::chrono::steady_clock::now();
    HttpMeta meta = copy_http_meta(q);
    std::string kind = "image";
    if (q.path.find("/audio/speech") != std::string::npos) kind = "tts";
    else if (q.path == "/generate") kind = "shape";
    jobs_.running.fetch_add(1, std::memory_order_relaxed);
    HttpResponse r = (this->*fn)(q);
    const bool sse = r.streaming();
    std::shared_ptr<JobOutcome> outcome = r.job_outcome;
    auto finish = [this, t0, meta = std::move(meta), kind = std::move(kind), sse, outcome](bool ok) mutable {
        const double ms = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - t0).count();
        const int64_t ms_i = (int64_t)std::llround(ms);
        jobs_.running.fetch_sub(1, std::memory_order_relaxed);
        const bool job_ok = outcome ? (ok && outcome->code < 400 && outcome->err.empty()) : ok;
        if (!job_ok) {
            jobs_.failed.fetch_add(1, std::memory_order_relaxed);
        } else {
            jobs_.done.fetch_add(1, std::memory_order_relaxed);
            jobs_.total_ms.fetch_add(ms_i, std::memory_order_relaxed);
            jobs_.last_ms.store(ms_i, std::memory_order_relaxed);
        }
        if (outcome && outcome->admitted) {
            int code = outcome->code;
            std::string err = outcome->err;
            if (!ok && err.empty()) {
                code = 200;
                err = "client disconnected";
            }
            if (meta.tag.empty() && !outcome->meta.empty()) meta.tag = outcome->meta;
            emit_job_record(meta, opt_.model_id, kind, outcome->rid, sse, code, err, ms);
        }
    };
    if (!sse) {
        finish(r.status < 400);
        return r;
    }
    std::function<void(bool)> prev = std::move(r.on_close);
    r.on_close = [prev = std::move(prev), finish = std::move(finish)](bool ok) mutable {
        if (prev) prev(ok);
        finish(ok);
    };
    return r;
}

/* ------------------------------------------------------------------ /admin/control-vector
 *
 * The control vector's runtime switch (core/cvec.h). Turning it on for the next
 * request costs a boolean: the direction table was uploaded at startup and the per-request mask
 * is a derived buffer the core fills every step, so there is nothing to rebuild and nothing to
 * reload. The engine's own log records the load; this records the flip, because a deployment's
 * answer to "was that text produced with the vector" should not depend on a browser's memory.
 *
 * GET reports the state (and is what the Model view renders); POST takes {"enabled": true|false}
 * and answers with the same object. A deployment with no vector loaded answers 404 on both: it has
 * no such feature, and its requests refuse `control_vector: true` by name. */
HttpResponse Server::handle_control_vector(const HttpRequest& req) {
    /* Keyless, the vector and its switch belong to the machine: a rebinding page, a page on
     * any origin a localhost proxy fronts, or a plain remote client reads neither the state
     * nor the 404-that-means-no-vector. With --api-key both verbs are behind the key anyway. */
    if (opt_.api_key.empty() && !local_operator(req)) {
        ApiError e;
        e.status  = 403;
        e.type    = "permission_error";
        e.message = "without --api-key, the control vector is read and its default changed only "
                    "from a loopback client naming this machine; start the server with --api-key "
                    "to reach it from elsewhere";
        return error_response(e, req.peer);
    }
    const bool have = deps_.control_vector.available && deps_.control_vector.available();
    if (!have) {
        /* 404, like a model the server does not serve: the route exists, this deployment has nothing
         * behind it, and that is what the page tests for before hiding the panel. */
        ApiError e;
        e.status  = 404;
        e.type    = "not_found_error";
        e.message = "this deployment found no control vector for its model; there is nothing to "
                    "switch";
        return error_response(e, req.peer);
    }

    if (req.method == "POST") {
        bool over = false, deep = false;
        json body = parse_json_bounded(req.body.empty() ? "{}" : req.body, 0, &over, &deep);
        if (body.is_discarded()) return error_response(err_bad("body", "not JSON"), req.peer);
        if (over || deep)
            return error_response(err_bad("body", "expected {\"enabled\": true|false} and "
                                                  "nothing deeper than that"), req.peer);
        const auto it = body.find("enabled");
        if (it == body.end() || !it->is_boolean())
            return error_response(err_bad("enabled", "a boolean is required"), req.peer);
        const bool on = it->get<bool>();
        if (deps_.control_vector.set_default) deps_.control_vector.set_default(on);
        RAD_INFO("control vector: default %s by an admin request%s", on ? "ON" : "OFF",
                 req.peer.empty() ? "" : (" from " + req.peer).c_str());
    }

    metrics_.observe_http(200);
    return HttpResponse::json_body(
        200, deps_.control_vector.json ? deps_.control_vector.json() : std::string("{}"));
}

/* ------------------------------------------------------------------ /sessions
 *
 * A separate route, not a /stats field: /stats is polled every second, while a stored session
 * changes on the scale of its idle thresholds (tens of seconds at the fastest), and the view that
 * reads this is usually off screen. */
HttpResponse Server::handle_sessions(const HttpRequest&) {
    json o;
    std::vector<SessionStat> v;
    SessionOccupancy occ;
    if (deps_.sched) deps_.sched->sessions(&v, &occ);

    int64_t dev = 0, host = 0, bytes = 0;
    int64_t snaps = 0;
    json a = json::array();
    for (const SessionStat& s : v) {
        json e;
        e["id"]        = s.id;
        e["model"]     = s.model;
        if (!s.label.empty()) e["label"] = s.label;
        e["tokens"]    = s.n_tokens;
        e["bytes"]     = s.bytes;
        e["idle_s"]    = s.idle_s;
        e["age_s"]     = s.age_s;
        e["on_device"] = s.on_device;
        e["on_host"]   = s.on_host;
        e["moving"]    = s.moving;
        /* On a hybrid model a session also needs its linear-state snapshots back: a different
         * object size, kept in a separate store in host memory. */
        e["snapshots"]   = s.snapshots;
        e["snap_bytes"]  = s.snap_bytes;
        e["resume_tokens"] = s.resume_tokens;
        a.push_back(std::move(e));
        dev += s.on_device; host += s.on_host;
        snaps += s.snapshots;
        bytes += s.bytes;
    }
    o["sessions"] = std::move(a);
    /* Sessions sharing a prefix share its blocks, so these sums over-count (by more than an order
     * of magnitude with long agent transcripts); the field names say so. */
    o["blocks_sum_overlapping"] = { { "device", dev }, { "host", host } };
    o["snapshots_sum_overlapping"] = snaps;
    o["bytes_sum_overlapping"] = bytes;
    const SchedMetrics sm = deps_.sched ? deps_.sched->metrics() : SchedMetrics{};
    /* What the card actually holds: the pool counts a block once however many sessions name it,
     * which the per-session rows cannot yield. Tokens are the binding group's only; see
     * SchedMetrics::kv_tokens_used for why paged groups are not additive. */
    o["pool"] = { { "tokens_used",     sm.kv_tokens_used },
                  { "tokens_total",    sm.kv_tokens_total },
                  { "unshared_tokens", sm.kv_tokens_cached },
                  { "bytes_used",      sm.kv_bytes_used },
                  { "bytes_total",     sm.kv_bytes_total } };
    const IScheduler::TierCounters c =
        deps_.sched ? deps_.sched->tier_counters() : IScheduler::TierCounters{};
    o["moved"] = { { "to_host", c.to_host }, { "dropped", c.dropped },
                   { "promoted", c.promoted }, { "host_drops", c.host_drops },
                   { "held_back", c.held_back },
                   { "restore_cuts", sm.prefix_restore_cuts },
                   { "failures", c.failures } };
    /* Snapshot store on a hybrid model: bytes per snapshot and slot count. `bytes_each` is 0
     * on a model with no recurrent state. */
    o["snapshot_store"] = { { "bytes_each", c.ck_bytes }, { "slots", c.ck_slots } };
    /* Entries and snapshots removed by --prefix-cache-ttl, from whichever tier held them. */
    o["expired"] = { { "entries", sm.prefix_expired }, { "snapshots", sm.prefix_ckpt_expired } };
    /* And the ones a client gave up on purpose (DELETE /sessions). */
    o["released"] = { { "entries", sm.prefix_released }, { "snapshots", sm.prefix_ckpt_released } };
    /* Step-thread time spent on tier moves; every request waits through it. */
    o["stall"] = { { "restores", c.restores }, { "restore_ms", (double)c.restore_ns / 1e6 },
                   { "flushes", c.flushes }, { "flush_ms", (double)c.flush_ns / 1e6 } };
    /* Whether restored snapshots are served. A hybrid server can move snapshots and still replay
     * from token zero if the restored checkpoint is not one a hit can reach. */
    o["linear"] = { { "hit_rate", sm.linear_hit_rate },
                    { "cached_tokens", sm.linear_cached_tokens },
                    { "checkpoints_written", sm.checkpoints_written },
                    { "evictions", { { "retention", sm.prefix_ckpt_retired },
                                     { "store_full", sm.prefix_ckpt_lru } } },
                    { "refused", sm.prefix_ckpt_refused },
                    { "hit_cuts", { { "no_snapshot", sm.hit_cut_no_snapshot },
                                    { "windowed_group", sm.hit_cut_window },
                                    { "adopt_failed", sm.hit_cut_adopt },
                                    { "resumed_below", sm.hit_cut_resumed_below } } },
                    { "hit_cut_tokens", sm.hit_cut_tokens } };
    /* Whether a tier exists to move sessions to. A session is recorded whether or not it can be
     * demoted, so a non-empty table only says something is held. */
    o["tiers"] = { { "host", c.host_on } };
    /* Off-card bytes, counted once; see SessionOccupancy. */
    o["occupancy"] = { { "host_bytes", occ.host_bytes },
                       { "host_cap_bytes", occ.host_cap_bytes } };
    /* The attention hit rate: the whole answer on a model with no recurrent state. On a hybrid
     * model, read `linear.hit_rate`. */
    o["prefix_hit_rate"] = sm.prefix_hit_rate;
    o["enabled"] = c.host_on;
    return HttpResponse::json_body(200, json_dump(o));
}

/* ------------------------------------------------------------------ DELETE /sessions
 *
 * A client that deletes a conversation, or replaces everything past a prefix of it, knows the
 * rest is dead before the TTL does. Named by the label it sent (`session_id`, or Anthropic's
 * `metadata.user_id`), or by the engine id `/sessions` shows. `keep_tokens` keeps the chain's
 * start. Shared blocks and blocks a live request reads stay; a request of the same conversation
 * in flight is a 409, since its close would publish the chain again. */
HttpResponse Server::handle_session_release(const HttpRequest& req) {
    if (!deps_.sched)
        return error_response(err_not_implemented("the server has no engine attached"), req.peer);

    /* Releasing a session destroys another client's cached conversation: keyless, that is an
     * operator act, not something any page or client that reaches the port may do. */
    if (opt_.api_key.empty() && !local_operator(req))
        return error_response(
            err_forbidden("without --api-key, sessions are released only from a loopback client "
                          "naming this machine; start the server with --api-key to do it from "
                          "elsewhere"),
            req.peer);

    const std::string label = req.param("label");
    uint64_t id = 0;
    const std::string id_s = req.param("id");
    if (!id_s.empty()) {
        if (id_s.find_first_not_of("0123456789") != std::string::npos || id_s.size() > 19)
            return error_response(err_bad("id", "expected the session's engine id, a decimal "
                                                "integer as /sessions reports it"), req.peer);
        id = std::stoull(id_s);
        if (id == 0) return error_response(err_bad("id", "0 names no session"), req.peer);
    }
    if (label.empty() && id == 0)
        return error_response(err_bad("label", "name the session: DELETE /sessions/<label>, "
                                               "?label=<label> or ?id=<engine id>"), req.peer);
    int64_t keep_tokens = 0;
    const std::string keep_s = req.param("keep_tokens");
    if (!keep_s.empty()) {
        if (keep_s.find_first_not_of("0123456789") != std::string::npos || keep_s.size() > 12)
            return error_response(err_bad("keep_tokens", "expected a non-negative integer: the "
                                                         "prefix to keep, in tokens"), req.peer);
        keep_tokens = std::stoll(keep_s);
    }

    SessionReleased r;
    const int rc = deps_.sched->release_session(label, id, keep_tokens, &r);
    if (rc == RAD_E_UNSUPPORTED)
        return error_response(err_not_implemented(
            "this engine has no prefix cache (started with --no-prefix-cache, or the model "
            "declares no cacheable KV group)"), req.peer);
    const std::string who = label.empty() ? "id " + std::to_string(id) : "'" + label + "'";
    if (rc == RAD_E_NOTFOUND) {
        ApiError e;
        e.status = 404;
        e.type = "not_found_error";
        e.param = label.empty() ? "id" : "label";
        e.message = "no stored session " + who + "; GET /sessions lists them";
        return error_response(e, req.peer);
    }
    if (rc == RAD_E_STATE) {
        ApiError e;
        e.status = 409;
        e.type = "conflict_error";
        e.code = "session_in_use";
        e.message = "a request of session " + who + " is queued or running; cancel it or wait "
                    "for it to finish, then release again";
        return error_response(e, req.peer);
    }
    if (rc == RAD_E_INVAL)
        return error_response(err_bad("keep_tokens", rad_strerror(rc)), req.peer);
    if (rc < 0) return error_response(err_internal(rad_strerror(rc)), req.peer);

    json o;
    if (!label.empty()) o["label"] = label;
    if (id != 0) o["id"] = id;
    o["keep_tokens"]  = keep_tokens;
    o["sessions"]     = r.sessions;
    o["entries"]      = r.entries;
    o["tokens"]       = r.tokens;
    o["device_bytes"] = r.device_bytes;
    o["host_bytes"]   = r.host_bytes;
    o["snapshots"]    = r.snapshots;
    o["kept"] = { { "tokens", r.kept_tokens }, { "shared", r.kept_shared },
                  { "live", r.kept_live } };
    metrics_.observe_http(200);
    return HttpResponse::json_body(200, json_dump(o));
}

HttpResponse Server::handle_stats(const HttpRequest&) {
    json o;
    o["model"]     = opt_.model_id;
    o["version"]   = opt_.version;
    /* The control vector (core/cvec.h), when this deployment has one: `available` is what a UI
     * tests before offering the control, `default` what a request that names no choice runs. The
     * dashboard's own control asks /admin/control-vector, which also reports this. */
    if (deps_.control_vector.json) {
        try {
            o["control_vector"] = json::parse(deps_.control_vector.json());
        } catch (const std::exception&) {
            /* A malformed snapshot is not worth failing /stats over; the field is omitted. */
        }
    }
    o["uptime_s"]  = unix_now() - started_at_;
    /* Brilliance: the two-rank host mailboxes (fix C1; win/device/hipnative.cpp): faults since start
     * (each stopped the engine), the resend's counters (stage 2: requests raised, blocks resent,
     * control words re-stored, acks that never came, kept as `ack_timeouts`), and the injections
     * BRILLIANCE_AR_INJECT made; `gather_hc` is ar_gather_hc_write's share of the four resend
     * counters (stage 3), `exact` the plain exact all-reduce's and `gather` the two-rank
     * all-gather's (stage 4), the rest being ar_hc_write's. `wht6` is the rotated wire's
     * (tp-wire wht6): the sum of its three collectives' shares, and each, `all_reduce` (the wht6
     * all-reduce), `hc_write` and `gather_hc_write` (the fused writes' wht6 forms). `wide`: the
     * four-rank host mailboxes' loud stop (W1; libr4d's r4d_ar_mailbox_counters from entry 31):
     * instances, faults (each stopped the engine), late passes (a push that landed after its flag,
     * harmless), the injections that changed bytes, each of the first two by source rank
     * (`by_source`, ranks 0-3: a rank whose link degrades shows there, not in a total) and by
     * collective (`by_op`). From W2/W3 (entries 53-80) the exchange's resend counters too, as the
     * two-rank ones (`resend_requests`, `resends`, `restores`, `ack_timeouts`), the requests by
     * source rank, and each collective's four; from W4 (entries 81-86) the coded two-shot's
     * (`ts4c`). Under injection the check is resends = effective injections. Omitted where the
     * backend keeps none. */
    if (deps_.mailbox_counters) {
        int64_t v[87] = { 0 };
        const int k = deps_.mailbox_counters(v, 87);
        if (k >= 53 && v[31] > 0) {
            json w = { { "instances", v[31] }, { "faults", v[32] }, { "late", v[33] },
                       { "injections_effective", v[34] } };
            w["by_source"] = { { "faults", { v[35], v[36], v[37], v[38] } },
                               { "late", { v[39], v[40], v[41], v[42] } } };
            static const char* const kOps[5] = { "hc4", "ghc4", "exact4", "gather4", "ts4" };
            json bo = json::object();
            for (int i = 0; i < 5; ++i) bo[kOps[i]] = { { "faults", v[43 + i] }, { "late", v[48 + i] } };
            if (k >= 81) {
                w["resend_requests"] = v[53]; w["resends"] = v[54]; w["restores"] = v[55];
                w["ack_timeouts"] = v[56];
                w["by_source"]["resend_requests"] = { v[57], v[58], v[59], v[60] };
                for (int i = 0; i < 5; ++i) {
                    bo[kOps[i]]["resend_requests"] = v[61 + 4 * i];
                    bo[kOps[i]]["resends"] = v[62 + 4 * i];
                    bo[kOps[i]]["restores"] = v[63 + 4 * i];
                    bo[kOps[i]]["ack_timeouts"] = v[64 + 4 * i];
                }
            }
            if (k >= 87)
                bo["ts4c"] = { { "faults", v[85] }, { "late", v[86] }, { "resend_requests", v[81] },
                               { "resends", v[82] }, { "restores", v[83] }, { "ack_timeouts", v[84] } };
            w["by_op"] = bo;
            o["host_mailbox"] = { { "instances", v[0] }, { "faults", v[1] },
                                  { "injections", v[6] }, { "wide", w } };
        }
        if (k >= 6 && v[0] > 0) {
            json wide = o.contains("host_mailbox") ? o["host_mailbox"]["wide"] : json();
            o["host_mailbox"] = { { "instances", v[0] }, { "faults", v[1] },
                                  { "resend_requests", v[2] }, { "resends", v[3] },
                                  { "restores", v[4] }, { "ack_timeouts", v[5] },
                                  { "injections", v[6] } };
            if (!wide.is_null()) o["host_mailbox"]["wide"] = wide;
            auto share = [&](const char* key, int at) {
                o["host_mailbox"][key] = { { "resend_requests", v[at] }, { "resends", v[at + 1] },
                                           { "restores", v[at + 2] }, { "ack_timeouts", v[at + 3] } };
            };
            if (k >= 11) share("gather_hc", 7);
            if (k >= 19) { share("exact", 11); share("gather", 15); }
            if (k >= 31) {
                auto four = [&](int at) {
                    return json{ { "resend_requests", v[at] }, { "resends", v[at + 1] },
                                 { "restores", v[at + 2] }, { "ack_timeouts", v[at + 3] } };
                };
                json w6 = { { "resend_requests", v[19] + v[23] + v[27] },
                            { "resends", v[20] + v[24] + v[28] },
                            { "restores", v[21] + v[25] + v[29] },
                            { "ack_timeouts", v[22] + v[26] + v[30] } };
                w6["all_reduce"] = four(19);
                w6["hc_write"] = four(23);
                w6["gather_hc_write"] = four(27);
                o["host_mailbox"]["wht6"] = w6;
            }
        }
    }
    /* The process's start, unix seconds: with a request id, a key unique across restarts. */
    o["started_at"] = started_at_;
    /* Seconds this process took to come up, the cost of a restart; 0 before the server listens. */
    o["startup_s"] = startup_s_;
    o["in_flight"] = in_flight_.load(std::memory_order_relaxed);
    o["jobs"] = { { "running", jobs_.running.load(std::memory_order_relaxed) },
                  { "done", jobs_.done.load(std::memory_order_relaxed) },
                  { "failed", jobs_.failed.load(std::memory_order_relaxed) },
                  { "total_ms", jobs_.total_ms.load(std::memory_order_relaxed) },
                  { "last_ms", jobs_.last_ms.load(std::memory_order_relaxed) } };
    o["queue_cap"] = queue_depth_;
    o["max_num_seqs"] = opt_.max_seqs;
    o["now_ms"]    = (int64_t)std::time(nullptr) * 1000;

    if (deps_.sched) {
        const SchedMetrics m = deps_.sched->metrics();
        o["running"]         = m.running;
        o["waiting"]         = m.waiting;
        o["preempted"]       = m.preempted;
        o["kv_util"]         = m.kv_util;
        o["kv_tokens_used"]  = m.kv_tokens_used;
        o["kv_tokens_total"] = m.kv_tokens_total;
        /* The part of `used` no running request reads: cached blocks of finished turns. Without
         * the split, a working cache and a pool that never releases look the same. */
        o["kv_tokens_cached"] = m.kv_tokens_cached;
        /* The pool in bytes beside tokens: tokens say how much context fits, bytes how much VRAM
         * is held. Not a unit conversion: tokens are the binding paged group's, bytes are every
         * group's, recurrent included. */
        o["kv_bytes_used"]   = (double)m.kv_bytes_used;
        o["kv_bytes_total"]  = (double)m.kv_bytes_total;
        o["kv_bytes_carved"] = (double)m.kv_bytes_carved;
        o["kv_tokens_max"]   = m.kv_tokens_max;
        o["prefix_hit_rate"] = m.prefix_hit_rate;
        /* Leading indicator beside the lagging hit rate: past ~75% kv utilisation the cache
         * starts dropping prefixes the next turn wants. */
        o["prefix_evictions"] = (double)m.prefix_evictions;
        /* Linear-state caching, separate from the attention hit rate: a hybrid prompt can be
         * fully attention-cached and still re-run every recurrent layer over its prefix, since
         * the two hit at different granularities. Zero on a model with no recurrent state. */
        o["linear_hit_rate"] = m.linear_hit_rate;
        o["linear_cached_tokens"] = (double)m.linear_cached_tokens;
        o["checkpoints_written"] = (double)m.checkpoints_written;
        /* Why snapshots went and why hits reused nothing: on a hybrid model these say why a
         * long prompt was prefilled again. `hit_cut_tokens` is the checkpoint shortfall,
         * prompt tokens the attention cache held and admission computed again. */
        o["ckpt_evictions"]  = { { "retention", m.prefix_ckpt_retired },
                                 { "store_full", m.prefix_ckpt_lru } };
        o["ckpt_refused"]    = m.prefix_ckpt_refused;
        o["released"]        = { { "entries", m.prefix_released },
                                 { "snapshots", m.prefix_ckpt_released } };
        o["hit_cuts"]        = { { "no_snapshot", m.hit_cut_no_snapshot },
                                 { "windowed_group", m.hit_cut_window },
                                 { "adopt_failed", m.hit_cut_adopt },
                                 { "resumed_below", m.hit_cut_resumed_below } };
        o["hit_cut_tokens"]  = (double)m.hit_cut_tokens;
        o["prefill_tps"]     = m.prefill_tps;
        o["decode_tps"]      = m.decode_tps;
        o["draft_accept"]    = m.draft_acceptance;
        o["preemptions"]     = m.preemptions;
        o["total_requests"]  = m.total_requests;
        o["steps"]           = m.steps;
        o["steps_prefill"]   = m.steps_prefill;
        o["steps_mixed"]     = m.steps_mixed;
        o["prefill_chunks_capped"] = m.prefill_chunks_capped;
        o["steps_decode"]    = m.steps_decode;
        o["steps_held"]      = m.steps_held;
        o["mixed_step_target_steps"] = m.mixed_step_target_steps;
        o["mixed_step_target_misses"] = m.mixed_step_target_misses;
        o["mixed_step_target_prefill_cap"] = m.mixed_step_target_prefill_cap;
        /* Time inside steps. The one rate the page cannot derive: wall clock between polls also
         * covers idle time (see SchedMetrics::step_ns). */
        o["step_ns"]         = m.step_ns;
        o["step_ns_decode"]  = m.step_ns_decode;
        o["step_ns_decode_best"] = m.step_ns_decode_best;
        o["step_ns_decode_recent"] = m.step_ns_decode_recent;
        o["rows_unspec"]     = m.decode_rows_unspeculated;

        /* Conditional rate per position with its reach count: a rate of 0.0 over a reach of 3 is
         * noise, over a reach of 40000 a broken draft round. */
        json pos = json::array();
        for (int j = 0; j < m.draft_depth_seen && j < SchedMetrics::MAX_DRAFT_POS; ++j) {
            json p;
            p["reached"]  = m.draft_pos_reached[j];
            p["accepted"] = m.draft_pos_accepted[j];
            p["rate"] = m.draft_pos_reached[j] > 0
                      ? (double)m.draft_pos_accepted[j] / (double)m.draft_pos_reached[j] : 0.0;
            pos.push_back(std::move(p));
        }
        o["draft_positions"] = std::move(pos);

        /* Live request table: counters and timestamps. `decode_tps` is the request's own average
         * since its first token. */
        std::vector<RequestStat> rq;
        deps_.sched->requests(&rq);
        json reqs = json::array();
        for (const RequestStat& q : rq) {
            json j;
            j["id"]        = q.id;
            j["state"]     = q.state;
            j["prompt"]    = q.prompt_tokens;
            j["computed"]  = q.computed_tokens;
            j["cached"]    = q.cached_tokens;
            j["output"]    = q.output_tokens;
            j["max"]       = q.max_tokens;
            j["ctx"]       = q.ctx_tokens;
            j["kv_tokens"] = q.kv_tokens;
            j["kv_blocks"] = q.kv_blocks;
            j["draft"]     = q.n_draft;
            j["slot"]      = q.slot;
            j["age_s"]     = q.age_s;
            if (q.ttft_s >= 0) j["ttft_s"] = q.ttft_s;
            if (q.prefill_s >= 0) j["prefill_s"] = q.prefill_s;
            j["tps"]       = q.decode_tps;
            if (!q.tag.empty()) j["tag"] = q.tag;
            j["priority"]  = q.priority;
            if (q.queue_pos >= 0) { j["queue_pos"] = q.queue_pos; j["wait"] = q.wait; }
            if (q.held_s >= 0) j["held_s"] = q.held_s;
            if (q.admit_tokens > 0) j["admit_tokens"] = q.admit_tokens;
            reqs.push_back(std::move(j));
        }
        o["requests"] = std::move(reqs);
        /* What admission decides with, so a client can redraw it: the reserve each request
         * carries, how long a held one lets others pass, and whether the claimant policy is on. */
        o["queue"] = { { "kv_reserve",  m.admit_kv_reserve },
                       { "backfill_ms", m.admit_backfill_ms },
                       { "claimant",    m.admit_claimant },
                       { "claimant_min_pct", m.admit_claimant_min_pct } };
    }

    /* The engine's snapshot. Absent without a snapshot function, and the page then omits those
     * panels rather than drawing zeroes (an empty VRAM bar would read as "no memory used"). */
    if (deps_.live) {
        LiveSnapshot s;
        deps_.live(s);

        json cards = json::array();
        for (const CardStat& c : s.cards) {
            json k;
            k["index"]      = c.index;
            k["name"]       = c.name;
            k["vram_used"]  = c.vram_used;
            k["vram_total"] = c.vram_total;
            /* 0 means "not sampled" for these three; the page shows nothing rather than a zero. */
            if (c.util > 0)    k["util"]    = c.util;
            if (c.power_w > 0) k["power_w"] = c.power_w;
            if (c.temp_c > 0)  k["temp_c"]  = c.temp_c;
            cards.push_back(std::move(k));
        }
        o["cards"] = std::move(cards);

        /* Expert panel data (see ExpertPlane in liveview.h). Tallied once in the engine, not here
         * or in the page, so all views agree. */
        if (s.experts.n_layers > 0 && s.experts.n_experts > 0) {
            json e;
            e["n_layers"]   = s.experts.n_layers;
            e["n_experts"]  = s.experts.n_experts;
            e["tier"]       = s.experts.tier;
            e["n_units"]    = s.experts.n_units;
            e["bytes"]      = s.experts.total_bytes;
            e["movable"]    = s.experts.movable;
            e["heat"]       = s.experts.heat_enabled;
            /* One named row per tier, so the page holds no copy of the enum's order. */
            json tiers = json::array();
            for (int t = 0; t < kTierCount; ++t) {
                json r;
                r["name"]  = tier_name((Tier)t);
                r["units"] = s.experts.units[t];
                r["bytes"] = s.experts.bytes[t];
                tiers.push_back(std::move(r));
            }
            e["tiers"] = std::move(tiers);
            e["layer_units"]    = s.experts.layer_units;
            e["layer_resident"] = s.experts.layer_resident;
            e["promotions"] = s.experts.promotions;
            e["demotions"]  = s.experts.demotions;
            e["distinct_promoted"] = s.experts.distinct_promoted;
            e["readmits"]    = s.experts.readmits;
            e["routed"]      = s.experts.routed;
            e["routed_res"]  = s.experts.routed_resident;
            e["dispatches"]  = s.experts.dispatches;
            e["refused"]     = s.experts.refused;
            e["no_candidate"] = s.experts.no_candidate;
            e["no_record"]   = s.experts.no_record;
            e["starved_slab"] = s.experts.starved_slab;
            e["flex_bytes"]    = (double)s.experts.flex_bytes;
            e["flex_capacity"] = (double)s.experts.flex_capacity;
            e["starved_pool"] = s.experts.starved_pool;
            e["quarantined"] = s.experts.quarantined;
            e["stage_layers"]   = s.experts.stage_layers;
            e["staged_units"]   = s.experts.staged_units;
            e["staged_bytes"]   = (double)s.experts.staged_bytes;
            e["stage_overflow"] = s.experts.stage_overflow;
            e["stage_copies"]   = s.experts.stage_copies;
            o["experts"] = std::move(e);
        }

        /* Link traffic: cumulative byte counters only; the page derives rates. */
        if (s.link.present) {
            json l;
            l["world"]          = s.link.world;
            l["ar_calls"]       = s.link.ar_calls;
            l["ar_bytes"]       = s.link.ar_bytes;
            l["h2d_bytes"]      = s.link.h2d_bytes;
            l["d2h_bytes"]      = s.link.d2h_bytes;
            l["ssd_reads"]      = s.link.ssd_reads;
            l["ssd_bytes"]      = s.link.ssd_bytes;
            l["ram_weights"]    = s.link.ram_weights;
            l["ram_bytes"]      = s.link.ram_bytes;
            l["relaid_weights"] = s.link.relaid_weights;
            l["ssd_staging_bytes"] = s.link.ssd_staging_bytes;
            l["ssd_promoted_bytes"] = s.link.ssd_promoted_bytes;
            l["ssd_deposits"]      = s.link.ssd_deposits;
            l["ssd_deposit_bytes"] = s.link.ssd_deposit_bytes;
            l["pool_evictions"]     = s.link.pool_evictions;
            l["prefetched"]     = s.link.prefetched;
            l["prefetch_bytes"] = s.link.prefetch_bytes;
            l["staged_bytes"]   = s.link.staged_bytes;
            l["stream_bytes"]   = s.link.stream_bytes;
            l["kv_stream_bytes"]  = s.link.kv_stream_bytes;
            l["kv_streaming"]   = s.link.kv_streaming;
            l["kv_stream_active"] = s.link.kv_stream_active;
            o["link"] = std::move(l);
        }
        if (s.passes.present) {
            json p;
            p["played"]         = s.passes.played;
            p["recorded"]       = s.passes.recorded;
            p["audited"]        = s.passes.audited;
            p["issued_unkeyed"] = s.passes.issued_unkeyed;
            p["issued_refused"] = s.passes.issued_refused;
            p["issued_first"]   = s.passes.issued_first;
            p["dispatched"]     = s.passes.dispatched;
            p["unordered"]      = s.passes.unordered;
            o["passes"] = std::move(p);
        }
    }

    /* Not counted in metrics_.observe_http, as for /health: a page polling twice a second would
     * make the request counters describe the dashboard. */
    return HttpResponse::json_body(200, json_dump(o));
}


/* ================================================================== /graph */
/* The declared compute graph: every op, its bucket table, the kernel that resolved each band, its
 * library, the constraints it matched and the chain it stands in for. The same walk as
 * `--debug-graph` (dump_graph_json shares its helpers), served from the running process. Static
 * after declare, so it is rendered once. */
HttpResponse Server::handle_graph(const HttpRequest& req) {
    if (!opt_.graph_json)
        return error_response(err_not_implemented(
            "the server was not given a declared graph; this build has no engine attached"),
                req.peer);
    HttpResponse r;
    r.status = 200;
    r.body = opt_.graph_json();
    return r;
}

/* ================================================================== the page */
HttpResponse Server::handle_dashboard(const HttpRequest&) { return dashboard_page(); }

HttpResponse dashboard_page() {
    HttpResponse r;
    r.status = 200;
    r.content_type = "text/html; charset=utf-8";
    r.body = kPage;
    /* (local) RADIANCE_DASHBOARD_PAGE names a built page (dashboard/'s dist/index.html) served in
     * place of the compiled-in one, read again on every load: a page change is a file copy, not an
     * engine build. A missing or empty file serves the built-in page, so removing it rolls back.
     * The page is the operator's own file; the same CSP below still binds it. */
    if (const char* p = std::getenv("RADIANCE_DASHBOARD_PAGE"); p && *p) {
        std::ifstream in(p, std::ios::binary);
        std::ostringstream s;
        if (in && (s << in.rdbuf()) && s.tellp() > 0) {
            r.body = s.str();
            r.set_header("X-Radiance-Page", "file");
        }
    }
    /* Brilliance: a link to the terms of use (GET /terms, terms.cpp) in the page's corner, added
     * here rather than in dashboard/'s sources, so the generated page stays upstream's. */
    if (const size_t at = r.body.rfind("</body>"); at != std::string::npos)
        r.body.insert(at, "<a href=\"/terms\" style=\"position:fixed;right:10px;bottom:6px;"
                          "z-index:30;font:12px/1.5 system-ui,sans-serif;color:#8a8f98\">"
                          "Terms of use</a>");
    /* No caching: the page must match the binary's /stats shape, and a stale copy shows only
     * blank panels. */
    r.set_header("Cache-Control", "no-store");
    /* The page is fixed markup that talks only to its own origin, and CSP is how that promise
     * becomes enforceable: even a future markup bug could not phone an injected payload's
     * findings home, and could not reach the key beyond this origin. script/style 'unsafe-inline'
     * is the cost of shipping as one compiled-in literal with its own <style> and <script>;
     * frame-ancestors keeps a hostile page from framing the Model view and clickjacking its
     * guardrail toggle. */
    r.set_header("Content-Security-Policy",
                 "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
                 "connect-src 'self'; img-src 'self' data:; font-src data:; frame-ancestors 'none'; "
                 "base-uri 'none'; form-action 'none'");
    r.set_header("X-Frame-Options", "DENY");
    return r;
}

}  /* namespace server */
}  /* namespace rad */
