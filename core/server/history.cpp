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
#include "os/os.h"   /* Brilliance: os::rename_replace -- Windows' rename will not replace a file */
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

json History::model_since(const std::string& id, double since) const {
    std::lock_guard<std::mutex> lk(mu_);
    json out = json::object();
    auto it = models_.find(id);
    if (it == models_.end()) Series().write(out, since);
    else it->second.series.write(out, since);
    /* The requests that ended after `since`; `t1` is in whole milliseconds, so compare in those. */
    json reqs = json::array();
    {
        std::lock_guard<std::mutex> lg(log_mu_);
        const Log& g = log_locked(id);
        const double cut = (double)std::llround(since * 1000.0);
        for (const json& h : g.recent)
            if (num0(h, "t1") > cut) reqs.push_back(h);
    }
    out["requests"] = std::move(reqs);
    return out;
}

json History::fleet_since(double since) const {
    std::lock_guard<std::mutex> lk(mu_);
    json out = json::object();
    fleet_.write(out, since);
    return out;
}

namespace {
/* `{...}` with `"live": <text>` appended, the text spliced in as it was read. */
std::string with_live(const json& o, const std::string& live) {
    std::string b = o.dump();
    b.pop_back();
    b += ",\"live\":";
    b += live.empty() ? "null" : live;
    b += '}';
    return b;
}
}  // namespace

std::string History::model_body(const std::string& id, double since) const {
    asked_ns_.store(steady_ns(), std::memory_order_relaxed);
    const json o = model_since(id, since);
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

/* ------------------------------------------------------------------ the request log (local) */

const std::vector<std::string>& History::record_keys() {
    static const std::vector<std::string> k = {
        "n", "t0", "t1", "rid", "model", "path", "sse", "code", "err", "src", "ua",
        "cache", "in", "out", "dn", "da", "pms", "dms", "prms", "ms", "pps", "tps", "ttft",
        "ses", "pri", "tag" };
    return k;
}

void History::set_dir(const std::string& dir) {
    std::lock_guard<std::mutex> lg(log_mu_);
    dir_ = dir;
    while (dir_.size() > 1 && (dir_.back() == '/' || dir_.back() == '\\') &&
           !(dir_.size() == 3 && dir_[1] == ':'))
        dir_.pop_back();
    dir_failed_ = false;
    logs_.clear();
    if (!dir_.empty()) {
        std::error_code ec;
        std::filesystem::create_directories(dir_, ec);
        RAD_INFO("history: finished requests are kept in %s", dir_.c_str());
    }
}

std::string History::file_of(const std::string& model) const {
    std::string f;
    for (char c : model) f += (std::isalnum((unsigned char)c) || c == '-' || c == '_' || c == '.') ? c : '_';
    if (f.empty() || f[0] == '.') f = "_" + f;
    return dir_ + "/" + f + ".jsonl";
}

/* Rewrites the file to its newest kLogCap records (a temporary file, then a rename). */
void History::trim_locked(const std::string& model, Log& g) const {
    const std::string path = file_of(model), tmp = path + ".tmp";
    std::deque<std::string> keep;
    {
        std::ifstream in(path);
        std::string line;
        while (std::getline(in, line)) {
            if (line.empty()) continue;
            keep.push_back(std::move(line));
            if (keep.size() > kLogCap) keep.pop_front();
        }
    }
    std::ofstream out(tmp, std::ios::trunc);
    for (const std::string& l : keep) out << l << '\n';
    out.close();
#if defined(_WIN32)
    const int renamed = out ? rad::os::rename_replace(tmp, path) : -1;
#else
    const int renamed = out ? std::rename(tmp.c_str(), path.c_str()) : -1;
#endif
    if (renamed != 0) {
        std::remove(tmp.c_str());
        return;
    }
    g.lines = keep.size();
}

History::Log& History::log_locked(const std::string& model) const {
    Log& g = logs_[model];
    if (g.loaded) return g;
    g.loaded = true;
    if (dir_.empty() || dir_failed_) return g;
    {
        std::ifstream in(file_of(model));
        std::string line;
        while (std::getline(in, line)) {
            if (line.empty()) continue;
            json o = json::parse(line, nullptr, false);
            if (!o.is_object()) continue;          /* a torn last line after a crash */
            ++g.lines;
            g.next = std::max<int64_t>(g.next, (int64_t)num0(o, "n") + 1);
            g.recent.push_back(std::move(o));
            if (g.recent.size() > (size_t)kRequests) g.recent.pop_front();
        }
    }
    if (g.lines > kLogCap) trim_locked(model, g);
    return g;
}

void History::request_done(const std::string& model, json rec) {
    std::lock_guard<std::mutex> lg(log_mu_);
    Log& g = log_locked(model);
    rec["n"] = g.next++;
    if (!dir_.empty() && !dir_failed_) {
        std::ofstream out(file_of(model), std::ios::app);
        out << rec.dump() << '\n';
        out.flush();
        if (!out) {
            dir_failed_ = true;
            RAD_WARN("history: cannot write %s; finished requests are kept in memory only from now on",
                     file_of(model).c_str());
        } else if (++g.lines > kLogCap + kLogCap / 10) {
            trim_locked(model, g);
        }
    }
    g.recent.push_back(std::move(rec));
    if (g.recent.size() > (size_t)kRequests) g.recent.pop_front();
}

std::string History::requests_body(const std::string& model) const {
    const std::vector<std::string>& keys = record_keys();
    json rows = json::array();
    auto row_of = [&](const json& o) {
        json r = json::array();
        for (const std::string& k : keys) r.push_back(o.is_object() && o.contains(k) ? o[k] : json(nullptr));
        rows.push_back(std::move(r));
    };
    {
        std::lock_guard<std::mutex> lg(log_mu_);
        const Log& g = log_locked(model);
        if (!dir_.empty() && !dir_failed_) {
            std::ifstream in(file_of(model));
            std::string line;
            while (std::getline(in, line)) {
                if (line.empty()) continue;
                const json o = json::parse(line, nullptr, false);
                if (o.is_object()) row_of(o);
            }
        } else {
            for (const json& o : g.recent) row_of(o);
        }
    }
    json out = json::object();
    json k = json::array();
    for (const std::string& s : keys) k.push_back(s);
    out["keys"] = std::move(k);
    out["rows"] = std::move(rows);
    return out.dump();
}

}  // namespace server
}  // namespace rad
