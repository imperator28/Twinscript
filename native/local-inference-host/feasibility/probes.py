import argparse
import json
from pathlib import Path
import time
from typing import Callable

from feasibility.prompts import hy_mt2_prompt


GENERATION_OPTIONS = {
    "temperature": 0,
    "do_sample": False,
    "max_new_tokens": 256,
}


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 3)


def _text(value) -> str:
    if isinstance(value, str):
        return value
    texts = getattr(value, "texts", None)
    if texts:
        return str(texts[0])
    return str(value)


def probe_translation(pipe, device: str, text: str, target_language: str) -> dict[str, object]:
    prompt = hy_mt2_prompt(text, target_language)
    started = time.perf_counter()
    try:
        first = pipe.generate(prompt, **GENERATION_OPTIONS)
        first_run_ms = _elapsed_ms(started)
        started = time.perf_counter()
        warm = pipe.generate(prompt, **GENERATION_OPTIONS)
        warm_run_ms = _elapsed_ms(started)
    except Exception as error:
        return {
            "passed": False,
            "failurePhase": "generation",
            "requestedDevice": device,
            "actualDevice": device,
            "error": str(error),
        }
    return {
        "passed": True,
        "requestedDevice": device,
        "actualDevice": device,
        "firstRunMs": first_run_ms,
        "warmRunMs": warm_run_ms,
        "firstText": _text(first),
        "text": _text(warm),
    }


def compile_and_probe_translation(
    model_path: Path,
    device: str,
    text: str,
    target_language: str,
    *,
    pipeline_factory: Callable | None = None,
) -> dict[str, object]:
    if pipeline_factory is None:
        import openvino_genai

        pipeline_factory = openvino_genai.LLMPipeline
    started = time.perf_counter()
    try:
        pipe = pipeline_factory(str(model_path), device)
    except Exception as error:
        return {
            "passed": False,
            "failurePhase": "compile",
            "requestedDevice": device,
            "actualDevice": None,
            "modelPath": str(model_path),
            "error": str(error),
        }
    load_ms = _elapsed_ms(started)
    result = probe_translation(pipe, device, text, target_language)
    result["modelPath"] = str(model_path)
    result["loadMs"] = load_ms
    return result


def probe_asr(pipe, device: str, audio) -> dict[str, object]:
    started = time.perf_counter()
    try:
        first = pipe.generate(audio)
        first_run_ms = _elapsed_ms(started)
        started = time.perf_counter()
        warm = pipe.generate(audio)
        warm_run_ms = _elapsed_ms(started)
    except Exception as error:
        return {
            "passed": False,
            "failurePhase": "generation",
            "requestedDevice": device,
            "actualDevice": device,
            "error": str(error),
        }
    return {
        "passed": True,
        "requestedDevice": device,
        "actualDevice": device,
        "firstRunMs": first_run_ms,
        "warmRunMs": warm_run_ms,
        "firstText": _text(first),
        "text": _text(warm),
    }


def compile_and_probe_asr(
    model_path: Path,
    device: str,
    audio,
    *,
    pipeline_factory: Callable | None = None,
) -> dict[str, object]:
    if pipeline_factory is None:
        import openvino_genai

        pipeline_factory = openvino_genai.WhisperPipeline
    started = time.perf_counter()
    try:
        pipe = pipeline_factory(str(model_path), device)
    except Exception as error:
        return {
            "passed": False,
            "failurePhase": "compile",
            "requestedDevice": device,
            "actualDevice": None,
            "modelPath": str(model_path),
            "error": str(error),
        }
    load_ms = _elapsed_ms(started)
    result = probe_asr(pipe, device, audio)
    result["modelPath"] = str(model_path)
    result["loadMs"] = load_ms
    return result


def _resample_audio(audio, source_rate: int, target_rate: int = 16000):
    import numpy as np

    values = np.asarray(audio, dtype=np.float32)
    if source_rate == target_rate or len(values) == 0:
        return values
    target_length = max(1, round(len(values) * target_rate / source_rate))
    source_positions = np.arange(len(values), dtype=np.float64) / source_rate
    target_positions = np.arange(target_length, dtype=np.float64) / target_rate
    return np.interp(target_positions, source_positions, values).astype(np.float32)


def _load_audio(path: Path):
    import soundfile

    audio, sample_rate = soundfile.read(path, dtype="float32")
    if getattr(audio, "ndim", 1) != 1:
        audio = audio.mean(axis=1)
    return _resample_audio(audio, sample_rate)


def run_probes(device: str, models: Path, audio_path: Path | None) -> dict[str, object]:
    fixture_path = Path(__file__).resolve().parents[1] / "fixtures" / "translation-goldens.json"
    fixtures = json.loads(fixture_path.read_text(encoding="utf-8"))["cases"]
    translation_model = models / "hy-mt2-1.8b"
    if translation_model.is_dir():
        translations = [
            compile_and_probe_translation(
                translation_model,
                device,
                case["source"],
                case["targetLanguage"],
            )
            for case in fixtures
        ]
    else:
        translations = [{
            "passed": False,
            "failurePhase": "prerequisite",
            "requestedDevice": device,
            "actualDevice": None,
            "modelPath": str(translation_model),
            "error": "Hy-MT2 OpenVINO export is unavailable",
        }]

    if audio_path is None:
        asr = {
            "passed": False,
            "failurePhase": "prerequisite",
            "requestedDevice": device,
            "actualDevice": None,
            "error": "no private validation audio supplied",
        }
    else:
        asr = compile_and_probe_asr(models / "whisper-small", device, _load_audio(audio_path))
    return {"device": device, "asr": asr, "translations": translations}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--audio", type=Path)
    args = parser.parse_args(argv)
    result = run_probes(args.device, args.models.resolve(), args.audio)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["asr"]["passed"] and all(row["passed"] for row in result["translations"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
