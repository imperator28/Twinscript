import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from feasibility.report import build_report, write_reports


class ReportTest(unittest.TestCase):
    def test_failed_hymt_npu_is_reported_as_local_fallback(self):
        report = build_report({
            "gate": "GO: Whisper NPU and Hy-MT2 local fallback",
            "allocation": {"whisper": "NPU", "hyMt2": "CPU"},
            "probes": {
                "hyMt2Npu": {"passed": False, "error": "unsupported architecture"},
                "hyMt2Cpu": {"passed": True, "runtime": "llama.cpp", "cases": []},
            },
        })

        self.assertIn("Hy-MT2 NPU: unsupported", report)
        self.assertIn("Hy-MT2 selected device: CPU", report)
        self.assertIn("GO: Whisper NPU and Hy-MT2 local fallback", report)

    def test_report_outputs_are_written_atomically(self):
        evidence = {
            "gate": "GO: fully local without NPU",
            "allocation": {"whisper": "CPU", "hyMt2": "CPU"},
            "probes": {},
        }
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            write_reports(evidence, root / "report.md", root / "report.json")

            self.assertIn("GO: fully local without NPU", (root / "report.md").read_text())
            self.assertIn('"gate": "GO: fully local without NPU"', (root / "report.json").read_text())
            self.assertFalse((root / "report.md.tmp").exists())


if __name__ == "__main__":
    unittest.main()
