#!/usr/bin/env python3
"""Stubs GPU-sandbox pour le pack gen3-visual-pack (validateur / dry_run).

Installe dans sys.modules des modules factices torch/datasets/transformers/peft
afin d'importer et d'exécuter le chemin « dry_run » (aucune fonction GPU)
sur une machine sans PyTorch — exactement comme le ferait le validateur.

Usage :
    python stub_import.py train_gen3_visuel.py --dry_run
"""
import sys
import types


def _factice(nom: str, **attributs) -> types.ModuleType:
    mod = types.ModuleType(nom)
    for cle, valeur in attributs.items():
        setattr(mod, cle, valeur)
    sys.modules[nom] = mod
    return mod


def installer_stubs() -> None:
    if "torch" in sys.modules and getattr(sys.modules["torch"], "__stubs__", False):
        return

    def indisponible(*_args, **_kwargs):
        raise RuntimeError("GPU CUDA requis : gen3 est conçue pour fonctionner "
                           "avec les ressources GPU à sa disposition "
                           "(L4, A100...), pas sur CPU.")

    torch = _factice(
        "torch",
        cuda=types.SimpleNamespace(
            is_available=lambda: False,
            is_bf16_supported=lambda: False,
            get_device_properties=lambda *_a: types.SimpleNamespace(
                name="aucun", total_memory=0),
        ),
        Tensor=object,
        bfloat16="bfloat16",
        float16="float16",
        no_grad=indisponible,
        __stubs__=True,
    )
    sys.modules["torch"] = torch

    _factice("datasets", Dataset=lambda *a, **k: None)

    def _classe(*_a, **_k):
        return types.SimpleNamespace()

    _factice(
        "transformers",
        AutoProcessor=_classe,
        BitsAndBytesConfig=_classe,
        Gemma3ForConditionalGeneration=types.SimpleNamespace(
            from_pretrained=indisponible),
        Trainer=_classe,
        TrainingArguments=_classe,
        TrainerCallback=type("TrainerCallback", (), {}),
    )
    _factice(
        "peft",
        LoraConfig=_classe,
        get_peft_model=indisponible,
        prepare_model_for_kbit_training=indisponible,
        PeftModel=types.SimpleNamespace(from_pretrained=indisponible),
    )


if __name__ == "__main__":
    installer_stubs()
    import runpy

    script, *rest = sys.argv[1:]
    if not script:
        raise SystemExit("usage: python stub_import.py SCRIPT.py [args...]")
    sys.argv = [script] + rest
    runpy.run_path(script, run_name="__main__")
