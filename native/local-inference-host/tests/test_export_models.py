import hashlib
import pathlib
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from feasibility.export_models import download_source, export_command, hash_files


class ExportModelsTest(unittest.TestCase):
    def test_whisper_export_is_int8_and_stateful(self):
        command = export_command(
            {
                "task": "automatic-speech-recognition-with-past",
                "weight_format": "int8",
            },
            pathlib.Path("snapshots/whisper"),
            pathlib.Path("models/whisper-small"),
            "optimum-cli",
        )

        self.assertEqual(command[:3], ["optimum-cli", "export", "openvino"])
        self.assertIn("automatic-speech-recognition-with-past", command)
        self.assertIn("int8", command)
        self.assertNotIn("--disable-stateful", command)
        self.assertEqual(command[-1], "models\\whisper-small")

    def test_hymt2_export_uses_the_resolved_snapshot_and_int4(self):
        command = export_command(
            {"task": "text-generation-with-past", "weight_format": "int4"},
            pathlib.Path("snapshots/hy-mt2"),
            pathlib.Path("models/hy-mt2"),
            "optimum-cli",
        )

        self.assertIn("snapshots\\hy-mt2", command)
        self.assertIn("text-generation-with-past", command)
        self.assertIn("int4", command)

    def test_hash_files_records_relative_paths_sizes_and_sha256(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            payload = b"model-bytes"
            (root / "openvino_model.bin").write_bytes(payload)

            rows = hash_files(root)

        self.assertEqual(rows, [{
            "path": "openvino_model.bin",
            "size": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
        }])

    def test_source_download_uses_a_direct_directory_without_symlink_cache(self):
        calls = []

        class Info:
            sha = "resolved-sha"

        def download(repo, **options):
            calls.append((repo, options))
            return str(options["local_dir"])

        with tempfile.TemporaryDirectory() as directory:
            snapshot, revision = download_source(
                "whisper-small",
                {"repo": "openai/whisper-small", "revision": "main"},
                pathlib.Path(directory),
                info_loader=lambda *_args, **_options: Info(),
                downloader=download,
            )

        self.assertEqual(revision, "resolved-sha")
        self.assertEqual(snapshot.name, "whisper-small")
        self.assertNotIn("cache_dir", calls[0][1])
        self.assertEqual(pathlib.Path(calls[0][1]["local_dir"]).name, "whisper-small")


if __name__ == "__main__":
    unittest.main()
