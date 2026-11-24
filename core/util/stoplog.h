/* stoplog.h -- Brilliance: the stop journal, a durable record of a server's stop, step by step.
 *
 * Why: a Ctrl-Break during a long four-card prefill hard-locked the test machine once (win/SUPPORT.md,
 * known issue 12). A hard lock leaves no crash dump and loses whatever the operating system still
 * held in its file cache, so the server's own log ends wherever the cache last reached the disk.
 * The journal writes each record through to the disk before the stop goes on (Windows:
 * FILE_FLAG_WRITE_THROUGH and FlushFileBuffers; elsewhere fdatasync), so after a lock it holds every
 * step of the stop up to the last one that completed, and the step that was still running.
 *
 * What it records follows the bounded stop contract (win/SUPPORT.md, "Stopping a multi-card
 * server"): the stop's cause, each step's begin and end with its time and whether it kept its bound,
 * what each model was doing when the stop came (idle, prefill, decode), how each rank thread left
 * its loop, whether each rank's streams had drained before the engine waits on them, and each
 * release of memory and cards. While a step runs past its bound, a watcher thread records that it
 * is still waiting, at 1x, 2x, 4x ... the bound, so a step that never ends is named too.
 *
 * Off unless BRILLIANCE_STOP_LOG names a file, or an existing directory (the journal is then
 * radiance-stop-<pid>.log in it). Off, every call is one relaxed atomic load. On, nothing is
 * written while the server serves: the journal is opened at start (so a stop never depends on
 * creating a file) and written only by the stop and by an engine's teardown. Nothing here is on the
 * step's path.
 *
 * Line format, one record a line (win/tools/stop_log_check.py reads it):
 *   <local date> <local time.ms> t=<ms since armed> tid=<thread> <KIND> <name> [detail]
 * KIND is ARM, STOP, BEGIN, END, WAIT, NOTE or CLOSE. An END's detail starts with
 * "ok|over <elapsed> ms bound <bound> ms" and the step's outcome.
 */
#pragma once

#include <cstdint>
#include <string>

namespace rad::stoplog {

/* The contract's bounds, in milliseconds (win/SUPPORT.md, "Stopping a multi-card server"). A step
 * past its bound is recorded `over`; none of them ends the process (the engine's own limits do:
 * five minutes for a step loop or a held response). */
namespace bound {
constexpr int64_t kLoopExit       = 1000;    /* the fleet's loop sees the stop (100 ms tick) */
constexpr int64_t kHistoryJoin    = 2000;    /* the history thread (200 ms tick) */
constexpr int64_t kOpIdle         = 60000;   /* a model's load or restore in progress gives up */
constexpr int64_t kStepLoopStop   = 10000;   /* the step in flight ends; the step loop returns */
constexpr int64_t kRankJoin       = 10000;   /* every rank thread leaves its loop */
constexpr int64_t kStreamProbe    = 2000;    /* each rank's streams found drained, per rank */
constexpr int64_t kCtxShutdown    = 10000;   /* a rank's streams synced and its arenas freed */
constexpr int64_t kRelease        = 10000;   /* each later release step of an engine */
constexpr int64_t kTeardown       = 60000;   /* one engine's whole teardown */
constexpr int64_t kCacheSave      = 30000;   /* (local) save-on-unload KV cache snapshot */
constexpr int64_t kFrontStop      = 5000;    /* the listener closes */
}  // namespace bound

/* Opens the journal BRILLIANCE_STOP_LOG names. Unset or empty: off, and false. Once on, later
 * calls do nothing and return true. */
bool arm_from_env();
/* Opens (truncates) `path` and writes the ARM record. False, with the journal off, if it cannot. */
bool arm(const std::string& path);
bool active();
std::string path();

/* The stop begins: a STOP record with `cause`. The first call also starts the watcher thread;
 * later calls only record (a second Ctrl-Break, the fleet's loop seeing the first). */
void begin(const char* cause);
bool begun();

/* A NOTE record: `name` and a printf-style detail. Written through to the disk on return. */
void note(const char* name, const char* fmt = nullptr, ...)
#if defined(__GNUC__) || defined(__clang__)
    __attribute__((format(printf, 2, 3)))
#endif
    ;

/* A bounded step: BEGIN when constructed, END when end() is called or the step goes out of scope.
 * `name` is copied (up to 159 bytes); a space in it is written as '_', so it stays one word. */
class Step {
public:
    Step(const char* name, int64_t bound_ms);
    Step(const std::string& name, int64_t bound_ms) : Step(name.c_str(), bound_ms) {}
    ~Step() { end(); }
    Step(const Step&) = delete;
    Step& operator=(const Step&) = delete;
    /* Ends the step with `outcome` ("ok" by default, or what the step found). Once only. */
    void end(const char* outcome = nullptr);

private:
    int slot_ = -1;
};

/* A CLOSE record with `why`; stops the watcher. Later records are dropped. Also run at exit. */
void finish(const char* why);

/* Tests only: closes the journal and forgets it, so another arm() starts afresh. */
void reset_for_test();

}  // namespace rad::stoplog
