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

namespace {
int key_index(const json& keys, const std::string& name) {
    for (size_t i = 0; i < keys.size(); ++i)
        if (keys[i].is_string() && keys[i].get<std::string>() == name) return (int)i;
    return -1;
}
}  // namespace

TEST(multi_model_global_n_survives_restart_and_ignores_tmp_and_torn_lines) {
    const std::string dir = temp_dir();
    REQUIRE(!dir.empty());
    {
        History h;
        h.set_dir(dir);
        h.request_done("qwen27b", json::parse(R"({"t0":1000,"t1":1100,"model":"rad"})"));
        h.request_done("qwen3-asr", json::parse(R"({"t0":1050,"t1":1200,"model":"qwen3-asr","kind":"asr","audio_s":3.5})"));
        h.request_done("qwen-image-turbo", json::parse(R"({"t0":1100,"t1":1300,"model":"qwen-image-turbo","kind":"image"})"));
    }
    /* A leftover .jsonl.tmp file and a torn last line without '\n' must be ignored at startup. */
    {
        std::ofstream tmp(dir + "/qwen27b.jsonl.tmp");
        tmp << "{\"n\":99999,\"t1\":99999}\n";
    }
    {
        std::ofstream torn(dir + "/qwen3-asr.jsonl", std::ios::app);
        torn << "{\"n\":88888,\"t1\":";
    }

    History h;
    h.set_dir(dir);
    h.request_done("qwen27b", json::parse(R"({"t0":1400,"t1":1500,"model":"qwen27b"})"));

    const json page = json::parse(h.requests_page(RequestsQuery{}));
    const json& keys = page["keys"];
    const int i_n = key_index(keys, "n");
    const int i_fm = key_index(keys, "fm");
    const int i_model = key_index(keys, "model");
    const int i_kind = key_index(keys, "kind");
    const int i_audio = key_index(keys, "audio_s");
    REQUIRE(i_n >= 0 && i_fm >= 0 && i_model >= 0 && i_kind >= 0 && i_audio >= 0);
    CHECK_EQ(page["total"].get<int64_t>(), (int64_t)4);
    CHECK(!page["has_more"].get<bool>());
    CHECK_EQ(page["min_n"].get<int64_t>(), (int64_t)1);
    REQUIRE_EQ((int)page["rows"].size(), 4);
    CHECK_EQ(page["rows"][0][i_n].get<int64_t>(), (int64_t)1);
    CHECK_EQ(page["rows"][0][i_fm].get<std::string>(), "qwen27b");
    CHECK_EQ(page["rows"][0][i_model].get<std::string>(), "rad");
    CHECK_EQ(page["rows"][0][i_kind].get<std::string>(), "chat");
    CHECK_EQ(page["rows"][1][i_n].get<int64_t>(), (int64_t)2);
    CHECK_EQ(page["rows"][1][i_fm].get<std::string>(), "qwen3-asr");
    CHECK_EQ(page["rows"][1][i_kind].get<std::string>(), "asr");
    CHECK_EQ(page["rows"][1][i_audio].get<double>(), 3.5);
    CHECK_EQ(page["rows"][2][i_n].get<int64_t>(), (int64_t)3);
    CHECK_EQ(page["rows"][2][i_fm].get<std::string>(), "qwen-image-turbo");
    CHECK_EQ(page["rows"][2][i_kind].get<std::string>(), "image");
    /* Global monotonic n resumed at 4 (not 88889 or 100000). */
    CHECK_EQ(page["rows"][3][i_n].get<int64_t>(), (int64_t)4);
    CHECK_EQ(page["rows"][3][i_fm].get<std::string>(), "qwen27b");
    remove_dir(dir);
}

TEST(unknown_model_lookup_does_not_pollute_logs) {
    const std::string dir = temp_dir();
    REQUIRE(!dir.empty());
    History h;
    h.set_dir(dir);
    h.request_done("qwen27b", json::parse(R"({"t0":100,"t1":200})"));

    CHECK_EQ((int)h.model_since("ghost", 0)["requests"].size(), 0);
    CHECK_EQ((int)json::parse(h.model_body("ghost", 0))["requests"].size(), 0);
    RequestsQuery gq;
    gq.model = "ghost";
    const json gp = json::parse(h.requests_page(gq));
    CHECK_EQ((int)gp["rows"].size(), 0);
    CHECK_EQ(gp["total"].get<int64_t>(), (int64_t)0);
    CHECK(!gp["has_more"].get<bool>());
    CHECK_EQ(gp["min_n"].get<int64_t>(), (int64_t)0);

    const json all = json::parse(h.requests_page(RequestsQuery{}));
    CHECK_EQ((int)all["rows"].size(), 1);
    CHECK_EQ(all["total"].get<int64_t>(), (int64_t)1);
    remove_dir(dir);
}

TEST(requests_page_paging_filtering_fields_and_legacy_backfill) {
    const std::string dir = temp_dir();
    REQUIRE(!dir.empty());
    /* Legacy lines without fm or kind across two models. */
    {
        std::ofstream a(dir + "/m1.jsonl");
        a << "{\"n\":1,\"t0\":1000,\"t1\":1100,\"dms\":50}\n";
        a << "{\"n\":3,\"t0\":1200,\"t1\":1300,\"dms\":60}\n";
        a << "{\"n\":5,\"t0\":1400,\"t1\":1500,\"dms\":70}\n";
        std::ofstream b(dir + "/m2.jsonl");
        b << "{\"n\":2,\"t0\":1100,\"t1\":1200,\"dms\":80}\n";
        b << "{\"n\":4,\"t0\":1300,\"t1\":1400,\"dms\":90}\n";
        b << "{\"n\":6,\"t0\":1500,\"t1\":1600,\"dms\":100}\n";
    }
    History h;
    h.set_dir(dir);

    /* Newest page of 2. */
    RequestsQuery q1;
    q1.limit = 2;
    const json p1 = json::parse(h.requests_page(q1));
    const int i_n = key_index(p1["keys"], "n");
    const int i_fm = key_index(p1["keys"], "fm");
    const int i_kind = key_index(p1["keys"], "kind");
    REQUIRE(i_n >= 0 && i_fm >= 0 && i_kind >= 0);
    CHECK_EQ(p1["total"].get<int64_t>(), (int64_t)6);
    CHECK(p1["has_more"].get<bool>());
    CHECK_EQ(p1["min_n"].get<int64_t>(), (int64_t)5);
    REQUIRE_EQ((int)p1["rows"].size(), 2);
    CHECK_EQ(p1["rows"][0][i_n].get<int64_t>(), (int64_t)5);
    CHECK_EQ(p1["rows"][0][i_fm].get<std::string>(), "m1");
    CHECK_EQ(p1["rows"][0][i_kind].get<std::string>(), "chat");
    CHECK_EQ(p1["rows"][1][i_n].get<int64_t>(), (int64_t)6);
    CHECK_EQ(p1["rows"][1][i_fm].get<std::string>(), "m2");

    /* Older page via before_n=5. */
    RequestsQuery q2;
    q2.limit = 2;
    q2.before_n = p1["min_n"].get<int64_t>();
    const json p2 = json::parse(h.requests_page(q2));
    CHECK(p2["has_more"].get<bool>());
    CHECK_EQ(p2["min_n"].get<int64_t>(), (int64_t)3);
    REQUIRE_EQ((int)p2["rows"].size(), 2);
    CHECK_EQ(p2["rows"][0][i_n].get<int64_t>(), (int64_t)3);
    CHECK_EQ(p2["rows"][1][i_n].get<int64_t>(), (int64_t)4);

    /* Final older page via before_n=3. */
    RequestsQuery q3;
    q3.limit = 2;
    q3.before_n = p2["min_n"].get<int64_t>();
    const json p3 = json::parse(h.requests_page(q3));
    CHECK(!p3["has_more"].get<bool>());
    CHECK_EQ(p3["min_n"].get<int64_t>(), (int64_t)1);
    REQUIRE_EQ((int)p3["rows"].size(), 2);
    CHECK_EQ(p3["rows"][0][i_n].get<int64_t>(), (int64_t)1);
    CHECK_EQ(p3["rows"][1][i_n].get<int64_t>(), (int64_t)2);

    /* Gap catch-up via after_n=3 (with limit=2 takes oldest 2 after 3: n=4, 5). */
    RequestsQuery qa;
    qa.after_n = 3;
    qa.limit = 2;
    const json pa = json::parse(h.requests_page(qa));
    CHECK(pa["has_more"].get<bool>());
    REQUIRE_EQ((int)pa["rows"].size(), 2);
    CHECK_EQ(pa["rows"][0][i_n].get<int64_t>(), (int64_t)4);
    CHECK_EQ(pa["rows"][1][i_n].get<int64_t>(), (int64_t)5);

    /* Time-range + fields subset (ignoring unknown fields). */
    RequestsQuery qt;
    qt.t_from = 1250;
    qt.t_to = 1350;
    qt.fields = { "t0", "t1", "dms", "fm", "not_a_real_key" };
    const json pt = json::parse(h.requests_page(qt));
    REQUIRE_EQ((int)pt["keys"].size(), 4);
    CHECK_EQ(pt["keys"][0].get<std::string>(), "t0");
    CHECK_EQ(pt["keys"][1].get<std::string>(), "t1");
    CHECK_EQ(pt["keys"][2].get<std::string>(), "dms");
    CHECK_EQ(pt["keys"][3].get<std::string>(), "fm");
    /* Overlapping [1250, 1350]: n=3 [1200,1300] (t1=1300>=1250, t0=1200<=1350) and n=4 [1300,1400]. */
    REQUIRE_EQ((int)pt["rows"].size(), 2);
    CHECK_EQ(pt["rows"][0][3].get<std::string>(), "m1");
    CHECK_EQ(pt["rows"][1][3].get<std::string>(), "m2");
    remove_dir(dir);
}

TEST(handle_history_requests_enforces_operator_ok_for_all_and_single_model) {
    History h;
    h.request_done("qwen27b", json::parse(R"({"t0":100,"t1":200})"));
    h.request_done("qwen3-asr", json::parse(R"({"t0":200,"t1":300,"kind":"asr"})"));

    HttpRequest req_all;
    req_all.path = "/history/requests";
    const HttpResponse r_all_403 = handle_history_requests(h, req_all, false);
    CHECK_EQ(r_all_403.status, 403);
    CHECK_EQ(json::parse(r_all_403.body)["error"]["type"].get<std::string>(), "permission_error");

    HttpRequest req_model;
    req_model.path = "/history/requests";
    req_model.query["model"] = "qwen27b";
    const HttpResponse r_model_403 = handle_history_requests(h, req_model, false);
    CHECK_EQ(r_model_403.status, 403);

    const HttpResponse r_all_200 = handle_history_requests(h, req_all, true);
    CHECK_EQ(r_all_200.status, 200);
    CHECK_EQ((int)json::parse(r_all_200.body)["rows"].size(), 2);

    const HttpResponse r_model_200 = handle_history_requests(h, req_model, true);
    CHECK_EQ(r_model_200.status, 200);
    CHECK_EQ((int)json::parse(r_model_200.body)["rows"].size(), 1);

    HttpRequest req_fields;
    req_fields.path = "/history/requests";
    req_fields.query["fields"] = "n,fm,kind";
    req_fields.query["limit"] = "1";
    const HttpResponse r_f = handle_history_requests(h, req_fields, true);
    CHECK_EQ(r_f.status, 200);
    const json jf = json::parse(r_f.body);
    REQUIRE_EQ((int)jf["keys"].size(), 3);
    CHECK(jf["has_more"].get<bool>());
    REQUIRE_EQ((int)jf["rows"].size(), 1);
    CHECK_EQ(jf["rows"][0][1].get<std::string>(), "qwen3-asr");
}

TEST(model_body_and_since_omit_requests_when_not_operator) {
    History h;
    h.request_done("m", json::parse(R"({"t1":1000})"));
    const json s_no = h.model_since("m", 0, false);
    CHECK(!s_no.contains("requests"));
    const json b_no = json::parse(h.model_body("m", 0, false));
    CHECK(!b_no.contains("requests"));
    const json b_yes = json::parse(h.model_body("m", 0, true));
    REQUIRE(b_yes.contains("requests"));
    CHECK_EQ((int)b_yes["requests"].size(), 1);
}

TEST(fleet_body_activity_returns_non_adapter_model_stats_tail_and_oldest_n) {
    History h;
    const json s = stats(7, 100, 2.2e9, 10);
    h.model_sample("qwen27b", s, 10.0, R"({"decode_tps":68.5})");
    h.model_sample("qwen27b:lora", s, 10.0, R"({"decode_tps":68.5})");
    h.model_sample("qwen3-asr", s, 10.0, R"({"decode_tps":12.0})");
    h.fleet_sample(json::parse(R"({"models":[],"cards":[]})"), 10.0, R"({"models":[]})");

    h.request_done("qwen27b", json::parse(R"({"t1":1000})"));
    h.request_done("qwen3-asr", json::parse(R"({"t1":1100,"kind":"asr"})"));
    h.request_done("qwen27b", json::parse(R"({"t1":1200})"));

    /* When include_activity == false, matches plain fleet_body(0). */
    CHECK_EQ(h.fleet_body(0, false, 0, {"qwen27b"}), h.fleet_body(0));

    const json a1 = json::parse(h.fleet_body(0, true, 1, {"qwen27b", "qwen3-asr"}));
    REQUIRE(a1.contains("model_stats"));
    CHECK(a1["model_stats"].contains("qwen27b"));
    CHECK(a1["model_stats"].contains("qwen3-asr"));
    CHECK(!a1["model_stats"].contains("qwen27b:lora"));
    CHECK_EQ(a1["model_stats"]["qwen27b"]["decode_tps"].get<double>(), 68.5);
    CHECK_EQ(a1["oldest_n"].get<int64_t>(), (int64_t)0);
    REQUIRE_EQ((int)a1["requests"].size(), 2);
    CHECK_EQ(a1["requests"][0]["n"].get<int64_t>(), (int64_t)2);
    CHECK_EQ(a1["requests"][1]["n"].get<int64_t>(), (int64_t)3);

    /* Exceed kRequests in qwen27b so its ring evicts older records -> oldest_n reports front n. */
    for (int i = 0; i < History::kRequests + 10; ++i)
        h.request_done("qwen27b", json::parse(R"({"t1":)" + std::to_string(2000 + i) + "}"));
    /* Total requests in qwen27b: 2 + (500 + 10) = 512. Evicted: 12 (n=1, 3, 4..13).
     * Oldest kept in qwen27b ring is n=14. */
    const json a2 = json::parse(h.fleet_body(0, true, 500, {"qwen27b", "qwen3-asr"}));
    CHECK_EQ(a2["oldest_n"].get<int64_t>(), (int64_t)14);
    CHECK(!a2["requests"].empty());
    CHECK_EQ(a2["requests"][0]["n"].get<int64_t>(), (int64_t)501);
}

TEST(request_done_handles_invalid_utf8_without_throwing) {
    const std::string dir = temp_dir();
    REQUIRE(!dir.empty());
    History h;
    h.set_dir(dir);
    json rec = json::object();
    rec["t1"] = 1000;
    rec["err"] = std::string("bad\xff\xfe\x80utf8");
    rec["ua"] = std::string("agent\xc3");
    h.request_done("qwen27b", std::move(rec));

    const json m = h.model_since("qwen27b", 0);
    REQUIRE_EQ((int)m["requests"].size(), 1);
    const std::string dumped = m.dump();
    CHECK(dumped.find("\xef\xbf\xbd") != std::string::npos);

    const json page = json::parse(h.requests_page(RequestsQuery{}));
    REQUIRE_EQ((int)page["rows"].size(), 1);
    const json fl = json::parse(h.fleet_body(0, true, 0, {"qwen27b"}));
    REQUIRE_EQ((int)fl["requests"].size(), 1);
    remove_dir(dir);
}

RAD_TEST_MAIN()
