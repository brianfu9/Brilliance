/* kvsnap.h -- save-on-unload / load-on-bringup persistence for the KV prefix cache (local).
 *
 * Writes ONLY live host-resident attention KV entries, valid committed linear-state checkpoints,
 * and IdleTiers session chains atomically to one sequential file when an engine unloads cleanly,
 * and restores them straight into pinned host memory on the next load (zero VRAM touched until a
 * returning conversation hits and promotes its chain).
 *
 * Zero SSD writes happen during normal inference.
 *
 * Privacy: cached KV blocks and token ids are a lossless function of prompt text and are stored
 * unencrypted on local disk. Callers log this clearly when --prefix-cache-file is set.
 */
#pragma once

#include "mem/hostarena.h"
#include "mem/kvtier.h"
#include "mem/prefix.h"
#include "rad_core.h"

#include <cstdint>
#include <string>

namespace rad {

struct KvSnapMeta {
    uint64_t fingerprint = 0;
    int64_t  block_size = 0;
    int64_t  entry_bytes = 0;
    int64_t  ckpt_bytes = 0;
    int64_t  checkpoint_interval = 0;
    int64_t  ttl_s = 0;            /* > 0: expire items older than ttl_s on load */
};

struct KvSnapResult {
    int64_t entries = 0;
    int64_t ckpts = 0;
    int64_t sessions = 0;
    int64_t bytes = 0;
    int64_t skipped_expired = 0;
    int64_t skipped_capacity = 0;
    double  seconds = 0.0;
};

/* Hash a model path's identity: for a regular file, size + first 64 KiB (container header); for a
 * directory (HF checkpoint), config.json + first safetensors file's size & 64 KiB header. Returns 0
 * if unreadable. */
uint64_t kvsnap_hash_model(const std::string& path);

/* FNV-1a 64-bit incremental helper for building fingerprints. */
void kvsnap_hash_bytes(uint64_t* h, const void* data, size_t len);
void kvsnap_hash_str(uint64_t* h, const std::string& s);
void kvsnap_hash_i64(uint64_t* h, int64_t v);

/* Atomically save live host entries, valid checkpoints, and sessions to `path`.
 * If 0 entries and 0 checkpoints remain, removes any stale `path` and returns RAD_OK. */
int kvsnap_save(const std::string& path,
                const KvSnapMeta& meta,
                const PrefixCache& prefix,
                const IdleTiers& tiers,
                const HostArena* ck_store,
                KvSnapResult* out = nullptr);

/* Load a snapshot from `path` into a freshly configured `prefix`, `tiers`, and `ck_store`.
 * Returns RAD_E_NOTFOUND silently when `path` does not exist.
 * On fingerprint mismatch, truncation, or checksum error, logs RAD_WARN and returns RAD_E_FORMAT
 * leaving `prefix`, `tiers`, and `ck_store` untouched. */
int kvsnap_load(const std::string& path,
                const KvSnapMeta& meta,
                PrefixCache* prefix,
                IdleTiers* tiers,
                HostArena* ck_store,
                KvSnapResult* out = nullptr);

}  /* namespace rad */
