import argparse
import json
from pathlib import Path
import subprocess
import sys


PROPERTIES = ("FULL_DEVICE_NAME", "DRIVER_VERSION")
DEVICE_PRIORITY = ("NPU", "GPU", "CPU")


def _probe_core(core) -> list[dict[str, str]]:
    rows = []
    for device in core.available_devices:
        row = {"device": str(device), "available": True}
        for key in PROPERTIES:
            try:
                row[key.lower()] = str(core.get_property(device, key))
            except Exception as error:
                row[key.lower()] = f"unavailable: {error}"
        rows.append(row)
    return rows


def _unavailable_row(device: str, completed) -> dict[str, object]:
    diagnostic = (completed.stderr or completed.stdout or "").strip()
    error = diagnostic or f"plugin process exited {completed.returncode} without diagnostics"
    return {
        "device": device,
        "available": False,
        "error": error,
    }


def probe_devices(core=None, runner=subprocess.run) -> list[dict[str, object]]:
    if core is not None:
        return _probe_core(core)

    rows = []
    script = str(Path(__file__).resolve())
    for device in DEVICE_PRIORITY:
        try:
            completed = runner(
                [sys.executable, script, "--probe-one", device],
                capture_output=True,
                text=True,
                timeout=20,
                check=False,
            )
        except subprocess.TimeoutExpired:
            rows.append(
                {
                    "device": device,
                    "available": False,
                    "error": "plugin process timed out",
                },
            )
            continue
        if completed.returncode != 0:
            rows.append(_unavailable_row(device, completed))
            continue
        try:
            rows.append(json.loads(completed.stdout.strip()))
        except json.JSONDecodeError as error:
            rows.append(
                {
                    "device": device,
                    "available": False,
                    "error": f"plugin returned invalid JSON: {error}",
                },
            )
    return rows


def choose_device(rows: list[dict[str, object]]) -> str:
    names = [
        str(row["device"])
        for row in rows
        if row.get("available", True) is True
    ]
    for prefix in DEVICE_PRIORITY:
        match = next(
            (
                name
                for name in names
                if name == prefix or name.startswith(f"{prefix}.")
            ),
            None,
        )
        if match:
            return match
    raise RuntimeError("OpenVINO reported no usable NPU, GPU, or CPU device")


def probe_one(device: str) -> dict[str, object]:
    import openvino as ov

    core = ov.Core()
    versions = core.get_versions(device)
    if not versions:
        raise RuntimeError(f"OpenVINO plugin {device} is unavailable")
    row: dict[str, object] = {"device": device, "available": True}
    for key in PROPERTIES:
        try:
            row[key.lower()] = str(core.get_property(device, key))
        except Exception as error:
            row[key.lower()] = f"unavailable: {error}"
    return row


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--probe-one", choices=DEVICE_PRIORITY)
    args = parser.parse_args(argv)
    if args.probe_one:
        print(json.dumps(probe_one(args.probe_one)))
        return 0

    rows = probe_devices()
    print(json.dumps({"devices": rows, "selected": choose_device(rows)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
