/* rad_block_asr_tower.h -- Qwen3-ASR's audio encoder: a Whisper-style tower (three Conv2d over
 * [mel, time], a 7680 -> 1024 linear, sinusoidal positions per second, pre-LayerNorm transformer
 * layers attending in 104-row blocks) and the 1024 -> 2048 projector, at bf16.
 *
 * Shared by every Qwen3-ASR plugin (qwen3asr_bf16, qwen3asr_q): the tower stays bf16 whatever
 * format the decoder is stored in. arch/qwen3asr_bf16/qwen3asr_bf16.cpp documents the shape and
 * what is easy to get wrong.
 */
#ifndef RAD_BLOCK_ASR_TOWER_H
#define RAD_BLOCK_ASR_TOWER_H

#include "rad_arch.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <vector>

namespace rad {
namespace arch {
namespace qwen3asr_tower {

/* The longest clip one encoder pass carries, in seconds: the reference extractor's own chunk
 * length (`chunk_length`), and the clip the transcription route cuts longer audio into. */
constexpr int64_t kPassSeconds = 30;

/* Rows a chunk of `frames` keeps: three convolutions of kernel 3, stride 2, padding 1. */
inline int64_t post_cnn(int64_t frames) {
    for (int i = 0; i < 3; ++i) frames = frames > 0 ? (frames - 1) / 2 + 1 : 0;
    return frames;
}

/* ============================== THE AUDIO ENCODER ============================== */
struct AudioTower {
    struct Layer {
        rad_weight ln1w = 0, ln1b = 0, qkv_w = 0, qkv_b = 0, o_w = 0, o_b = 0;
        rad_weight ln2w = 0, ln2b = 0, fc1_w = 0, fc1_b = 0, fc2_w = 0, fc2_b = 0;
        rad_op op_ln1 = 0, op_qkv = 0, op_attn = 0, op_o = 0, op_ln2 = 0, op_fc1 = 0, op_fc2 = 0;
    };
    bool on = false;
    int64_t P = 0, R = 0, H = 0, heads = 0, hd = 0, ffn = 0, C = 0, nmel = 0, f3 = 0, w3 = 0;
    int64_t chunk_rows = 0, block = 0, n_embd = 0;
    static constexpr int64_t kMerge = 8;   /* three stride-2 convolutions: 8 frames a row */
    rad_weight w_c1 = 0, b_c1 = 0, w_c2 = 0, b_c2 = 0, w_c3 = 0, b_c3 = 0, w_co = 0;
    rad_weight ln_w = 0, ln_b = 0, p1_w = 0, p1_b = 0, p2_w = 0, p2_b = 0;
    rad_op op_c1 = 0, op_u2 = 0, op_c2 = 0, op_u3 = 0, op_c3 = 0, op_uo = 0, op_co = 0;
    rad_op op_pos = 0, op_add_pos = 0;
    rad_op op_ln = 0, op_p1 = 0, op_p2 = 0;
    rad_buf b_s1 = 0, b_u = 0, b_s2 = 0, b_s3 = 0, b_uo = 0, b_x = 0, b_h = 0, b_pos = 0;
    rad_buf b_qkv = 0, b_att = 0;
    rad_buf b_f = 0, b_p1 = 0, b_out = 0;
    std::vector<Layer> L;

    static bool present(const RadModelMeta* m) {
        const char* t = rad_meta_gets(m, "audio_config.model_type", "");
        return t && !std::strcmp(t, "qwen3_asr_encoder");
    }
    /* The frames a pass of kPassSeconds stages: whole seconds of merge x 13 rows each. */
    static int64_t frames_for(const RadModelMeta* m) {
        const int64_t nw = rad_meta_geti(m, "audio_config.n_window", 0);
        if (nw <= 0) return 0;
        return kPassSeconds * kMerge * post_cnn(2 * nw);
    }

    int declare(RadBuilder* b, const RadModelMeta* m, const RadBuildCtx* ctx, Names& nm,
                int64_t model_embd, int first_group) {
        on = false;
        if (!present(m) || ctx->max_audio_frames <= 0) return RAD_OK;
        auto gi = [&](const char* k, int64_t d) {
            char key[96];
            std::snprintf(key, sizeof key, "audio_config.%s", k);
            return rad_meta_geti(m, key, d);
        };
        H     = gi("d_model", 0);
        heads = gi("encoder_attention_heads", 0);
        ffn   = gi("encoder_ffn_dim", 0);
        C     = gi("downsample_hidden_size", 0);
        nmel  = gi("num_mel_bins", 0);
        const int64_t depth  = gi("encoder_layers", 0);
        const int64_t nw     = gi("n_window", 0);
        const int64_t nwi    = gi("n_window_infer", 0);
        const int64_t out    = gi("output_dim", 0);
        const int64_t kvh    = gi("num_key_value_heads", heads);
        const char*   act    = rad_meta_gets(m, "audio_config.activation_function", "");
        hd = heads > 0 ? H / heads : 0;
        f3 = ((((nmel + 1) / 2) + 1) / 2 + 1) / 2;
        chunk_rows = post_cnn(2 * nw);
        block = nw > 0 && nwi % (2 * nw) == 0 ? chunk_rows * (nwi / (2 * nw)) : 0;
        /* What this tower does not carry is refused by name: a scaled embedding, grouped heads,
         * an activation other than exact gelu, a projector into some other width. */
        if (H <= 0 || heads <= 0 || hd * heads != H || ffn <= 0 || C <= 0 || nmel <= 0 ||
            depth <= 0 || nw <= 0 || block <= 0 || kvh != heads || out != model_embd ||
            std::strcmp(act ? act : "", "gelu") ||
            rad_meta_geti(m, "audio_config.scale_embedding", 0)) {
            fprintf(stderr, "radiance: qwen3asr: the container's audio_config is not the encoder "
                            "this plugin serves (d_model %lld, heads %lld, ffn %lld, channels %lld, "
                            "mel %lld, layers %lld, n_window %lld/%lld, output %lld for a %lld-wide "
                            "decoder, act %s)\n", (long long)H, (long long)heads, (long long)ffn,
                    (long long)C, (long long)nmel, (long long)depth, (long long)nw,
                    (long long)nwi, (long long)out, (long long)model_embd, act ? act : "");
            return RAD_E_UNSUPPORTED;
        }
        n_embd = model_embd;
        P = ctx->max_audio_frames;
        if (P % kMerge) return RAD_E_SHAPE;
        R = P / kMerge;
        const int AC = RAD_ACCESS_PER_REQUEST, N = RAD_SHARD_NONE;
        const char* T = "model.audio_tower";

        auto w = [&](const char* dn, const char* src, std::initializer_list<int64_t> shp,
                     RadWeightGroup g) -> rad_weight {
            if (map_copy(b, dn, src) < 0) return 0;
            return decl_w(b, dn, RAD_BF16, shp, AC, N, g);
        };
        /* q, k and v into one projection, weights and biases alike: one GEMM a layer, and the
         * attention reads three column slices of its row. */
        auto wcat = [&](const char* dn, std::initializer_list<const char*> src,
                        std::initializer_list<int64_t> shp, RadWeightGroup g) -> rad_weight {
            if (map_concat(b, dn, src, 0) < 0) return 0;
            return decl_w(b, dn, RAD_BF16, shp, AC, N, g);
        };
        w_c1 = w(nm.f("a.conv1.w"), nm.ckpt("%s.conv2d1.weight", T), {C, 1, 3, 3}, grp_model());
        b_c1 = w(nm.f("a.conv1.b"), nm.ckpt("%s.conv2d1.bias", T),   {C}, grp_model());
        /* The two 480-channel kernels as the [cout, cin * 9] matrices their GEMMs read: the
         * checkpoint's [C, C, 3, 3], row-major, is that matrix. */
        w_c2 = w(nm.f("a.conv2.w"), nm.ckpt("%s.conv2d2.weight", T), {C, C * 9}, grp_model());
        b_c2 = w(nm.f("a.conv2.b"), nm.ckpt("%s.conv2d2.bias", T),   {C}, grp_model());
        w_c3 = w(nm.f("a.conv3.w"), nm.ckpt("%s.conv2d3.weight", T), {C, C * 9}, grp_model());
        b_c3 = w(nm.f("a.conv3.b"), nm.ckpt("%s.conv2d3.bias", T),   {C}, grp_model());
        w_co = w(nm.f("a.conv_out.w"), nm.ckpt("%s.conv_out.weight", T), {H, C * f3}, grp_model());
        ln_w = w(nm.f("a.ln_post.w"), nm.ckpt("%s.ln_post.weight", T), {H}, grp_model());
        ln_b = w(nm.f("a.ln_post.b"), nm.ckpt("%s.ln_post.bias", T),   {H}, grp_model());
        p1_w = w(nm.f("a.proj1.w"), nm.ckpt("model.multi_modal_projector.linear_1.weight"), {H, H}, grp_model());
        p1_b = w(nm.f("a.proj1.b"), nm.ckpt("model.multi_modal_projector.linear_1.bias"),   {H}, grp_model());
        p2_w = w(nm.f("a.proj2.w"), nm.ckpt("model.multi_modal_projector.linear_2.weight"), {n_embd, H}, grp_model());
        p2_b = w(nm.f("a.proj2.b"), nm.ckpt("model.multi_modal_projector.linear_2.bias"),   {n_embd}, grp_model());
        if (!w_c1 || !b_c1 || !w_c2 || !b_c2 || !w_c3 || !b_c3 || !w_co || !ln_w || !ln_b ||
            !p1_w || !p1_b || !p2_w || !p2_b)
            return RAD_E_INVAL;
        L.assign((size_t)depth, Layer{});
        for (int64_t i = 0; i < depth; ++i) {
            Layer& l = L[(size_t)i];
            const RadWeightGroup g = grp_layer(first_group + (int)i);
            const int li = (int)i;
            const char* S = "model.audio_tower.layers";
            l.ln1w  = w(nm.f("a.blk.%d.ln1.w", li), nm.ckpt("%s.%d.self_attn_layer_norm.weight", S, li), {H}, g);
            l.ln1b  = w(nm.f("a.blk.%d.ln1.b", li), nm.ckpt("%s.%d.self_attn_layer_norm.bias", S, li),   {H}, g);
            l.qkv_w = wcat(nm.f("a.blk.%d.qkv.w", li),
                           { nm.ckpt("%s.%d.self_attn.q_proj.weight", S, li),
                             nm.ckpt("%s.%d.self_attn.k_proj.weight", S, li),
                             nm.ckpt("%s.%d.self_attn.v_proj.weight", S, li) }, {3 * H, H}, g);
            l.qkv_b = wcat(nm.f("a.blk.%d.qkv.b", li),
                           { nm.ckpt("%s.%d.self_attn.q_proj.bias", S, li),
                             nm.ckpt("%s.%d.self_attn.k_proj.bias", S, li),
                             nm.ckpt("%s.%d.self_attn.v_proj.bias", S, li) }, {3 * H}, g);
            l.o_w   = w(nm.f("a.blk.%d.o.w", li),   nm.ckpt("%s.%d.self_attn.out_proj.weight", S, li), {H, H}, g);
            l.o_b   = w(nm.f("a.blk.%d.o.b", li),   nm.ckpt("%s.%d.self_attn.out_proj.bias", S, li),   {H}, g);
            l.ln2w  = w(nm.f("a.blk.%d.ln2.w", li), nm.ckpt("%s.%d.final_layer_norm.weight", S, li),   {H}, g);
            l.ln2b  = w(nm.f("a.blk.%d.ln2.b", li), nm.ckpt("%s.%d.final_layer_norm.bias", S, li),     {H}, g);
            l.fc1_w = w(nm.f("a.blk.%d.fc1.w", li), nm.ckpt("%s.%d.fc1.weight", S, li), {ffn, H}, g);
            l.fc1_b = w(nm.f("a.blk.%d.fc1.b", li), nm.ckpt("%s.%d.fc1.bias", S, li),   {ffn}, g);
            l.fc2_w = w(nm.f("a.blk.%d.fc2.w", li), nm.ckpt("%s.%d.fc2.weight", S, li), {H, ffn}, g);
            l.fc2_b = w(nm.f("a.blk.%d.fc2.b", li), nm.ckpt("%s.%d.fc2.bias", S, li),   {H}, g);
            if (!l.ln1w || !l.ln1b || !l.qkv_w || !l.qkv_b || !l.o_w || !l.o_b || !l.ln2w ||
                !l.ln2b || !l.fc1_w || !l.fc1_b || !l.fc2_w || !l.fc2_b)
                return RAD_E_INVAL;
        }

        /* ---- activations: the convolutions' planes at their own widths, (time, mel, channel)
         * with the channel innermost; the rest at R rows. */
        /* The second and third convolutions' outputs are their GEMMs' [positions, C], which is the
         * same bytes as [time rows, width * C]: the next unfold reads them that way. */
        const int64_t w2 = (nmel + 1) / 2;
        w3 = (w2 + 1) / 2;
        b_s1  = decl_b(b, nm.f("a.s1"),  RAD_BF16, {P / 2, w2 * C});
        b_u   = decl_b(b, nm.f("a.unfold"), RAD_BF16, {P / 4 * w3, 9 * C});
        b_s2  = decl_b(b, nm.f("a.s2"),  RAD_BF16, {P / 4 * w3, C});
        b_s3  = decl_b(b, nm.f("a.s3"),  RAD_BF16, {R * f3, C});
        b_uo  = decl_b(b, nm.f("a.unfold_out"), RAD_BF16, {R, f3 * C});
        b_x   = decl_b(b, nm.f("a.x"),   RAD_BF16, {R, H});
        b_h   = decl_b(b, nm.f("a.h"),   RAD_BF16, {R, H});
        b_pos = decl_b(b, nm.f("a.pos"), RAD_BF16, {R, H});
        b_qkv = decl_b(b, nm.f("a.qkv"), RAD_BF16, {R, 3 * H});
        b_att = decl_b(b, nm.f("a.att"), RAD_BF16, {R, H});
        b_f   = decl_b(b, nm.f("a.f"),   RAD_BF16, {R, ffn});
        b_p1  = decl_b(b, nm.f("a.p1"),  RAD_BF16, {R, H});
        b_out = decl_b(b, nm.f("a.out"), RAD_BF16, {R, n_embd});

        /* The first convolution has one input channel, so it is direct: nine taps are too narrow
         * a K for a GEMM. */
        auto conv1 = [&](rad_weight wt, rad_weight bias) {
            return RAD_OP(b, "conv2d",
                          RAD_PARAMS(RAD_RANGE("M", 1, P), RAD_INT("width", nmel),
                                     RAD_INT("cin", 1), RAD_INT("cout", C), RAD_INT("kh", 3),
                                     RAD_INT("kw", 3), RAD_INT("stride", 2), RAD_INT("pad", 1),
                                     RAD_INT("cu_div", 1), RAD_INT("valid_stride", 1),
                                     RAD_STR("dtype", "bf16"), RAD_INT("t_last", 1),
                                     RAD_STR("act", "gelu")),
                          RAD_WEIGHTS(wt, bias));
        };
        auto gemm_m = [&](int64_t rows, int64_t Nn, int64_t K, const char* act_, rad_weight wt,
                          rad_weight bias) {
            return RAD_OP(b, "gemm_nt_bias",
                          RAD_PARAMS(RAD_RANGE("M", 1, rows), RAD_INT("N", Nn), RAD_INT("K", K),
                                     RAD_STR("dtype", "bf16"), RAD_STR("act", act_)),
                          RAD_WEIGHTS(wt, bias));
        };
        auto gemm = [&](int64_t Nn, int64_t K, const char* act_, rad_weight wt, rad_weight bias) {
            return gemm_m(R, Nn, K, act_, wt, bias);
        };
        auto unfold = [&](int64_t rows, int64_t width, int64_t kh, int64_t kw, int64_t stride,
                          int64_t pad, int64_t cu_div, int tlast) {
            return RAD_OP(b, "conv2d_unfold",
                          RAD_PARAMS(RAD_RANGE("M", 1, rows), RAD_INT("width", width),
                                     RAD_INT("cin", C), RAD_INT("kh", kh), RAD_INT("kw", kw),
                                     RAD_INT("stride", stride), RAD_INT("pad", pad),
                                     RAD_INT("cu_div", cu_div), RAD_INT("valid_stride", cu_div),
                                     RAD_INT("t_last", tlast), RAD_STR("dtype", "bf16")),
                          RAD_NOWEIGHTS);
        };
        auto lnorm = [&](rad_weight wt, rad_weight bias) {
            return RAD_OP(b, "layernorm",
                          RAD_PARAMS(RAD_RANGE("M", 1, R), RAD_INT("n", H), RAD_F64("eps", 1e-5),
                                     RAD_STR("dtype", "bf16")),
                          RAD_WEIGHTS(wt, bias));
        };

        op_c1 = rw(b, conv1(w_c1, b_c1), {}, {b_s1});
        op_u2 = rw(b, unfold(P / 2, w2, 3, 3, 2, 1, 2, 1), {b_s1}, {b_u});
        op_c2 = rw(b, gemm_m(P / 4 * w3, C, 9 * C, "gelu", w_c2, b_c2), {b_u}, {b_s2});
        op_u3 = rw(b, unfold(P / 4, w3, 3, 3, 2, 1, 4, 1), {b_s2}, {b_u});
        op_c3 = rw(b, gemm_m(R * f3, C, 9 * C, "gelu", w_c3, b_c3), {b_u}, {b_s3});
        /* The 7680 -> 1024 linear as a 1 x f3 convolution over the frequency axis, unfolded: its
         * rows are (channel, frequency), the checkpoint's own [H, C * f3] column order. */
        op_uo = rw(b, unfold(R, f3, 1, f3, 1, 0, kMerge, 0), {b_s3}, {b_uo});
        op_co = rw(b, RAD_OP(b, "gemm_nt",
                             RAD_PARAMS(RAD_RANGE("M", 1, R), RAD_INT("N", H),
                                        RAD_INT("K", C * f3), RAD_STR("dtype", "bf16")),
                             RAD_WEIGHTS(w_co)),
                   {b_uo}, {b_x});
        op_pos = rw(b, RAD_OP(b, "seg_sinusoid",
                              RAD_PARAMS(RAD_RANGE("M", 1, R), RAD_INT("n", H),
                                         RAD_INT("period", chunk_rows),
                                         RAD_F64("max_timescale", 10000.0),
                                         RAD_INT("cu_div", kMerge), RAD_STR("dtype", "bf16")),
                              RAD_NOWEIGHTS),
                    {}, {b_pos});
        op_add_pos = rw(b, RAD_OP(b, "add",
                                  RAD_PARAMS(RAD_RANGE("M", 1, R), RAD_INT("n", H),
                                             RAD_STR("dtype", "bf16")),
                                  RAD_NOWEIGHTS),
                        {b_x, b_pos}, {b_x});
        for (Layer& l : L) {
            l.op_ln1 = rw(b, lnorm(l.ln1w, l.ln1b), {b_x}, {b_h});
            l.op_qkv = rw(b, gemm(3 * H, H, "none", l.qkv_w, l.qkv_b), {b_h}, {b_qkv});
            l.op_attn = rw(b, RAD_OP(b, "attn_dense",
                                     RAD_PARAMS(RAD_RANGE("M", 1, R), RAD_INT("head_dim", hd),
                                                RAD_INT("gqa", 1), RAD_INT("causal", 0),
                                                RAD_STR("dtype", "bf16"),
                                                RAD_F64("scale", 1.0 / std::sqrt((double)hd)),
                                                RAD_INT("max_seqlen", R),
                                                RAD_INT("cu_div", kMerge),
                                                RAD_INT("block", block)),
                                     RAD_NOWEIGHTS),
                           {b_qkv}, {b_att});
            /* The output projection and the second FFN linear add the residual in their epilogue,
             * rounded after the biased product as the reference's two tensors are. */
            l.op_o   = rw(b, gemm(H, H, "none", l.o_w, l.o_b), {b_att, b_x}, {b_x});
            l.op_ln2 = rw(b, lnorm(l.ln2w, l.ln2b), {b_x}, {b_h});
            l.op_fc1 = rw(b, gemm(ffn, H, "gelu", l.fc1_w, l.fc1_b), {b_h}, {b_f});
            l.op_fc2 = rw(b, gemm(H, ffn, "none", l.fc2_w, l.fc2_b), {b_f, b_x}, {b_x});
        }
        op_ln = rw(b, lnorm(ln_w, ln_b), {b_x}, {b_h});
        op_p1 = rw(b, gemm(H, H, "gelu", p1_w, p1_b), {b_h}, {b_p1});
        op_p2 = rw(b, gemm(n_embd, H, "none", p2_w, p2_b), {b_p1}, {b_out});

        if (!ctx->shape_probe) {
            RadEncoderDecl e{};
            e.name        = "audio";
            e.modalities  = RAD_MM_AUDIO;
            e.patch_dim   = nmel;
            e.merge       = kMerge;
            e.max_patches = P;
            e.n_embd      = n_embd;
            e.out         = b_out;
            RAD_ARCH_TRY(rad_declare_encoder(b, &e));
            rad_note(b, "audio encoder: 3 convolutions of %lld channels over %lld mel bins, %lld "
                        "layers of %lld (%lld heads x %lld), ffn %lld, attention in blocks of %lld "
                        "rows; %lld frames a pass (%lld s) -> %lld rows of %lld",
                     (long long)C, (long long)nmel, (long long)depth, (long long)H,
                     (long long)heads, (long long)hd, (long long)ffn, (long long)block,
                     (long long)P, (long long)kPassSeconds, (long long)R, (long long)n_embd);
        }
        on = true;
        return RAD_OK;
    }

    void step(RadCtx* c, const RadBatch* batch) const {
        const int64_t Pn = batch->enc_n_patch, S = batch->enc_n_seg;
        if (!on || Pn <= 0 || Pn > P || Pn % kMerge || S <= 0) {
            rad_step_fail(c, "an audio pass this program's audio encoder cannot serve: none "
                             "declared, more frames than it was declared for, or not whole rows");
            return;
        }
        const int64_t Rn = Pn / kMerge;
        const RadOperand frames = praw2(batch->enc_pixels, RAD_BF16, Pn, nmel);
        /* Plane 1: whether a frame takes part in the convolution (item.cpp). */
        const RadOperand valid = praw(batch->enc_coord + Pn, RAD_I32, Pn);
        const RadOperand cu = praw(batch->enc_cu, RAD_I32, S + 1);

        RAD_ISSUE_N(c, op_c1, Pn, frames, RAD_W(w_c1), cu, valid, brows(b_s1, Pn / 2),
                    RAD_W(b_c1));
        const int64_t n2 = Pn / 4 * w3, n3 = Rn * f3;
        RAD_ISSUE_N(c, op_u2, Pn / 2, brows(b_s1, Pn / 2), cu, valid, brows(b_u, n2));
        RAD_ISSUE_N(c, op_c2, n2, brows(b_u, n2), RAD_W(w_c2), RAD_W(b_c2), RAD_NONE,
                    brows(b_s2, n2));
        RAD_ISSUE_N(c, op_u3, Pn / 4, brows(b_s2, n2), cu, valid, brows(b_u, n3));
        RAD_ISSUE_N(c, op_c3, n3, brows(b_u, n3), RAD_W(w_c3), RAD_W(b_c3), RAD_NONE,
                    brows(b_s3, n3));
        RAD_ISSUE_N(c, op_uo, Rn, brows(b_s3, n3), cu, RAD_NONE, brows(b_uo, Rn));
        RAD_ISSUE_N(c, op_co, Rn, brows(b_uo, Rn), RAD_W(w_co), brows(b_x, Rn));
        RAD_ISSUE_N(c, op_pos, Rn, cu, brows(b_pos, Rn));
        RAD_ISSUE_N(c, op_add_pos, Rn, brows(b_x, Rn), brows(b_pos, Rn), brows(b_x, Rn));
        for (const Layer& l : L) {
            RAD_ISSUE_N(c, l.op_ln1, Rn, brows(b_x, Rn), RAD_W(l.ln1w), RAD_W(l.ln1b),
                        brows(b_h, Rn));
            RAD_ISSUE_N(c, l.op_qkv, Rn, brows(b_h, Rn), RAD_W(l.qkv_w), RAD_W(l.qkv_b), RAD_NONE,
                        brows(b_qkv, Rn));
            RAD_ISSUE_N(c, l.op_attn, Rn, bcol(b_qkv, 0, H, Rn), bcol(b_qkv, H, H, Rn),
                        bcol(b_qkv, 2 * H, H, Rn), cu, brows(b_att, Rn));
            RAD_ISSUE_N(c, l.op_o, Rn, brows(b_att, Rn), RAD_W(l.o_w), RAD_W(l.o_b),
                        brows(b_x, Rn), brows(b_x, Rn));
            RAD_ISSUE_N(c, l.op_ln2, Rn, brows(b_x, Rn), RAD_W(l.ln2w), RAD_W(l.ln2b),
                        brows(b_h, Rn));
            RAD_ISSUE_N(c, l.op_fc1, Rn, brows(b_h, Rn), RAD_W(l.fc1_w), RAD_W(l.fc1_b), RAD_NONE,
                        brows(b_f, Rn));
            RAD_ISSUE_N(c, l.op_fc2, Rn, brows(b_f, Rn), RAD_W(l.fc2_w), RAD_W(l.fc2_b),
                        brows(b_x, Rn), brows(b_x, Rn));
        }
        RAD_ISSUE_N(c, op_ln, Rn, brows(b_x, Rn), RAD_W(ln_w), RAD_W(ln_b), brows(b_h, Rn));
        RAD_ISSUE_N(c, op_p1, Rn, brows(b_h, Rn), RAD_W(p1_w), RAD_W(p1_b), RAD_NONE,
                    brows(b_p1, Rn));
        RAD_ISSUE_N(c, op_p2, Rn, brows(b_p1, Rn), RAD_W(p2_w), RAD_W(p2_b), RAD_NONE,
                    brows(b_out, Rn));
    }
};

}  /* namespace qwen3asr_tower */
}  /* namespace arch */
}  /* namespace rad */

#endif /* RAD_BLOCK_ASR_TOWER_H */
