import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time


GGUF_REPO = "tencent/Hy-MT2-1.8B-GGUF"
GGUF_FILENAME = "Hy-MT2-1.8B-Q4_K_M.gguf"


def hymt2_payload(text: str, target_language: str) -> dict[str, object]:
    prompt = (
        f"Translate the following text into {target_language}. Note that you should only "
        f"output the translated result without any additional explanation: {text}"
    )
    return {
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 256,
    }


def probe_server(server, text: str, target_language: str) -> dict[str, object]:
    started = time.perf_counter()
    try:
        reply = server.chat(hymt2_payload(text, target_language))
        content = reply["choices"][0]["message"]["content"].strip()
    except Exception as error:
        return {
            "passed": False,
            "failurePhase": "generation",
            "runtime": "llama.cpp",
            "requestedDevice": "CPU",
            "actualDevice": "CPU",
            "error": str(error),
        }
    return {
        "passed": True,
        "runtime": "llama.cpp",
        "requestedDevice": "CPU",
        "actualDevice": "CPU",
        "inferenceMs": round((time.perf_counter() - started) * 1000, 3),
        "text": content,
        "completionTokens": int((reply.get("usage") or {}).get("completion_tokens") or 0),
    }


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _runtime_module():
    repository = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(repository / "sidecar"))
    from sokuji_sidecar import llama_runtime

    return llama_runtime


def prepare(root: Path):
    from huggingface_hub import hf_hub_download, model_info

    root.mkdir(parents=True, exist_ok=True)
    info = model_info(GGUF_REPO, revision="main")
    model_dir = root / "source-snapshots" / "hy-mt2-1.8b-gguf"
    gguf = Path(hf_hub_download(
        GGUF_REPO,
        GGUF_FILENAME,
        revision=info.sha,
        local_dir=model_dir,
    ))
    os.environ["SOKUJI_LLAMA_BIN_DIR"] = str(root / "llama-bin")
    runtime = _runtime_module()
    binary = Path(runtime.ensure_binary("cpu"))
    return runtime, binary, gguf, info.sha


def run(root: Path, fixtures_path: Path) -> dict[str, object]:
    runtime, binary, gguf, revision = prepare(root)
    server = runtime.LlamaServerProc(str(binary), str(gguf), ctx=2048)
    load_started = time.perf_counter()
    try:
        server.start()
        load_ms = round((time.perf_counter() - load_started) * 1000, 3)
        fixtures = json.loads(fixtures_path.read_text(encoding="utf-8"))["cases"]
        cases = [
            {
                "id": case["id"],
                "source": case["source"],
                "targetLanguage": case["targetLanguage"],
                **probe_server(server, case["source"], case["targetLanguage"]),
            }
            for case in fixtures
        ]
    finally:
        server.stop()
    return {
        "model": "hy-mt2-1.8b",
        "runtime": "llama.cpp",
        "requestedDevice": "CPU",
        "actualDevice": "CPU",
        "resolvedRevision": revision,
        "modelFile": GGUF_FILENAME,
        "modelBytes": gguf.stat().st_size,
        "modelSha256": _sha256(gguf),
        "runtimeFile": binary.name,
        "runtimeSha256": _sha256(binary),
        "loadMs": load_ms,
        "cases": cases,
        "passed": all(case["passed"] for case in cases),
    }


def render_json(value: dict[str, object]) -> str:
    return json.dumps(value, indent=2, ensure_ascii=True)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "fixtures" / "translation-goldens.json",
    )
    args = parser.parse_args(argv)
    result = run(args.root.resolve(), args.fixtures.resolve())
    print(render_json(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
