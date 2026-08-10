# Windows NPU Model Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove Whisper small and Hy-MT2-1.8B correctness, device placement, latency, and simultaneous residency on the target Intel Core Ultra Windows machine before application integration begins.

**Architecture:** A Python-only engineering harness performs reproducible model export, probes OpenVINO devices, runs bilingual golden inputs, and emits a machine-readable feasibility decision. Production will not depend on Python; this plan exists to retire model/runtime risk and select the native host's stable device allocation.

**Tech Stack:** Python 3.13, OpenVINO 2026.x, OpenVINO GenAI 2026.x, Optimum Intel, Hugging Face Hub, NumPy, unittest, PowerShell

---

**Depends on:** `docs/superpowers/specs/2026-08-10-hybrid-full-local-inference-design.md`

**Produces:** `artifacts/local-inference/feasibility.json` and `docs/validation/windows-local-inference-feasibility.md`. Both record actual devices; generated model weights and audio remain ignored.

### Task 1: Create the reproducible feasibility package

**Files:**
- Create: `native/local-inference-host/feasibility/__init__.py`
- Create: `native/local-inference-host/feasibility/model_sources.json`
- Create: `native/local-inference-host/requirements-feasibility.txt`
- Create: `native/local-inference-host/tests/test_model_sources.py`
- Create: `native/local-inference-host/feasibility/model_sources.py`
- Modify: `.gitignore`

- [ ] **Step 1: Write the failing source-manifest test**

```python
# native/local-inference-host/tests/test_model_sources.py
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from feasibility.model_sources import load_model_sources

class ModelSourcesTest(unittest.TestCase):
    def test_manifest_pins_exactly_whisper_and_hymt2(self):
        sources = load_model_sources(ROOT / "feasibility" / "model_sources.json")
        self.assertEqual(set(sources), {"whisper-small", "hy-mt2-1.8b"})
        self.assertEqual(sources["whisper-small"]["task"], "automatic-speech-recognition-with-past")
        self.assertEqual(sources["hy-mt2-1.8b"]["task"], "text-generation-with-past")
        self.assertTrue(all(row["revision"] for row in sources.values()))

if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test and verify the package does not exist yet**

Run: `python -m unittest native/local-inference-host/tests/test_model_sources.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'feasibility'`.

- [ ] **Step 3: Add the manifest loader and source manifest**

```python
# feasibility/model_sources.py
import json
from pathlib import Path

REQUIRED = {"repo", "revision", "task", "weight_format"}

def load_model_sources(path: Path) -> dict[str, dict[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    models = data.get("models")
    if not isinstance(models, dict) or set(models) != {"whisper-small", "hy-mt2-1.8b"}:
        raise ValueError("model_sources.json must define the two approved models")
    for model_id, row in models.items():
        missing = REQUIRED - row.keys()
        if missing:
            raise ValueError(f"{model_id} missing {sorted(missing)}")
    return models
```

```json
{
  "schemaVersion": 1,
  "models": {
    "whisper-small": {
      "repo": "openai/whisper-small",
      "revision": "main",
      "task": "automatic-speech-recognition-with-past",
      "weight_format": "int8"
    },
    "hy-mt2-1.8b": {
      "repo": "tencent/Hy-MT2-1.8B",
      "revision": "main",
      "task": "text-generation-with-past",
      "weight_format": "int4"
    }
  }
}
```

Add `openvino>=2026.1,<2027`, `openvino-genai>=2026.1,<2027`, `optimum-intel[openvino]>=1.26,<2`, `huggingface-hub>=0.34,<1`, `numpy>=2.1,<3`, and `soundfile>=0.13,<1` to `requirements-feasibility.txt`. Add `/native/local-inference-host/.venv/`, `/native/local-inference-host/models/`, and `/artifacts/local-inference/` to `.gitignore`.

- [ ] **Step 4: Run the manifest test**

Run: `python -m unittest native/local-inference-host/tests/test_model_sources.py -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add .gitignore native/local-inference-host/feasibility native/local-inference-host/requirements-feasibility.txt native/local-inference-host/tests/test_model_sources.py
git commit -m "test: define local inference feasibility inputs"
```

### Task 2: Probe OpenVINO devices without guessing

**Files:**
- Create: `native/local-inference-host/feasibility/device_probe.py`
- Create: `native/local-inference-host/tests/test_device_probe.py`

- [ ] **Step 1: Write tests for truthful device selection**

```python
import pathlib, sys, unittest
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from feasibility.device_probe import probe_devices, choose_device

class FakeCore:
    available_devices = ["CPU", "GPU.0", "NPU"]
    def get_property(self, device, key):
        return {"FULL_DEVICE_NAME": f"fake {device}", "DRIVER_VERSION": "test"}[key]

class DeviceProbeTest(unittest.TestCase):
    def test_npu_first_selection_uses_only_reported_devices(self):
        report = probe_devices(FakeCore())
        self.assertEqual(choose_device(report), "NPU")
        self.assertEqual([row["device"] for row in report], ["CPU", "GPU.0", "NPU"])

    def test_cpu_is_truthful_fallback(self):
        self.assertEqual(choose_device([{"device": "CPU"}]), "CPU")
```

- [ ] **Step 2: Run the focused test and see the missing module failure**

Run: `python -m unittest native/local-inference-host/tests/test_device_probe.py -v`

Expected: FAIL importing `feasibility.device_probe`.

- [ ] **Step 3: Implement lazy OpenVINO probing**

```python
# feasibility/device_probe.py
PROPERTIES = ("FULL_DEVICE_NAME", "DRIVER_VERSION")

def probe_devices(core=None):
    if core is None:
        import openvino as ov
        core = ov.Core()
    rows = []
    for device in core.available_devices:
        row = {"device": device}
        for key in PROPERTIES:
            try:
                row[key.lower()] = str(core.get_property(device, key))
            except Exception as error:
                row[key.lower()] = f"unavailable: {error}"
        rows.append(row)
    return rows

def choose_device(rows):
    names = [row["device"] for row in rows]
    for prefix in ("NPU", "GPU", "CPU"):
        match = next((name for name in names if name == prefix or name.startswith(prefix + ".")), None)
        if match:
            return match
    raise RuntimeError("OpenVINO reported no usable NPU, GPU, or CPU device")
```

- [ ] **Step 4: Run unit and hardware probes**

Run: `python -m unittest native/local-inference-host/tests/test_device_probe.py -v`

Expected: PASS.

Run: `python native/local-inference-host/feasibility/device_probe.py`

Expected on the target machine: JSON includes an `NPU` row whose full device name identifies Intel AI Boost. Add a `__main__` block that prints `probe_devices()` as indented JSON if the command initially produces no output.

- [ ] **Step 5: Commit**

```powershell
git add native/local-inference-host/feasibility/device_probe.py native/local-inference-host/tests/test_device_probe.py
git commit -m "feat: probe local OpenVINO devices"
```

### Task 3: Export both approved models and pin resolved revisions

**Files:**
- Create: `native/local-inference-host/feasibility/export_models.py`
- Create: `native/local-inference-host/tests/test_export_models.py`

- [ ] **Step 1: Test exact export command construction**

```python
import pathlib, sys, unittest
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from feasibility.export_models import export_command

class ExportModelsTest(unittest.TestCase):
    def test_whisper_export_is_int8_and_stateful(self):
        command = export_command("whisper-small", {
            "repo": "openai/whisper-small", "revision": "main",
            "task": "automatic-speech-recognition-with-past", "weight_format": "int8"
        }, pathlib.Path("models/whisper"))
        self.assertIn("automatic-speech-recognition-with-past", command)
        self.assertEqual(command[-1], "models\\whisper")

    def test_hymt2_export_targets_int4_generation(self):
        command = export_command("hy-mt2-1.8b", {
            "repo": "tencent/Hy-MT2-1.8B", "revision": "main",
            "task": "text-generation-with-past", "weight_format": "int4"
        }, pathlib.Path("models/hymt2"))
        self.assertIn("int4", command)
        self.assertIn("tencent/Hy-MT2-1.8B", command)
```

- [ ] **Step 2: Verify the test fails**

Run: `python -m unittest native/local-inference-host/tests/test_export_models.py -v`

Expected: FAIL importing `feasibility.export_models`.

- [ ] **Step 3: Implement command construction and result recording**

```python
def export_command(model_id, row, output):
    return [
        sys.executable, "-m", "optimum.exporters.openvino", "--model", row["repo"],
        "--revision", row["revision"], "--task", row["task"],
        "--weight-format", row["weight_format"], str(output),
    ]
```

The CLI must invoke each command with `subprocess.run(..., check=False, capture_output=True, text=True)`, resolve the downloaded repository commit through `huggingface_hub.model_info(repo, revision).sha`, and write `models/export-results.json` with the command, resolved revision, exit code, stdout tail, stderr tail, output path, and SHA-256 for every generated file. Do not conceal an unsupported Hy-MT2 exporter failure; record it as `exported: false` and exit nonzero after Whisper completes.

- [ ] **Step 4: Run unit tests, install the isolated environment, and export**

Run: `python -m unittest native/local-inference-host/tests/test_export_models.py -v`

Expected: PASS.

Run: `python -m venv native/local-inference-host/.venv`

Expected: the virtual environment is created under the ignored path.

Run: `native\local-inference-host\.venv\Scripts\python.exe -m pip install -r native\local-inference-host\requirements-feasibility.txt`

Expected: OpenVINO, OpenVINO GenAI, and Optimum Intel install successfully.

From `native/local-inference-host`, run: `.venv\Scripts\python.exe -m feasibility.export_models --root models`

Expected: Whisper exports successfully. Hy-MT2 either exports successfully or produces a captured, actionable incompatibility result; this result determines Task 5's translation device path.

- [ ] **Step 5: Commit code only**

```powershell
git add native/local-inference-host/feasibility/export_models.py native/local-inference-host/tests/test_export_models.py
git commit -m "feat: export local inference candidates reproducibly"
```

### Task 4: Run bilingual functional probes

**Files:**
- Create: `native/local-inference-host/feasibility/prompts.py`
- Create: `native/local-inference-host/feasibility/probes.py`
- Create: `native/local-inference-host/tests/test_probes.py`
- Create: `native/local-inference-host/fixtures/translation-goldens.json`

- [ ] **Step 1: Write tests for the approved prompt and device evidence**

```python
import unittest
from feasibility.prompts import hy_mt2_prompt
from feasibility.probes import probe_translation

class ProbeTest(unittest.TestCase):
    def test_hymt2_prompt_is_user_only_and_directional(self):
        self.assertEqual(hy_mt2_prompt("Hold ±0.2 mm.", "Chinese"), (
            "Translate the following text into Chinese. Note that you should only output "
            "the translated result without any additional explanation: Hold ±0.2 mm."
        ))

    def test_probe_records_actual_device(self):
        class FakePipe:
            def generate(self, prompt, **options): return "保持 ±0.2 mm。"
        result = probe_translation(FakePipe(), "NPU", "Hold ±0.2 mm.", "Chinese")
        self.assertEqual(result["actualDevice"], "NPU")
        self.assertEqual(result["text"], "保持 ±0.2 mm。")
```

- [ ] **Step 2: Run the tests and verify missing implementations**

Run: `python -m unittest discover -s native/local-inference-host/tests -p "test_probes.py" -v`

Expected: FAIL importing `prompts` or `probes`.

- [ ] **Step 3: Implement lazy OpenVINO GenAI probes**

`probes.py` must construct `openvino_genai.WhisperPipeline(model_path, device)` for ASR and `openvino_genai.LLMPipeline(model_path, device)` for translation. It must use deterministic generation (`temperature=0`, `do_sample=False`, `max_new_tokens=256`), measure warm-up separately, and return `requestedDevice`, `actualDevice`, model path, load time, first run, warm run, and text. Catch compilation and generation separately so NPU compilation failure is distinguishable from bad output.

Create translation goldens for both directions containing names, `±0.2 mm`, `24 VDC`, `DVT`, and a mixed-language sentence. Do not commit meeting recordings; invoke the ASR probe with files under ignored `evals/audio-private/`.

- [ ] **Step 4: Run CPU, GPU, and NPU probes explicitly**

Run the probe once per device, rather than using `AUTO`, so the report cannot mislabel placement:

From `native/local-inference-host`, run:

```powershell
.venv\Scripts\python.exe -m feasibility.probes --device NPU --models models --audio ..\..\evals\audio-private\bilingual-validation.wav
.venv\Scripts\python.exe -m feasibility.probes --device GPU --models models --audio ..\..\evals\audio-private\bilingual-validation.wav
.venv\Scripts\python.exe -m feasibility.probes --device CPU --models models --audio ..\..\evals\audio-private\bilingual-validation.wav
```

Expected: each successful result names the explicitly requested device. A failed Hy-MT2 NPU result remains a valid feasibility finding if GPU or CPU produces correct translations.

- [ ] **Step 5: Commit**

```powershell
git add native/local-inference-host/feasibility/prompts.py native/local-inference-host/feasibility/probes.py native/local-inference-host/tests/test_probes.py native/local-inference-host/fixtures/translation-goldens.json
git commit -m "test: probe bilingual local inference correctness"
```

### Task 5: Measure simultaneous residency and select the allocation

**Files:**
- Create: `native/local-inference-host/feasibility/residency.py`
- Create: `native/local-inference-host/feasibility/energy.py`
- Create: `native/local-inference-host/tests/test_residency.py`
- Create: `native/local-inference-host/tests/test_energy.py`

- [ ] **Step 1: Write the allocation decision tests**

```python
import unittest
from feasibility.residency import select_allocation

class ResidencyTest(unittest.TestCase):
    def test_both_models_remain_on_npu_when_stable(self):
        result = select_allocation({"bothNpu": {"passed": True, "asrP95Ms": 800}})
        self.assertEqual(result, {"whisper": "NPU", "hyMt2": "NPU"})

    def test_whisper_keeps_npu_when_co_residency_fails(self):
        result = select_allocation({
            "bothNpu": {"passed": False},
            "npuGpu": {"passed": True, "asrP95Ms": 900},
        })
        self.assertEqual(result, {"whisper": "NPU", "hyMt2": "GPU"})
```

- [ ] **Step 2: Verify failure, then implement the deterministic policy**

`select_allocation` must choose both on NPU only when 60 minutes complete without compile failure, memory failure, model reload, unbounded queue growth, or more than 10 percent ASR p95 regression against Whisper-alone NPU. Otherwise choose Whisper NPU plus Hy-MT2 GPU, then Whisper NPU plus Hy-MT2 CPU. If Whisper itself fails on NPU, choose the fastest correct all-local allocation and mark NPU ASR unsupported.

- [ ] **Step 3: Run unit tests**

Run: `python -m unittest native/local-inference-host/tests/test_residency.py -v`

Expected: PASS.

Add `test_energy.py` for `summarize_power(samples)` using timestamped watt samples. `energy.py` samples the Windows `Energy Meter` power counter plus processor and GPU-engine utilization when available, integrates watts over time into joules, and records `available: false` with the counter error when unavailable. Energy results are diagnostic and never change `select_allocation` or the pass gate.

- [ ] **Step 4: Run the 60-minute benchmark**

The CLI cycles the private bilingual audio corpus and translation goldens, records queue depth once per second, and writes one JSON result per allocation. Run:

From `native/local-inference-host`, run: `.venv\Scripts\python.exe -m feasibility.residency --duration-minutes 60 --output ..\..\artifacts\local-inference\residency.json`

Expected: exit 0 when at least one fully local allocation passes. The JSON includes selected allocation, per-model p50/p95, maximum queue depth, load count, errors, actual devices, and available power/energy diagnostics.

- [ ] **Step 5: Commit**

```powershell
git add native/local-inference-host/feasibility/residency.py native/local-inference-host/feasibility/energy.py native/local-inference-host/tests/test_residency.py native/local-inference-host/tests/test_energy.py
git commit -m "feat: select stable NPU inference allocation"
```

### Task 6: Generate and review the feasibility gate

**Files:**
- Create: `native/local-inference-host/feasibility/report.py`
- Create: `native/local-inference-host/tests/test_report.py`
- Generated: `docs/validation/windows-local-inference-feasibility.md`

- [ ] **Step 1: Test that reports never claim unproven NPU support**

```python
import unittest
from feasibility.report import build_report

class ReportTest(unittest.TestCase):
    def test_failed_hymt_npu_is_reported_as_gpu_fallback(self):
        report = build_report({
            "allocation": {"whisper": "NPU", "hyMt2": "GPU"},
            "probes": {"hyMt2Npu": {"passed": False, "error": "compile failed"}},
        })
        self.assertIn("Hy-MT2 NPU: unsupported", report)
        self.assertIn("Hy-MT2 selected device: GPU", report)
```

- [ ] **Step 2: Implement report generation**

The report must include hardware and driver, resolved source revisions, exported file hashes, correctness outcomes, actual devices, cold/warm p50/p95, residency decision, failures, and one of these exact gates:

- `GO: Whisper NPU and Hy-MT2 NPU`
- `GO: Whisper NPU and Hy-MT2 local fallback`
- `GO: fully local without NPU`
- `NO-GO: no correct fully local allocation`

The script writes both the Markdown report and `artifacts/local-inference/feasibility.json` atomically.

- [ ] **Step 3: Run all unit tests and generate the report**

Run: `python -m unittest discover -s native/local-inference-host/tests -v`

Expected: PASS.

From `native/local-inference-host`, run: `.venv\Scripts\python.exe -m feasibility.report --exports models\export-results.json --residency ..\..\artifacts\local-inference\residency.json --markdown ..\..\docs\validation\windows-local-inference-feasibility.md --json ..\..\artifacts\local-inference\feasibility.json`

Expected: one exact gate is printed and written. Stop before the native-host plan only if the result is `NO-GO`.

- [ ] **Step 4: Commit the code and generated Markdown, not weights or private audio**

```powershell
git add native/local-inference-host/feasibility/report.py native/local-inference-host/tests/test_report.py docs/validation/windows-local-inference-feasibility.md
git commit -m "docs: record Windows local inference feasibility"
```

### Task 7: Final verification checkpoint

- [ ] **Step 1: Verify repository hygiene**

Run: `git status --short`

Expected: no model weights, virtual environment, private audio, or artifact JSON is staged.

- [ ] **Step 2: Re-run the complete feasibility unit suite**

Run: `python -m unittest discover -s native/local-inference-host/tests -v`

Expected: all tests PASS.

- [ ] **Step 3: Record the gate for the next plan**

The executor must quote the exact gate and selected `whisper`/`hyMt2` devices from `docs/validation/windows-local-inference-feasibility.md`. The local-host implementation uses that allocation as its default and keeps runtime fallback truthful.
