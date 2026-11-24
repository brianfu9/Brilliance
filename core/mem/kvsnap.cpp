/* kvsnap.cpp -- save-on-unload / load-on-bringup KV prefix cache snapshot (local). */
#include "mem/kvsnap.h"

#include "device/directio.h"
#include "rad_internal.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <errno.h>
#include <filesystem>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include "os/os.h"
#include <io.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace rad {

namespace {

constexpr uint32_t kMagicHead = 0x53564B52u; /* "RKVS" */
constexpr uint32_t kMagicFoot = 0x524B5653u; /* "SVKR" */
constexpr uint32_t kVersion   = 1u;
constexpr uint64_t kAlign     = 4096ull;
constexpr uint64_t kMaxMeta   = 512ull << 20;
constexpr uint64_t kRestoredSessionBase = 1ull << 62;

struct SnapHeader {
    uint32_t magic;
    uint32_t version;
    uint64_t fingerprint;
    uint64_t saved_wall_ns;
    int64_t  block_size;
    int64_t  entry_bytes;
    int64_t  ckpt_bytes;
    int64_t  checkpoint_interval;
    uint64_t n_entries;
    uint64_t n_ckpts;
    uint64_t n_sessions;
    uint64_t meta_bytes;
    uint64_t meta_checksum;
    uint64_t entry_data_off;
    uint64_t ckpt_data_off;
    uint64_t total_bytes;
    uint64_t reserved;
};
static_assert(sizeof(SnapHeader) == 128, "SnapHeader must be 128 bytes");

struct SnapFooter {
    uint32_t magic;
    uint32_t version;
    uint64_t total_bytes;
};
static_assert(sizeof(SnapFooter) == 16, "SnapFooter must be 16 bytes");

uint64_t wall_now_ns() {
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    const auto ns = std::chrono::duration_cast<std::chrono::nanoseconds>(now).count();
    return ns > 0 ? (uint64_t)ns : 0ull;
}

uint64_t align_up_u64(uint64_t v, uint64_t a) {
    return (v + a - 1) & ~(a - 1);
}

int seek64(FILE* f, int64_t off, int whence) {
#if defined(_WIN32)
    return _fseeki64(f, off, whence);
#else
    return fseeko(f, (off_t)off, whence);
#endif
}

int64_t tell64(FILE* f) {
#if defined(_WIN32)
    return (int64_t)_ftelli64(f);
#else
    return (int64_t)ftello(f);
#endif
}

bool sync_direct(const DirectFile& df) {
#if defined(_WIN32)
    return df.file().sync() == 0;
#else
    return ::fsync(df.fd()) == 0;
#endif
}

bool atomic_replace(const std::string& tmp, const std::string& dst) {
#if defined(_WIN32)
    return MoveFileExA(tmp.c_str(), dst.c_str(),
                       MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
    return std::rename(tmp.c_str(), dst.c_str()) == 0;
#endif
}

struct AlignedBuf {
    uint8_t* ptr = nullptr;
    size_t   cap = 0;

    AlignedBuf() = default;
    ~AlignedBuf() { reset(); }
    AlignedBuf(const AlignedBuf&) = delete;
    AlignedBuf& operator=(const AlignedBuf&) = delete;

    bool alloc(size_t bytes) {
        reset();
        const size_t A = (size_t)DirectFile::alignment();
        const size_t n = (bytes + A - 1) & ~(A - 1);
#if defined(_WIN32)
        ptr = static_cast<uint8_t*>(os::aligned_alloc(A, n));
#else
        void* p = nullptr;
        if (posix_memalign(&p, A, n) == 0) ptr = static_cast<uint8_t*>(p);
#endif
        if (!ptr) return false;
        cap = n;
        return true;
    }

    void reset() {
        if (!ptr) return;
#if defined(_WIN32)
        os::aligned_free(ptr);
#else
        std::free(ptr);
#endif
        ptr = nullptr;
        cap = 0;
    }
};

/* Sequential O_DIRECT / FILE_FLAG_NO_BUFFERING writer with a 16 MiB aligned staging buffer.
 * Large page-aligned payloads (e.g. 153 MiB checkpoints) bypass the staging buffer and stream
 * straight from pinned HostArena memory; scattered smaller blocks coalesce into 16 MiB aligned
 * writes so unloading never pollutes the OS page cache. */
struct DirectWriter {
    static constexpr size_t kChunk = 16u << 20;
    DirectFile& df;
    AlignedBuf  stage;
    size_t      used = 0;
    int64_t     off  = 0;

    explicit DirectWriter(DirectFile& f) : df(f) {}

    bool init() { return stage.alloc(kChunk); }

    bool flush_stage() {
        if (used == 0) return true;
        if (df.write_at(stage.ptr, off, (int64_t)used) != RAD_OK) return false;
        off += (int64_t)used;
        used = 0;
        return true;
    }

    bool write(const void* src, size_t n) {
        if (n == 0) return true;
        const size_t A = (size_t)DirectFile::alignment();
        const auto* p = static_cast<const uint8_t*>(src);
        if (used == 0 && n >= (4u << 20) &&
            ((uintptr_t)p % A) == 0 && (n % A) == 0 && (off % (int64_t)A) == 0) {
            while (n > 0) {
                const size_t step = std::min(n, kChunk);
                if (df.write_at(p, off, (int64_t)step) != RAD_OK) return false;
                p += step;
                off += (int64_t)step;
                n -= step;
            }
            return true;
        }
        while (n > 0) {
            const size_t room = stage.cap - used;
            const size_t step = std::min(n, room);
            std::memcpy(stage.ptr + used, p, step);
            used += step;
            p += step;
            n -= step;
            if (used == stage.cap && !flush_stage()) return false;
        }
        return true;
    }

    bool write_zeros(uint64_t n) {
        while (n > 0) {
            const size_t room = stage.cap - used;
            const size_t step = (size_t)std::min<uint64_t>(n, room);
            std::memset(stage.ptr + used, 0, step);
            used += step;
            n -= step;
            if (used == stage.cap && !flush_stage()) return false;
        }
        return true;
    }
};

struct BufWriter {
    std::vector<uint8_t> buf;
    template <class T>
    void put(const T& v) {
        const size_t off = buf.size();
        buf.resize(off + sizeof(T));
        std::memcpy(buf.data() + off, &v, sizeof(T));
    }
    void put_bytes(const void* p, size_t n) {
        if (n == 0) return;
        const size_t off = buf.size();
        buf.resize(off + n);
        std::memcpy(buf.data() + off, p, n);
    }
};

struct BufReader {
    const uint8_t* p = nullptr;
    size_t         n = 0;
    size_t         off = 0;
    template <class T>
    bool get(T* out) {
        if (off + sizeof(T) > n) return false;
        std::memcpy(out, p + off, sizeof(T));
        off += sizeof(T);
        return true;
    }
    bool get_bytes(void* out, size_t len) {
        if (off + len > n) return false;
        if (len > 0) std::memcpy(out, p + off, len);
        off += len;
        return true;
    }
};

void hash_file_head_into(uint64_t* h, const std::string& path) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return;
    if (seek64(f, 0, SEEK_END) == 0) {
        const int64_t sz = tell64(f);
        kvsnap_hash_i64(h, sz);
        seek64(f, 0, SEEK_SET);
    }
    std::vector<uint8_t> head(65536);
    const size_t got = std::fread(head.data(), 1, head.size(), f);
    std::fclose(f);
    if (got > 0) kvsnap_hash_bytes(h, head.data(), got);
}

}  /* namespace */

void kvsnap_hash_bytes(uint64_t* h, const void* data, size_t len) {
    const uint8_t* p = static_cast<const uint8_t*>(data);
    uint64_t v = *h;
    for (size_t i = 0; i < len; ++i) {
        v ^= p[i];
        v *= 1099511628211ull;
    }
    *h = v;
}

void kvsnap_hash_str(uint64_t* h, const std::string& s) {
    kvsnap_hash_i64(h, (int64_t)s.size());
    if (!s.empty()) kvsnap_hash_bytes(h, s.data(), s.size());
}

void kvsnap_hash_i64(uint64_t* h, int64_t v) {
    kvsnap_hash_bytes(h, &v, sizeof(v));
}

uint64_t kvsnap_hash_model(const std::string& path) {
    namespace fs = std::filesystem;
    if (path.empty()) return 0;
    uint64_t h = 1469598103934665603ull;
    std::error_code ec;
    const fs::path p(path);
    if (fs::is_regular_file(p, ec)) {
        hash_file_head_into(&h, path);
        return h;
    }
    if (fs::is_directory(p, ec)) {
        const fs::path cfg = p / "config.json";
        if (fs::is_regular_file(cfg, ec)) hash_file_head_into(&h, cfg.string());
        std::vector<std::string> shards;
        for (const auto& de : fs::directory_iterator(p, ec)) {
            if (!de.is_regular_file(ec)) continue;
            if (de.path().extension() == ".safetensors") shards.push_back(de.path().string());
        }
        std::sort(shards.begin(), shards.end());
        for (const std::string& s : shards) hash_file_head_into(&h, s);
        return h;
    }
    return 0;
}

/* ------------------------------------------------------------------ save */

int kvsnap_save(const std::string& path,
                const KvSnapMeta& meta,
                const PrefixCache& prefix,
                const IdleTiers& tiers,
                const HostArena* ck_store,
                KvSnapResult* out) {
    if (out) *out = KvSnapResult{};
    if (path.empty() || !prefix.enabled() || !tiers.host_on()) return RAD_E_INVAL;
    if (meta.block_size <= 0 || meta.entry_bytes <= 0) return RAD_E_INVAL;

    const uint64_t t0 = rad_mono_ns();
    const uint64_t save_mono = t0;
    const uint64_t save_wall = wall_now_ns();

    std::vector<PrefixCache::SnapEntry> pc_entries;
    std::vector<PrefixCache::SnapCkpt>  pc_ckpts;
    prefix.export_snap(&pc_entries, &pc_ckpts);

    std::vector<IdleTiers::SnapHostRec> tier_recs;
    std::vector<IdleTiers::SnapSession> tier_sessions;
    tiers.export_snap(&tier_recs, &tier_sessions);

    /* Index PrefixCache entries by key so we intersect cleanly with HostArena-backed records. */
    std::unordered_map<BlockHash, const PrefixCache::SnapEntry*, BlockHashHash> pc_map;
    pc_map.reserve(pc_entries.size());
    for (const auto& e : pc_entries) pc_map.emplace(e.key, &e);

    struct SaveEntry {
        BlockHash            key;
        int32_t              host_slot = -1;
        int64_t              depth = 0;
        uint64_t             age_ns = 0;
        uint8_t              n_children = 0;
        std::vector<int32_t> tokens;
    };

    const HostArena& arena = tiers.arena();
    std::vector<SaveEntry> entries;
    entries.reserve(tier_recs.size());
    std::unordered_set<BlockHash, BlockHashHash> saved_keys;
    saved_keys.reserve(tier_recs.size());

    for (const auto& r : tier_recs) {
        if (r.host_slot < 0 || !arena.in_use(r.host_slot)) continue;
        auto it = pc_map.find(r.key);
        if (it == pc_map.end()) continue;
        const PrefixCache::SnapEntry& pe = *it->second;
        if ((int64_t)pe.tokens.size() != meta.block_size) continue;
        const uint64_t used = std::max(pe.used_ns, r.used_ns);
        SaveEntry se;
        se.key        = r.key;
        se.host_slot  = r.host_slot;
        se.depth      = r.depth;
        se.age_ns     = save_mono > used ? save_mono - used : 0;
        se.n_children = pe.n_children;
        se.tokens     = pe.tokens;
        saved_keys.insert(r.key);
        entries.push_back(std::move(se));
    }

    /* Most recently used first, shallower blocks before deeper blocks. */
    std::sort(entries.begin(), entries.end(), [](const SaveEntry& a, const SaveEntry& b) {
        if (a.age_ns != b.age_ns) return a.age_ns < b.age_ns;
        if (a.depth != b.depth)   return a.depth < b.depth;
        return a.key.hi != b.key.hi ? a.key.hi < b.key.hi : a.key.lo < b.key.lo;
    });

    /* Remap live session ids to compact 1..K indices. */
    std::unordered_map<uint64_t, uint64_t> sid_map;
    uint64_t next_sid = 1;
    auto remap_sid = [&](uint64_t raw) -> uint64_t {
        auto it = sid_map.find(raw);
        if (it != sid_map.end()) return it->second;
        const uint64_t v = next_sid++;
        sid_map.emplace(raw, v);
        return v;
    };

    struct SaveCkpt {
        BlockHash prefix;
        uint64_t  session_idx = 0;
        int64_t   pos = 0;
        int32_t   slot = -1;
        uint64_t  age_ns = 0;
        uint64_t  used = 0, made = 0, resumed = 0;
    };
    std::vector<SaveCkpt> ckpts;
    if (ck_store && ck_store->enabled() && meta.ckpt_bytes > 0) {
        ckpts.reserve(pc_ckpts.size());
        for (const auto& c : pc_ckpts) {
            if (c.slot < 0 || !ck_store->in_use(c.slot)) continue;
            if (!saved_keys.count(c.prefix)) continue;
            SaveCkpt sc;
            sc.prefix      = c.prefix;
            sc.session_idx = remap_sid(c.session);
            sc.pos         = c.pos;
            sc.slot        = c.slot;
            sc.age_ns      = save_mono > c.used_ns ? save_mono - c.used_ns : 0;
            sc.used        = c.used;
            sc.made        = c.made;
            sc.resumed     = c.resumed;
            ckpts.push_back(sc);
        }
        std::sort(ckpts.begin(), ckpts.end(), [](const SaveCkpt& a, const SaveCkpt& b) {
            return a.used > b.used;
        });
    }

    struct SaveSession {
        uint64_t               session_idx = 0;
        int64_t                n_tokens = 0;
        uint64_t               first_age_ns = 0;
        uint64_t               last_age_ns = 0;
        std::string            label;
        std::vector<BlockHash> chain;
    };
    std::vector<SaveSession> sessions;
    sessions.reserve(tier_sessions.size());
    for (const auto& s : tier_sessions) {
        size_t keep = 0;
        while (keep < s.chain.size() && saved_keys.count(s.chain[keep])) ++keep;
        if (keep == 0) continue;
        SaveSession ss;
        ss.session_idx  = remap_sid(s.id);
        ss.chain.assign(s.chain.begin(), s.chain.begin() + (long)keep);
        ss.n_tokens     = std::min<int64_t>(s.n_tokens, (int64_t)keep * meta.block_size);
        ss.first_age_ns = save_mono > s.first_seen_ns ? save_mono - s.first_seen_ns : 0;
        ss.last_age_ns  = save_mono > s.last_used_ns  ? save_mono - s.last_used_ns  : 0;
        ss.label        = s.label;
        sessions.push_back(std::move(ss));
    }

    if (entries.empty() && ckpts.empty()) {
        std::error_code ec;
        std::filesystem::remove(path, ec);
        if (out) out->seconds = (double)(rad_mono_ns() - t0) * 1e-9;
        return RAD_OK;
    }

    /* Serialize metadata buffer. */
    BufWriter mw;
    for (const auto& e : entries) {
        mw.put(e.key.hi);
        mw.put(e.key.lo);
        mw.put(e.depth);
        mw.put(e.age_ns);
        mw.put(e.n_children);
        mw.put_bytes(e.tokens.data(), e.tokens.size() * sizeof(int32_t));
    }
    for (const auto& c : ckpts) {
        mw.put(c.prefix.hi);
        mw.put(c.prefix.lo);
        mw.put(c.session_idx);
        mw.put(c.pos);
        mw.put(c.age_ns);
        mw.put(c.used);
        mw.put(c.made);
        mw.put(c.resumed);
    }
    for (const auto& s : sessions) {
        mw.put(s.session_idx);
        mw.put(s.n_tokens);
        mw.put(s.first_age_ns);
        mw.put(s.last_age_ns);
        const uint32_t llen = (uint32_t)s.label.size();
        const uint32_t clen = (uint32_t)s.chain.size();
        mw.put(llen);
        mw.put_bytes(s.label.data(), llen);
        mw.put(clen);
        for (const BlockHash& h : s.chain) {
            mw.put(h.hi);
            mw.put(h.lo);
        }
    }

    uint64_t meta_cksum = 1469598103934665603ull;
    kvsnap_hash_bytes(&meta_cksum, mw.buf.data(), mw.buf.size());

    const uint64_t meta_end       = sizeof(SnapHeader) + (uint64_t)mw.buf.size();
    const uint64_t entry_data_off = align_up_u64(meta_end, kAlign);
    const uint64_t entry_bytes_all = (uint64_t)entries.size() * (uint64_t)meta.entry_bytes;
    const uint64_t ckpt_data_off  = align_up_u64(entry_data_off + entry_bytes_all, kAlign);
    const uint64_t ckpt_bytes_all = (uint64_t)ckpts.size() * (uint64_t)meta.ckpt_bytes;
    const uint64_t total_bytes    = ckpt_data_off + ckpt_bytes_all + sizeof(SnapFooter);

    SnapHeader hdr{};
    hdr.magic               = kMagicHead;
    hdr.version             = kVersion;
    hdr.fingerprint         = meta.fingerprint;
    hdr.saved_wall_ns       = save_wall;
    hdr.block_size          = meta.block_size;
    hdr.entry_bytes         = meta.entry_bytes;
    hdr.ckpt_bytes          = meta.ckpt_bytes;
    hdr.checkpoint_interval = meta.checkpoint_interval;
    hdr.n_entries           = entries.size();
    hdr.n_ckpts             = ckpts.size();
    hdr.n_sessions          = sessions.size();
    hdr.meta_bytes          = mw.buf.size();
    hdr.meta_checksum       = meta_cksum;
    hdr.entry_data_off      = entry_data_off;
    hdr.ckpt_data_off       = ckpt_data_off;
    hdr.total_bytes         = total_bytes;

    SnapFooter ftr{};
    ftr.magic       = kMagicFoot;
    ftr.version     = kVersion;
    ftr.total_bytes = total_bytes;

    /* Ensure parent directory exists. */
    {
        std::error_code ec;
        const std::filesystem::path parent = std::filesystem::path(path).parent_path();
        if (!parent.empty()) std::filesystem::create_directories(parent, ec);
    }

    const std::string tmp = path + ".tmp";
    DirectFile df;
    if (df.open(tmp.c_str(),
                RAD_DIO_WRITE | RAD_DIO_CREATE | RAD_DIO_TRUNC | RAD_DIO_ALLOW_BUFFERED) != RAD_OK) {
        RAD_WARN("kv snap: cannot open %s for writing", tmp.c_str());
        return RAD_E_IO;
    }

    DirectWriter w(df);
    bool ok = w.init()
           && w.write(&hdr, sizeof(hdr))
           && w.write(mw.buf.data(), mw.buf.size())
           && w.write_zeros(entry_data_off - meta_end);

    for (size_t i = 0; ok && i < entries.size(); ++i) {
        const void* src = arena.at(entries[i].host_slot);
        if (!src) { ok = false; break; }
        ok = w.write(src, (size_t)meta.entry_bytes);
    }

    if (ok) ok = w.write_zeros(ckpt_data_off - (entry_data_off + entry_bytes_all));

    for (size_t i = 0; ok && i < ckpts.size(); ++i) {
        const void* src = ck_store->at(ckpts[i].slot);
        if (!src) { ok = false; break; }
        ok = w.write(src, (size_t)meta.ckpt_bytes);
    }

    if (ok) ok = w.write(&ftr, sizeof(ftr));
    if (ok) ok = w.flush_stage();
    if (ok) ok = sync_direct(df);
    df.close();

    if (!ok) {
        std::error_code ec;
        std::filesystem::remove(tmp, ec);
        RAD_WARN("kv snap: failed writing %s", tmp.c_str());
        return RAD_E_IO;
    }
    if (!atomic_replace(tmp, path)) {
        std::error_code ec;
        std::filesystem::remove(tmp, ec);
        RAD_WARN("kv snap: failed renaming %s -> %s", tmp.c_str(), path.c_str());
        return RAD_E_IO;
    }

    if (out) {
        out->entries  = (int64_t)entries.size();
        out->ckpts    = (int64_t)ckpts.size();
        out->sessions = (int64_t)sessions.size();
        out->bytes    = (int64_t)total_bytes;
        out->seconds  = (double)(rad_mono_ns() - t0) * 1e-9;
    }
    return RAD_OK;
}

/* ------------------------------------------------------------------ load */

int kvsnap_load(const std::string& path,
                const KvSnapMeta& meta,
                PrefixCache* prefix,
                IdleTiers* tiers,
                HostArena* ck_store,
                KvSnapResult* out) {
    if (out) *out = KvSnapResult{};
    if (path.empty() || !prefix || !tiers || !prefix->enabled() || !tiers->host_on())
        return RAD_E_INVAL;

    const uint64_t t0 = rad_mono_ns();
    {
        std::error_code ec;
        if (!std::filesystem::exists(path, ec) && !ec) return RAD_E_NOTFOUND;
    }
    DirectFile df;
    if (df.open(path.c_str(), RAD_DIO_READ | RAD_DIO_ALLOW_BUFFERED) != RAD_OK) {
        if (errno == ENOENT) return RAD_E_NOTFOUND;
        RAD_WARN("kv snap: cannot open %s: %s", path.c_str(), std::strerror(errno));
        return RAD_E_IO;
    }

    const int64_t file_size = df.size();
    if (file_size < 0) return RAD_E_IO;
    if (file_size < (int64_t)(sizeof(SnapHeader) + sizeof(SnapFooter))) {
        RAD_WARN("kv snap: %s is truncated (%lld bytes); starting cold",
                 path.c_str(), (long long)file_size);
        return RAD_E_FORMAT;
    }

    SnapHeader hdr{};
    SnapFooter ftr{};
    if (df.read_at(&hdr, 0, (int64_t)sizeof(hdr)) != RAD_OK) return RAD_E_IO;
    if (df.read_at(&ftr, file_size - (int64_t)sizeof(ftr), (int64_t)sizeof(ftr)) != RAD_OK)
        return RAD_E_IO;

    if (hdr.magic != kMagicHead || hdr.version != kVersion ||
        ftr.magic != kMagicFoot || ftr.version != kVersion ||
        hdr.total_bytes != (uint64_t)file_size || ftr.total_bytes != (uint64_t)file_size) {
        RAD_WARN("kv snap: %s header/footer invalid or truncated; starting cold", path.c_str());
        return RAD_E_FORMAT;
    }
    if (hdr.fingerprint != meta.fingerprint) {
        RAD_WARN("kv snap: %s fingerprint mismatch (model or KV layout changed); starting cold",
                 path.c_str());
        return RAD_E_FORMAT;
    }
    if (hdr.block_size != meta.block_size || hdr.entry_bytes != meta.entry_bytes ||
        hdr.ckpt_bytes != meta.ckpt_bytes || hdr.checkpoint_interval != meta.checkpoint_interval) {
        RAD_WARN("kv snap: %s geometry mismatch; starting cold", path.c_str());
        return RAD_E_FORMAT;
    }
    if (hdr.meta_bytes > kMaxMeta ||
        sizeof(SnapHeader) + hdr.meta_bytes > hdr.entry_data_off ||
        hdr.entry_data_off > hdr.ckpt_data_off ||
        hdr.ckpt_data_off > (uint64_t)file_size - sizeof(SnapFooter)) {
        RAD_WARN("kv snap: %s section bounds invalid; starting cold", path.c_str());
        return RAD_E_FORMAT;
    }
    if (hdr.n_entries > ((hdr.ckpt_data_off - hdr.entry_data_off) / (uint64_t)hdr.entry_bytes)) {
        RAD_WARN("kv snap: %s entry payload bounds invalid; starting cold", path.c_str());
        return RAD_E_FORMAT;
    }
    if (hdr.n_ckpts > 0 &&
        (hdr.ckpt_bytes <= 0 ||
         hdr.n_ckpts > (((uint64_t)file_size - sizeof(SnapFooter) - hdr.ckpt_data_off) /
                        (uint64_t)hdr.ckpt_bytes))) {
        RAD_WARN("kv snap: %s checkpoint payload bounds invalid; starting cold", path.c_str());
        return RAD_E_FORMAT;
    }

    std::vector<uint8_t> mbuf((size_t)hdr.meta_bytes);
    if (hdr.meta_bytes > 0 &&
        df.read_at(mbuf.data(), (int64_t)sizeof(SnapHeader), (int64_t)mbuf.size()) != RAD_OK) {
        RAD_WARN("kv snap: %s failed reading metadata; starting cold", path.c_str());
        return RAD_E_IO;
    }
    uint64_t cksum = 1469598103934665603ull;
    kvsnap_hash_bytes(&cksum, mbuf.data(), mbuf.size());
    if (cksum != hdr.meta_checksum) {
        RAD_WARN("kv snap: %s metadata checksum mismatch; starting cold", path.c_str());
        return RAD_E_FORMAT;
    }

    struct LoadEntry {
        size_t               file_idx = 0;
        BlockHash            key;
        int64_t              depth = 0;
        uint64_t             age_ns = 0;
        uint8_t              n_children = 0;
        std::vector<int32_t> tokens;
    };
    struct LoadCkpt {
        size_t    file_idx = 0;
        BlockHash prefix;
        uint64_t  session_idx = 0;
        int64_t   pos = 0;
        uint64_t  age_ns = 0;
        uint64_t  used = 0, made = 0, resumed = 0;
    };
    struct LoadSession {
        uint64_t               session_idx = 0;
        int64_t                n_tokens = 0;
        uint64_t               first_age_ns = 0;
        uint64_t               last_age_ns = 0;
        std::string            label;
        std::vector<BlockHash> chain;
    };

    BufReader mr{ mbuf.data(), mbuf.size(), 0 };
    std::vector<LoadEntry> all_entries((size_t)hdr.n_entries);
    for (size_t i = 0; i < all_entries.size(); ++i) {
        LoadEntry& e = all_entries[i];
        e.file_idx = i;
        e.tokens.resize((size_t)hdr.block_size);
        if (!mr.get(&e.key.hi) || !mr.get(&e.key.lo) || !mr.get(&e.depth) ||
            !mr.get(&e.age_ns) || !mr.get(&e.n_children) ||
            !mr.get_bytes(e.tokens.data(), e.tokens.size() * sizeof(int32_t))) {
            RAD_WARN("kv snap: %s corrupt entry table; starting cold", path.c_str());
            return RAD_E_FORMAT;
        }
    }
    std::vector<LoadCkpt> all_ckpts((size_t)hdr.n_ckpts);
    for (size_t i = 0; i < all_ckpts.size(); ++i) {
        LoadCkpt& c = all_ckpts[i];
        c.file_idx = i;
        if (!mr.get(&c.prefix.hi) || !mr.get(&c.prefix.lo) || !mr.get(&c.session_idx) ||
            !mr.get(&c.pos) || !mr.get(&c.age_ns) || !mr.get(&c.used) ||
            !mr.get(&c.made) || !mr.get(&c.resumed)) {
            RAD_WARN("kv snap: %s corrupt checkpoint table; starting cold", path.c_str());
            return RAD_E_FORMAT;
        }
    }
    std::vector<LoadSession> all_sessions((size_t)hdr.n_sessions);
    for (size_t i = 0; i < all_sessions.size(); ++i) {
        LoadSession& s = all_sessions[i];
        uint32_t llen = 0, clen = 0;
        if (!mr.get(&s.session_idx) || !mr.get(&s.n_tokens) ||
            !mr.get(&s.first_age_ns) || !mr.get(&s.last_age_ns) || !mr.get(&llen)) {
            RAD_WARN("kv snap: %s corrupt session table; starting cold", path.c_str());
            return RAD_E_FORMAT;
        }
        s.label.resize(llen);
        if (!mr.get_bytes(s.label.data(), llen) || !mr.get(&clen)) {
            RAD_WARN("kv snap: %s corrupt session label; starting cold", path.c_str());
            return RAD_E_FORMAT;
        }
        s.chain.resize(clen);
        for (uint32_t k = 0; k < clen; ++k) {
            if (!mr.get(&s.chain[k].hi) || !mr.get(&s.chain[k].lo)) {
                RAD_WARN("kv snap: %s corrupt session chain; starting cold", path.c_str());
                return RAD_E_FORMAT;
            }
        }
    }
    if (mr.off != mr.n) {
        RAD_WARN("kv snap: %s trailing metadata bytes; starting cold", path.c_str());
        return RAD_E_FORMAT;
    }

    const uint64_t load_mono = rad_mono_ns();
    const uint64_t load_wall = wall_now_ns();
    const uint64_t since_save = load_wall > hdr.saved_wall_ns ? load_wall - hdr.saved_wall_ns : 0;
    const uint64_t ttl_ns = meta.ttl_s > 0 ? (uint64_t)meta.ttl_s * 1000000000ull : 0;
    auto mono_for_age = [&](uint64_t age) -> uint64_t {
        const uint64_t tot = since_save + age;
        return load_mono > tot ? load_mono - tot : 1ull;
    };

    /* Select entries up to HostArena capacity (entries are already sorted most-recent & shallowest
     * first, preserving prefix closure for chains stamped with one clock). */
    HostArena& arena = tiers->arena();
    const int64_t max_entries = arena.free_slots();
    std::vector<size_t> sel_entries;
    sel_entries.reserve((size_t)std::min<int64_t>(max_entries, (int64_t)all_entries.size()));
    std::unordered_set<BlockHash, BlockHashHash> kept_keys;
    kept_keys.reserve(sel_entries.capacity());

    int64_t skipped_exp = 0, skipped_cap = 0;
    for (size_t i = 0; i < all_entries.size(); ++i) {
        const LoadEntry& e = all_entries[i];
        if (ttl_ns > 0 && since_save + e.age_ns >= ttl_ns) {
            ++skipped_exp;
            continue;
        }
        if ((int64_t)sel_entries.size() >= max_entries) {
            ++skipped_cap;
            continue;
        }
        if (kept_keys.insert(e.key).second) sel_entries.push_back(i);
    }

    /* Select valid checkpoints whose prefix block is kept and fit in ck_store. */
    std::vector<size_t> sel_ckpts;
    if (ck_store && ck_store->enabled() && meta.ckpt_bytes > 0) {
        const int64_t max_ckpts = ck_store->free_slots();
        sel_ckpts.reserve((size_t)std::min<int64_t>(max_ckpts, (int64_t)all_ckpts.size()));
        for (size_t i = 0; i < all_ckpts.size(); ++i) {
            const LoadCkpt& c = all_ckpts[i];
            if (ttl_ns > 0 && since_save + c.age_ns >= ttl_ns) {
                ++skipped_exp;
                continue;
            }
            if (!kept_keys.count(c.prefix)) continue;
            if ((int64_t)sel_ckpts.size() >= max_ckpts) {
                ++skipped_cap;
                continue;
            }
            sel_ckpts.push_back(i);
        }
    }

    /* Stream entry & checkpoint payloads directly into pinned HostArena slots via O_DIRECT /
     * FILE_FLAG_NO_BUFFERING, coalescing contiguous spans into 16 MiB chunks and reading across
     * multiple threads so NVMe queue depth stays saturated without double-buffering in RAM. */
    std::vector<int32_t> entry_slots;
    entry_slots.reserve(sel_entries.size());
    std::vector<int32_t> ckpt_slots;
    ckpt_slots.reserve(sel_ckpts.size());

    auto rollback_slots = [&] {
        for (int32_t s : entry_slots) arena.free(s);
        for (int32_t s : ckpt_slots) if (ck_store) ck_store->free(s);
    };

    struct ReadSpan {
        uint8_t* dst = nullptr;
        int64_t  off = 0;
        int64_t  len = 0;
    };
    constexpr int64_t kReadChunk = 16ll << 20;
    std::vector<ReadSpan> spans;
    spans.reserve(sel_entries.size() / 16 + sel_ckpts.size() * 10 + 16);

    auto push_span = [&](uint8_t* dst, int64_t off, int64_t len) {
        if (len <= 0) return;
        if (!spans.empty()) {
            ReadSpan& back = spans.back();
            if (back.off + back.len == off && back.dst + back.len == dst &&
                back.len + len <= kReadChunk) {
                back.len += len;
                return;
            }
        }
        while (len > 0) {
            const int64_t step = std::min(len, kReadChunk);
            spans.push_back({ dst, off, step });
            dst += step;
            off += step;
            len -= step;
        }
    };

    int64_t payload_bytes = 0;
    for (size_t idx : sel_entries) {
        const int32_t slot = arena.alloc();
        if (slot < 0) break;
        entry_slots.push_back(slot);
        auto* dst = static_cast<uint8_t*>(arena.at(slot));
        if (!dst) { rollback_slots(); return RAD_E_IO; }
        const int64_t off = (int64_t)(hdr.entry_data_off +
                                      (uint64_t)all_entries[idx].file_idx *
                                          (uint64_t)hdr.entry_bytes);
        push_span(dst, off, hdr.entry_bytes);
        payload_bytes += hdr.entry_bytes;
    }

    for (size_t idx : sel_ckpts) {
        const int32_t slot = ck_store->alloc();
        if (slot < 0) break;
        ckpt_slots.push_back(slot);
        auto* dst = static_cast<uint8_t*>(ck_store->at(slot));
        if (!dst) { rollback_slots(); return RAD_E_IO; }
        const int64_t off = (int64_t)(hdr.ckpt_data_off +
                                      (uint64_t)all_ckpts[idx].file_idx *
                                          (uint64_t)hdr.ckpt_bytes);
        push_span(dst, off, hdr.ckpt_bytes);
        payload_bytes += hdr.ckpt_bytes;
    }

    constexpr size_t kMaxReaders = 4;
    const size_t n_workers = (payload_bytes >= (4ll << 20) && spans.size() > 1)
                                 ? std::min(kMaxReaders, spans.size())
                                 : 1;
    std::atomic<size_t> next_span{0};
    std::atomic<bool>   io_failed{false};

    auto run_worker = [&](DirectFile& reader) {
        for (;;) {
            if (io_failed.load(std::memory_order_relaxed)) return;
            const size_t i = next_span.fetch_add(1, std::memory_order_relaxed);
            if (i >= spans.size()) return;
            const ReadSpan& sp = spans[i];
            if (reader.read_at(sp.dst, sp.off, sp.len) != RAD_OK) {
                io_failed.store(true, std::memory_order_relaxed);
                return;
            }
        }
    };

    if (n_workers <= 1) {
        run_worker(df);
    } else {
        std::vector<std::thread> workers;
        workers.reserve(n_workers - 1);
        for (size_t t = 1; t < n_workers; ++t) {
            workers.emplace_back([&] {
                DirectFile wdf;
                if (wdf.open(path.c_str(), RAD_DIO_READ | RAD_DIO_ALLOW_BUFFERED) != RAD_OK) {
                    io_failed.store(true, std::memory_order_relaxed);
                    return;
                }
                run_worker(wdf);
            });
        }
        run_worker(df);
        for (auto& th : workers) th.join();
    }

    if (io_failed.load(std::memory_order_relaxed)) {
        rollback_slots();
        RAD_WARN("kv snap: %s read error in payload; starting cold", path.c_str());
        return RAD_E_IO;
    }
    const int64_t bytes_read = (int64_t)hdr.meta_bytes + payload_bytes;

    /* All I/O succeeded — commit into IdleTiers and PrefixCache (no partial state on I/O error). */
    std::unordered_set<BlockHash, BlockHashHash> loaded_keys;
    loaded_keys.reserve(entry_slots.size());
    int64_t n_loaded_entries = 0;
    for (size_t k = 0; k < entry_slots.size(); ++k) {
        LoadEntry& e = all_entries[sel_entries[k]];
        const uint64_t used_ns = mono_for_age(e.age_ns);
        if (tiers->import_host_rec(e.key, entry_slots[k], e.depth, used_ns) != RAD_OK) {
            arena.free(entry_slots[k]);
            continue;
        }
        if (prefix->import_host_entry(e.key, std::move(e.tokens), e.n_children, used_ns) != RAD_OK) {
            tiers->forget(e.key);
            continue;
        }
        loaded_keys.insert(e.key);
        ++n_loaded_entries;
    }

    int64_t n_loaded_ckpts = 0;
    for (size_t k = 0; k < ckpt_slots.size(); ++k) {
        const LoadCkpt& c = all_ckpts[sel_ckpts[k]];
        const uint64_t sid = kRestoredSessionBase | c.session_idx;
        const uint64_t used_ns = mono_for_age(c.age_ns);
        if (!loaded_keys.count(c.prefix) ||
            prefix->import_checkpoint(sid, c.pos, c.prefix, ckpt_slots[k],
                                      c.used, c.made, c.resumed, used_ns) != RAD_OK) {
            ck_store->free(ckpt_slots[k]);
            continue;
        }
        ++n_loaded_ckpts;
    }

    int64_t n_loaded_sessions = 0;
    for (const auto& s : all_sessions) {
        size_t keep = 0;
        while (keep < s.chain.size() && loaded_keys.count(s.chain[keep])) ++keep;
        if (keep == 0) continue;
        std::vector<BlockHash> chain(s.chain.begin(), s.chain.begin() + (long)keep);
        const int64_t n_tok = std::min<int64_t>(s.n_tokens, (int64_t)keep * meta.block_size);
        const uint64_t sid = kRestoredSessionBase | s.session_idx;
        tiers->import_session(sid, chain, n_tok,
                              mono_for_age(s.first_age_ns),
                              mono_for_age(s.last_age_ns),
                              s.label);
        ++n_loaded_sessions;
    }

    if (out) {
        out->entries          = n_loaded_entries;
        out->ckpts            = n_loaded_ckpts;
        out->sessions         = n_loaded_sessions;
        out->bytes            = bytes_read;
        out->skipped_expired  = skipped_exp;
        out->skipped_capacity = skipped_cap;
        out->seconds          = (double)(rad_mono_ns() - t0) * 1e-9;
    }
    return RAD_OK;
}

}  /* namespace rad */
