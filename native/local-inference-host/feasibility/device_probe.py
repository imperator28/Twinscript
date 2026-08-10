import json


PROPERTIES = ("FULL_DEVICE_NAME", "DRIVER_VERSION")
DEVICE_PRIORITY = ("NPU", "GPU", "CPU")


def probe_devices(core=None) -> list[dict[str, str]]:
    if core is None:
        import openvino as ov

        core = ov.Core()

    rows = []
    for device in core.available_devices:
        row = {"device": str(device)}
        for key in PROPERTIES:
            try:
                row[key.lower()] = str(core.get_property(device, key))
            except Exception as error:
                row[key.lower()] = f"unavailable: {error}"
        rows.append(row)
    return rows


def choose_device(rows: list[dict[str, str]]) -> str:
    names = [row["device"] for row in rows]
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


def main() -> int:
    rows = probe_devices()
    print(json.dumps({"devices": rows, "selected": choose_device(rows)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
