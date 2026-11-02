#!/usr/bin/env bash
# Téléchargement des 19 domaines gen3 depuis HF (Kings237/gen3ia-media-engine @ v4)
# + dataset conversationnel public (alpaca-gpt4-french).
# Jetons lus depuis l'environnement (HF_TOKEN / KAGGLE_TOKEN) — jamais affichés.
set -u
DEST="var/datasets-hf"
mkdir -p "$DEST"

DOMAINES=(
  math sciences reasoning problem_solving nlp_comprehension text_generation
  conversational_memory contextual_understanding intent_recognition professions
  databases tools code_v4 security_v4 image_analysis video_v4 voice_speech
  audio_understanding multimodal_v4
)

total=0
for d in "${DOMAINES[@]}"; do
  f="$DEST/$d.jsonl"
  if [ -s "$f" ]; then
    s=$(stat -c%s "$f"); total=$((total + s))
    echo "CACHE $d ($s octets)"
    continue
  fi
  echo "TELECHARGE $d ..."
  curl -fsSL --retry 3 -m 900 \
    -H "Authorization: Bearer ${HF_TOKEN:-}" \
    "https://huggingface.co/Kings237/gen3ia-media-engine/resolve/main/v4/$d/train.jsonl" \
    -o "$f" || { echo "ECHEC $d"; continue; }
  s=$(stat -c%s "$f"); total=$((total + s))
  echo "OK $d ($s octets)"
done

# Complément conversationnel public (scénarios/instructions FR)
f="$DEST/alpaca-gpt4-french.jsonl"
if [ ! -s "$f" ]; then
  echo "TELECHARGE alpaca-gpt4-french ..."
  curl -fsSL --retry 3 -m 900 \
    -H "Authorization: Bearer ${HF_TOKEN:-}" \
    "https://huggingface.co/datasets/FreedomIntelligence/alpaca-gpt4-french/resolve/main/alpaca_gpt4_french.json" \
    -o "$f" || echo "ECHEC alpaca (canal secondaire tenté par le script principal)"
  [ -s "$f" ] && echo "OK alpaca ($(( $(stat -c%s "$f") )) octets)"
fi

echo "TOTAL téléchargé/caché: $total octets"
