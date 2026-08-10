import argparse
import json
from pathlib import Path


GATES = {
    "GO: Whisper NPU and Hy-MT2 NPU",
    "GO: Whisper NPU and Hy-MT2 local fallback",
    "GO: fully local without NPU",
    "NO-GO: no correct fully local allocation",
}


def _format_ms(value) -> str:
    return "not measured" if value is None else f"{float(value):,.1f} ms"


def build_report(evidence: dict[str, object]) -> str:
    gate = evidence["gate"]
    if gate not in GATES:
        raise ValueError(f"unknown feasibility gate: {gate}")
    allocation = evidence["allocation"]
    probes = evidence.get("probes", {})
    whisper = probes.get("whisperNpu", {})
    hy_npu = probes.get("hyMt2Npu", {})
    hy_cpu = probes.get("hyMt2Cpu", {})
    exports = evidence.get("exports", {}).get("models", {})
    devices = evidence.get("devices", [])

    lines = [
        "# Windows Local Inference Feasibility",
        "",
        f"**Gate:** `{gate}`",
        "",
        "## Selected allocation",
        "",
        f"- Whisper selected device: {allocation['whisper']}",
        f"- Hy-MT2 selected device: {allocation['hyMt2']}",
        f"- Hy-MT2 selected runtime: {hy_cpu.get('runtime', 'OpenVINO GenAI')}",
        "",
        "## Hardware evidence",
        "",
    ]
    if devices:
        for row in devices:
            status = "available" if row.get("available", True) else "unavailable"
            detail = row.get("full_device_name") or row.get("error") or ""
            lines.append(f"- {row.get('device')}: {status} — {detail}")
    else:
        lines.append("- No hardware rows supplied.")

    lines.extend([
        "",
        "## Model and runtime findings",
        "",
        f"- Whisper NPU: {'supported' if whisper.get('passed') else 'not proven'}",
        f"- Whisper first inference: {_format_ms(whisper.get('firstRunMs'))}",
        f"- Whisper warm inference: {_format_ms(whisper.get('warmRunMs'))}",
        "- Hy-MT2 NPU: unsupported",
        f"- Hy-MT2 OpenVINO failure: {hy_npu.get('error', 'unsupported architecture')}",
        f"- Hy-MT2 CPU/llama.cpp: {'supported' if hy_cpu.get('passed') else 'not proven'}",
        f"- Hy-MT2 load: {_format_ms(hy_cpu.get('loadMs'))}",
    ])

    for model_id, row in exports.items():
        lines.extend([
            "",
            f"### {model_id}",
            "",
            f"- Source: `{row.get('repo', 'unknown')}`",
            f"- Resolved revision: `{row.get('resolvedRevision', 'unknown')}`",
            f"- OpenVINO exported: `{str(bool(row.get('exported'))).lower()}`",
        ])
    if hy_cpu.get("resolvedRevision"):
        lines.extend([
            "",
            "### hy-mt2-1.8b GGUF fallback",
            "",
            f"- Resolved revision: `{hy_cpu['resolvedRevision']}`",
            f"- Model file: `{hy_cpu.get('modelFile')}`",
            f"- Model SHA-256: `{hy_cpu.get('modelSha256')}`",
            f"- Runtime SHA-256: `{hy_cpu.get('runtimeSha256')}`",
        ])

    cases = hy_cpu.get("cases", [])
    if cases:
        lines.extend(["", "## Bilingual translation probes", ""])
        for case in cases:
            lines.append(
                f"- {case['id']}: {'PASS' if case.get('passed') else 'FAIL'} "
                f"({_format_ms(case.get('inferenceMs'))}) — {case.get('text', '')}",
            )

    limitations = evidence.get("limitations", [])
    if limitations:
        lines.extend(["", "## Remaining validation", ""])
        lines.extend(f"- {item}" for item in limitations)
    lines.append("")
    return "\n".join(lines)


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def write_reports(evidence: dict[str, object], markdown: Path, json_path: Path) -> None:
    _atomic_write(markdown, build_report(evidence))
    _atomic_write(json_path, json.dumps(evidence, indent=2, ensure_ascii=False) + "\n")


def assemble_evidence(exports_path: Path, whisper_path: Path, hy_path: Path):
    from feasibility.device_probe import probe_devices

    exports = json.loads(exports_path.read_text(encoding="utf-8"))
    whisper_report = json.loads(whisper_path.read_text(encoding="utf-8"))
    hy_cpu = json.loads(hy_path.read_text(encoding="utf-8"))
    whisper = whisper_report["asr"]
    hy_export = exports["models"]["hy-mt2-1.8b"]
    passed = whisper.get("passed") is True and hy_cpu.get("passed") is True
    return {
        "gate": (
            "GO: Whisper NPU and Hy-MT2 local fallback"
            if passed else "NO-GO: no correct fully local allocation"
        ),
        "allocation": {"whisper": "NPU", "hyMt2": "CPU"},
        "devices": probe_devices(),
        "exports": exports,
        "probes": {
            "whisperNpu": whisper,
            "hyMt2Npu": {
                "passed": False,
                "error": hy_export.get("stderrTail", "unsupported architecture").splitlines()[-1],
            },
            "hyMt2Cpu": hy_cpu,
        },
        "limitations": [
            "The 60-minute simultaneous-residency soak remains a release validation gate.",
            "OpenVINO GPU is disabled on this machine because isolated plugin discovery exits with an access violation.",
            "Energy counters were not sampled; energy is diagnostic and does not change the allocation.",
        ],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exports", type=Path, required=True)
    parser.add_argument("--whisper-npu", type=Path, required=True)
    parser.add_argument("--hymt-cpu", type=Path, required=True)
    parser.add_argument("--markdown", type=Path, required=True)
    parser.add_argument("--json", type=Path, required=True)
    args = parser.parse_args(argv)
    evidence = assemble_evidence(args.exports, args.whisper_npu, args.hymt_cpu)
    write_reports(evidence, args.markdown, args.json)
    print(evidence["gate"])
    return 0 if str(evidence["gate"]).startswith("GO:") else 1


if __name__ == "__main__":
    raise SystemExit(main())
