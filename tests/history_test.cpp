/* history_test.cpp -- the dashboard's hour of history (core/server/history.h).
 *
 *   Rows     what two consecutive /stats objects yield: instantaneous figures from one, rates from
 *            the difference, and nothing where a counter did not move
 *   Fleet    a card's telemetry, a model's state and its bytes on each card
 *   Ring     an hour is kept, a value a sample did not yield is null, and `since` cuts
 *   Requests a request is recorded once when it finishes, seen done or gone between two samples
 *   Starts   a model's counters start over with it: no rate across a restart
 *   Live     a response body carries the latest sample's object, and none for a model not open
 *
 * No server: JSON objects in, JSON out.
 */
#include "rad_test.h"

#include "server/history.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>

using namespace rad;
using namespace rad::server;

namespace {

double of(const History::Row& r, const std::string& k) {
    for (const auto& [name, v] : r)
        if (name == k) return v;
    return std::nan("");
}
bool has(const History::Row& r, const std::string& k) { return std::isfinite(of(r, k)); }

json stats(int64_t started, double steps_decode, double step_ns_decode, double total_requests) {
    return json::parse(R"({"started_at": )" + std::to_string(started) + R"(, "decode_tps": 120.5, "prefill_tps": 900,
        "running": 2, "waiting": 1, "preempted": 0, "in_flight": 3, "prefix_hit_rate": 0.75,
        "kv_bytes_used": 4000, "kv_bytes_total": 16000, "kv_tokens_used": 1000, "kv_tokens_cached": 250,
        "step_ns_decode_best": 21000000, "jobs": {"running": 0, "done": 0, "last_ms": 0},
        "steps": )" + std::to_string(steps_decode) + R"(, "step_ns": )" + std::to_string(step_ns_decode) + R"(,
        "steps_decode": )" + std::to_string(steps_decode) + R"(, "step_ns_decode": )" + std::to_string(step_ns_decode) + R"(,
        "total_requests": )" + std::to_string(total_requests) + R"(,
        "draft_positions": [{"reached": )" + std::to_string(steps_decode) + R"(, "accepted": )" +
        std::to_string(steps_decode / 2) + R"(}], "requests": []})");
}

}  // namespace

TEST(one_stats_object_yields_the_instantaneous_figures_and_no_rate) {
    const History::Row r = History::model_row(stats(7, 100, 2.2e9, 10), nullptr, 0);
    CHECK_EQ(of(r, "decode"), 120.5);
    CHECK_EQ(of(r, "running"), 2.0);
    CHECK_EQ(of(r, "flight"), 3.0);
    CHECK_EQ(of(r, "hit"), 0.75);
    /* A quarter of the tokens are kept turns, so a quarter of the bytes. */
    CHECK_EQ(of(r, "kvKept"), 1000.0);
    CHECK_EQ(of(r, "kvRead"), 3000.0);
    CHECK_EQ(of(r, "stepBest"), 21.0);
    CHECK(!has(r, "step"));
    CHECK(!has(r, "reqRate"));
    CHECK(!has(r, "accept"));
}

TEST(two_stats_objects_yield_rates_over_the_time_between_them) {
    const json a = stats(7, 100, 2.2e9, 10), b = stats(7, 150, 3.3e9, 14);
    const History::Row r = History::model_row(b, &a, 2.0);
    CHECK_EQ(of(r, "reqRate"), 2.0);                 /* four requests in two seconds */
    CHECK_EQ(of(r, "step"), 22.0);                   /* 1.1e9 ns over 50 steps */
    CHECK_EQ(of(r, "accept"), 0.5);                  /* 25 accepted of 50 reached */
    CHECK_EQ(of(r, "tokStep"), 1.5);
    /* No step ran: no step time, and the counters that did not move yield no acceptance. */
    const History::Row idle = History::model_row(a, &a, 1.0);
    CHECK(!has(idle, "step"));
    CHECK(!has(idle, "accept"));
    CHECK_EQ(of(idle, "reqRate"), 0.0);
}

TEST(a_prompt_s_prefill_rate_is_its_fresh_tokens_over_its_own_prefill_time_once) {
    json a = stats(7, 100, 2.2e9, 10), b = stats(7, 100, 2.2e9, 10);
    b["requests"] = json::parse(R"([{"id": "r1", "state": "decode", "prompt": 5000, "cached": 1000, "prefill_s": 2.0}])");
    CHECK_EQ(of(History::model_row(b, &a, 1.0), "prefillRate"), 2000.0);
    /* The next sample sees the same request past its prefill: it is counted once. */
    CHECK(!has(History::model_row(b, &b, 1.0), "prefillRate"));
}

TEST(the_fleet_row_holds_telemetry_states_and_bytes_per_card) {
    const json f = json::parse(R"({"models": [
        {"id": "a", "state": "resident", "cards": [0, 1], "vram_bytes_per_card": 1000},
        {"id": "b", "state": "parked", "cards": [1], "vram_bytes_per_card": 0},
        {"id": "c", "state": "cold"}],
      "cards": [{"card": 0, "busy": 0.5, "power_w": 200, "temp_c": 60, "free_bytes": 7},
                {"card": 1, "free_bytes": 9}]})");
    const History::Row r = History::fleet_row(f);
    CHECK_EQ(of(r, "s:a"), 3.0);
    CHECK_EQ(of(r, "s:b"), 1.0);
    CHECK_EQ(of(r, "s:c"), 0.0);
    CHECK_EQ(of(r, "busy0"), 0.5);
    CHECK_EQ(of(r, "power0"), 200.0);
    CHECK_EQ(of(r, "temp0"), 60.0);
    CHECK(!has(r, "busy1"));                         /* not sampled is a gap, not a zero */
    CHECK_EQ(of(r, "c0:a"), 1000.0);
    CHECK_EQ(of(r, "c1:a"), 1000.0);
    CHECK_EQ(of(r, "c0:b"), 0.0);                    /* a model with nothing on a card is an empty band */
    CHECK_EQ(of(r, "c1:c"), 0.0);
}

TEST(the_ring_keeps_an_hour_and_since_cuts) {
    History h;
    for (int i = 0; i < History::kKeepS + 10; ++i) h.model_sample("m", stats(7, 100 + i, 2.2e9 + 2e7 * i, 10), 1000.0 + i);
    json all = h.model_since("m", 0);
    CHECK_EQ((int)all["t"].size(), History::kKeepS);
    CHECK_EQ(all["t"][0].get<double>(), 1010.0);                    /* the ten oldest are gone */
    CHECK_EQ((int)all["c"]["decode"].size(), History::kKeepS);
    CHECK_EQ(all["keep_s"].get<int>(), History::kKeepS);
    json tail = h.model_since("m", 1000.0 + History::kKeepS + 7);
    CHECK_EQ((int)tail["t"].size(), 2);
    CHECK_EQ((int)tail["c"]["step"].size(), 2);
    CHECK_EQ(tail["c"]["step"][0].get<double>(), 20.0);
    /* A model nobody sampled answers with nothing. */
    CHECK_EQ((int)h.model_since("other", 0)["t"].size(), 0);
}

TEST(a_value_a_sample_did_not_yield_is_null_and_an_empty_column_is_left_out) {
    History h;
    h.model_sample("m", stats(7, 100, 2.2e9, 10), 10.0);
    h.model_sample("m", stats(7, 150, 3.3e9, 10), 11.0);
    json j = h.model_since("m", 0);
    CHECK(j["c"]["step"][0].is_null());              /* the first sample has no predecessor */
    CHECK_EQ(j["c"]["step"][1].get<double>(), 22.0);
    CHECK(!j["c"].contains("lkAr"));                 /* no link counters in these objects */
}

/* (local) A finished request comes from Server::record, not from the samples: it is numbered,
 * kept, and `since` cuts it by the time it ended (`t1`, unix milliseconds). */
TEST(a_finished_request_is_numbered_kept_and_cut_by_since) {
    History h;
    h.request_done("m", json::parse(R"({"rid": "r1", "t0": 1794590850000, "t1": 1794590851000, "out": 90})"));
    h.request_done("m", json::parse(R"({"rid": "r2", "t0": 1794590851000, "t1": 1794590852500, "out": 5})"));
    json r = h.model_since("m", 0)["requests"];
    REQUIRE_EQ((int)r.size(), 2);
    CHECK_EQ(r[0]["rid"].get<std::string>(), "r1");
    CHECK_EQ(r[0]["n"].get<int64_t>(), (int64_t)1);
    CHECK_EQ(r[1]["n"].get<int64_t>(), (int64_t)2);
    CHECK_EQ((int)h.model_since("m", 1794590851.0)["requests"].size(), 1);
    CHECK_EQ((int)h.model_since("m", 1794590852.5)["requests"].size(), 0);
    CHECK_EQ((int)h.model_since("other", 0)["requests"].size(), 0);
    /* The samples no longer make requests: a row that leaves the table records nothing. */
    json s = stats(7, 100, 2.2e9, 10);
    s["requests"] = json::parse(R"([{"id": "r9", "state": "decode", "prompt": 4, "cached": 0, "output": 1, "ctx": 5, "tps": 5}])");
    h.model_sample("m", s, 10.0);
    s["requests"] = json::array();
    h.model_sample("m", s, 11.0);
    CHECK_EQ((int)h.model_since("m", 0)["requests"].size(), 2);
}

namespace {
std::string temp_dir() {
    static std::atomic<int> seq{0};
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    std::error_code ec;
    const auto base = std::filesystem::temp_directory_path(ec);
    if (ec) return std::string();
    const auto p = base / ("history_test_" + std::to_string(stamp) + "_" + std::to_string(++seq));
    std::filesystem::create_directories(p, ec);
    return ec ? std::string() : p.string();
}
void remove_dir(const std::string& dir) {
    std::error_code ec;
    std::filesystem::remove_all(dir, ec);
}
int lines_of(const std::string& path) {
    std::ifstream in(path);
    std::string l;
    int n = 0;
    while (std::getline(in, l)) n += !l.empty();
    return n;
}
}  // namespace

/* (local) With a directory, the requests outlive the process: a new History reads them back,
 * numbers on from the last, and answers all of them as columns. */
TEST(the_request_log_survives_a_restart_and_numbers_on) {
    const std::string dir = temp_dir();
    REQUIRE(!dir.empty());
    {
        History h;
        h.set_dir(dir);
        for (int i = 0; i < 3; ++i)
            h.request_done("qwen27b", json::parse(R"({"t1": )" + std::to_string(1000 + i) + R"(, "out": 7, "ses": "s"})"));
    }
    CHECK_EQ(lines_of(dir + "/qwen27b.jsonl"), 3);
    History h;
    h.set_dir(dir);
    CHECK_EQ((int)h.model_since("qwen27b", 0)["requests"].size(), 3);
    h.request_done("qwen27b", json::parse(R"({"t1": 2000})"));
    const json b = json::parse(h.requests_body("qwen27b"));
    REQUIRE_EQ((int)b["rows"].size(), 4);
    const json& keys = b["keys"];
    REQUIRE_EQ(keys[0].get<std::string>(), "n");
    CHECK_EQ(b["rows"][3][0].get<int64_t>(), (int64_t)4);
    int ses = -1;
    for (size_t i = 0; i < keys.size(); ++i) if (keys[i].get<std::string>() == "ses") ses = (int)i;
    REQUIRE(ses >= 0);
    CHECK_EQ(b["rows"][0][ses].get<std::string>(), "s");
    CHECK(b["rows"][3][ses].is_null());
    /* A model's name never leaves the directory. */
    h.request_done("../x/y", json::parse(R"({"t1": 1})"));
    CHECK_EQ(lines_of(dir + "/.._x_y.jsonl") + lines_of(dir + "/_.._x_y.jsonl"), 1);
    remove_dir(dir);
}

/* (local) A file over the cap is cut to its newest kLogCap records when it is read. */
TEST(the_request_log_keeps_its_newest_records_up_to_the_cap) {
    const std::string dir = temp_dir();
    REQUIRE(!dir.empty());
    const int n = (int)History::kLogCap + 5;
    {
        std::ofstream out(dir + "/m.jsonl");
        for (int i = 1; i <= n; ++i) out << "{\"n\":" << i << ",\"t1\":" << i << "}\n";
        out << "{\"n\":";                         /* a torn last line */
    }
    History h;
    h.set_dir(dir);
    const json r = h.model_since("m", 0)["requests"];
    REQUIRE_EQ((int)r.size(), History::kRequests);
    CHECK_EQ(r[r.size() - 1]["n"].get<int64_t>(), (int64_t)n);
    CHECK_EQ(lines_of(dir + "/m.jsonl"), (int)History::kLogCap);
    h.request_done("m", json::parse(R"({"t1": 9999999})"));
    const json last = h.model_since("m", 0)["requests"];
    CHECK_EQ(last[last.size() - 1]["n"].get<int64_t>(), (int64_t)n + 1);
    remove_dir(dir);
}

/* (local) A directory that cannot be written costs nothing but the file: requests stay in memory. */
TEST(an_unwritable_request_log_keeps_requests_in_memory) {
    const std::string dir = temp_dir();
    REQUIRE(!dir.empty());
    const std::string blocker = dir + "/file";
    { std::ofstream f(blocker); f << "x"; }
    History h;
    h.set_dir(blocker + "/sub");
    h.request_done("m", json::parse(R"({"t1": 5})"));
    h.request_done("m", json::parse(R"({"t1": 6})"));
    CHECK_EQ((int)h.model_since("m", 0)["requests"].size(), 2);
    CHECK_EQ((int)json::parse(h.requests_body("m"))["rows"].size(), 2);
    remove_dir(dir);
}

/* A page asks for what came after the last sample time it was given. Times are sent to the
 * millisecond, so a sample taken between two milliseconds must not be later than its own sent
 * time: asked with it, the history answers with nothing of that sample. */
TEST(asking_with_the_last_time_given_does_not_repeat_a_sample) {
    for (double frac : { 0.0, 0.0004, 0.0006, 0.84561, 0.9996 }) {
        History h;
        json s = stats(7, 100, 2.2e9, 10);
        h.model_sample("m", s, 1794590850.0 + frac);
        h.model_sample("m", s, 1794590851.0 + frac);
        const json all = h.model_since("m", 0);
        REQUIRE_EQ((int)all["t"].size(), 2);
        const double last = all["t"][1].get<double>();
        /* The page sends the number back as text. */
        const double asked = std::strtod(json(last).dump().c_str(), nullptr);
        const json next = h.model_since("m", asked);
        CHECK_EQ((int)next["t"].size(), 0);
        /* Asked with the sample before, it gets exactly the last one. */
        const json one = h.model_since("m", all["t"][0].get<double>());
        CHECK_EQ((int)one["t"].size(), 1);
        h.fleet_sample(json::parse(R"({"models": [], "cards": [{"card": 0, "free_bytes": 7}]})"), 1794590851.0 + frac);
        const json f = h.fleet_since(0);
        REQUIRE_EQ((int)f["t"].size(), 1);
        CHECK_EQ((int)h.fleet_since(f["t"][0].get<double>())["t"].size(), 0);
    }
}

TEST(a_restarted_model_yields_no_rate_across_the_restart) {
    History h;
    h.model_sample("m", stats(7, 5000, 9e10, 400), 10.0);
    h.model_sample("m", stats(8, 10, 2.2e8, 1), 11.0);        /* started_at moved: counters began again */
    json j = h.model_since("m", 0);
    CHECK(!j["c"].contains("step"));
    h.model_sample("m", stats(8, 20, 4.4e8, 3), 12.0);
    j = h.model_since("m", 0);
    CHECK_EQ(j["c"]["step"][2].get<double>(), 22.0);
    CHECK_EQ(j["c"]["reqRate"][2].get<double>(), 2.0);
    h.forget("m");
    CHECK_EQ((int)h.model_since("m", 0)["t"].size(), 0);
}

TEST(a_body_carries_the_latest_sample_s_object_as_live) {
    History h;
    CHECK_EQ(h.fleet_body(0), R"({"keep_s":3600,"t":[],"c":{},"live":null})");
    const json s = stats(7, 100, 2.2e9, 10);
    h.model_sample("m", s, 10.0, R"({"decode_tps":120.5})");
    json b = json::parse(h.model_body("m", 0));
    CHECK_EQ(b["live"]["decode_tps"].get<double>(), 120.5);
    CHECK_EQ((int)b["t"].size(), 1);
    /* A model that is not open keeps its history and has no live object. */
    h.model_closed("m");
    b = json::parse(h.model_body("m", 0));
    CHECK(b["live"].is_null());
    CHECK_EQ((int)b["t"].size(), 1);
    CHECK(json::parse(h.model_body("unknown", 0))["live"].is_null());
}

RAD_TEST_MAIN()
