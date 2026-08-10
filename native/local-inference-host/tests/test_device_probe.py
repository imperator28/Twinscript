import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from feasibility.device_probe import choose_device, probe_devices


class FakeCore:
    available_devices = ["CPU", "GPU.0", "NPU"]

    def get_property(self, device, key):
        return {
            "FULL_DEVICE_NAME": f"fake {device}",
            "DRIVER_VERSION": "test-driver",
        }[key]


class DeviceProbeTest(unittest.TestCase):
    def test_npu_first_selection_uses_only_reported_devices(self):
        report = probe_devices(FakeCore())

        self.assertEqual(choose_device(report), "NPU")
        self.assertEqual(
            [row["device"] for row in report],
            ["CPU", "GPU.0", "NPU"],
        )
        self.assertEqual(report[-1]["full_device_name"], "fake NPU")

    def test_gpu_is_selected_when_npu_is_absent(self):
        self.assertEqual(
            choose_device([{"device": "CPU"}, {"device": "GPU.1"}]),
            "GPU.1",
        )

    def test_cpu_is_truthful_fallback(self):
        self.assertEqual(choose_device([{"device": "CPU"}]), "CPU")

    def test_no_usable_device_is_an_error(self):
        with self.assertRaisesRegex(RuntimeError, "no usable"):
            choose_device([{"device": "GNA"}])


if __name__ == "__main__":
    unittest.main()
