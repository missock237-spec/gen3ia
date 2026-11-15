#!/usr/bin/env python3
"""
train_av_neural.py - Moteur AUDIO+VIDEO neuronal "ondes" de gen3 (AV-DiT from scratch).

NOTE GEN3 (piste expérimentale) : ce moteur entraîne une architecture PROPRE (AV-DiT,
flow matching, embeddings temporels continus en secondes) SANS poids pré-entraînés.
Il COMPLÈTE (et ne remplace pas) les moteurs SDXL / F5-TTS / LTX-Video pré-entraînés :
résultats expérimentaux attendus — pas le niveau Veo — sauf des semaines de GPU et un
dataset vidéo+audio massif. Honnêteté assumée et documentée dans README_FR.md.

Architecture
  * VAE video 3D   : compression x8 spatial, x4 temporel
  * VAE audio 1D   : waveform 16 kHz -> latents (x512)
  * AV-DiT         : deux tours (video / audio) + attention croisee bidirectionnelle a chaque
                     couche (synchro levres/voix), cross-attention texte, adaLN, QK-norm,
                     embeddings temporels en SECONDES partages (alignement exact audio/video)
  * Flow matching (rectified flow) avec timesteps par modalite -> UN seul modele apprend :
        texte -> video+audio | image -> video+audio | AUDIO(voix) -> video (lip-sync) | video -> audio
  * bf16, DDP multi-GPU (torchrun), gradient checkpointing, EMA, reprise automatique,
    cache de latents (l'entrainement du DiT ne charge plus ni VAE ni encodeur texte)

Donnees : dossier avec videos (AVEC piste audio) + metadata.csv (colonnes : file,caption)
          Mets la transcription entre guillemets dans la caption pour les scenes parlees.

Pipeline (remplace "torchrun --nproc_per_node=N" par "python" pour 1 GPU) :
  1) torchrun --nproc_per_node=N train_av.py vae_v --data D --out runs/vae_v
  2) torchrun --nproc_per_node=N train_av.py vae_a --data D --out runs/vae_a
  3) torchrun --nproc_per_node=N train_av.py cache --data D --vae_v runs/vae_v/last.pt \
         --vae_a runs/vae_a/last.pt --cache cache --clips 4
  4) torchrun --nproc_per_node=N train_av.py dit --cache cache --preset base --out runs/dit
  5) python train_av.py sample --vae_v ... --vae_a ... --ckpt runs/dit/last.pt \
         --prompt "..." [--image img.jpg] [--audio voix.wav] --out clip.mp4

Prerequis : Linux + CUDA (Ampere+ recommande), ffmpeg, pip install torch opencv-python
            transformers sentencepiece
"""
import argparse, copy, csv, math, os, random, shutil, subprocess, wave
from pathlib import Path

import cv2
import numpy as np
import torch
import torch.distributed as dist
import torch.nn as nn
import torch.nn.functional as F
from torch.nn.parallel import DistributedDataParallel as DDP
from torch.utils.checkpoint import checkpoint
from torch.utils.data import DataLoader, Dataset, DistributedSampler

TC = 4        # compression temporelle du VAE video
HOP = 512     # compression du VAE audio
PRESETS = {   # ~params : small 0.1B | base 0.8B | large 2.4B
    "small": dict(dv=512, da=256, depth=12, hv=8, ha=4),
    "base": dict(dv=1024, da=512, depth=24, hv=16, ha=8),
    "large": dict(dv=1536, da=768, depth=32, hv=24, ha=12),
}


# ============================================================================
# OUTILS (distribue, checkpoints, schedule)
# ============================================================================
def dist_init():
    if not torch.cuda.is_available():
        raise SystemExit("REFUS : GPU CUDA requis - l'entrainement AV neural de gen3 "
                         "ne fonctionne pas sur CPU (convention gen3 GPU-only).")
    if "RANK" in os.environ:
        dist.init_process_group("nccl")
        lr = int(os.environ["LOCAL_RANK"])
        torch.cuda.set_device(lr)
        return dist.get_rank(), dist.get_world_size(), torch.device("cuda", lr)
    return 0, 1, torch.device("cuda", 0)


def save(obj, path):
    tmp = str(path) + ".tmp"
    torch.save(obj, tmp)
    os.replace(tmp, path)


def lr_at(step, total, base, warm=1000):
    if step < warm:
        return base * (step + 1) / warm
    p = (step - warm) / max(1, total - warm)
    return base * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * p)))


def amp_dtype():
    return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16


def loader(ds, bs, w, r, workers=4, shuffle=True):
    sam = DistributedSampler(ds, w, r, shuffle=shuffle) if w > 1 else None
    dl = DataLoader(ds, batch_size=bs, sampler=sam, shuffle=(sam is None and shuffle),
                    num_workers=workers, drop_last=True, pin_memory=True,
                    persistent_workers=workers > 0)
    ep = 0
    while True:
        if sam is not None:
            sam.set_epoch(ep)
        yield from dl
        ep += 1


# ============================================================================
# DONNEES  (video + audio alignes exactement dans le temps)
# ============================================================================
def center_square(fr_bgr, size):
    fr = cv2.cvtColor(fr_bgr, cv2.COLOR_BGR2RGB)
    h, w = fr.shape[:2]
    s = min(h, w)
    y, x = (h - s) // 2, (w - s) // 2
    return cv2.resize(fr[y:y + s, x:x + s], (size, size), interpolation=cv2.INTER_AREA)


def read_audio(path, t0, dur, sr, n):
    cmd = ["ffmpeg", "-v", "quiet", "-ss", f"{t0:.3f}", "-t", f"{dur:.3f}", "-i", str(path),
           "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"]
    try:
        a = np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, dtype=np.float32)
    except Exception:
        a = np.zeros(0, dtype=np.float32)
    a = a[:n]
    if len(a) < n:
        a = np.pad(a, (0, n - len(a)))
    return np.clip(a, -1, 1)


class AVDataset(Dataset):
    def __init__(self, root, size=256, frames=32, fps=12, sr=16000):
        assert frames % TC == 0 and size % 16 == 0
        self.root, self.size, self.frames, self.fps, self.sr = Path(root), size, frames, fps, sr
        self.dur = frames / fps
        self.n_audio = int(self.dur * sr) // HOP * HOP
        with open(self.root / "metadata.csv", encoding="utf-8") as f:
            self.items = [(r["file"], r["caption"]) for r in csv.DictReader(f)]

    def __len__(self):
        return len(self.items)

    def get(self, i):
        f, cap = self.items[i]
        path = self.root / f
        vc = cv2.VideoCapture(str(path))
        src = vc.get(cv2.CAP_PROP_FPS) or 24.0
        total = int(vc.get(cv2.CAP_PROP_FRAME_COUNT)) / src
        t0 = random.uniform(0, max(0.0, total - self.dur))
        idx = [int(round((t0 + k / self.fps) * src)) for k in range(self.frames)]  # fps exact
        vc.set(cv2.CAP_PROP_POS_FRAMES, idx[0])
        need, got, cur = set(idx), {}, idx[0]
        while cur <= idx[-1]:
            ok, fr = vc.read()
            if not ok:
                break
            if cur in need:
                got[cur] = center_square(fr, self.size)
            cur += 1
        vc.release()
        if not got:
            raise IOError(path)
        frames, last = [], next(iter(got.values()))
        for k in idx:
            last = got.get(k, last)
            frames.append(last)
        v = torch.from_numpy(np.stack(frames)).float().permute(3, 0, 1, 2) / 127.5 - 1  # 3,T,H,W
        a = torch.from_numpy(read_audio(path, idx[0] / src, self.dur, self.sr, self.n_audio))[None]
        return v, a, cap

    def __getitem__(self, i):
        for _ in range(10):
            try:
                return self.get(i)
            except Exception:
                i = random.randrange(len(self))
        raise RuntimeError("Dataset illisible")


# ============================================================================
# VAE VIDEO 3D
# ============================================================================
def conv3(i, o, s=(1, 1, 1)):
    return nn.Conv3d(i, o, 3, s, 1)


class Res3D(nn.Module):
    def __init__(self, c):
        super().__init__()
        self.n1, self.c1 = nn.GroupNorm(8, c), conv3(c, c)
        self.n2, self.c2 = nn.GroupNorm(8, c), conv3(c, c)

    def forward(self, x):
        return x + self.c2(F.silu(self.n2(self.c1(F.silu(self.n1(x))))))


class VAE3D(nn.Module):
    STRIDES = [(2, 2, 2), (2, 2, 2), (1, 2, 2)]

    def __init__(self, zc=8, chs=(64, 128, 256, 256)):
        super().__init__()
        enc = [conv3(3, chs[0])]
        for i, st in enumerate(self.STRIDES):
            enc += [Res3D(chs[i]), Res3D(chs[i]), conv3(chs[i], chs[i + 1], st)]
        enc += [Res3D(chs[-1]), nn.GroupNorm(8, chs[-1]), nn.SiLU(), conv3(chs[-1], 2 * zc)]
        dec = [conv3(zc, chs[-1]), Res3D(chs[-1])]
        for i in reversed(range(3)):
            dec += [nn.Upsample(scale_factor=self.STRIDES[i], mode="nearest"),
                    conv3(chs[i + 1], chs[i]), Res3D(chs[i]), Res3D(chs[i])]
        dec += [nn.GroupNorm(8, chs[0]), nn.SiLU(), conv3(chs[0], 3)]
        self.enc, self.dec, self.zc = nn.Sequential(*enc), nn.Sequential(*dec), zc

    def encode(self, x):
        mu, lv = self.enc(x).chunk(2, 1)
        return mu, lv.clamp(-20, 10)

    def decode(self, z):
        return self.dec(z)

    def forward(self, x):
        mu, lv = self.encode(x)
        z = mu + torch.randn_like(mu) * torch.exp(0.5 * lv)
        return self.decode(z), -0.5 * torch.mean(1 + lv - mu.pow(2) - lv.exp())


def vid_loss(rec, x):  # L1 + coherence temporelle (fluidite) + nettete spatiale
    l = F.l1_loss(rec, x)
    lt = F.l1_loss(rec[:, :, 1:] - rec[:, :, :-1], x[:, :, 1:] - x[:, :, :-1])
    gx = F.l1_loss(rec[..., 1:] - rec[..., :-1], x[..., 1:] - x[..., :-1])
    gy = F.l1_loss(rec[..., 1:, :] - rec[..., :-1, :], x[..., 1:, :] - x[..., :-1, :])
    return l + 0.5 * lt + 0.5 * (gx + gy)


# ============================================================================
# VAE AUDIO 1D (waveform)
# ============================================================================
class Res1D(nn.Module):
    def __init__(self, c, d=1):
        super().__init__()
        self.n1, self.c1 = nn.GroupNorm(8, c), nn.Conv1d(c, c, 7, padding=3 * d, dilation=d)
        self.n2, self.c2 = nn.GroupNorm(8, c), nn.Conv1d(c, c, 1)

    def forward(self, x):
        return x + self.c2(F.silu(self.n2(self.c1(F.silu(self.n1(x))))))


class AudioVAE(nn.Module):
    STRIDES = (2, 4, 4, 4, 4)  # produit = 512 = HOP

    def __init__(self, ac=16, chs=(32, 64, 128, 256, 256, 256)):
        super().__init__()
        enc = [nn.Conv1d(1, chs[0], 7, padding=3)]
        for i, s in enumerate(self.STRIDES):
            enc += [Res1D(chs[i], 1), Res1D(chs[i], 3), nn.Conv1d(chs[i], chs[i + 1], 2 * s, s, padding=s // 2)]
        enc += [Res1D(chs[-1]), nn.GroupNorm(8, chs[-1]), nn.SiLU(), nn.Conv1d(chs[-1], 2 * ac, 3, padding=1)]
        dec = [nn.Conv1d(ac, chs[-1], 3, padding=1), Res1D(chs[-1])]
        for i in reversed(range(len(self.STRIDES))):
            s = self.STRIDES[i]
            dec += [nn.ConvTranspose1d(chs[i + 1], chs[i], 2 * s, s, padding=s // 2),
                    Res1D(chs[i], 1), Res1D(chs[i], 3)]
        dec += [nn.GroupNorm(8, chs[0]), nn.SiLU(), nn.Conv1d(chs[0], 1, 7, padding=3)]
        self.enc, self.dec, self.ac = nn.Sequential(*enc), nn.Sequential(*dec), ac

    def encode(self, x):
        mu, lv = self.enc(x).chunk(2, 1)
        return mu, lv.clamp(-20, 10)

    def decode(self, z):
        return self.dec(z)

    def forward(self, x):
        mu, lv = self.encode(x)
        z = mu + torch.randn_like(mu) * torch.exp(0.5 * lv)
        return self.decode(z), -0.5 * torch.mean(1 + lv - mu.pow(2) - lv.exp())


def aud_loss(rec, x):  # waveform L1 + multi-resolution STFT
    l = F.l1_loss(rec, x)
    s = 0.0
    for n in (512, 1024, 2048):
        w = torch.hann_window(n, device=x.device)
        Y = torch.stft(rec.squeeze(1), n, n // 4, window=w, return_complex=True).abs()
        X = torch.stft(x.squeeze(1), n, n // 4, window=w, return_complex=True).abs()
        s = s + torch.norm(X - Y) / (torch.norm(X) + 1e-7) + F.l1_loss(torch.log(Y + 1e-5), torch.log(X + 1e-5))
    return l + s / 3


def load_vae(cls, path, dev):
    m = cls().to(dev)
    m.load_state_dict(torch.load(path, map_location=dev)["model"])
    return m.eval().requires_grad_(False)


# ============================================================================
# ENCODEUR TEXTE (gele). Francais : --text_model google/mt5-large
# ============================================================================
class TextEnc:
    def __init__(self, dev, name="google/flan-t5-large", max_len=96):
        from transformers import AutoModel, AutoTokenizer
        self.tok = AutoTokenizer.from_pretrained(name)
        self.m = AutoModel.from_pretrained(name).encoder.to(dev).eval().requires_grad_(False)
        self.dev, self.L, self.dim = dev, max_len, self.m.config.d_model

    @torch.no_grad()
    def __call__(self, caps):
        t = self.tok(list(caps), padding="max_length", truncation=True, max_length=self.L,
                     return_tensors="pt").to(self.dev)
        return self.m(**t).last_hidden_state, t.attention_mask.bool()


# ============================================================================
# AV-DiT
# ============================================================================
def timestep_emb(t, dim=256):
    half = dim // 2
    f = torch.exp(-math.log(10000) * torch.arange(half, device=t.device) / half)
    a = t[:, None].float() * 1000 * f[None]
    return torch.cat([a.cos(), a.sin()], -1)


def sincos(sec, dim):  # embedding temporel en SECONDES (commun video/audio)
    f = 2 * math.pi * torch.logspace(math.log10(0.1), math.log10(60), dim // 2, device=sec.device)
    a = sec[:, None].float() * f[None]
    return torch.cat([a.sin(), a.cos()], -1)


class RMS(nn.Module):
    def __init__(self, d):
        super().__init__()
        self.w = nn.Parameter(torch.ones(d))

    def forward(self, x):
        return (x.float() * torch.rsqrt(x.float().pow(2).mean(-1, keepdim=True) + 1e-6) * self.w).to(x.dtype)


class Attn(nn.Module):
    def __init__(self, d, heads, ctx_dim=None):
        super().__init__()
        self.h = heads
        self.q, self.kv, self.o = nn.Linear(d, d), nn.Linear(ctx_dim or d, 2 * d), nn.Linear(d, d)
        self.qn, self.kn = RMS(d // heads), RMS(d // heads)

    def forward(self, x, ctx=None, mask=None):
        ctx = x if ctx is None else ctx
        B, N, D = x.shape
        q = self.q(x).view(B, N, self.h, -1).transpose(1, 2)
        k, v = self.kv(ctx).view(B, ctx.shape[1], 2, self.h, -1).permute(2, 0, 3, 1, 4)
        o = F.scaled_dot_product_attention(self.qn(q), self.kn(k), v, attn_mask=mask)
        return self.o(o.transpose(1, 2).reshape(B, N, D))


def mlp(d):
    return nn.Sequential(nn.Linear(d, 4 * d), nn.GELU(approximate="tanh"), nn.Linear(4 * d, d))


def ln0(d):
    return nn.LayerNorm(d, elementwise_affine=False, eps=1e-6)


def zero_(lin):
    nn.init.zeros_(lin.weight), nn.init.zeros_(lin.bias)
    return lin


class AVBlock(nn.Module):
    def __init__(self, dv, da, hv, ha):
        super().__init__()
        self.ada_v, self.ada_a = nn.Sequential(nn.SiLU(), zero_(nn.Linear(dv, 6 * dv))), \
            nn.Sequential(nn.SiLU(), zero_(nn.Linear(da, 6 * da)))
        self.n1v, self.n3v, self.n1a, self.n3a = ln0(dv), ln0(dv), ln0(da), ln0(da)
        self.sa_v, self.sa_a = Attn(dv, hv), Attn(da, ha)
        self.n2v, self.n2a = nn.LayerNorm(dv), nn.LayerNorm(da)
        self.tx_v, self.tx_a = Attn(dv, hv), Attn(da, ha)                       # texte
        self.nxv, self.nxa = nn.LayerNorm(dv), nn.LayerNorm(da)
        self.xv, self.xa = Attn(dv, hv, ctx_dim=da), Attn(da, ha, ctx_dim=dv)   # audio <-> video
        self.gv, self.ga = nn.Parameter(torch.zeros(1)), nn.Parameter(torch.zeros(1))
        self.mv, self.ma = mlp(dv), mlp(da)

    def forward(self, hv, ha, cv, ca, tv, ta, m):
        s1, c1, g1, s2, c2, g2 = self.ada_v(cv)[:, None].chunk(6, -1)
        u1, d1, e1, u2, d2, e2 = self.ada_a(ca)[:, None].chunk(6, -1)
        hv = hv + g1 * self.sa_v(self.n1v(hv) * (1 + c1) + s1)
        ha = ha + e1 * self.sa_a(self.n1a(ha) * (1 + d1) + u1)
        hv = hv + self.tx_v(self.n2v(hv), tv, m)
        ha = ha + self.tx_a(self.n2a(ha), ta, m)
        nv, na = self.nxv(hv), self.nxa(ha)                                      # synchro AV
        hv, ha = hv + self.gv * self.xv(nv, na), ha + self.ga * self.xa(na, nv)
        hv = hv + g2 * self.mv(self.n3v(hv) * (1 + c2) + s2)
        ha = ha + e2 * self.ma(self.n3a(ha) * (1 + d2) + u2)
        return hv, ha


class AVDiT(nn.Module):
    def __init__(self, zc, ac, T, H, W, La, dv, da, depth, hv, ha, txt_dim, fps, sr, p=2, ckpt=True):
        super().__init__()
        self.zc, self.p, self.ckpt = zc, p, ckpt
        self.dv, self.da = dv, da
        self.pv = nn.Conv3d(2 * zc + 1, dv, (1, p, p), (1, p, p))
        self.pa = nn.Linear(ac, da)
        self.pos_s = nn.Parameter(torch.randn(1, 1, (H // p) * (W // p), dv) * 0.02)
        self.tp_v, self.tp_a = nn.Linear(dv, dv), nn.Linear(da, da)
        self.register_buffer("vt", torch.arange(T) * (TC / fps), persistent=False)
        self.register_buffer("at", torch.arange(La) * (HOP / sr), persistent=False)
        self.tm_v = nn.Sequential(nn.Linear(256, dv), nn.SiLU(), nn.Linear(dv, dv))
        self.tm_a = nn.Sequential(nn.Linear(256, da), nn.SiLU(), nn.Linear(da, da))
        self.txt_v, self.txt_a = nn.Linear(txt_dim, dv), nn.Linear(txt_dim, da)
        self.blocks = nn.ModuleList([AVBlock(dv, da, hv, ha) for _ in range(depth)])
        self.nfv, self.nfa = ln0(dv), ln0(da)
        self.adf_v = nn.Sequential(nn.SiLU(), zero_(nn.Linear(dv, 2 * dv)))
        self.adf_a = nn.Sequential(nn.SiLU(), zero_(nn.Linear(da, 2 * da)))
        self.ov, self.oa = zero_(nn.Linear(dv, p * p * zc)), zero_(nn.Linear(da, ac))

    def forward(self, xv, xa, tv, ta, txt, mask, cond):
        B = xv.shape[0]
        h = self.pv(torch.cat([xv, cond], 1))                       # B,dv,T,Hp,Wp
        T, Hp, Wp = h.shape[2:]
        h = h.permute(0, 2, 3, 4, 1).reshape(B, T, Hp * Wp, self.dv)
        h = h + self.tp_v(sincos(self.vt, self.dv))[None, :, None] + self.pos_s
        hv = h.reshape(B, T * Hp * Wp, self.dv)
        ha = self.pa(xa.transpose(1, 2)) + self.tp_a(sincos(self.at, self.da))[None]
        cv, ca = self.tm_v(timestep_emb(tv)), self.tm_a(timestep_emb(ta))
        tvx, tax, m = self.txt_v(txt), self.txt_a(txt), mask[:, None, None, :]
        for blk in self.blocks:
            if self.ckpt and self.training:
                hv, ha = checkpoint(blk, hv, ha, cv, ca, tvx, tax, m, use_reentrant=False)
            else:
                hv, ha = blk(hv, ha, cv, ca, tvx, tax, m)
        sv, cs = self.adf_v(cv)[:, None].chunk(2, -1)
        sa_, ca_ = self.adf_a(ca)[:, None].chunk(2, -1)
        ov = self.ov(self.nfv(hv) * (1 + cs) + sv).view(B, T, Hp, Wp, self.p, self.p, self.zc)
        ov = ov.permute(0, 6, 1, 2, 4, 3, 5).reshape(B, self.zc, T, Hp * self.p, Wp * self.p)
        oa = self.oa(self.nfa(ha) * (1 + ca_) + sa_).transpose(1, 2)
        return ov, oa


def build_dit(cfg, ckpt=True):
    return AVDiT(cfg["zc"], cfg["ac"], cfg["T"], cfg["H"], cfg["W"], cfg["La"], cfg["dv"], cfg["da"],
                 cfg["depth"], cfg["hv"], cfg["ha"], cfg["txt_dim"], cfg["fps"], cfg["sr"], ckpt=ckpt)


def appliquer_profil(a):
    """Ajuste preset et affiche le niveau gen3 détecté (GPU obligatoire)."""
    if not torch.cuda.is_available():
        raise SystemExit("REFUS : GPU CUDA requis - gen3 ne s'entraine pas sur CPU.")
    vram = torch.cuda.get_device_properties(0).total_memory / 2 ** 30
    nom = getattr(a, "profil", "auto") or "auto"
    if nom == "auto":
        nom = "a100_40g" if vram >= 36 else "l4"
    if hasattr(a, "preset") and a.preset is None:
        a.preset = "base" if nom == "a100_40g" else "small"
    print(f"[profil] gen3 AV neural : {nom} ({vram:.0f} Go VRAM) - preset {getattr(a, 'preset', '-')}")


# ============================================================================
# 1) / 2)  ENTRAINEMENT DES VAE
# ============================================================================
def train_vae(a, kind):
    r, w, dev = dist_init()
    dt = amp_dtype()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    ds = AVDataset(a.data, a.size, a.frames, a.fps, a.sr)
    model = (VAE3D() if kind == "v" else AudioVAE()).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, betas=(0.9, 0.99))
    step = 0
    if (out / "last.pt").exists():
        s = torch.load(out / "last.pt", map_location=dev)
        model.load_state_dict(s["model"]); opt.load_state_dict(s["opt"]); step = s["step"]
    dm = DDP(model, device_ids=[dev.index]) if w > 1 else model
    scaler = torch.amp.GradScaler("cuda", enabled=dt == torch.float16)
    data = loader(ds, a.bs, w, r, a.workers)
    while step < a.steps:
        v, au, _ = next(data)
        x = (v if kind == "v" else au).to(dev, non_blocking=True)
        for g in opt.param_groups:
            g["lr"] = lr_at(step, a.steps, a.lr, 500)
        with torch.autocast("cuda", dtype=dt):
            rec, kl = dm(x)
        l = vid_loss(rec.float(), x) if kind == "v" else aud_loss(rec.float(), x)
        loss = l + a.kl * kl.float()
        opt.zero_grad(set_to_none=True)
        scaler.scale(loss).backward()
        scaler.unscale_(opt); nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(opt); scaler.update()
        step += 1
        if r == 0 and step % 50 == 0:
            print(f"[vae_{kind}] {step}/{a.steps} loss={l.item():.4f} kl={kl.item():.2f}", flush=True)
        if r == 0 and (step % a.save_every == 0 or step == a.steps):
            save({"model": model.state_dict(), "opt": opt.state_dict(), "step": step}, out / "last.pt")


# ============================================================================
# 3) CACHE DES LATENTS + EMBEDDINGS TEXTE
# ============================================================================
@torch.no_grad()
def cache(a):
    r, w, dev = dist_init()
    dt = amp_dtype()
    vv, va = load_vae(VAE3D, a.vae_v, dev), load_vae(AudioVAE, a.vae_a, dev)
    te = TextEnc(dev, a.text_model)
    ds = AVDataset(a.data, a.size, a.frames, a.fps, a.sr)
    out = Path(a.cache); out.mkdir(parents=True, exist_ok=True)
    if r == 0:
        t, m = te([""])
        save({"txt": t[0].cpu().half(), "mask": m[0].cpu()}, out / "null.pt")
    for i in range(r, len(ds), w):
        for k in range(a.clips):
            f = out / f"{i:07d}_{k}.pt"
            if f.exists():
                continue
            try:
                v, au, cap = ds.get(i)
            except Exception:
                continue
            with torch.autocast("cuda", dtype=dt):
                zv = vv.encode(v[None].to(dev))[0][0]
                za = va.encode(au[None].to(dev))[0][0]
            t, m = te([cap])
            save({"zv": zv.float().cpu().half(), "za": za.float().cpu().half(),
                  "txt": t[0].cpu().half(), "mask": m[0].cpu()}, f)
        if r == 0 and i % 100 == 0:
            print(f"[cache] {i}/{len(ds)}", flush=True)


class LatentDS(Dataset):
    def __init__(self, root):
        self.files = sorted(p for p in Path(root).glob("*.pt") if p.name != "null.pt")

    def __len__(self):
        return len(self.files)

    def __getitem__(self, i):
        d = torch.load(self.files[i], weights_only=True)
        return d["zv"], d["za"], d["txt"], d["mask"]


# ============================================================================
# 4) ENTRAINEMENT AV-DiT  (flow matching, timesteps par modalite)
# ============================================================================
def train_dit(a):
    r, w, dev = dist_init()
    dt = amp_dtype()
    torch.backends.cuda.matmul.allow_tf32 = True
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    ds = LatentDS(a.cache)
    null = torch.load(Path(a.cache) / "null.pt", weights_only=True)
    ntxt, nmask = null["txt"].float().to(dev), null["mask"].to(dev)

    zs = [ds[i] for i in range(min(128, len(ds)))]                 # echelle des latents
    sv = float(1 / torch.stack([z[0].float() for z in zs]).std())
    sa = float(1 / torch.stack([z[1].float() for z in zs]).std())
    zc, T, H, W = zs[0][0].shape
    ac, La = zs[0][1].shape
    cfg = dict(PRESETS[a.preset], zc=zc, ac=ac, T=T, H=H, W=W, La=La, txt_dim=zs[0][2].shape[-1],
               fps=a.fps, sr=a.sr, size=a.size, frames=a.frames, sv=sv, sa=sa, text_model=a.text_model)

    ck, step = out / "last.pt", 0
    sd = torch.load(ck, map_location="cpu") if ck.exists() else None
    if sd is not None:
        cfg = sd["cfg"]
    model = build_dit(cfg, ckpt=not a.no_ckpt).to(dev)
    ema = copy.deepcopy(model).requires_grad_(False)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, betas=(0.9, 0.95), weight_decay=0.01)
    if sd is not None:
        model.load_state_dict(sd["model"]); ema.load_state_dict(sd["ema"])
        opt.load_state_dict(sd["opt"]); step = sd["step"]; sv, sa = cfg["sv"], cfg["sa"]
        del sd
    if a.compile:
        for i in range(len(model.blocks)):
            model.blocks[i] = torch.compile(model.blocks[i])
    if r == 0:
        n = sum(p.numel() for p in model.parameters()) / 1e9
        print(f"AV-DiT {a.preset}: {n:.2f} B params | latent video {zc}x{T}x{H}x{W} | audio {ac}x{La}", flush=True)
    dm = DDP(model, device_ids=[dev.index]) if w > 1 else model
    scaler = torch.amp.GradScaler("cuda", enabled=dt == torch.float16)
    data = loader(ds, a.bs, w, r, a.workers)
    probs = torch.tensor([0.5, 0.3, 0.2], device=dev)             # joint | audio->video | video->audio
    model.train()
    run = 0.0
    while step < a.steps:
        for g in opt.param_groups:
            g["lr"] = lr_at(step, a.steps, a.lr)
        for mi in range(a.accum):
            zv, za, txt, mask = [t.to(dev, non_blocking=True) for t in next(data)]
            zv, za, txt = zv.float() * sv, za.float() * sa, txt.float()
            B = zv.shape[0]
            drop = torch.rand(B, device=dev) < a.drop                # dropout texte (CFG)
            txt = torch.where(drop[:, None, None], ntxt.expand(B, -1, -1), txt)
            mask = torch.where(drop[:, None], nmask.expand(B, -1), mask)
            mode = torch.multinomial(probs, B, replacement=True)
            tv = torch.sigmoid(torch.randn(B, device=dev)); ta = tv.clone()
            ta = torch.where(mode == 1, torch.zeros_like(ta), ta)    # voix donnee propre
            tv = torch.where(mode == 2, torch.zeros_like(tv), tv)    # video donnee propre
            ev, ea = torch.randn_like(zv), torch.randn_like(za)
            xv = (1 - tv.view(B, 1, 1, 1, 1)) * zv + tv.view(B, 1, 1, 1, 1) * ev
            xa = (1 - ta.view(B, 1, 1)) * za + ta.view(B, 1, 1) * ea
            cond = torch.zeros(B, zc + 1, T, H, W, device=dev)       # image -> video (30%)
            use = (torch.rand(B, device=dev) < 0.3) & (mode != 2)
            cond[use, :zc, 0] = zv[use, :, 0]
            cond[use, zc, 0] = 1
            sync = dm.no_sync() if (w > 1 and mi < a.accum - 1) else torch.autocast("cuda", enabled=False)
            with sync:
                with torch.autocast("cuda", dtype=dt):
                    pv, pa = dm(xv, xa, tv, ta, txt, mask, cond)
                mv, ma = (tv > 0).float(), (ta > 0).float()
                lv = (((pv.float() - (ev - zv)) ** 2).flatten(1).mean(1) * mv).sum() / mv.sum().clamp(min=1)
                la = (((pa.float() - (ea - za)) ** 2).flatten(1).mean(1) * ma).sum() / ma.sum().clamp(min=1)
                loss = (lv + a.wa * la) / a.accum
                scaler.scale(loss).backward()
            run += loss.item()
        scaler.unscale_(opt); nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(opt); scaler.update(); opt.zero_grad(set_to_none=True)
        with torch.no_grad():
            d = min(a.ema, (1 + step) / (10 + step))
            for pe, p in zip(ema.parameters(), model.parameters()):
                pe.lerp_(p, 1 - d)
        step += 1
        if r == 0 and step % 25 == 0:
            print(f"[dit] {step}/{a.steps} loss={run / 25:.4f} lr={opt.param_groups[0]['lr']:.2e}", flush=True)
            run = 0.0
        if r == 0 and (step % a.save_every == 0 or step == a.steps):
            save({"model": model.state_dict(), "ema": ema.state_dict(), "opt": opt.state_dict(),
                  "step": step, "cfg": cfg}, ck)


# ============================================================================
# 5) GENERATION  (Euler + CFG ; voix optionnelle => lip-sync)
# ============================================================================
@torch.no_grad()
def sample(a):
    dev = torch.device("cuda")
    s = torch.load(a.ckpt, map_location=dev); cfg = s["cfg"]
    model = build_dit(cfg, ckpt=False).to(dev)
    model.load_state_dict(s["ema"]); model.eval()
    vv, va = load_vae(VAE3D, a.vae_v, dev), load_vae(AudioVAE, a.vae_a, dev)
    te = TextEnc(dev, cfg["text_model"])
    zc, ac, T, H, W, La = cfg["zc"], cfg["ac"], cfg["T"], cfg["H"], cfg["W"], cfg["La"]
    sv, sa, fps, sr = cfg["sv"], cfg["sa"], cfg["fps"], cfg["sr"]
    dur = cfg["frames"] / fps
    n_audio = int(dur * sr) // HOP * HOP

    cond = torch.zeros(1, zc + 1, T, H, W, device=dev)
    if a.image:
        fr = center_square(cv2.imread(a.image), cfg["size"])
        v = torch.from_numpy(np.stack([fr] * cfg["frames"])).float().permute(3, 0, 1, 2)[None] / 127.5 - 1
        cond[:, :zc, 0] = vv.encode(v.to(dev))[0][:, :, 0] * sv
        cond[:, zc, 0] = 1
    fixed = None
    if a.audio:
        wav = torch.from_numpy(read_audio(a.audio, 0.0, dur, sr, n_audio))[None, None].to(dev)
        fixed = va.encode(wav)[0] * sa

    txt, mask = te([a.prompt]); ntxt, nmask = te([""])
    if a.seed is not None:
        torch.manual_seed(a.seed)
    xv = torch.randn(1, zc, T, H, W, device=dev)
    xa = fixed if fixed is not None else torch.randn(1, ac, La, device=dev)
    ts = torch.linspace(1, 0, a.steps + 1, device=dev)
    ts = a.shift * ts / (1 + (a.shift - 1) * ts)
    for i in range(a.steps):
        t = ts[i].expand(1)
        tau = torch.zeros_like(t) if fixed is not None else t
        with torch.autocast("cuda", dtype=amp_dtype()):
            pv, pa = model(xv, xa, t, tau, txt, mask, cond)
            uv, ua = model(xv, xa, t, tau, ntxt, nmask, cond)
        dtt = ts[i] - ts[i + 1]
        xv = xv - dtt * (uv.float() + a.cfg * (pv.float() - uv.float()))
        if fixed is None:
            xa = xa - dtt * (ua.float() + a.cfg_audio * (pa.float() - ua.float()))
    vid = vv.decode(xv / sv).clamp(-1, 1)[0].permute(1, 2, 3, 0)
    vid = ((vid + 1) * 127.5).byte().cpu().numpy()
    aud = va.decode(xa / sa).clamp(-1, 1)[0, 0].cpu().numpy()

    out = Path(a.out)
    tmp_v, tmp_a = out.with_suffix(".tmp.mp4"), out.with_suffix(".wav")
    wr = cv2.VideoWriter(str(tmp_v), cv2.VideoWriter_fourcc(*"mp4v"), fps, (vid.shape[2], vid.shape[1]))
    for f in vid:
        wr.write(cv2.cvtColor(f, cv2.COLOR_RGB2BGR))
    wr.release()
    with wave.open(str(tmp_a), "wb") as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(sr)
        wf.writeframes((aud * 32767).astype(np.int16).tobytes())
    if shutil.which("ffmpeg"):
        subprocess.run(["ffmpeg", "-y", "-v", "quiet", "-i", str(tmp_v), "-i", str(tmp_a), "-c:v", "libx264",
                        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(out)], check=True)
        tmp_v.unlink()
    else:
        tmp_v.rename(out)
    print("sauvegarde :", out)


# ============================================================================
if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest="cmd", required=True)

    def common(q):
        q.add_argument("--data", default="./data"); q.add_argument("--out", default="./runs/out")
        q.add_argument("--size", type=int, default=256); q.add_argument("--frames", type=int, default=32)
        q.add_argument("--fps", type=int, default=12); q.add_argument("--sr", type=int, default=16000)
        q.add_argument("--bs", type=int, default=2); q.add_argument("--steps", type=int, default=100000)
        q.add_argument("--save_every", type=int, default=1000); q.add_argument("--workers", type=int, default=4)
        q.add_argument("--lr", type=float, default=2e-4)
        q.add_argument("--profil", choices=["auto", "l4", "a100_40g"], default="auto")

    for name in ("vae_v", "vae_a"):
        q = sp.add_parser(name); common(q); q.add_argument("--kl", type=float, default=1e-6)

    q = sp.add_parser("cache"); common(q)
    q.add_argument("--vae_v", required=True); q.add_argument("--vae_a", required=True)
    q.add_argument("--cache", default="./cache"); q.add_argument("--clips", type=int, default=4)
    q.add_argument("--text_model", default="google/flan-t5-large")

    q = sp.add_parser("dit"); common(q)
    q.set_defaults(lr=1e-4, bs=4, steps=300000)
    q.add_argument("--cache", default="./cache"); q.add_argument("--preset", choices=PRESETS, default=None)
    q.add_argument("--accum", type=int, default=4); q.add_argument("--drop", type=float, default=0.1)
    q.add_argument("--wa", type=float, default=1.0); q.add_argument("--ema", type=float, default=0.9999)
    q.add_argument("--text_model", default="google/flan-t5-large")
    q.add_argument("--no_ckpt", action="store_true"); q.add_argument("--compile", action="store_true")

    q = sp.add_parser("sample")
    q.add_argument("--vae_v", required=True); q.add_argument("--vae_a", required=True)
    q.add_argument("--ckpt", required=True); q.add_argument("--prompt", default="")
    q.add_argument("--image", default=None); q.add_argument("--audio", default=None)
    q.add_argument("--out", default="clip.mp4"); q.add_argument("--steps", type=int, default=40)
    q.add_argument("--cfg", type=float, default=5.0); q.add_argument("--cfg_audio", type=float, default=3.0)
    q.add_argument("--shift", type=float, default=3.0); q.add_argument("--seed", type=int, default=None)

    args = p.parse_args()
    appliquer_profil(args)
    {"vae_v": lambda x: train_vae(x, "v"), "vae_a": lambda x: train_vae(x, "a"),
     "cache": cache, "dit": train_dit, "sample": sample}[args.cmd](args)
    if dist.is_initialized():
        dist.destroy_process_group()
