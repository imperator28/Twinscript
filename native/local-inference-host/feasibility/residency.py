def select_allocation(results: dict[str, dict[str, object]]) -> dict[str, str]:
    for key, allocation in (
        ("bothNpu", {"whisper": "NPU", "hyMt2": "NPU"}),
        ("npuGpu", {"whisper": "NPU", "hyMt2": "GPU"}),
        ("npuCpu", {"whisper": "NPU", "hyMt2": "CPU"}),
        ("gpuGpu", {"whisper": "GPU", "hyMt2": "GPU"}),
        ("cpuCpu", {"whisper": "CPU", "hyMt2": "CPU"}),
    ):
        if results.get(key, {}).get("passed") is True:
            return allocation
    raise RuntimeError("no correct fully local allocation")
