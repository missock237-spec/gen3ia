# syntax=docker/dockerfile:1
# ------------------------------------------------------------------
# Worker GPU d'entraînement Gen3ia (FastAPI + PyTorch/PEFT).
#
# Cette image « slim » convient au DÉVELOPPEMENT et au moteur rag-index
# (CPU uniquement). Pour un entraînement text-lora réel, utilisez la
# variante CUDA documentée ci-dessous — un CPU ne fait PAS de LoRA.
# ------------------------------------------------------------------
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Dépendances d'abord (couche Docker mise en cache).
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Code applicatif.
COPY training_worker ./training_worker

EXPOSE 8000

# ------------------------------------------------------------------
# VARIANTE GPU (CUDA) — pour l'entraînement LoRA/QLoRA réel :
#
#   FROM pytorch/pytorch:2.4.1-cuda12.1-cudnn9-runtime
#
# (torch CUDA est déjà présent dans l'image : retirer « torch » de
#  requirements.txt ou l'installer avec --no-deps pour ne pas le
#  remplacer par la roue CPU ; ajouter RUN pip install bitsandbytes
#  pour QLoRA.)
# ------------------------------------------------------------------

CMD ["uvicorn", "training_worker.app:app", "--host", "0.0.0.0", "--port", "8000"]
