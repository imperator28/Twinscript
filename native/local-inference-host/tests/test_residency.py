import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from feasibility.residency import select_allocation


class ResidencyTest(unittest.TestCase):
    def test_both_models_remain_on_npu_when_stable(self):
        result = select_allocation({"bothNpu": {"passed": True, "asrP95Ms": 800}})
        self.assertEqual(result, {"whisper": "NPU", "hyMt2": "NPU"})

    def test_whisper_keeps_npu_when_gpu_fallback_passes(self):
        result = select_allocation({
            "bothNpu": {"passed": False},
            "npuGpu": {"passed": True, "asrP95Ms": 900},
        })
        self.assertEqual(result, {"whisper": "NPU", "hyMt2": "GPU"})

    def test_whisper_keeps_npu_with_the_verified_llamacpp_cpu_fallback(self):
        result = select_allocation({
            "bothNpu": {"passed": False},
            "npuGpu": {"passed": False},
            "npuCpu": {"passed": True, "asrP95Ms": 600},
        })
        self.assertEqual(result, {"whisper": "NPU", "hyMt2": "CPU"})

    def test_no_correct_fully_local_allocation_is_an_error(self):
        with self.assertRaisesRegex(RuntimeError, "no correct fully local allocation"):
            select_allocation({})


if __name__ == "__main__":
    unittest.main()
