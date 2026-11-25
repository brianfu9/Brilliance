/* qwen3asr_q -- Qwen3-ASR: bf16 Whisper-style audio encoder and bf16 attention over a dense
 * Qwen3 decoder with W8A8 int8 FFN (and optional int8 lm_head).
 *
 * A speech recogniser served as the generative model it is: the clip goes through the audio
 * encoder (RadEncoderDecl, RAD_MM_AUDIO), its rows replace the prompt's <|audio_pad|>
 * placeholders, and the decoder writes the transcript, after "language <Name><asr_text>" when the
 * request forces a language and after naming it when it does not. POST /v1/audio/transcriptions
 * builds the prompt from rad_arch_audio_format (below); /v1/chat/completions takes the clip as an
 * input_audio part. The reference is transformers' modeling_qwen3_asr (5.18) with its
 * Qwen3ASRFeatureExtractor, which core/mm reproduces (AudioFamily::Qwen3ASR).
 *
 * ============================== The shape, at 1.7B ==============================
 *
 *   audio encoder: log-mel [frames, 128], convolved one second (100 frames) at a time: three
 *     Conv2d 3x3 / stride 2 / pad 1 over [mel, time] with 480 channels and exact gelu, 128 mel ->
 *     16 and 100 frames -> 13 rows; a row's 16 x 480 features through a 7680 -> 1024 linear (no
 *     bias); sinusoidal positions 0..12 added to each second's rows; 24 pre-LayerNorm layers (eps
 *     1e-5), d_model 1024, 16 heads of 64, biased q/k/v/o and FFN linears, FFN 4096 with exact
 *     gelu, attention bidirectional in blocks of 104 rows (n_window_infer 800 frames = 8 s) from
 *     the clip's start; a final LayerNorm.
 *   projector: 1024 -> 1024, gelu, 1024 -> 2048.
 *   decoder: Qwen3-1.7B: 28 layers, hidden 2048, 16 heads over 8 KV heads of 128 (GQA 2), per-head
 *     q/k RMS norms, NeoX rope over the whole head at theta 1e6, SwiGLU 6144, RMS eps 1e-6,
 *     vocab 151936, the lm_head tied to the embedding.
 *
 * ============================== What is easy to get wrong ==============================
 *
 * Each second is convolved on its own. The core lays a clip out so one convolution over it does
 * that (core/mm/processor.h, AudioFamily::Qwen3ASR): a whole second is staged as 104 frames whose
 * last four read as zero (RadBatch::enc_coord plane 1), and the last, shorter second as 8 x the
 * rows the reference keeps of it. `conv2d`'s `valid` at strides 1, 2 and 4 keeps one second's
 * convolution out of the next's, and every row the tower writes is a row the reference keeps, so
 * nothing is compacted.
 *
 * The convolutions run over [mel, time], so PyTorch's kernel is [cout, cin, mel, time] with time
 * last, where `conv2d` convolves (time, width); `t_last` reads the checkpoint as it is. The 7680 ->
 * 1024 linear takes its input channel-major (c * 16 + f) where the convolution writes
 * frequency-major (f * 480 + c); as a 1 x 16 convolution over the frequency axis, the checkpoint's
 * [1024, 7680] is the kernel [1024, 480, 1, 16] in PyTorch's layout, and nothing is permuted.
 *
 * The 480-channel convolutions are GEMMs. Two of them and the 7680 -> 1024 linear are 95% of the
 * tower's arithmetic outside its transformer (68 GMAC for 30 s), and a direct convolution re-reads
 * the weights for every output. `conv2d_unfold` writes each output position's receptive field as
 * a row, its columns in the weight's own order, so `gemm_nt_bias` against the checkpoint's kernel
 * read as [cout, cin * 9] (a reshape, not a relayout) is the convolution, with the bias and the
 * gelu in its epilogue. The first convolution has one input channel and nine taps, too narrow a K
 * for a GEMM, so it stays a `conv2d`.
 *
 * Positions restart every 13 rows (`seg_sinusoid`, per clip), and attention runs in blocks of 104
 * rows from the clip's start, the last one short (`attn_dense`'s `block`). A clip is one encoder
 * segment, so the segment bounds (in frames, read at cu_div 8) are the clip's.
 *
 * The decoder's positions are the tokens' indices. The checkpoint's text_config is plain Qwen3
 * (no mrope_section), and the reference's position ids count the placeholders like text.
 */
#include <arch/rad_arch.h>
#include <arch/rad_block_attn.h>
#include <arch/rad_block_mlp_fp8.h>
#include <arch/rad_block_asr_tower.h>
#include <arch/rad_block_vit.h>

#include <cmath>
#include <cstring>
#include <vector>

namespace qwen3asr_q {

using namespace rad::arch;

/* The audio encoder (arch/common/rad_block_asr_tower.h), shared with qwen3asr_q. */
using qwen3asr_tower::kPassSeconds;
using qwen3asr_tower::AudioTower;

/* ============================== THE DECODER ============================== */
struct Layer {
    AttnBF16 attn;
    MlpFP8   mlp;
};

struct Model {
    Names nm{""};
    Geom  g{};
    rad_kvgroup kv = 0;
    rad_buf b_x = 0, b_q = 0, b_k = 0, b_v = 0, b_attn = 0;
    rad_buf b_gate_up = 0, b_hout = 0, b_logits = 0;
    ActFP8  a_h{}, a_ffn{};
    rad_weight w_tok = 0, w_out_norm = 0, w_lm_head = 0;
    rad_op op_embed = 0, op_embed_ar = 0, op_final_norm = 0, op_gather = 0, op_logits = 0;
    bool media = false;
    MediaRows mrows{};
    AudioTower aud{};
    std::vector<Layer> layers;
};

static Model g_model[MAX_SLOTS];

static int declare(RadBuilder* b, const RadModelMeta* meta, const RadBuildCtx* ctx) {
    if (!b || !meta || !ctx) return RAD_E_INVAL;
    if (ctx->rank < 0 || ctx->rank >= MAX_RANKS || rad_build_slot(ctx) >= MAX_SLOTS)
        return RAD_E_INVAL;
    Model& m = g_model[rad_build_slot(ctx)];
    m = Model{};
    m.nm = Names(ctx->scope);
    RAD_ARCH_TRY(geom_from(m.g, meta, ctx, "bf16", RAD_BF16));
    Geom& g = m.g;
    Names& nm = m.nm;

    /* Plain Qwen3: every layer full attention, no sliding window, plain RMS gains. */
    if (meta->n_expert > 0 || rad_meta_geti(meta, "text_config.use_sliding_window", 0)) {
        fprintf(stderr, "radiance: qwen3asr: the decoder has experts or a sliding window; this "
                        "plugin serves the dense, full-attention Qwen3 decoder\n");
        return RAD_E_UNSUPPORTED;
    }
    if (!(g.theta > 0.0f)) g.theta = (float)rad_meta_getf(meta, "rope_parameters.rope_theta", 0.0);
    if (!(g.theta > 0.0f) || g.head_dim <= 0 || g.n_head % g.n_head_kv) {
        fprintf(stderr, "radiance: qwen3asr: the decoder's geometry is incomplete (theta %g, "
                        "head_dim %lld, heads %lld over %lld)\n", (double)g.theta,
                (long long)g.head_dim, (long long)g.n_head, (long long)g.n_head_kv);
        return RAD_E_INVAL;
    }
    g.wadd = 0.0f;
    g.wadd_qk = 0.0f;

    RadKVGroupDecl fd{};
    fd.kind      = RAD_KV_FULL;
    fd.dtype     = rad_kv_cache_dtype(ctx, RAD_BF16);
    fd.n_head_kv = g.n_head_kv;
    fd.head_dim  = g.head_dim;
    m.kv = rad_decl_kv_group(b, nm.f("kv_attn"), &fd);
    g.kv_dtype = rad_dtype_name(fd.dtype);

    m.b_x       = decl_b(b, nm.f("x"),        g.act_dtype, {g.max_tok, g.n_embd});
    m.a_h.x     = decl_b(b, nm.f("h"),        g.act_dtype, {g.max_tok, g.n_embd});
    RAD_ARCH_TRY(m.a_h.declare_qs(b, nm, g, "h", g.n_embd, 0, /*i8=*/true, /*fp8_pair=*/true,
                                  /*i8_group=*/RAD_FP8_BLOCK));
    m.b_q       = decl_b(b, nm.f("attn_q"),   g.act_dtype, {g.max_tok, g.q_dim()});
    m.b_k       = decl_b(b, nm.f("attn_k"),   g.act_dtype, {g.max_tok, g.kv_dim()});
    m.b_v       = decl_b(b, nm.f("attn_v"),   g.act_dtype, {g.max_tok, g.kv_dim()});
    m.b_attn    = decl_b(b, nm.f("attn_out"), g.act_dtype, {g.max_tok, g.q_dim()});
    m.b_gate_up = decl_b(b, nm.f("gate_up"),  g.act_dtype, {g.max_tok, 2 * g.n_ff});
    m.a_ffn.x   = decl_b(b, nm.f("ffn"),      g.act_dtype, {g.max_tok, g.n_ff});
    RAD_ARCH_TRY(m.a_ffn.declare_qs(b, nm, g, "ffn", g.n_ff, 0, /*i8=*/true, /*fp8_pair=*/true,
                                    /*i8_group=*/RAD_FP8_BLOCK));
    m.b_hout    = decl_b(b, nm.f("h_out"),    g.act_dtype, {g.max_logit_rows, g.n_embd});
    m.b_logits  = decl_b(b, nm.f("logits"),   RAD_F32,     {g.max_logit_rows, g.n_vocab});
    RAD_ARCH_TRY(rad_declare_logits(b, m.b_logits));

    /* ---- the vocabulary edges, both row-sharded; the head is tied to the embedding
     * (tie_word_embeddings, and the checkpoint ships no lm_head.weight). */
    const char* pre = "model.language_model";
    RAD_ARCH_TRY(map_copy(b, nm.f("token_embd.weight"), nm.ckpt("%s.embed_tokens.weight", pre)));
    RAD_ARCH_TRY(map_copy(b, nm.f("output_norm.weight"), nm.ckpt("%s.norm.weight", pre)));
    RAD_ARCH_TRY(map_copy_alt(b, nm.f("output.weight"), nm.ckpt("lm_head.weight"),
                              nm.ckpt("%s.embed_tokens.weight", pre)));
    m.w_tok = decl_w(b, nm.f("token_embd.weight"), RAD_BF16, {g.n_vocab, g.n_embd},
                     RAD_ACCESS_VOCAB, RAD_SHARD_ROW, grp_model());
    m.w_out_norm = decl_w(b, nm.f("output_norm.weight"), RAD_F32, {g.n_embd},
                          RAD_ACCESS_PER_TOKEN, RAD_SHARD_NONE, grp_model());
    m.w_lm_head = decl_w(b, nm.f("output.weight"),
                         weight_codes_dtype(b, nm.f("output.weight"), RAD_BF16),
                         {g.n_vocab, g.n_embd}, RAD_ACCESS_VOCAB, RAD_SHARD_ROW, grp_model());

    m.op_embed = rw(b, RAD_OP(b, "embed_lookup",
                        RAD_PARAMS(RAD_RANGE("M", 1, g.max_tok), RAD_INT("n_embd", g.n_embd),
                                   RAD_INT("n_vocab", g.n_vocab), RAD_STR("dtype", g.dtype),
                                   RAD_INT("vocab_offset", g.vocab_off)),
                        RAD_WEIGHTS(m.w_tok)),
                    {}, {m.b_x});
    /* The encoder's rows, over the lookup and before its reduction (MediaRows says why). */
    m.media = AudioTower::present(meta) && ctx->max_audio_frames > 0;
    if (m.media) RAD_ARCH_TRY(m.mrows.declare(b, g.max_tok, g.n_embd, m.b_x));
    if (g.world > 1)
        m.op_embed_ar = rw(b, RAD_OP(b, "all_reduce",
                                  RAD_PARAMS(RAD_INT("world_size", g.world),
                                             RAD_RANGE("numel", g.n_embd, g.max_tok * g.n_embd),
                                             RAD_STR("dtype", g.dtype), RAD_INT("exact", 1)),
                                  RAD_NOWEIGHTS),
                              {m.b_x}, {m.b_x});

    AttnBF16::Wire aw{};
    aw.x = m.b_x; aw.h = m.a_h.x; aw.q = m.b_q; aw.k = m.b_k; aw.v = m.b_v; aw.attn = m.b_attn;
    MlpFP8::Wire mw{};
    mw.x = m.b_x; mw.h = m.a_h; mw.gate_up = m.b_gate_up; mw.ffn = m.a_ffn;
    m.layers.resize((size_t)g.n_layer);
    for (int64_t l = 0; l < g.n_layer; ++l) {
        Layer& lay = m.layers[(size_t)l];
        const char* lp = "model.language_model.layers";
        const long long li = (long long)l;
        AttnBF16::Src as{};
        as.norm   = nm.ckpt("%s.%lld.input_layernorm.weight",  lp, li);
        as.q      = nm.ckpt("%s.%lld.self_attn.q_proj.weight", lp, li);
        as.k      = nm.ckpt("%s.%lld.self_attn.k_proj.weight", lp, li);
        as.v      = nm.ckpt("%s.%lld.self_attn.v_proj.weight", lp, li);
        as.q_norm = nm.ckpt("%s.%lld.self_attn.q_norm.weight", lp, li);
        as.k_norm = nm.ckpt("%s.%lld.self_attn.k_norm.weight", lp, li);
        as.o      = nm.ckpt("%s.%lld.self_attn.o_proj.weight", lp, li);
        RAD_ARCH_TRY(rad_bind_layer_kv(b, (int)l, m.kv));
        RAD_ARCH_TRY(lay.attn.declare(b, nm, g, (int)l, m.kv, aw, as));
        MlpFP8::Src ms{};
        ms.norm = nm.ckpt("%s.%lld.post_attention_layernorm.weight", lp, li);
        ms.gate = nm.ckpt("%s.%lld.mlp.gate_proj.weight",            lp, li);
        ms.up   = nm.ckpt("%s.%lld.mlp.up_proj.weight",              lp, li);
        ms.down = nm.ckpt("%s.%lld.mlp.down_proj.weight",            lp, li);
        RAD_ARCH_TRY(lay.mlp.declare(b, nm, g, (int)l, mw, ms, /*fold=*/false, /*add_out=*/true));
    }

    m.op_final_norm = rw(b, RAD_OP(b, "rmsnorm",
                             RAD_PARAMS(RAD_RANGE("M", 1, g.max_tok), RAD_INT("n", g.n_embd),
                                        RAD_F64("eps", g.eps), RAD_F64("wadd", 0.0),
                                        RAD_STR("dtype", g.dtype)),
                             RAD_WEIGHTS(m.w_out_norm)),
                         {m.b_x}, {m.a_h.x});
    m.op_gather = rw(b, RAD_OP(b, "gather_rows",
                         RAD_PARAMS(RAD_RANGE("M", 1, g.max_logit_rows),
                                    RAD_INT("n", g.n_embd), RAD_STR("dtype", g.dtype)),
                         RAD_NOWEIGHTS),
                     {m.a_h.x}, {m.b_hout});
    m.op_logits = rw(b, RAD_OP(b, "logits_gemm",
                         RAD_PARAMS(RAD_RANGE("M", 1, g.max_logit_rows),
                                    RAD_INT("n_vocab", g.n_vocab),
                                    RAD_INT("n_embd", g.n_embd), RAD_STR("dtype", g.dtype)),
                         RAD_WEIGHTS(m.w_lm_head)),
                     {m.b_hout}, {m.b_logits});

    rad_note(b, "rank %d/%d: %lld decoder layers, n_head=%lld n_head_kv=%lld head_dim=%lld "
                "n_ff=%lld theta=%g vocab=[%lld,%lld), lm_head tied",
             g.rank, g.world, (long long)g.n_layer, (long long)g.n_head, (long long)g.n_head_kv,
             (long long)g.head_dim, (long long)g.n_ff, (double)g.theta, (long long)g.vocab_off,
             (long long)(g.vocab_off + g.n_vocab));

    /* The audio tower last, so its activations share the arena with every buffer above. */
    if (m.media) RAD_ARCH_TRY(m.aud.declare(b, meta, ctx, nm, g.n_embd, (int)g.n_layer + 64));
    return RAD_OK;
}

static void step(RadCtx* c, const RadBatch* batch) {
    Model& m = g_model[rad_slot(c)];
    /* An encoder pass runs the audio tower and nothing else (RadBatch::enc). */
    if (batch->enc) {
        m.aud.step(c, batch);
        return;
    }
    const int64_t T = batch->n_tok;
    RAD_ISSUE(c, m.op_embed, praw(batch->token_ids, RAD_I32, T), RAD_W(m.w_tok), brows(m.b_x, T));
    m.mrows.step(c, batch, m.b_x, T);
    if (m.op_embed_ar)
        RAD_ISSUE_N(c, m.op_embed_ar, T * m.g.n_embd, brows(m.b_x, T), RAD_NONE);
    for (const Layer& l : m.layers) {
        l.attn.step(c, batch);
        l.mlp.step(c, batch);
    }
    RAD_ISSUE(c, m.op_final_norm, brows(m.b_x, T), RAD_W(m.w_out_norm), brows(m.a_h.x, T));
    if (batch->n_out > 0) {
        RAD_ISSUE_N(c, m.op_gather, batch->n_out, brows(m.a_h.x, T),
                    praw(batch->out_ids, RAD_I32, batch->n_out), brows(m.b_hout, batch->n_out));
        RAD_ISSUE_N(c, m.op_logits, batch->n_out, brows(m.b_hout, batch->n_out),
                    RAD_W(m.w_lm_head), brows(m.b_logits, batch->n_out));
    }
}

/* Before declare: the frames a pass carries, so the core sizes the audio encoder's pass. */
static int probe(const RadModelMeta* meta, RadArchProbe* out) {
    if (!meta || !out) return RAD_E_INVAL;
    if (AudioTower::present(meta)) out->audio_frames = AudioTower::frames_for(meta);
    return RAD_OK;
}

/* Qwen3-ASR's audio format (RadAudioFormat): its clip markers; its transcription turn, which is
 * the reference processor's chat template with the request's prompt as the system text and the
 * clip as the user turn; and the forced-language prefix the model was trained with,
 * "language <Name><asr_text>". The language names are the reference processor's
 * LANGUAGE_CODE_TO_NAME. */
static const char* const kLanguages[] = {
    "ar", "Arabic",     "yue", "Cantonese",  "zh", "Chinese",   "cs", "Czech",
    "da", "Danish",     "nl", "Dutch",       "en", "English",   "fil", "Filipino",
    "fi", "Finnish",    "fr", "French",      "de", "German",    "el", "Greek",
    "hi", "Hindi",      "hu", "Hungarian",   "id", "Indonesian", "it", "Italian",
    "ja", "Japanese",   "ko", "Korean",      "mk", "Macedonian", "ms", "Malay",
    "fa", "Persian",    "pl", "Polish",      "pt", "Portuguese", "ro", "Romanian",
    "ru", "Russian",    "es", "Spanish",     "sv", "Swedish",   "th", "Thai",
    "tr", "Turkish",    "vi", "Vietnamese",
};

static const RadAudioFormat* audio_format(const RadModelMeta* meta) {
    if (!AudioTower::present(meta)) return nullptr;
    static const RadAudioFormat f = {
        (uint32_t)sizeof(RadAudioFormat),
        "<|audio_start|>",
        "<|audio_end|>",
        "<|im_start|>system\n{context}<|im_end|>\n<|im_start|>user\n{audio}<|im_end|>\n"
        "<|im_start|>assistant\n{language}",
        "language {language}<asr_text>",
        "<asr_text>",
        "language ",
        kLanguages,
        (uint32_t)(sizeof(kLanguages) / sizeof(kLanguages[0]) / 2),
    };
    return &f;
}

}  /* namespace qwen3asr_q */

#ifndef RAD_ARCH_NO_EXPORTS
/* Every per-instance state above is indexed by slot (rad_build_slot / rad_slot). */
RAD_ARCH_MULTI_INSTANCE()
RAD_ARCH_SERVES_IMPORTS(0)
RAD_ARCH_PLUGIN(qwen3asr_q, "qwen3asr", "w8a8", "0.1.0",
                "Qwen3-ASR: bf16 audio encoder and attention over a W8A8 int8 FFN Qwen3 decoder")
RAD_ARCH_PROBE(qwen3asr_q)
RAD_ARCH_AUDIO_FORMAT(qwen3asr_q)
#endif
