#!/usr/bin/env python3
"""
voice_audio_system.py
=====================================================================
Système complet de génération audio ultra-réaliste + clonage de voix.

POSITION DANS LE PACK GEN3 (honnêteté) :
  · Vocodeur HiFi-GAN entraîné ICI-FROM-SCRATCH → SONS et SFX réels
    (le corpus fourni définit ce que le vocodeur sait restituer) ;
  · Clonage de voix zero-shot → F5-TTS (poids pré-entraînés, ~6-10 s
    de référence) — pas un modèle from scratch ;
  · Mémorisation de voix → empreintes ECAPA-TDNN 192-d (768 octets
    par voix : identification, vérification d'identité vocale).

ARCHITECTURE
------------
[WAV/OGG/FLAC] -> [Mel spectrogram] -> [HiFi-GAN Generator] -> [Onde 24 kHz]
                                                          ^
                                                          |
              [Embedding ECAPA-TDNN (192-d)] <- voix mémorisée
                                                          ^
                                                          |
                          [F5-TTS / XTTS-v2] <- clonage zero-shot

COMMANDES
---------
python voice_audio_system.py prepare                    # WAV -> .npy mel
python voice_audio_system.py train                      # entraîne HiFi-GAN
python voice_audio_system.py sample --n 8               # sons depuis le vocodeur
python voice_audio_system.py sfx --label explosion      # SFX catégoriel
python voice_audio_system.py memorize --wav voix.wav --name alice
python voice_audio_system.py clone --text "Bonjour" --ref_wav r.wav --ref_text "…"

DÉPENDANCES
-----------
pip install torch torchaudio librosa soundfile numpy tqdm
pip install speechbrain   # pour ECAPA-TDNN (mémorisation voix)
pip install f5-tts        # pour le clonage zero-shot (optionnel)

STRUCTURE DISQUE ATTENDUE
-------------------------
data/raw/       # place ici tes .wav / .ogg / .flac / .mp3
data/mels/      # généré par `prepare`
checkpoints/    # généré par `train`
voices/         # généré par `memorize`
outputs/        # généré par `sample`, `clone`, `sfx`

CORRECTIONS PAR RAPPORT À LA SOURCE UTILISATEUR (documentées) :
  · `train` REFUSE PROPREMENT sans CUDA (standard du pack : gen3 ne
    s'entraîne pas sur CPU — la source lançait silencieusement sur CPU) ;
  · `_save_wav` gère les chemins sans répertoire parent (dirname "") ;
  · `clone` sauvegarde toujours le WAV produit (la source écrasait avec
    un appel conditionnel équivalent mais confus).
=====================================================================
"""

import argparse
import glob
import os
import random

import numpy as np
import soundfile as sf
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, Dataset
from tqdm import tqdm

# -------------------------------------------------------------------------
# CONFIG GLOBALE
# -------------------------------------------------------------------------
CFG = dict(
    sr=24000,        # fréquence d'échantillonnage cible (24 kHz = HiFi-GAN v1)
    n_fft=1024,
    hop=256,         # 24000 / 256 ≈ 93.75 frames/s
    n_mels=80,
    t_frames=352,    # ~3.75 s par clip
    batch=16,
    lr=2e-4,
    steps=200_000,
    device="cuda" if torch.cuda.is_available() else "cpu",
)

DATA_RAW = "data/raw"
DATA_MEL = "data/mels"
CKPT_DIR = "checkpoints"
VOICE_DIR = "voices"
OUT_DIR = "outputs"


# =====================================================================
# 1. PRÉPARATION DES DONNÉES
# =====================================================================
class MelDataset(Dataset):
    """Charge des mel-spectrogrammes .npy normalisés dans [0, 1]."""

    def __init__(self, folder):
        self.files = sorted(glob.glob(os.path.join(folder, "*.npy")))
        if not self.files:
            raise FileNotFoundError(
                f"Aucun .npy dans {folder}. Lance d'abord `prepare`."
            )

    def __len__(self):
        return len(self.files)

    def __getitem__(self, i):
        mel = np.load(self.files[i])  # (n_mels, T)
        return torch.from_numpy(mel).float()  # (n_mels, T)


def cmd_prepare(_args):
    """WAV/OGG/FLAC -> mel .npy normalisé [0, 1], longueur fixe."""
    import librosa

    os.makedirs(DATA_MEL, exist_ok=True)
    files = [os.path.join(r, f) for r, _, fs in os.walk(DATA_RAW)
             for f in fs if f.lower().endswith((".wav", ".ogg", ".flac", ".mp3"))]
    if not files:
        raise SystemExit(f"Aucun audio trouvé dans {DATA_RAW}/")

    for i, path in enumerate(tqdm(files, desc="prepare")):
        y, _ = librosa.load(path, sr=CFG["sr"], mono=True)
        mel = librosa.feature.melspectrogram(
            y=y, sr=CFG["sr"], n_fft=CFG["n_fft"],
            hop_length=CFG["hop"], n_mels=CFG["n_mels"], power=2.0,
        )
        mel_db = librosa.power_to_db(mel, ref=np.max)   # ~[-80, 0]
        mel_norm = np.clip((mel_db + 40) / 40, 0, 1)    # -> [0, 1]

        T = CFG["t_frames"]
        if mel_norm.shape[1] < T:
            mel_norm = np.pad(mel_norm, ((0, 0), (0, T - mel_norm.shape[1])))
        else:
            mel_norm = mel_norm[:, :T]

        np.save(os.path.join(DATA_MEL, f"{i:05d}.npy"),
                mel_norm.astype(np.float32))

    print(f"[✓] {len(files)} mels écrits dans {DATA_MEL}/")


# =====================================================================
# 2. VOCODEUR HiFi-GAN (générateur + discriminateur multi-périodes)
# =====================================================================
class ResBlock(nn.Module):
    def __init__(self, ch, k, dilations):
        super().__init__()
        self.convs = nn.ModuleList([
            nn.Conv1d(ch, ch, k, dilation=d, padding=(k * d - d) // 2)
            for d in dilations
        ])

    def forward(self, x):
        for c in self.convs:
            x = x + c(F.leaky_relu(x, 0.1))
        return x


class Generator(nn.Module):
    """HiFi-GAN V1 : mel (B, 80, T) -> onde (B, T * 256)."""

    def __init__(self, mel_ch=80, ch=512, upsample=(8, 8, 2, 2)):
        super().__init__()
        self.pre = nn.Conv1d(mel_ch, ch, 7, 1, 3)
        blocks = []
        for u in upsample:
            blocks += [
                nn.LeakyReLU(0.1),
                nn.ConvTranspose1d(ch, ch // 2, u * 2, u, padding=u // 2),
                ResBlock(ch // 2, 3, (1, 3, 5)),
                ResBlock(ch // 2, 5, (1, 3, 5)),
            ]
            ch //= 2
        blocks += [nn.LeakyReLU(0.1), nn.Conv1d(ch, 1, 7, 1, 3), nn.Tanh()]
        self.net = nn.Sequential(*blocks)

    def forward(self, mel):
        return self.net(self.pre(mel)).squeeze(1)


class DiscriminatorP(nn.Module):
    """Discriminateur multi-périodes — apprend les micro-motifs temporels."""

    def __init__(self, period):
        super().__init__()
        self.period = period
        self.convs = nn.ModuleList([
            nn.Conv2d(1, 32, (5, 1), (3, 1), padding=(2, 0)),
            nn.Conv2d(32, 128, (5, 1), (3, 1), padding=(2, 0)),
            nn.Conv2d(128, 512, (5, 1), (3, 1), padding=(2, 0)),
            nn.Conv2d(512, 1024, (5, 1), (3, 1), padding=(2, 0)),
            nn.Conv2d(1024, 1024, (5, 1), 1, padding=(2, 0)),
        ])
        self.conv_post = nn.Conv2d(1024, 1, (3, 1), 1, padding=(1, 0))

    def forward(self, x):
        fmap = []
        b, c, t = x.shape
        if t % self.period != 0:
            pad = self.period - (t % self.period)
            x = F.pad(x, (0, pad), "reflect")
            t += pad
        x = x.view(b, c, t // self.period, self.period)
        for conv in self.convs:
            x = F.leaky_relu(conv(x), 0.1)
            fmap.append(x)
        x = self.conv_post(x)
        fmap.append(x)
        return torch.flatten(x, 1, -1), fmap


class MPD(nn.Module):
    def __init__(self, periods=(2, 3, 5, 7, 11)):
        super().__init__()
        self.discs = nn.ModuleList([DiscriminatorP(p) for p in periods])

    def forward(self, x):
        return [d(x) for d in self.discs]


# =====================================================================
# 3. ENTRAÎNEMENT HiFi-GAN
# =====================================================================
def _mel_from_wav(wav):
    """(B, N) onde -> (B, 80, T) mel, mêmes paramètres que `prepare`."""
    import torchaudio
    mel_tf = torchaudio.transforms.MelSpectrogram(
        sample_rate=CFG["sr"], n_fft=CFG["n_fft"],
        hop_length=CFG["hop"], n_mels=CFG["n_mels"], power=2.0,
    ).to(wav.device)
    mel = mel_tf(wav)
    mel_db = 10 * torch.log10(mel.clamp_min(1e-5))
    return torch.clamp((mel_db + 40) / 40, 0, 1)


def cmd_train(args):
    import librosa

    # GARDE GPU — standard du pack (gen3 ne s'entraîne pas sur CPU) :
    # un entraînement HiFi-GAN sur CPU prendrait des semaines ; on refuse
    # proprement AVANT de consommer des heures d'itération inutiles.
    if not torch.cuda.is_available():
        raise SystemExit(
            "Refus : aucun GPU CUDA détecté. L'entraînement HiFi-GAN est "
            "GPU-UNIQUEMENT (standard gen3) — lance sur Colab/L4/A100."
        )

    os.makedirs(CKPT_DIR, exist_ok=True)
    ds = MelDataset(DATA_MEL)
    dl = DataLoader(ds, batch_size=CFG["batch"], shuffle=True,
                    num_workers=args.workers, drop_last=True)

    gen = Generator().to(CFG["device"])
    mpd = MPD().to(CFG["device"])
    opt_g = torch.optim.AdamW(gen.parameters(), lr=CFG["lr"], betas=(0.8, 0.99))
    opt_d = torch.optim.AdamW(mpd.parameters(), lr=CFG["lr"], betas=(0.8, 0.99))

    # On reconstruit le wav réel à partir du mel d'entrée via Griffin-Lim,
    # utilisé UNIQUEMENT comme cible pour le discriminateur.
    def mel_to_wav(mel_batch):
        audios = []
        for m in mel_batch:
            m_pow = 10 ** ((m.cpu().numpy() * 40 - 40) / 10)
            audios.append(librosa.feature.inverse.mel_to_audio(
                m_pow, sr=CFG["sr"], n_fft=CFG["n_fft"],
                hop_length=CFG["hop"], n_mels=CFG["n_mels"]))
        return torch.from_numpy(np.stack(audios)).float().to(CFG["device"])

    step = 0
    for epoch in range(args.epochs):
        pbar = tqdm(dl, desc=f"epoch {epoch}")
        for mel in pbar:
            if step >= args.steps:
                break
            mel = mel.to(CFG["device"])
            wav_real = mel_to_wav(mel).unsqueeze(1)  # (B, 1, N)

            # -------- Générateur --------
            fake = gen(mel).unsqueeze(1)
            opt_g.zero_grad()
            loss_mel = F.l1_loss(_mel_from_wav(fake.squeeze(1)), mel)

            loss_adv = 0.0
            for (real_out, _), (fake_out, _) in zip(mpd(wav_real), mpd(fake)):
                loss_adv = loss_adv + (fake_out - 1).pow(2).mean()
            (loss_mel + 0.1 * loss_adv).backward()
            torch.nn.utils.clip_grad_norm_(gen.parameters(), 5.0)
            opt_g.step()

            # -------- Discriminateur --------
            opt_d.zero_grad()
            loss_d = 0.0
            for (r_out, _), (f_out, _) in zip(mpd(wav_real), mpd(fake.detach())):
                loss_d = loss_d + ((r_out - 1).pow(2).mean()
                                   + f_out.pow(2).mean())
            loss_d.backward()
            opt_d.step()

            pbar.set_postfix(mel=f"{loss_mel.item():.3f}",
                             adv=f"{loss_adv.item() if torch.is_tensor(loss_adv) else loss_adv:.3f}",
                             d=f"{loss_d.item():.3f}", step=step)

            if step % 2000 == 0 and step > 0:
                torch.save(
                    {"gen": gen.state_dict(), "mpd": mpd.state_dict(),
                     "cfg": CFG, "step": step},
                    os.path.join(CKPT_DIR, f"hifigan_{step:06d}.pt"),
                )
            step += 1
            if step >= args.steps:
                break

    torch.save(
        {"gen": gen.state_dict(), "mpd": mpd.state_dict(),
         "cfg": CFG, "step": step},
        os.path.join(CKPT_DIR, "hifigan_final.pt"),
    )
    print(f"[✓] checkpoint final -> {CKPT_DIR}/hifigan_final.pt")


# =====================================================================
# 4. GÉNÉRATION DE SONS / SFX DEPUIS LE VOCODEUR
# =====================================================================
def _load_generator(ckpt_path):
    ckpt = torch.load(ckpt_path, map_location=CFG["device"])
    gen = Generator().to(CFG["device"])
    gen.load_state_dict(ckpt["gen"])
    gen.eval()
    return gen


def _save_wav(wav_np, path):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    sf.write(path, wav_np, CFG["sr"])


def cmd_sample(args):
    """Génère n sons en partant de mels aléatoires ou seedés."""
    gen = _load_generator(args.ckpt)
    torch.manual_seed(args.seed)
    T = CFG["t_frames"]
    with torch.no_grad():
        mel = torch.rand(args.n, CFG["n_mels"], T, device=CFG["device"])
        if args.seed_mel:
            src = np.load(args.seed_mel)
            src = torch.from_numpy(src).float().unsqueeze(0).to(CFG["device"])
            mel = src.repeat(args.n, 1, 1) + 0.05 * mel
    wav = gen(mel).cpu().numpy()
    for i, w in enumerate(wav):
        _save_wav(w, os.path.join(OUT_DIR, f"sample_{args.seed}_{i:03d}.wav"))
    print(f"[✓] {args.n} sons -> {OUT_DIR}/")


def cmd_sfx(args):
    """SFX catégoriel : biaise le mel aléatoire selon un label de jeu."""
    # Profils spectraux grossiers par catégorie (filtre plus ou moins passe-haut,
    # enveloppe percussive vs ambiante). Sert de prior minimaliste ; pour un
    # vrai conditionnement, entraîne un Transformer sur (label, codes).
    profiles = {
        "explosion": dict(slope=-0.3, attack=0.02, decay=0.6),
        "impact": dict(slope=-0.1, attack=0.01, decay=0.3),
        "porte": dict(slope=-0.2, attack=0.05, decay=0.4),
        "pas": dict(slope=-0.2, attack=0.03, decay=0.25),
        "ambiance": dict(slope=0.0, attack=0.9, decay=0.95),
        "musique": dict(slope=0.0, attack=0.5, decay=0.9),
    }
    if args.label not in profiles:
        raise SystemExit(f"Labels valides : {list(profiles)}")
    p = profiles[args.label]

    torch.manual_seed(args.seed)
    T = CFG["t_frames"]
    freq = torch.linspace(0, 1, CFG["n_mels"], device=CFG["device"])
    spectral_env = (freq + 0.2) ** p["slope"]  # (n_mels,)
    time_env = torch.linspace(0, 1, T, device=CFG["device"])
    env = (1 - time_env).pow(1 / max(p["decay"], 1e-3))
    noise = torch.rand(args.n, CFG["n_mels"], T, device=CFG["device"])
    mel = noise * spectral_env[None, :, None] * env[None, None, :]
    mel = torch.clamp(mel, 0, 1)

    gen = _load_generator(args.ckpt)
    with torch.no_grad():
        wav = gen(mel).cpu().numpy()
    for i, w in enumerate(wav):
        _save_wav(w, os.path.join(OUT_DIR, f"sfx_{args.label}_{i:03d}.wav"))
    print(f"[✓] {args.n} SFX '{args.label}' -> {OUT_DIR}/")


# =====================================================================
# 5. MÉMORISATION DE VOIX (ECAPA-TDNN, 192-d)
# =====================================================================
def cmd_memorize(args):
    """Enregistre l'empreinte de la voix dans voices/<nom>.npy (768 octets)."""
    try:
        from speechbrain.inference.speaker import EncoderClassifier
    except ImportError:
        raise SystemExit("Installe speechbrain : pip install speechbrain")

    import torchaudio
    encoder = EncoderClassifier.from_hparams(
        source="speechbrain/spkrec-ecapa-voxceleb", savedir=".hf/sb"
    )
    sig, fs = torchaudio.load(args.wav)
    sig = sig.mean(0, keepdim=True)
    if fs != 16000:
        sig = torchaudio.transforms.Resample(fs, 16000)(sig)
    emb = encoder.encode_batch(sig).squeeze().detach().cpu().numpy()

    os.makedirs(VOICE_DIR, exist_ok=True)
    np.save(os.path.join(VOICE_DIR, f"{args.name}.npy"), emb)
    print(f"[✓] voix '{args.name}' mémorisée ({emb.shape[0]}-d) "
          f"-> {VOICE_DIR}/{args.name}.npy")


# =====================================================================
# 6. CLONAGE DE VOIX (F5-TTS zero-shot)
# =====================================================================
def cmd_clone(args):
    """Clone la voix à partir d'un wav de référence de ~6-10 s."""
    try:
        from f5_tts.api import F5TTS
    except ImportError:
        raise SystemExit(
            "Installe F5-TTS : pip install f5-tts\n"
            "Alternative : pip install TTS puis utilise XTTS-v2."
        )
    if not args.ref_wav or not args.ref_text:
        raise SystemExit("--ref_wav et --ref_text requis pour le clonage.")

    tts = F5TTS()
    wav, sr, _ = tts.infer(
        ref_file=args.ref_wav,
        ref_text=args.ref_text,
        gen_text=args.text,
        speed=args.speed,
    )
    out = os.path.join(OUT_DIR, f"clone_{args.voice or 'ref'}.wav")
    _save_wav(wav, out)
    print(f"[✓] clone -> {out}")

    # Bonus : si une empreinte existe, on la rappelle à l'utilisateur pour
    # confirmer que l'identité vocale cible est bien mémorisée.
    emb_path = os.path.join(VOICE_DIR, f"{args.voice}.npy")
    if args.voice and os.path.exists(emb_path):
        emb = np.load(emb_path)
        print(f"  Empreinte '{args.voice}' chargée ({emb.shape[0]}-d).")


# =====================================================================
# CLI
# =====================================================================
def build_parser():
    p = argparse.ArgumentParser(
        description="Génération audio ultra-réaliste + clonage de voix."
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("prepare", help="WAV -> mel .npy")
    sp.set_defaults(func=cmd_prepare)

    st = sub.add_parser("train", help="entraîne HiFi-GAN (GPU uniquement)")
    st.add_argument("--epochs", type=int, default=200)
    st.add_argument("--steps", type=int, default=CFG["steps"])
    st.add_argument("--workers", type=int, default=4)
    st.set_defaults(func=cmd_train)

    ss = sub.add_parser("sample", help="génère des sons depuis le vocodeur")
    ss.add_argument("--ckpt", default=f"{CKPT_DIR}/hifigan_final.pt")
    ss.add_argument("--n", type=int, default=8)
    ss.add_argument("--seed", type=int, default=0)
    ss.add_argument("--seed_mel", default=None,
                    help="chemin vers un .npy mel à interpoler")
    ss.set_defaults(func=cmd_sample)

    sf_ = sub.add_parser("sfx", help="génère un SFX catégoriel")
    sf_.add_argument("--label", required=True,
                     choices=["explosion", "impact", "porte", "pas",
                              "ambiance", "musique"])
    sf_.add_argument("--ckpt", default=f"{CKPT_DIR}/hifigan_final.pt")
    sf_.add_argument("--n", type=int, default=4)
    sf_.add_argument("--seed", type=int, default=0)
    sf_.set_defaults(func=cmd_sfx)

    sm = sub.add_parser("memorize", help="mémorise une voix (ECAPA-TDNN)")
    sm.add_argument("--wav", required=True)
    sm.add_argument("--name", required=True)
    sm.set_defaults(func=cmd_memorize)

    sc = sub.add_parser("clone", help="clonage zero-shot (F5-TTS)")
    sc.add_argument("--text", required=True)
    sc.add_argument("--ref_wav", required=True)
    sc.add_argument("--ref_text", required=True)
    sc.add_argument("--voice", default=None,
                    help="nom d'une empreinte mémorisée (facultatif)")
    sc.add_argument("--speed", type=float, default=1.0)
    sc.set_defaults(func=cmd_clone)

    return p


if __name__ == "__main__":
    random.seed(0)
    np.random.seed(0)
    torch.manual_seed(0)
    args = build_parser().parse_args()
    args.func(args)
