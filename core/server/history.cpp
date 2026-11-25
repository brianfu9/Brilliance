/* core/server/history.cpp -- see history.h. */
#include "server/history.h"

#include <chrono>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <limits>
#if defined(_WIN32)
#include <io.h>
#include "os/os.h"   /* Brilliance: os::rename_replace, os::open_shared_fd (FILE_SHARE_DELETE) */
#endif

#include "rad_internal.h"

namespace rad {
namespace server {

namespace {

const double kNone = std::numeric_limits<double>::quiet_NaN();

/* A member's number, or NaN where the object has none. */
double num(const json& o, const char* k) {
    if (!o.is_object() || !o.contains(k)) return kNone;
    const json& v = o[k];
    return v.is_number() ? v.get<double>() : kNone;
}
double num0(const json& o, const char* k) {
    const double v = num(o, k);
    return std::isfinite(v) ? v : 0.0;
}
const json* member(const json& o, const char* k) {
    return o.is_object() && o.contains(k) ? &o[k] : nullptr;
}
std::string text(const json& o, const char* k) {
    if (!o.is_object() || !o.contains(k)) return std::string();
    const json& v = o[k];
    return v.is_string() ? v.get<std::string>() : v.dump();
}

/* Four significant digits: what a chart resolves, and a third of the bytes on the wire. */
double round4(double v) {
    char b[32];
    std::snprintf(b, sizeof b, "%.4g", v);
    return std::strtod(b, nullptr);
}

void put(History::Row& r, const char* k, double v) {
    if (std::isfinite(v)) r.emplace_back(k, v);
}

/* A model's state as a level a chart can draw; an unknown state is 0. */
double state_code(const std::string& s) {
    if (s == "resident") return 3;
    if (s == "loading" || s == "closing") return 2;
    if (s == "parked") return 1;
    if (s == "failed") return 4;
    if (s == "waiting") return 5;
    return 0;
}

}  // namespace

/* ------------------------------------------------------------------ rows */

History::Row History::model_row(const json& s, const json* prev, double dt) {
    Row row;
    put(row, "decode", num(s, "decode_tps"));
    put(row, "prefill", num(s, "prefill_tps"));
    put(row, "running", num(s, "running"));
    put(row, "waiting", num(s, "waiting"));
    put(row, "preempted", num(s, "preempted"));
    put(row, "flight", num(s, "in_flight"));
    put(row, "hit", num(s, "prefix_hit_rate"));
    put(row, "kvUsed", num(s, "kv_bytes_used"));
    put(row, "kvCap", num(s, "kv_bytes_total"));
    /* The pool's bytes split by tokens: what finished turns keep for reuse and what running
     * requests read. */
    {
        const double held = num0(s, "kv_bytes_used"), used = num0(s, "kv_tokens_used");
        const double kept = std::min(num0(s, "kv_tokens_cached"), used);
        const double kept_b = used > 0 ? held * kept / used : 0.0;
        put(row, "kvKept", kept_b);
        put(row, "kvRead", std::max(0.0, held - kept_b));
    }
    if (const double best = num(s, "step_ns_decode_best"); best > 0) put(row, "stepBest", best / 1e6);
    const json* jobs = member(s, "jobs");
    if (jobs) {
        put(row, "jobRun", num(*jobs, "running"));
        put(row, "jobDone", num(*jobs, "done"));
    }
    /* A prompt's fresh tokens over its own prefill time, for the requests whose prefill ended
     * since the last sample: the scheduler's rate divides by everything the step loop did, so
     * one short prompt among long decodes would read as a few tokens a second. */
    if (const json* rq = member(s, "requests"); rq && rq->is_array()) {
        std::set<std::string> seen;
        if (prev)
            if (const json* pq = member(*prev, "requests"); pq && pq->is_array())
                for (const json& r : *pq)
                    if (num(r, "prefill_s") > 0) seen.insert(text(r, "id"));
        double sum = 0;
        int n = 0;
        for (const json& r : *rq) {
            const double pf = num(r, "prefill_s"), fresh = num0(r, "prompt") - num0(r, "cached");
            if (pf > 0 && fresh > 0 && !seen.count(text(r, "id"))) {
                sum += fresh / pf;
                ++n;
            }
        }
        if (n) put(row, "prefillRate", sum / n);
    }
    if (!prev || !(dt > 0)) return row;
    const json& p = *prev;

    if (jobs)
        if (const json* pj = member(p, "jobs"); pj && num0(*jobs, "done") > num0(*pj, "done"))
            put(row, "jobTime", num(*jobs, "last_ms") / 1000.0);
    put(row, "reqRate", std::max(0.0, (num0(s, "total_requests") - num0(p, "total_requests")) / dt));
    if (const double steps = num0(s, "steps") - num0(p, "steps"); steps > 0)
        put(row, "stepAny", (num0(s, "step_ns") - num0(p, "step_ns")) / steps / 1e6);
    const double ds = num0(s, "steps_decode") - num0(p, "steps_decode");
    if (ds > 0) put(row, "step", (num0(s, "step_ns_decode") - num0(p, "step_ns_decode")) / ds / 1e6);
    /* Acceptance is accepted over reached, summed over the draft positions that were verified. */
    {
        const json* dp = member(s, "draft_positions");
        const json* pp = member(p, "draft_positions");
        if (dp && pp && dp->is_array() && pp->is_array() && dp->size() == pp->size()) {
            double reached = 0, accepted = 0;
            for (size_t i = 0; i < dp->size(); ++i) {
                const double dr = num0((*dp)[i], "reached") - num0((*pp)[i], "reached");
                const double da = num0((*dp)[i], "accepted") - num0((*pp)[i], "accepted");
                if (dr > 0) {
                    reached += dr;
                    accepted += da;
                }
            }
            if (reached > 0) put(row, "accept", accepted / reached);
            if (reached > 0 && ds > 0) put(row, "tokStep", 1.0 + accepted / ds);
        }
    }
    {
        const json* lk = member(s, "link");
        const json* lp = member(p, "link");
        if (lk && lp) {
            auto d = [&](const char* f) { return std::max(0.0, (num0(*lk, f) - num0(*lp, f)) / dt); };
            put(row, "lkAr", d("ar_bytes"));
            put(row, "lkUp", d("h2d_bytes"));
            put(row, "lkDn", d("d2h_bytes"));
            put(row, "lkSsd", d("ssd_bytes"));
            put(row, "lkStream", d("stream_bytes") + d("kv_stream_bytes"));
        }
    }
    {
        const json* ex = member(s, "experts");
        const json* xp = member(p, "experts");
        if (ex && xp) {
            if (const double routed = num0(*ex, "routed") - num0(*xp, "routed"); routed > 0)
                put(row, "expHit", (num0(*ex, "routed_res") - num0(*xp, "routed_res")) / routed);
            put(row, "expIn", std::max(0.0, (num0(*ex, "promotions") - num0(*xp, "promotions")) / dt));
            put(row, "expOut", std::max(0.0, (num0(*ex, "demotions") - num0(*xp, "demotions")) / dt));
        }
    }
    return row;
}

History::Row History::fleet_row(const json& f) {
    Row row;
    const json* models = member(f, "models");
    const json* cards = member(f, "cards");
    if (models && models->is_array())
        for (const json& m : *models) row.emplace_back("s:" + text(m, "id"), state_code(text(m, "state")));
    if (!cards || !cards->is_array()) return row;
    for (const json& c : *cards) {
        const std::string card = text(c, "card");
        auto name = [&](const char* k) { return std::string(k) + card; };
        if (const double v = num(c, "busy"); std::isfinite(v)) row.emplace_back(name("busy"), v);
        if (const double v = num(c, "power_w"); std::isfinite(v)) row.emplace_back(name("power"), v);
        if (const double v = num(c, "temp_c"); std::isfinite(v)) row.emplace_back(name("temp"), v);
        if (const double v = num(c, "free_bytes"); std::isfinite(v)) row.emplace_back(name("free"), v);
        if (!models || !models->is_array()) continue;
        /* A model's bytes on this card, 0 where it holds none: the stacked memory chart draws a
         * model that left as an empty band, not as a gap. */
        const double ci = num(c, "card");
        for (const json& m : *models) {
            double bytes = 0;
            /* What the model holds on this card now (a loading or partly parked one too), else
             * its claim on each of its cards. */
            const json* by = member(m, "vram_bytes_by_card");
            if (by && by->is_object()) {
                if (const auto it = by->find(card); it != by->end() && it->is_number()) bytes = it->get<double>();
            } else if (const json* on = member(m, "cards"); on && on->is_array()) {
                for (const json& x : *on)
                    if (x.is_number() && x.get<double>() == ci) bytes = num0(m, "vram_bytes_per_card");
            }
            row.emplace_back("c" + card + ":" + text(m, "id"), bytes);
        }
    }
    return row;
}

/* ------------------------------------------------------------------ the ring */

void History::Series::push(double at, const Row& row) {
    if (t.empty()) t.assign((size_t)kRows, 0.0);
    const size_t i = head;
    /* Kept as it is written out, to the millisecond: a page asks for what came after the last
     * time it was given, and a time kept finer than it was sent would be later than itself. */
    t[i] = std::round(at * 1000.0) / 1000.0;
    for (auto& [k, col] : c) col[i] = std::numeric_limits<float>::quiet_NaN();
    for (const auto& [k, v] : row) {
        auto it = c.find(k);
        if (it == c.end())
            it = c.emplace(k, std::vector<float>((size_t)kRows, std::numeric_limits<float>::quiet_NaN())).first;
        it->second[i] = (float)v;
    }
    head = (head + 1) % (size_t)kRows;
    if (n < (size_t)kRows) ++n;
}

void History::Series::write(json& out, double since) const {
    json times = json::array();
    json cols = json::object();
    std::vector<size_t> at;
    const size_t first = (head + (size_t)kRows - n) % (size_t)kRows;
    /* The ring holds the hour at its fastest rate, so at one row a second it holds more than the
     * hour: only what is within kKeepS of the latest row is given. */
    const double oldest = n ? t[(head + (size_t)kRows - 1) % (size_t)kRows] - (double)kKeepS : 0.0;
    for (size_t k = 0; k < n; ++k) {
        const size_t i = (first + k) % (size_t)kRows;
        if (t[i] > since && t[i] > oldest) at.push_back(i);
    }
    for (size_t i : at) times.push_back(t[i]);
    for (const auto& [name, col] : c) {
        bool any = false;
        for (size_t i : at) any = any || std::isfinite(col[i]);
        if (!any) continue;
        json a = json::array();
        for (size_t i : at) {
            if (std::isfinite(col[i])) a.push_back(round4((double)col[i]));
            else a.push_back(nullptr);
        }
        cols[name] = std::move(a);
    }
    out["keep_s"] = kKeepS;
    out["t"] = std::move(times);
    out["c"] = std::move(cols);
}

/* ------------------------------------------------------------------ samples */

void History::model_sample(const std::string& id, const json& stats, double t, std::string body) {
    std::lock_guard<std::mutex> lk(mu_);
    Model& m = models_[id];
    m.latest = std::move(body);
    /* Counters start over with the model: a sample of another start is no predecessor. */
    const bool same = m.prev.is_object() && num(m.prev, "started_at") == num(stats, "started_at");
    m.series.push(t, model_row(stats, same ? &m.prev : nullptr, t - m.prev_t));
    m.prev = stats;
    m.prev_t = t;
}

void History::fleet_sample(const json& fleet, double t, std::string body) {
    std::lock_guard<std::mutex> lk(mu_);
    fleet_.push(t, fleet_row(fleet));
    fleet_live_ = std::move(body);
}

namespace {
int64_t steady_ns() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch()).count();
}
}  // namespace

bool History::watched(double seconds) const {
    const int64_t at = asked_ns_.load(std::memory_order_relaxed);
    return at != 0 && (double)(steady_ns() - at) * 1e-9 < seconds;
}

void History::model_closed(const std::string& id) {
    std::lock_guard<std::mutex> lk(mu_);
    if (auto it = models_.find(id); it != models_.end()) it->second.latest.clear();
}

void History::forget(const std::string& id) {
    std::lock_guard<std::mutex> lk(mu_);
    models_.erase(id);
}

namespace {

int64_t i64(const json& o, const char* k, int64_t def = 0) {
    if (!o.is_object() || !o.contains(k)) return def;
    const json& v = o[k];
    if (v.is_number_integer()) return v.get<int64_t>();
    if (v.is_number()) {
        const double d = v.get<double>();
        return std::isfinite(d) ? (int64_t)std::llround(d) : def;
    }
    return def;
}

void backfill_record(json& o, const std::string& canonical_model) {
    if (!o.is_object()) return;
    if (!o.contains("fm") || !o["fm"].is_string() || o["fm"].get<std::string>().empty())
        o["fm"] = canonical_model;
    if (!o.contains("kind") || !o["kind"].is_string() || o["kind"].get<std::string>().empty()) {
        const std::string rid = text(o, "rid");
        const std::string path = text(o, "path");
        if (rid.rfind("tr-", 0) == 0 || path.find("/audio/transcriptions") != std::string::npos ||
            path.find("/realtime") != std::string::npos)
            o["kind"] = "asr";
        else if (path.find("/images/") != std::string::npos)
            o["kind"] = "image";
        else if (path.find("/videos") != std::string::npos)
            o["kind"] = "video";
        else if (path.find("/audio/speech") != std::string::npos)
            o["kind"] = "tts";
        else if (path == "/generate" || path == "/send")
            o["kind"] = "shape";
        else
            o["kind"] = "chat";
    }
}

bool record_order_less(const json& a, const json& b) {
    const int64_t ta = i64(a, "t1"), tb = i64(b, "t1");
    if (ta != tb) return ta < tb;
    return i64(a, "n") < i64(b, "n");
}

/* Read-only file handle opened with FILE_SHARE_DELETE on Windows so trim_locked()'s
 * rename_replace succeeds while concurrent readers scan the file. */
class SharedReader {
public:
    explicit SharedReader(const std::string& path) {
#if defined(_WIN32)
        const int fd = rad::os::open_shared_fd(path, /*write=*/false, /*create=*/false);
        if (fd >= 0) {
            fp_ = _fdopen(fd, "rb");
            if (!fp_) _close(fd);
        }
#else
        fp_ = std::fopen(path.c_str(), "rb");
#endif
    }
    ~SharedReader() {
        if (fp_) std::fclose(fp_);
    }
    SharedReader(const SharedReader&) = delete;
    SharedReader& operator=(const SharedReader&) = delete;

    bool ok() const { return fp_ != nullptr; }

    int seek(int64_t off, int whence) const {
#if defined(_WIN32)
        return _fseeki64(fp_, off, whence);
#else
        return fseeko(fp_, (off_t)off, whence);
#endif
    }
    int64_t tell() const {
#if defined(_WIN32)
        return _ftelli64(fp_);
#else
        return (int64_t)ftello(fp_);
#endif
    }
    int64_t size() const {
        if (!fp_ || seek(0, SEEK_END) != 0) return -1;
        return tell();
    }
    size_t read(void* buf, size_t n) const {
        return fp_ ? std::fread(buf, 1, n, fp_) : 0;
    }

private:
    FILE* fp_ = nullptr;
};

/* Fast raw '\n' line count (no JSON parsing). Drops any torn trailing fragment lacking '\n'. */
size_t count_lines(SharedReader& r) {
    if (!r.ok() || r.seek(0, SEEK_SET) != 0) return 0;
    char buf[65536];
    size_t lines = 0;
    bool has_content = false;
    while (const size_t n = r.read(buf, sizeof buf)) {
        for (size_t i = 0; i < n; ++i) {
            const char c = buf[i];
            if (c == '\n') {
                if (has_content) {
                    ++lines;
                    has_content = false;
                }
            } else if (c != '\r') {
                has_content = true;
            }
        }
    }
    return lines;
}

/* Forward scan emitting every non-empty '\n'-terminated line. Drops a torn trailing line without
 * '\n'. Stops early when `on_line` returns false. */
template <class Fn>
void scan_forward(SharedReader& r, Fn&& on_line) {
    if (!r.ok() || r.seek(0, SEEK_SET) != 0) return;
    char buf[65536];
    std::string cur;
    while (const size_t n = r.read(buf, sizeof buf)) {
        size_t start = 0;
        for (size_t i = 0; i < n; ++i) {
            if (buf[i] != '\n') continue;
            cur.append(buf + start, i - start);
            if (!cur.empty() && cur.back() == '\r') cur.pop_back();
            if (!cur.empty()) {
                std::string line = std::move(cur);
                cur.clear();
                if (!on_line(std::move(line))) return;
            } else {
                cur.clear();
            }
            start = i + 1;
        }
        if (start < n) cur.append(buf + start, n - start);
    }
}

/* Backward scan from EOF on '\n' (UTF-8 safe: 0x0A never appears inside a multibyte sequence).
 * Drops any torn trailing bytes lacking '\n'. Emits lines newest-first and stops early when
 * `on_line` returns false. */
template <class Fn>
void scan_backward(SharedReader& r, Fn&& on_line) {
    if (!r.ok()) return;
    int64_t pos = r.size();
    if (pos <= 0) return;
    constexpr int64_t kChunk = 65536;
    char buf[kChunk];
    std::string tail;
    bool saw_newline = false;
    while (pos > 0) {
        const int64_t take = std::min<int64_t>(pos, kChunk);
        pos -= take;
        if (r.seek(pos, SEEK_SET) != 0) return;
        const size_t got = r.read(buf, (size_t)take);
        if (got == 0) return;
        size_t seg_end = got;
        for (size_t i = got; i-- > 0;) {
            if (buf[i] != '\n') continue;
            if (!saw_newline) {
                /* Everything after the last '\n' is a torn trailing line (or empty): discard. */
                saw_newline = true;
                tail.clear();
                seg_end = i;
                continue;
            }
            std::string line;
            line.reserve((seg_end - (i + 1)) + tail.size());
            line.append(buf + i + 1, seg_end - (i + 1));
            line.append(tail);
            tail.clear();
            seg_end = i;
            if (!line.empty() && line.back() == '\r') line.pop_back();
            if (!line.empty() && !on_line(std::move(line))) return;
        }
        if (saw_newline && seg_end > 0) tail.insert(0, buf, seg_end);
    }
    if (saw_newline && !tail.empty()) {
        if (tail.back() == '\r') tail.pop_back();
        if (!tail.empty()) (void)on_line(std::move(tail));
    }
}

/* `{...}` with `"live": <text>` appended, the text spliced in as it was read. */
std::string with_live(const json& o, const std::string& live) {
    std::string b = o.dump(-1, ' ', false, json::error_handler_t::replace);
    b.pop_back();
    b += ",\"live\":";
    b += live.empty() ? "null" : live;
    b += '}';
    return b;
}

}  // namespace

json History::model_since(const std::string& id, double since, bool include_requests) const {
    json out = json::object();
    {
        std::lock_guard<std::mutex> lk(mu_);
        auto it = models_.find(id);
        if (it == models_.end()) Series().write(out, since);
        else it->second.series.write(out, since);
    }
    if (include_requests) {
        /* The requests that ended after `since`; `t1` is in whole milliseconds, so compare in those. */
        json reqs = json::array();
        {
            std::lock_guard<std::mutex> lg(log_mu_);
            if (const Log* g = find_log_locked(id)) {
                const double cut = (double)std::llround(since * 1000.0);
                for (const json& h : g->recent)
                    if (num0(h, "t1") > cut) reqs.push_back(h);
            }
        }
        out["requests"] = std::move(reqs);
    }
    return out;
}

json History::fleet_since(double since) const {
    std::lock_guard<std::mutex> lk(mu_);
    json out = json::object();
    fleet_.write(out, since);
    return out;
}

std::string History::model_body(const std::string& id, double since, bool include_requests) const {
    asked_ns_.store(steady_ns(), std::memory_order_relaxed);
    const json o = model_since(id, since, include_requests);
    std::string live;
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (auto it = models_.find(id); it != models_.end()) live = it->second.latest;
    }
    return with_live(o, live);
}

std::string History::fleet_body(double since) const {
    asked_ns_.store(steady_ns(), std::memory_order_relaxed);
    const json o = fleet_since(since);
    std::string live;
    {
        std::lock_guard<std::mutex> lk(mu_);
        live = fleet_live_;
    }
    return with_live(o, live);
}

std::string History::fleet_body(double since, bool include_activity, int64_t after_n,
                                const std::vector<std::string>& model_names) const {
    if (!include_activity) return fleet_body(since);
    asked_ns_.store(steady_ns(), std::memory_order_relaxed);

    json out = json::object();
    std::string live;
    std::vector<std::pair<std::string, std::string>> model_stats;
    {
        std::lock_guard<std::mutex> lk(mu_);
        fleet_.write(out, since);
        live = fleet_live_;
        std::set<std::string> seen;
        for (const std::string& name : model_names) {
            if (!seen.insert(name).second) continue;
            auto it = models_.find(name);
            if (it != models_.end() && !it->second.latest.empty())
                model_stats.emplace_back(name, it->second.latest);
        }
    }

    std::vector<json> recs;
    int64_t oldest_n = 0;
    {
        std::lock_guard<std::mutex> lg(log_mu_);
        for (const auto& [name, g] : logs_) {
            (void)name;
            for (const json& h : g.recent) {
                if (i64(h, "n") > after_n) recs.push_back(h);
            }
            if ((g.evicted || g.lines > g.recent.size()) && !g.recent.empty()) {
                const int64_t front_n = i64(g.recent.front(), "n");
                if (front_n > 0 && (oldest_n == 0 || front_n < oldest_n)) oldest_n = front_n;
            }
        }
    }
    std::stable_sort(recs.begin(), recs.end(), record_order_less);
    json reqs = json::array();
    for (json& r : recs) reqs.push_back(std::move(r));
    out["requests"] = std::move(reqs);
    out["oldest_n"] = oldest_n;

    std::string b = out.dump(-1, ' ', false, json::error_handler_t::replace);
    b.pop_back();
    b += ",\"live\":";
    b += live.empty() ? "null" : live;
    b += ",\"model_stats\":{";
    for (size_t i = 0; i < model_stats.size(); ++i) {
        if (i > 0) b += ',';
        b += json(model_stats[i].first).dump(-1, ' ', false, json::error_handler_t::replace);
        b += ':';
        b += model_stats[i].second;
    }
    b += "}}";
    return b;
}

/* ------------------------------------------------------------------ the request log (local) */

const std::vector<std::string>& History::record_keys() {
    static const std::vector<std::string> k = {
        "n", "t0", "t1", "rid", "model", "fm", "kind", "path", "sse", "code", "err", "src", "ua",
        "cache", "in", "out", "dn", "da", "pms", "dms", "prms", "ms", "pps", "tps", "ttft",
        "audio_s", "ses", "pri", "tag", "body" };
    return k;
}

void History::load_tail_locked(const std::string& path, const std::string& fallback_model,
                               Log& g, int64_t* max_n) {
    SharedReader in(path);
    if (!in.ok()) return;
    g.lines = count_lines(in);
    std::vector<json> rev;
    rev.reserve((size_t)kRequests);
    int64_t mx = 0;
    scan_backward(in, [&](std::string&& line) {
        json o = json::parse(line, nullptr, false);
        if (!o.is_object()) return true;
        mx = std::max<int64_t>(mx, i64(o, "n"));
        rev.push_back(std::move(o));
        return rev.size() < (size_t)kRequests;
    });
    std::reverse(rev.begin(), rev.end());
    g.recent.clear();
    for (json& o : rev) {
        backfill_record(o, fallback_model);
        g.recent.push_back(std::move(o));
    }
    if (max_n) *max_n = std::max<int64_t>(*max_n, mx);
}

void History::set_dir(const std::string& dir) {
    std::lock_guard<std::mutex> lg(log_mu_);
    dir_ = dir;
    while (dir_.size() > 1 && (dir_.back() == '/' || dir_.back() == '\\') &&
           !(dir_.size() == 3 && dir_[1] == ':'))
        dir_.pop_back();
    dir_failed_ = false;
    next_global_n_ = 1;
    disk_models_.clear();
    logs_.clear();
    if (dir_.empty()) return;

    std::error_code ec;
    std::filesystem::create_directories(dir_, ec);
    RAD_INFO("history: finished requests are kept in %s", dir_.c_str());
    body_scan_locked();

    std::vector<std::pair<std::string, std::string>> files;
    std::error_code it_ec;
    for (auto it = std::filesystem::directory_iterator(dir_, it_ec);
         !it_ec && it != std::filesystem::directory_iterator();
         it.increment(it_ec)) {
        std::error_code st_ec;
        if (!it->is_regular_file(st_ec) || st_ec) continue;
        const std::filesystem::path p = it->path();
        const std::string fname = p.filename().string();
        if (fname.size() <= 6 || fname.compare(fname.size() - 6, 6, ".jsonl") != 0) continue;
        const std::string stem = fname.substr(0, fname.size() - 6);
        files.emplace_back(stem, p.string());
    }
    std::sort(files.begin(), files.end());

    for (const auto& [stem, path] : files) {
        disk_models_.insert(stem);
        Log g;
        g.loaded = true;
        g.file_path = path;
        int64_t max_n = 0;
        load_tail_locked(path, stem, g, &max_n);
        std::string canonical = stem;
        if (!g.recent.empty()) {
            const json& last = g.recent.back();
            if (last.contains("fm") && last["fm"].is_string() && !last["fm"].get<std::string>().empty())
                canonical = last["fm"].get<std::string>();
        }
        next_global_n_ = std::max<int64_t>(next_global_n_, max_n + 1);
        Log& slot = logs_[canonical];
        slot = std::move(g);
        if (slot.lines > kLogCap) trim_locked(canonical, slot);
    }
}

std::string History::file_of(const std::string& model) const {
    std::string f;
    for (char c : model) f += (std::isalnum((unsigned char)c) || c == '-' || c == '_' || c == '.') ? c : '_';
    if (f.empty() || f[0] == '.') f = "_" + f;
    return dir_ + "/" + f + ".jsonl";
}

/* Rewrites the file to its newest kLogCap records (a temporary file, then a rename). */
void History::trim_locked(const std::string& model, Log& g) {
    const std::string path = g.file_path.empty() ? file_of(model) : g.file_path;
    const std::string tmp = path + ".tmp";
    std::deque<std::string> keep;
    {
        SharedReader in(path);
        if (!in.ok()) {
            g.lines = kLogCap;
            return;
        }
        scan_forward(in, [&](std::string&& line) {
            keep.push_back(std::move(line));
            if (keep.size() > kLogCap) keep.pop_front();
            return true;
        });
    }
    std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
    for (const std::string& l : keep) out << l << '\n';
    out.close();
#if defined(_WIN32)
    const int renamed = out ? rad::os::rename_replace(tmp, path) : -1;
#else
    const int renamed = out ? std::rename(tmp.c_str(), path.c_str()) : -1;
#endif
    if (renamed != 0) {
        std::remove(tmp.c_str());
        /* Back off so subsequent request_done() calls do not rewrite kLogCap lines on every request. */
        g.lines = kLogCap;
        return;
    }
    g.lines = keep.size();
}

const History::Log* History::find_log_locked(const std::string& model) const {
    if (auto it = logs_.find(model); it != logs_.end()) return &it->second;
    if (!dir_.empty()) {
        const std::string target = file_of(model);
        for (const auto& [k, v] : logs_) {
            (void)k;
            if (v.file_path == target) return &v;
        }
    }
    return nullptr;
}

History::Log& History::log_locked(const std::string& model) {
    if (auto it = logs_.find(model); it != logs_.end() && it->second.loaded) return it->second;
    if (!dir_.empty()) {
        const std::string target = file_of(model);
        for (auto it = logs_.begin(); it != logs_.end(); ++it) {
            if (it->first != model && it->second.file_path == target) {
                Log moved = std::move(it->second);
                logs_.erase(it);
                Log& dst = logs_[model];
                dst = std::move(moved);
                dst.loaded = true;
                return dst;
            }
        }
    }
    Log& g = logs_[model];
    if (g.loaded) return g;
    g.loaded = true;
    if (dir_.empty() || dir_failed_) return g;
    g.file_path = file_of(model);
    int64_t max_n = 0;
    load_tail_locked(g.file_path, model, g, &max_n);
    next_global_n_ = std::max<int64_t>(next_global_n_, max_n + 1);
    if (g.lines > kLogCap) trim_locked(model, g);
    return g;
}

void History::request_done(const std::string& model, json rec) {
    std::lock_guard<std::mutex> lg(log_mu_);
    if (!rec.is_object()) return;
    Log& g = log_locked(model);
    rec["fm"] = model;
    if (!rec.contains("kind") || !rec["kind"].is_string() || rec["kind"].get<std::string>().empty())
        rec["kind"] = "chat";
    rec["n"] = next_global_n_++;
    /* (local) The bodies go to their own store; the row keeps only where. */
    if (auto it = rec.find("_body"); it != rec.end()) {
        json body = std::move(*it);
        rec.erase(it);
        if (body.is_object() && !dir_.empty() && !dir_failed_ && body_cap_ > 0) {
            body["rid"] = rec.value("rid", std::string());
            body["n"] = rec["n"];
            body["model"] = model;
            body["t1"] = rec.value("t1", (int64_t)0);
            const std::string loc = body_write_locked(body);
            if (!loc.empty()) rec["body"] = loc;
        }
    }
    const std::string line = rec.dump(-1, ' ', false, json::error_handler_t::replace);
    if (!dir_.empty() && !dir_failed_) {
        const std::string path = g.file_path.empty() ? file_of(model) : g.file_path;
        std::ofstream out(path, std::ios::binary | std::ios::app);
        out << line << '\n';
        out.flush();
        if (!out) {
            dir_failed_ = true;
            RAD_WARN("history: cannot write %s; finished requests are kept in memory only from now on",
                     path.c_str());
        } else if (++g.lines > kLogCap + kLogCap / 10) {
            trim_locked(model, g);
        }
    }
    json safe = json::parse(line, nullptr, false);
    g.recent.push_back(safe.is_object() ? std::move(safe) : std::move(rec));
    if (g.recent.size() > (size_t)kRequests) {
        g.recent.pop_front();
        g.evicted = true;
    }
}

/* ---- (local) body store ---- */

void History::set_body_cap(int64_t bytes) {
    std::lock_guard<std::mutex> lg(log_mu_);
    body_cap_ = bytes < 0 ? 0 : bytes;
}

std::string History::body_dir_locked() const {
    return (std::filesystem::path(dir_) / "bodies").string();
}

std::string History::body_seg_path_locked(int64_t seg) const {
    char name[32];
    std::snprintf(name, sizeof name, "seg-%06lld.jsonl", (long long)seg);
    return (std::filesystem::path(body_dir_locked()) / name).string();
}

void History::body_scan_locked() {
    body_segs_.clear();
    body_seg_ = 0;
    body_seg_bytes_ = 0;
    std::error_code ec;
    std::filesystem::create_directories(body_dir_locked(), ec);
    for (const auto& e : std::filesystem::directory_iterator(body_dir_locked(), ec)) {
        const std::string f = e.path().filename().string();
        if (f.size() != 16 || f.compare(0, 4, "seg-") != 0 || f.compare(10, 6, ".jsonl") != 0) continue;
        const int64_t seg = std::strtoll(f.c_str() + 4, nullptr, 10);
        if (seg <= 0) continue;
        std::error_code ec2;
        const auto sz = std::filesystem::file_size(e.path(), ec2);
        body_segs_[seg] = ec2 ? 0 : (int64_t)sz;
    }
    if (!body_segs_.empty()) {
        body_seg_ = body_segs_.rbegin()->first;
        body_seg_bytes_ = body_segs_.rbegin()->second;
    }
}

std::string History::body_write_locked(const json& body) {
    const std::string line = body.dump(-1, ' ', false, json::error_handler_t::replace);
    if ((int64_t)line.size() + 1 > body_cap_) return std::string();
    if (body_seg_ == 0 || body_seg_bytes_ + (int64_t)line.size() + 1 > kBodySegBytes) {
        body_seg_ = body_seg_ + 1;
        body_seg_bytes_ = 0;
        body_segs_[body_seg_] = 0;
    }
    const std::string path = body_seg_path_locked(body_seg_);
    std::ofstream out(path, std::ios::binary | std::ios::app);
    if (!out) return std::string();
    const int64_t off = body_seg_bytes_;
    out << line << '\n';
    out.flush();
    if (!out) return std::string();
    body_seg_bytes_ += (int64_t)line.size() + 1;
    body_segs_[body_seg_] = body_seg_bytes_;
    /* The cap: drop whole segments, oldest first, never the one being written. A segment a reader
     * holds open (Windows) stays until a later write tries again. */
    int64_t total = 0;
    for (const auto& [s, b] : body_segs_) total += b;
    for (auto it = body_segs_.begin(); total > body_cap_ && it != body_segs_.end() && it->first != body_seg_;) {
        std::error_code ec;
        std::filesystem::remove(body_seg_path_locked(it->first), ec);
        if (ec && std::filesystem::exists(body_seg_path_locked(it->first))) { ++it; continue; }
        total -= it->second;
        it = body_segs_.erase(it);
    }
    char loc[64];
    std::snprintf(loc, sizeof loc, "%lld:%lld:%lld", (long long)body_seg_, (long long)off,
                  (long long)line.size());
    return loc;
}

std::string History::body_at(const std::string& locator, const std::string& rid) const {
    long long seg = 0, off = 0, len = 0;
    char tail = 0;
    if (std::sscanf(locator.c_str(), "%lld:%lld:%lld%c", &seg, &off, &len, &tail) != 3) return std::string();
    if (seg <= 0 || off < 0 || len <= 0 || len > kBodySegBytes) return std::string();
    std::string path;
    {
        std::lock_guard<std::mutex> lg(log_mu_);
        if (dir_.empty() || !body_segs_.count(seg)) return std::string();
        path = body_seg_path_locked(seg);
    }
    std::ifstream in(path, std::ios::binary);
    if (!in) return std::string();
    in.seekg(off);
    std::string s((size_t)len, '\0');
    in.read(&s[0], len);
    if (in.gcount() != len) return std::string();
    const json j = json::parse(s, nullptr, false);
    if (!j.is_object() || j.value("rid", std::string()) != rid) return std::string();
    return s;
}

std::string History::requests_page(const RequestsQuery& q) const {
    const std::vector<std::string>& all_keys = record_keys();
    std::vector<std::string> keys;
    if (q.fields.empty()) {
        keys = all_keys;
    } else {
        std::set<std::string> allowed(all_keys.begin(), all_keys.end());
        std::set<std::string> picked;
        for (const std::string& f : q.fields) {
            if (allowed.count(f) && picked.insert(f).second) keys.push_back(f);
        }
    }

    struct Source {
        std::string       model;
        std::string       path;
        size_t            total_lines = 0;
        std::vector<json> mem_records;
    };
    std::vector<Source> sources;
    bool use_disk = false;
    {
        std::lock_guard<std::mutex> lg(log_mu_);
        use_disk = !dir_.empty() && !dir_failed_;
        auto add_log = [&](const std::string& canonical, const Log& g) {
            Source s;
            s.model = canonical;
            if (use_disk) {
                s.path = g.file_path.empty() ? file_of(canonical) : g.file_path;
                s.total_lines = g.lines;
            } else {
                s.total_lines = g.recent.size();
                s.mem_records.assign(g.recent.begin(), g.recent.end());
            }
            sources.push_back(std::move(s));
        };
        if (!q.model.empty()) {
            if (const Log* g = find_log_locked(q.model)) add_log(q.model, *g);
        } else {
            for (const auto& [name, g] : logs_) add_log(name, g);
        }
    }
    /* log_mu_ released: all disk I/O and JSON parsing happens lock-free below. */

    uint64_t total = 0;
    for (const Source& s : sources) total += s.total_lines;

    auto matches = [&](const json& o) -> bool {
        const int64_t rn = i64(o, "n");
        if (q.before_n > 0 && rn >= q.before_n) return false;
        if (q.after_n > 0 && rn <= q.after_n) return false;
        if (q.t_from > 0 && i64(o, "t1") < q.t_from) return false;
        if (q.t_to > 0) {
            const int64_t t0 = o.contains("t0") ? i64(o, "t0") : i64(o, "t1");
            if (t0 > q.t_to) return false;
        }
        return true;
    };

    std::vector<json> candidates;
    const bool fast_backward_page = (q.limit > 0 && q.after_n == 0 && q.t_from == 0 && q.t_to == 0);
    const bool backward_after = (q.after_n > 0);

    for (const Source& s : sources) {
        if (!use_disk) {
            for (json o : s.mem_records) {
                if (!o.is_object()) continue;
                if (!matches(o)) continue;
                backfill_record(o, s.model);
                candidates.push_back(std::move(o));
            }
            continue;
        }
        SharedReader in(s.path);
        if (!in.ok()) continue;
        if (fast_backward_page) {
            size_t got = 0;
            scan_backward(in, [&](std::string&& line) {
                json o = json::parse(line, nullptr, false);
                if (!o.is_object()) return true;
                if (!matches(o)) return true;
                backfill_record(o, s.model);
                candidates.push_back(std::move(o));
                ++got;
                return got <= q.limit;  /* collect up to limit + 1 to detect has_more */
            });
        } else if (backward_after) {
            scan_backward(in, [&](std::string&& line) {
                json o = json::parse(line, nullptr, false);
                if (!o.is_object()) return true;
                if (i64(o, "n") <= q.after_n) return false;
                if (!matches(o)) return true;
                backfill_record(o, s.model);
                candidates.push_back(std::move(o));
                return true;
            });
        } else {
            scan_forward(in, [&](std::string&& line) {
                json o = json::parse(line, nullptr, false);
                if (!o.is_object()) return true;
                if (!matches(o)) return true;
                backfill_record(o, s.model);
                candidates.push_back(std::move(o));
                return true;
            });
        }
    }

    std::stable_sort(candidates.begin(), candidates.end(), record_order_less);

    bool has_more = false;
    if (q.limit > 0 && candidates.size() > q.limit) {
        has_more = true;
        if (q.after_n > 0) {
            candidates.resize(q.limit);
        } else {
            candidates.erase(candidates.begin(), candidates.end() - (ptrdiff_t)q.limit);
        }
    }

    /* Oldest returned row's sequence number (by chronological `(t1, n)` order), so a legacy
     * secondary model with small colliding `n` at recent `t1` does not pin `min_n` to 1. */
    const int64_t min_n = candidates.empty() ? 0 : i64(candidates.front(), "n");

    json rows = json::array();
    for (const json& o : candidates) {
        json r = json::array();
        for (const std::string& k : keys) r.push_back(o.is_object() && o.contains(k) ? o[k] : json(nullptr));
        rows.push_back(std::move(r));
    }

    json out = json::object();
    json k = json::array();
    for (const std::string& s : keys) k.push_back(s);
    out["keys"] = std::move(k);
    out["rows"] = std::move(rows);
    out["total"] = total;
    out["has_more"] = has_more;
    out["min_n"] = min_n;
    return out.dump(-1, ' ', false, json::error_handler_t::replace);
}

std::string History::requests_body(const std::string& model) const {
    RequestsQuery q;
    q.model = model;
    q.limit = 0;
    return requests_page(q);
}

HttpResponse handle_history_requests(const History& h, const HttpRequest& q, bool operator_ok) {
    if (!operator_ok) {
        return HttpResponse::json_body(
            403, error_body(q.path, 403, "permission_error",
                            "request history answers the local operator only "
                            "unless an api key is configured"));
    }
    RequestsQuery rq;
    if (auto it = q.query.find("model"); it != q.query.end()) rq.model = it->second;
    auto parse_i64 = [&](const char* name, int64_t def) -> int64_t {
        auto it = q.query.find(name);
        if (it == q.query.end() || it->second.empty()) return def;
        char* end = nullptr;
        const long long v = std::strtoll(it->second.c_str(), &end, 10);
        if (end == it->second.c_str() || *end != '\0') return def;
        return (int64_t)v;
    };
    const int64_t lim = parse_i64("limit", rq.model.empty() ? 5000 : 0);
    rq.limit = lim > 0 ? (size_t)lim : 0;
    rq.before_n = std::max<int64_t>(0, parse_i64("before_n", 0));
    rq.after_n = std::max<int64_t>(0, parse_i64("after_n", 0));
    rq.t_from = std::max<int64_t>(0, parse_i64("t_from", 0));
    rq.t_to = std::max<int64_t>(0, parse_i64("t_to", 0));
    if (auto it = q.query.find("fields"); it != q.query.end() && !it->second.empty()) {
        const std::string& s = it->second;
        size_t pos = 0;
        while (pos < s.size()) {
            const size_t comma = s.find(',', pos);
            std::string tok = (comma == std::string::npos) ? s.substr(pos) : s.substr(pos, comma - pos);
            while (!tok.empty() && std::isspace((unsigned char)tok.front())) tok.erase(tok.begin());
            while (!tok.empty() && std::isspace((unsigned char)tok.back())) tok.pop_back();
            if (!tok.empty()) rq.fields.push_back(std::move(tok));
            if (comma == std::string::npos) break;
            pos = comma + 1;
        }
    }
    return HttpResponse::json_body(200, h.requests_page(rq));
}

}  // namespace server
}  // namespace rad
