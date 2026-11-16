/* front_test.cpp -- the listener in front of every model (core/server/front.h).
 *
 *   Read     a request's model comes from the query, a form field, or the body's top-level
 *            string, found without parsing the body
 *   Merged   several models' metrics are one exposition, each family declared once
 *   Reads    what the dashboard polls is told apart from requests for work
 *   Jobs     a finished job is answered by its id with no model, until it expires or is deleted
 *   Probes   a bare /ping on several models is the process's liveness; a probe without the key
 *            reads the status alone, and a failed load's reason is the operator's (Brilliance,
 *            LAN F3 and F4); /ping naming a model reads its state and never loads it, with or
 *            without the key (Brilliance, ping-state)
 *
 * Most cases dispatch in process; discovery activity also uses a loopback listener.
 */
#include "server_fakes.h"
#include "cpp-httplib/httplib.h"

#include "server/front.h"

#include <ctime>
#include <string>

using namespace rad;
using namespace rad::server;

TEST(the_top_level_model_string_is_found_without_a_parse) {
    size_t b = 0, e = 0;
    const std::string body =
        R"({"messages":[{"role":"user","content":"say \"model\": no"}],"n":2,"x":{"model":"inner"},)"
        R"( "model" : "qwen:sql", "stream": true})";
    CHECK(json_top_string(body, "model", &b, &e));
    CHECK_EQ(body.substr(b, e - b), "qwen:sql");
    CHECK(!json_top_string(R"({"messages":[]})", "model", &b, &e));
    CHECK(!json_top_string(R"({"model": 3})", "model", &b, &e));
    CHECK(!json_top_string(R"([{"model":"x"}])", "model", &b, &e));
    CHECK(!json_top_string(R"({"model":"unterminated)", "model", &b, &e));
}

TEST(a_request_names_its_model_by_query_form_or_body) {
    HttpRequest q;
    q.body = R"({"model":"a"})";
    CHECK_EQ(Front::requested_model(q), "a");
    q.query["model"] = "b";
    CHECK_EQ(Front::requested_model(q), "b");
    HttpRequest f;
    f.form.push_back(FormPart{ "model", "", "", "whisper" });
    CHECK_EQ(Front::requested_model(f), "whisper");
    HttpRequest esc;
    esc.body = R"({"model":"a\u002db"})";
    CHECK_EQ(Front::requested_model(esc), "a-b");
    CHECK_EQ(Front::requested_model(HttpRequest{}), "");
}

TEST(the_dashboards_reads_do_not_count_as_wanting_a_model) {
    HttpRequest q;
    for (const char* path : { "/stats", "/sessions", "/graph", "/server_info", "/admin/control-vector" }) {
        q.path = path;
        q.method = "GET";
        CHECK(Front::dashboard_read(q));
        /* The router dispatches a doubled or trailing slash to the same route; so must the
         * read's exemption, or the read wakes a model for a slash. */
        q.path = std::string("/") + path;
        CHECK(Front::dashboard_read(q));
        q.path = std::string(path) + "/";
        CHECK(Front::dashboard_read(q));
    }
    q.path = "/admin/control-vector";
    q.method = "POST";
    CHECK(!Front::dashboard_read(q));
    q.path = "/v1/chat/completions";
    CHECK(!Front::dashboard_read(q));
    q.method = "GET";
    q.path = "/v1/videos/abc";
    CHECK(!Front::dashboard_read(q));
}

/* The set that must not wake a model for a caller its handler will refuse: exactly the routes
 * Server::register_routes guards with local_operator keyless, and nothing beside them. */
TEST(guarded_routes_are_the_local_operator_ones) {
    /* guarded_route reads the front's own copied routes, so the decision is made by an
     * instance's matcher -- a Front with no models installed still carries the full route table
     * (its prototype does), which is exactly the set whose handlers guard. */
    Front f(TransportOptions{}, 0);
    HttpRequest q;
    q.method = "GET";    q.path = "/diagnostics";          CHECK(f.guarded_route(q));
    /* The router collapses "//x" and "x/" into "/x" (split_path, http.cpp) -- the guard sees
     * the same path the handler reaches, or a slash buys the wake the guard denies. */
    q.path = "//diagnostics";                              CHECK(f.guarded_route(q));
    q.path = "/diagnostics/";                              CHECK(f.guarded_route(q));
    q.method = "POST";   q.path = "/reset_prefix_cache";   CHECK(f.guarded_route(q));
    q.path = "/admin/control-vector";                      CHECK(f.guarded_route(q));
    q.method = "GET";    q.path = "/admin/control-vector"; CHECK(f.guarded_route(q));
    q.method = "DELETE"; q.path = "/sessions";             CHECK(f.guarded_route(q));
    /* The :label form is registered and guarded next to it (server.cpp); the front must not
     * wake a model for a stranger's DELETE /sessions/whatever either. */
    q.path = "/sessions/abc";                              CHECK(f.guarded_route(q));
    q.method = "POST";   q.path = "/v1/load_lora_adapter"; CHECK(f.guarded_route(q));
    q.path = "/v1/unload_lora_adapter";                    CHECK(f.guarded_route(q));
    /* The rest is unguarded: the open dashboard reads stay as they are, and inference keeps
     * waking its model for whoever asks -- that is what a keyless box is for. */
    q.method = "GET";    q.path = "/sessions";             CHECK(!f.guarded_route(q));
    q.path = "/stats";                                     CHECK(!f.guarded_route(q));
    q.method = "POST";   q.path = "/v1/chat/completions";  CHECK(!f.guarded_route(q));
    q.method = "GET";    q.path = "/v1/models";            CHECK(!f.guarded_route(q));
    /* Shapes the :label pattern cannot match are no route at all, so they wake nothing -- but a
     * trailing slash is not such a shape: the router collapses it to the guarded bare route. */
    q.method = "DELETE"; q.path = "/sessions/";            CHECK(f.guarded_route(q));
    q.path = "/sessions/a/b";                              CHECK(!f.guarded_route(q));
}

TEST(a_finished_job_is_answered_by_its_id_with_no_model) {
    Front f(TransportOptions{}, 0);
    const int64_t later = (int64_t)std::time(nullptr) + 100;
    int asked = 0;
    const Handler answer = [&](const HttpRequest&) { ++asked; return HttpResponse::json_body(200, "{}"); };
    f.keep_job("video_a", later, 8, answer);
    f.keep_job("shape_b", later, 8, answer);
    HttpRequest q;
    q.method = "GET";
    q.path = "/v1/videos/video_a";
    CHECK(f.kept_job(q) != nullptr);
    q.path = "/v1/videos/video_a/content";
    CHECK(f.kept_job(q) != nullptr);
    q.path = "/status/shape_b";
    CHECK(f.kept_job(q) != nullptr);
    /* Another job, a prefix of the id, and a route that names no job. */
    q.path = "/v1/videos/video_b";
    CHECK(f.kept_job(q) == nullptr);
    q.path = "/v1/videos/video_";
    CHECK(f.kept_job(q) == nullptr);
    q.path = "/v1/chat/completions";
    CHECK(f.kept_job(q) == nullptr);
    /* A delete is answered once and forgets it. */
    q.method = "DELETE";
    q.path = "/v1/videos/video_a";
    const Handler del = f.kept_job(q);
    CHECK(del != nullptr);
    CHECK_EQ(del(q).status, 200);
    CHECK_EQ(asked, 1);
    q.method = "GET";
    CHECK(f.kept_job(q) == nullptr);
}

TEST(kept_jobs_expire_and_the_oldest_go_past_the_count) {
    Front f(TransportOptions{}, 0);
    const int64_t now = (int64_t)std::time(nullptr);
    const Handler answer = [](const HttpRequest&) { return HttpResponse::json_body(200, "{}"); };
    HttpRequest q;
    q.method = "GET";
    f.keep_job("old", now - 1, 8, answer);
    q.path = "/v1/videos/old";
    CHECK(f.kept_job(q) == nullptr);
    f.keep_job("a", now + 100, 2, answer);
    f.keep_job("b", now + 100, 2, answer);
    f.keep_job("c", now + 100, 2, answer);
    q.path = "/v1/videos/a";
    CHECK(f.kept_job(q) == nullptr);
    q.path = "/v1/videos/b";
    CHECK(f.kept_job(q) != nullptr);
    q.path = "/v1/videos/c";
    CHECK(f.kept_job(q) != nullptr);
}

TEST(metrics_from_several_models_declare_each_family_once) {
    const std::string a =
        "# HELP rad_requests_total Requests.\n# TYPE rad_requests_total counter\n"
        "rad_requests_total{model_name=\"a\"} 3\n"
        "# HELP rad_step_seconds Step time.\n# TYPE rad_step_seconds histogram\n"
        "rad_step_seconds_bucket{model_name=\"a\",le=\"0.1\"} 1\nrad_step_seconds_sum{model_name=\"a\"} 0.05\n";
    const std::string b =
        "# HELP rad_requests_total Requests.\n# TYPE rad_requests_total counter\n"
        "rad_requests_total{model_name=\"b\"} 5\n";
    const std::string m = merge_metrics({ a, b });
    CHECK_EQ(m,
             "# HELP rad_requests_total Requests.\n# TYPE rad_requests_total counter\n"
             "rad_requests_total{model_name=\"a\"} 3\nrad_requests_total{model_name=\"b\"} 5\n"
             "# HELP rad_step_seconds Step time.\n# TYPE rad_step_seconds histogram\n"
             "rad_step_seconds_bucket{model_name=\"a\",le=\"0.1\"} 1\n"
             "rad_step_seconds_sum{model_name=\"a\"} 0.05\n");
}


/* Exercise the public routes: both cards and collection reads retain the server while they
 * inspect it, but only a request for work changes its idle clock and use count. */
TEST(model_discovery_does_not_restart_the_idle_clock) {
    Fixture model;
    TransportOptions options;
    options.host = "127.0.0.1";
    options.port = 0;
    std::atomic<bool> held_during_description{ false };
    struct Listener {
        Front front;
        std::thread thread;
        explicit Listener(const TransportOptions& options) : front(options, 0) {}
        ~Listener() { front.stop(); if (thread.joinable()) thread.join(); }
    } listener(options);
    Front& front = listener.front;
    front.add("test-model", {}, 100, false);
    front.attach("test-model", {}, model.srv.get());
    front.set_describe([&front, &held_during_description](const std::string& name) {
        held_during_description.store(front.activity(name).leases == 1);
        return std::string("{}");
    });
    listener.thread = std::thread([&] { front.run(); });
    for (int i = 0; i < 200 && !front.port(); ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    CHECK(front.port() > 0);
    if (front.port() <= 0) return;
    httplib::Client client("127.0.0.1", front.port());
    client.set_read_timeout(2, 0);
    const auto before = front.activity("test-model");
    for (const char* path : { "/v1/models", "/models", "/v1/models/test-model" }) {
        const auto response = client.Get(path);
        CHECK(response != nullptr);
        if (!response) continue;
        CHECK_EQ(response->status, 200);
        const json card = json::parse(response->body, nullptr, false);
        CHECK(card.is_object());
        if (std::string(path) == "/v1/models/test-model")
            CHECK_EQ(card.value("id", ""), "test-model");
        else {
            CHECK(card.contains("data"));
            if (card.contains("data")) {
                CHECK(!card["data"].empty());
                if (!card["data"].empty()) CHECK_EQ(card["data"][0].value("id", ""), "test-model");
            }
        }
        const auto after = front.activity("test-model");
        CHECK_EQ(after.uses, before.uses);
        CHECK_EQ(after.last_used_ns, before.last_used_ns);
        CHECK_EQ(after.leases, 0);
    }
    CHECK(held_during_description.load());
    const auto response = client.Post("/v1/completions",
        R"({"model":"test-model","prompt":"hello","max_tokens":2})", "application/json");
    CHECK(response != nullptr);
    if (response) CHECK_EQ(response->status, 200);
    const auto after_work = front.activity("test-model");
    CHECK_EQ(after_work.uses, before.uses + 1);
    CHECK(after_work.last_used_ns >= before.last_used_ns);
    CHECK_EQ(after_work.leases, 0);
}

/* A Front on a loopback listener, torn down before the models it serves. */
namespace {
struct LiveFront {
    Front front;
    std::thread thread;
    explicit LiveFront(const TransportOptions& o) : front(o, 0) {}
    ~LiveFront() { front.stop(); if (thread.joinable()) thread.join(); }
    bool start() {
        thread = std::thread([this] { front.run(); });
        for (int i = 0; i < 200 && !front.port(); ++i)
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        return front.port() > 0;
    }
};

TransportOptions loopback(const char* key = "") {
    TransportOptions o;
    o.host = "127.0.0.1";
    o.port = 0;
    o.api_key = key;
    return o;
}

json body_of(const httplib::Result& r) {
    return r ? json::parse(r->body, nullptr, false) : json();
}
}  /* namespace */

/* Brilliance (LAN F4): /ping is the load balancer's liveness probe. With one model it is that
 * model's answer, as it always was; with several and none named it is the process's, as /health
 * is -- never a 400 a probe reads as down. Naming a model still asks that model. */
TEST(a_bare_ping_on_several_models_is_the_process_liveness) {
    Fixture a, b;
    LiveFront lf(loopback());
    Front& front = lf.front;
    front.add("a", {}, 100, false);
    front.attach("a", {}, a.srv.get());
    REQUIRE(lf.start());
    httplib::Client c("127.0.0.1", front.port());
    c.set_read_timeout(2, 0);
    /* One model: forwarded to it. */
    auto one = c.Get("/ping");
    REQUIRE(one != nullptr);
    CHECK_EQ(one->status, 200);
    CHECK(body_of(one).contains("queue_cap"));
    /* Several. */
    front.add("b", {}, 100, false);
    front.attach("b", {}, b.srv.get());
    for (int post = 0; post < 2; ++post) {
        auto r = post ? c.Post("/ping", "", "application/json") : c.Get("/ping");
        REQUIRE(r != nullptr);
        CHECK_EQ(r->status, 200);
        const json j = body_of(r);
        CHECK_EQ(j.value("status", ""), std::string("ok"));
        CHECK(j.contains("models") && j["models"].contains("a") && j["models"].contains("b"));
    }
    /* Named, by query or body: that model's own answer. */
    auto named = c.Get("/ping?model=b");
    REQUIRE(named != nullptr);
    CHECK_EQ(named->status, 200);
    CHECK(body_of(named).contains("queue_cap"));
    auto by_body = c.Post("/ping", R"({"model":"a"})", "application/json");
    REQUIRE(by_body != nullptr);
    CHECK_EQ(by_body->status, 200);
    CHECK(body_of(by_body).contains("queue_cap"));
    auto unknown = c.Get("/ping?model=nope");
    REQUIRE(unknown != nullptr);
    CHECK_EQ(unknown->status, 404);
    /* A model that must be loaded and is not: the bare probe says so, as /health does. */
    front.add("c", {}, 100, true);
    auto waiting = c.Get("/ping");
    REQUIRE(waiting != nullptr);
    CHECK_EQ(waiting->status, 503);
    CHECK_EQ(body_of(waiting).value("status", ""), std::string("loading"));
}

/* Brilliance (LAN F3): on a keyed server the probes answer a caller without the key the status
 * alone -- no model names, states, load, or a failed load's reason -- with the code the key holder
 * gets, so a load balancer reads the same verdict. The key holder reads everything. */
TEST(a_probe_without_the_key_reads_no_models_or_reasons) {
    Fixture a;
    LiveFront lf(loopback("k"));
    Front& front = lf.front;
    const std::string why = "startup failed: D:/models/secret/b.rad not found";
    front.add("a", {}, 100, false);
    front.attach("a", {}, a.srv.get());
    front.add("b", {}, 100, false);
    front.fail("b", why, 3600 * 1000);
    front.set_describe([&](const std::string& n) {
        return n == "b" ? json{{"error", why}}.dump() : std::string("{}");
    });
    REQUIRE(lf.start());
    httplib::Client c("127.0.0.1", front.port());
    c.set_read_timeout(2, 0);
    const httplib::Headers none, wrong = {{"Authorization", "Bearer nope"}},
                                 key = {{"Authorization", "Bearer k"}};
    for (const httplib::Headers* h : { &none, &wrong }) {
        for (const char* p : { "/health", "/v1/health", "/ping" }) {
            auto r = c.Get(p, *h);
            REQUIRE(r != nullptr);
            CHECK_EQ(r->status, 200);
            CHECK_EQ(r->body, std::string(R"({"status":"ok"})"));
        }
        auto post = c.Post("/ping", *h, "", "application/json");
        REQUIRE(post != nullptr);
        CHECK_EQ(post->body, std::string(R"({"status":"ok"})"));
        auto open = c.Get("/health?model=a", *h);
        REQUIRE(open != nullptr);
        CHECK_EQ(open->status, 200);
        CHECK_EQ(open->body, std::string(R"({"status":"ok"})"));
        auto failed = c.Get("/health?model=b", *h);
        REQUIRE(failed != nullptr);
        CHECK_EQ(failed->status, 503);
        CHECK_EQ(failed->body, std::string(R"({"status":"failed"})"));
        auto ping_failed = c.Get("/ping?model=b", *h);
        REQUIRE(ping_failed != nullptr);
        CHECK_EQ(ping_failed->status, 503);
        CHECK(!has(ping_failed->body, "secret"));
        auto models = c.Get("/v1/models", *h);
        REQUIRE(models != nullptr);
        CHECK_EQ(models->status, 401);
    }
    auto whole = c.Get("/health", key);
    REQUIRE(whole != nullptr);
    CHECK_EQ(whole->status, 200);
    const json w = body_of(whole);
    CHECK(w.contains("models") && w["models"].value("b", "") == "failed");
    auto failed = c.Get("/health?model=b", key);
    REQUIRE(failed != nullptr);
    CHECK_EQ(failed->status, 503);
    CHECK_EQ(body_of(failed).value("error", ""), why);
    CHECK_EQ(body_of(failed).value("model", ""), std::string("b"));
    auto ping_failed = c.Get("/ping?model=b", key);
    REQUIRE(ping_failed != nullptr);
    CHECK(has(ping_failed->body, "secret"));
    auto open = c.Get("/health?model=a", key);
    REQUIRE(open != nullptr);
    CHECK(body_of(open).contains("queue_cap"));
    auto models = c.Get("/v1/models", key);
    REQUIRE(models != nullptr);
    CHECK(has(models->body, "secret"));
}

/* Brilliance (LAN F3): a keyless server's states are public, as its /v1/models is, but a failed
 * load's reason is the operator's: the three-leg rule decides, as lease() already did for the
 * request a failed model refuses. */
TEST(a_stranger_reads_no_failure_reason_on_a_keyless_server) {
    LiveFront lf(loopback());
    Front& front = lf.front;
    const std::string why = "startup failed: D:/models/secret/b.rad not found";
    front.add("b", {}, 100, false);
    front.fail("b", why, 3600 * 1000);
    front.set_describe([&](const std::string&) { return json{{"error", why}}.dump(); });
    front.set_operator_rule([](const HttpRequest& q) { return local_operator(q, "0.0.0.0", {}); });
    REQUIRE(lf.start());
    httplib::Client c("127.0.0.1", front.port());
    c.set_read_timeout(2, 0);
    const std::string port = std::to_string(front.port());
    const httplib::Headers lan = {{"Host", "192.168.1.50:" + port}},
                           box = {{"Host", "127.0.0.1:" + port}};
    auto h = c.Get("/health?model=b", lan);
    REQUIRE(h != nullptr);
    CHECK_EQ(h->status, 503);
    CHECK_EQ(body_of(h).value("status", ""), std::string("failed"));
    CHECK_EQ(body_of(h).value("model", ""), std::string("b"));
    CHECK(!has(h->body, "secret"));
    auto m = c.Get("/v1/models", lan);
    REQUIRE(m != nullptr);
    CHECK_EQ(m->status, 200);
    CHECK(has(m->body, "\"failed\""));
    CHECK(!has(m->body, "secret"));
    auto all = c.Get("/health", lan);
    REQUIRE(all != nullptr);
    CHECK(body_of(all).contains("models"));
    auto ho = c.Get("/health?model=b", box);
    REQUIRE(ho != nullptr);
    CHECK_EQ(body_of(ho).value("error", ""), why);
    auto mo = c.Get("/v1/models", box);
    REQUIRE(mo != nullptr);
    CHECK(has(mo->body, "secret"));
}

/* Brilliance (ping-state): /ping naming a model is /health?model= for it -- the state the fleet is
 * in, never a load. A cold, parked or failed model (its retry time past) stays as it is: the
 * fleet's demand hook, which is how it loads, is never called, and the probe is not counted as a
 * use. A keyed server's stranger reads the status alone, the key holder the model and the reason.
 * A request for work still asks for the load, so the counter is live. */
TEST(a_ping_naming_a_model_reads_its_state_and_never_loads_it) {
    for (int keyed = 0; keyed < 2; ++keyed) {
        Fixture a;
        LiveFront lf(loopback(keyed ? "k" : ""));
        Front& front = lf.front;
        const std::string why = "startup failed: D:/models/secret/f.rad not found";
        std::atomic<int> demands{ 0 };
        front.set_demand([&](const std::string&) { ++demands; });
        front.add("a", {}, 100, false);
        front.attach("a", {}, a.srv.get());
        front.add("cold", {}, 100, false);
        front.add("park", {}, 100, false);
        front.set_parked("park", true);
        front.add("f", {}, 100, false);
        front.fail("f", why, 0);   /* its retry time is now: a request for work would reload it */
        REQUIRE(lf.start());
        httplib::Client c("127.0.0.1", front.port());
        c.set_read_timeout(2, 0);
        const httplib::Headers none, wrong = {{"Authorization", "Bearer nope"}},
                                     key = {{"Authorization", "Bearer k"}};
        std::vector<const httplib::Headers*> callers = { &none };
        if (keyed) callers = { &none, &wrong, &key };
        const auto before = front.activity("a");
        for (const httplib::Headers* h : callers) {
            const bool stranger = keyed && h != &key;
            struct Want { const char* name; const char* state; };
            for (const Want w : { Want{ "cold", "cold" }, Want{ "park", "parked" }, Want{ "f", "failed" } }) {
                const std::string q = std::string("/ping?model=") + w.name;
                const std::string body = std::string(R"({"model":")") + w.name + "\"}";
                const httplib::Result rs[] = {
                    c.Get(q, *h), c.Post(q, *h, "", "application/json"),
                    c.Post("/ping", *h, body, "application/json"),
                };
                for (const httplib::Result& r : rs) {
                    REQUIRE(r != nullptr);
                    CHECK_EQ(r->status, 503);
                    const json j = body_of(r);
                    CHECK_EQ(j.value("status", ""), std::string(w.state));
                    if (stranger) {
                        CHECK_EQ(r->body, std::string(R"({"status":")") + w.state + "\"}");
                    } else {
                        CHECK_EQ(j.value("model", ""), std::string(w.name));
                    }
                    /* The reason is the operator's: the key holder (keyed) or the box (the
                     * front's own tests wire no operator rule, so a keyless caller is one). */
                    CHECK_EQ(has(r->body, "secret"), !stranger && std::string(w.name) == "f");
                }
                /* The same answer /health?model= gives. */
                auto h2 = c.Get(std::string("/health?model=") + w.name, *h);
                REQUIRE(h2 != nullptr);
                CHECK_EQ(h2->status, 503);
                CHECK_EQ(body_of(h2).value("status", ""), std::string(w.state));
            }
            CHECK_EQ(demands.load(), 0);
            CHECK(front.activity("cold").state == Front::State::Cold);
            CHECK(front.activity("park").state == Front::State::Parked);
            CHECK(front.activity("f").state == Front::State::Failed);
            /* An open model: its own answer, and no use counted. */
            auto open = c.Get("/ping?model=a", *h);
            REQUIRE(open != nullptr);
            CHECK_EQ(open->status, 200);
            if (stranger) CHECK_EQ(open->body, std::string(R"({"status":"ok"})"));
            else CHECK(body_of(open).contains("queue_cap"));
            auto unknown = c.Get("/ping?model=nope", *h);
            REQUIRE(unknown != nullptr);
            CHECK_EQ(unknown->status, 404);
            CHECK(!has(unknown->body, "cold"));   /* no list of what is served */
        }
        const auto after = front.activity("a");
        CHECK_EQ(after.uses, before.uses);
        CHECK_EQ(after.last_used_ns, before.last_used_ns);
        CHECK_EQ(after.leases, 0);
        CHECK_EQ(demands.load(), 0);
        /* A request for work does ask for the load (and times out here: nothing loads it). */
        const httplib::Headers& worker = keyed ? key : none;
        auto work = c.Post("/v1/completions", worker,
                           R"({"model":"cold","prompt":"hi","max_tokens":1})", "application/json");
        REQUIRE(work != nullptr);
        CHECK_EQ(work->status, 503);
        CHECK(demands.load() > 0);
    }
}

/* Brilliance (ping-state): a bare /ping on a one-model fleet asks of the process. While the model
 * is open it is the model's own answer, as before; while it is cold or parked it is the process
 * /health answer -- 200 when nothing must be loaded, 503 "loading" when the model must (pinned or
 * preloaded) -- and the model is never loaded, with or without the key. A model that sits cold
 * until a request brings it back is not a process a load balancer should take out of rotation. */
TEST(a_bare_ping_on_one_model_reads_the_process_and_never_loads_it) {
    for (int keyed = 0; keyed < 2; ++keyed) {
        for (int required = 0; required < 2; ++required) {
            Fixture solo;
            LiveFront lf(loopback(keyed ? "k" : ""));
            Front& front = lf.front;
            std::atomic<int> demands{ 0 };
            front.set_demand([&](const std::string&) { ++demands; });
            front.add("solo", {}, 100, required != 0);
            REQUIRE(lf.start());
            httplib::Client c("127.0.0.1", front.port());
            c.set_read_timeout(2, 0);
            const httplib::Headers none, key = {{"Authorization", "Bearer k"}};
            std::vector<const httplib::Headers*> callers = { &none };
            if (keyed) callers = { &none, &key };
            for (int parked = 0; parked < 2; ++parked) {
                front.set_parked("solo", parked != 0);
                for (const httplib::Headers* h : callers) {
                    const bool stranger = keyed && h == &none;
                    for (int post = 0; post < 2; ++post) {
                        auto r = post ? c.Post("/ping", *h, "", "application/json") : c.Get("/ping", *h);
                        REQUIRE(r != nullptr);
                        const std::string status = required ? "loading" : "ok";
                        CHECK_EQ(r->status, required ? 503 : 200);
                        if (stranger) {
                            CHECK_EQ(r->body, std::string(R"({"status":")") + status + "\"}");
                        } else {
                            const json j = body_of(r);
                            CHECK_EQ(j.value("status", ""), status);
                            CHECK(j.contains("models") && j["models"].contains("solo"));
                        }
                    }
                }
                CHECK_EQ(demands.load(), 0);
                CHECK(front.activity("solo").state == (parked ? Front::State::Parked : Front::State::Cold));
            }
            /* Open: the model's own answer, and the probe is not a use of it. */
            front.set_parked("solo", false);
            front.attach("solo", {}, solo.srv.get());
            const auto before = front.activity("solo");
            for (const httplib::Headers* h : callers) {
                auto r = c.Get("/ping", *h);
                REQUIRE(r != nullptr);
                CHECK_EQ(r->status, 200);
                if (keyed && h == &none) CHECK_EQ(r->body, std::string(R"({"status":"ok"})"));
                else CHECK(body_of(r).contains("queue_cap"));
            }
            const auto after = front.activity("solo");
            CHECK_EQ(after.uses, before.uses);
            CHECK_EQ(after.last_used_ns, before.last_used_ns);
            CHECK_EQ(after.leases, 0);
            CHECK_EQ(demands.load(), 0);
        }
    }
}

RAD_TEST_MAIN()

/* Local patch 0031: llama-swap's /upstream/<model>/<rest>. */
TEST(an_upstream_path_is_the_rest_for_that_model) {
    HttpRequest q;
    q.method = "GET";
    q.path = "/upstream/rad/stats";
    Front::upstream_rewrite(q, "rad", "stats");
    CHECK_EQ(q.path, "/stats");
    CHECK_EQ(Front::requested_model(q), "rad");
    CHECK(Front::dashboard_read(q));
    HttpRequest c;
    c.method = "POST";
    c.body = R"({"model":"other"})";
    Front::upstream_rewrite(c, "qwen27b", "v1/chat/completions");
    CHECK_EQ(c.path, "/v1/chat/completions");
    CHECK_EQ(Front::requested_model(c), "qwen27b");
}
