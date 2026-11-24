/* core/server/history.h -- an hour of the dashboard's figures, kept by the process.
 *
 * A page that keeps its own samples shows nothing of the time before it was opened. The process
 * samples once a second instead and keeps an hour: for each model the figures its Performance page
 * charts, derived from two consecutive /stats objects, and (local) the requests that finished, as
 * Server::record reported them, kept across restarts in a file when set_dir names one; for the
 * fleet every card's telemetry, every model's state and its bytes on each card. A page loads the
 * hour when it opens (`since` 0) and asks for what is new after its last sample from then on.
 *
 * The sampler is the only reader of the engine on the dashboard's behalf. Every answer here comes
 * from what it last read (`live` is the /stats or /admin/fleet object of the latest sample, as
 * text), so any number of open pages costs the serving path nothing beyond the one sample a second.
 *
 * A row is a set of named values at one time; a value a sample did not yield is a gap, not a zero.
 * Rates are counter differences over the time between two samples of one start of the model: the
 * first sample after a load yields only the instantaneous figures.
 */
#pragma once
#include "server/http.h"
#include "server/iface.h"

#include <atomic>
#include <cstdint>
#include <deque>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace rad {
namespace server {

/* Query parameters for paged, lock-free reads of finished requests (History::requests_page). */
struct RequestsQuery {
    std::string              model;          /* empty = all models */
    size_t                   limit = 0;      /* 0 = all kept rows */
    int64_t                  before_n = 0;   /* > 0: only rows with n < before_n */
    int64_t                  after_n = 0;    /* > 0: only rows with n > after_n */
    int64_t                  t_from = 0;     /* > 0: only rows with t1 >= t_from (unix ms) */
    int64_t                  t_to = 0;       /* > 0: only rows with t0 <= t_to (unix ms) */
    std::vector<std::string> fields;         /* empty = full record_keys(); else validated subset */
};

class History {
public:
    static constexpr int kKeepS = 3600;      /* seconds of samples kept */
    /* Rows a ring holds: the hour at the five rows a second a watched page is given. */
    static constexpr int kRows = kKeepS * 5;
    static constexpr int kRequests = 500;    /* finished requests kept in memory for a model */
    /* Finished requests kept in a model's file (local): when it holds a tenth more, the oldest go. */
    static constexpr size_t kLogCap = 100000;

    /* The directory that keeps every model's finished requests across restarts, one
     * `<model>.jsonl` each (local: RADIANCE_HISTORY_DIR). Empty keeps them in memory only. */
    void set_dir(const std::string& dir);
    /* One finished request of `model`, the object Server::record gives (server.h, RequestRecord):
     * stamped with `fm` and `kind`, numbered with a fleet-global monotonic `n`, kept, and appended
     * to the model's file. A file that cannot be written logs once and the log stays in memory;
     * it never fails the request. */
    void request_done(const std::string& model, json rec);
    /* Every kept request of `model`, oldest first, as columns:
     * {"keys": [...], "rows": [[...]], "total": N, "has_more": false, "min_n": M}.
     * From the file when there is one, else the memory's newest kRequests. */
    std::string requests_body(const std::string& model) const;
    /* Paged, lock-free read of finished requests across one or all models. */
    std::string requests_page(const RequestsQuery& q) const;
    /* The keys of a request record, in the order requests_body writes them. */
    static const std::vector<std::string>& record_keys();

    /* One sample of a model from its /stats object (`body` its text), `t` in unix seconds. */
    void model_sample(const std::string& id, const json& stats, double t, std::string body = std::string());
    /* One sample of the fleet from /admin/fleet's object. */
    void fleet_sample(const json& fleet, double t, std::string body = std::string());
    /* A page asked for a body within the last `seconds`. */
    bool watched(double seconds) const;
    /* A model that is not open right now: its history stays, its live object goes. */
    void model_closed(const std::string& id);
    /* A model the process no longer serves. */
    void forget(const std::string& id);

    /* {"keep_s", "t": [...], "c": {name: [...]}, "requests": [...]}: the samples later than
     * `since` and (when `include_requests` is true) the requests that finished after it. A column
     * holds a value or null for every time in `t`; a column with no value in the range is left
     * out. An unknown model answers with empty arrays. */
    json model_since(const std::string& id, double since, bool include_requests = true) const;
    /* The fleet's, without `requests`. */
    json fleet_since(double since) const;
    /* The same as response bodies, with `"live"`: the latest sample's object, null for a model
     * that is not open. */
    std::string model_body(const std::string& id, double since, bool include_requests = true) const;
    std::string fleet_body(double since) const;
    /* Fleet response body with opt-in Overview activity: per-model latest `/stats` for the named
     * models, lossless `n > after_n` finished requests across all models, and `oldest_n` (the
     * lowest `n` remaining in any ring that has evicted older records, or 0 if none has). When
     * `include_activity` is false, delegates directly to `fleet_body(since)`. */
    std::string fleet_body(double since, bool include_activity, int64_t after_n,
                           const std::vector<std::string>& model_names) const;

    using Row = std::vector<std::pair<std::string, double>>;
    /* The row two consecutive /stats objects of one model yield (`prev` null for the first, `dt`
     * the seconds between them). Exposed for the tests. */
    static Row model_row(const json& now, const json* prev, double dt);
    /* The row /admin/fleet's object yields. */
    static Row fleet_row(const json& fleet);

private:
    /* A ring of rows in columns. */
    struct Series {
        std::vector<double> t;
        std::map<std::string, std::vector<float>> c;
        size_t head = 0, n = 0;
        void push(double at, const Row& row);
        void write(json& out, double since) const;
    };
    struct Model {
        Series series;
        json   prev;                 /* the last /stats object */
        double prev_t = 0;
        std::string                 latest;     /* the latest /stats text; empty while not open */
    };
    /* A model's finished requests (local): the newest in memory, the rest in its file. */
    struct Log {
        std::deque<json> recent;
        size_t           lines = 0;      /* records in the file */
        bool             loaded = false;
        bool             evicted = false; /* true once recent has dropped an older record */
        std::string      file_path;       /* resolved on-disk path when dir_ is set */
    };
    const Log* find_log_locked(const std::string& model) const;
    Log& log_locked(const std::string& model);
    std::string file_of(const std::string& model) const;
    void load_tail_locked(const std::string& path, const std::string& fallback_model,
                          Log& g, int64_t* max_n);
    void trim_locked(const std::string& model, Log& g);

    mutable std::mutex           log_mu_;
    std::string                  dir_;
    bool                         dir_failed_ = false;
    int64_t                      next_global_n_ = 1;
    std::set<std::string>        disk_models_;
    std::map<std::string, Log>   logs_;

    mutable std::mutex           mu_;
    std::map<std::string, Model> models_;
    Series                       fleet_;
    std::string                  fleet_live_;
    /* steady_clock nanoseconds of the last body asked for; 0 before the first. */
    mutable std::atomic<int64_t> asked_ns_{ 0 };
};

/* HTTP handler for GET /history/requests; enforces operator_ok consistently for both fleet-wide
 * and per-model queries. Exposed as a free function so tests can drive it directly. */
HttpResponse handle_history_requests(const History& h, const HttpRequest& q, bool operator_ok);

}  // namespace server
}  // namespace rad
