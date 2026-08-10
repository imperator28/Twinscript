import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from feasibility.model_sources import load_model_sources


def export_command(
    row: dict[str, str],
    snapshot: Path,
    output: Path,
    optimum_cli: str,
) -> list[str]:
    command = [
        optimum_cli,
        "export",
        "openvino",
        "--model",
        str(snapshot),
        "--task",
        row["task"],
        "--weight-format",
        row["weight_format"],
    ]
    if row.get("trust_remote_code") is True:
        command.append("--trust-remote-code")
    command.append(str(output))
    return command


def hash_files(root: Path) -> list[dict[str, object]]:
    rows = []
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        rows.append(
            {
                "path": path.relative_to(root).as_posix(),
                "size": path.stat().st_size,
                "sha256": digest.hexdigest(),
            },
        )
    return rows


def _tail(value: str, length: int = 4000) -> str:
    return (value or "")[-length:]


def _optimum_cli() -> str:
    executable = Path(sys.executable)
    candidate = executable.with_name(
        "optimum-cli.exe" if sys.platform == "win32" else "optimum-cli",
    )
    return str(candidate)


def download_source(
    model_id: str,
    row: dict[str, str],
    root: Path,
    *,
    info_loader,
    downloader,
) -> tuple[Path, str]:
    info = info_loader(row["repo"], revision=row["revision"])
    destination = root / "source-snapshots" / model_id
    snapshot = downloader(
        row["repo"],
        revision=info.sha,
        local_dir=destination,
    )
    return Path(snapshot), info.sha


def export_models(root: Path, sources_path: Path) -> dict[str, object]:
    from huggingface_hub import model_info, snapshot_download

    sources = load_model_sources(sources_path)
    root.mkdir(parents=True, exist_ok=True)
    results: dict[str, object] = {"schemaVersion": 1, "models": {}}

    for model_id, row in sources.items():
        snapshot, resolved_revision = download_source(
            model_id,
            row,
            root,
            info_loader=model_info,
            downloader=snapshot_download,
        )
        output = root / model_id
        command = export_command(row, snapshot, output, _optimum_cli())
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=False,
        )
        exported = completed.returncode == 0 and output.is_dir()
        results["models"][model_id] = {
            "repo": row["repo"],
            "requestedRevision": row["revision"],
            "resolvedRevision": resolved_revision,
            "command": command,
            "exitCode": completed.returncode,
            "exported": exported,
            "stdoutTail": _tail(completed.stdout),
            "stderrTail": _tail(completed.stderr),
            "output": str(output),
            "files": hash_files(output) if exported else [],
        }

    results_path = root / "export-results.json"
    temporary = results_path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(results, indent=2), encoding="utf-8")
    temporary.replace(results_path)
    return results


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument(
        "--sources",
        type=Path,
        default=Path(__file__).with_name("model_sources.json"),
    )
    args = parser.parse_args(argv)
    results = export_models(args.root.resolve(), args.sources.resolve())
    print(json.dumps(results, indent=2))
    return 0 if all(row["exported"] for row in results["models"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
