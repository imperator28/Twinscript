import pathlib
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from feasibility.prompts import hy_mt2_prompt
from feasibility.probes import _resample_audio, compile_and_probe_translation, probe_translation


class ProbeTest(unittest.TestCase):
    def test_hymt2_prompt_is_user_only_and_directional(self):
        self.assertEqual(
            hy_mt2_prompt("Hold ±0.2 mm.", "Chinese"),
            "Translate the following text into Chinese. Note that you should only output "
            "the translated result without any additional explanation: Hold ±0.2 mm.",
        )

    def test_probe_records_explicit_device_and_deterministic_options(self):
        calls = []

        class FakePipe:
            def generate(self, prompt, **options):
                calls.append((prompt, options))
                return "保持 ±0.2 mm。"

        result = probe_translation(FakePipe(), "NPU", "Hold ±0.2 mm.", "Chinese")

        self.assertTrue(result["passed"])
        self.assertEqual(result["requestedDevice"], "NPU")
        self.assertEqual(result["actualDevice"], "NPU")
        self.assertEqual(result["text"], "保持 ±0.2 mm。")
        self.assertEqual(calls[0][1]["temperature"], 0)
        self.assertFalse(calls[0][1]["do_sample"])
        self.assertEqual(calls[0][1]["max_new_tokens"], 256)

    def test_compile_failure_is_distinct_from_generation_failure(self):
        def fail_compile(_model_path, _device):
            raise RuntimeError("unsupported architecture")

        result = compile_and_probe_translation(
            pathlib.Path("models/hy-mt2"),
            "NPU",
            "Hold ±0.2 mm.",
            "Chinese",
            pipeline_factory=fail_compile,
        )

        self.assertFalse(result["passed"])
        self.assertEqual(result["failurePhase"], "compile")
        self.assertIn("unsupported architecture", result["error"])

    def test_audio_is_resampled_to_sixteen_khz(self):
        audio = _resample_audio([0.0] * 24000, 24000, 16000)

        self.assertEqual(len(audio), 16000)

    def test_load_time_excludes_generation_time(self):
        class FakePipe:
            def generate(self, _prompt, **_options):
                return "translated"

        with mock.patch(
            "feasibility.probes.time.perf_counter",
            side_effect=[0, 10, 11, 20, 21, 30],
        ):
            result = compile_and_probe_translation(
                pathlib.Path("models/hy-mt2"),
                "CPU",
                "hello",
                "Chinese",
                pipeline_factory=lambda *_args: FakePipe(),
            )

        self.assertEqual(result["loadMs"], 10000)


if __name__ == "__main__":
    unittest.main()
