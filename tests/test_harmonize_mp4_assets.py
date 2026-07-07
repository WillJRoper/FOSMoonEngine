from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = REPO_ROOT / "scripts" / "harmonize_mp4_assets.py"
MODULE_SPEC = importlib.util.spec_from_file_location(
    "harmonize_mp4_assets",
    MODULE_PATH,
)
if MODULE_SPEC is None or MODULE_SPEC.loader is None:
    raise RuntimeError(f"Unable to load module from {MODULE_PATH}")
harmonize = importlib.util.module_from_spec(MODULE_SPEC)
sys.modules[MODULE_SPEC.name] = harmonize
MODULE_SPEC.loader.exec_module(harmonize)


class HarmonizeMp4AssetsTests(unittest.TestCase):
    def test_calculate_gop_frames_matches_half_second_gop(self) -> None:
        self.assertEqual(harmonize.calculate_gop_frames(30, 0.5), 15)
        self.assertEqual(harmonize.calculate_gop_frames(60, 0.5), 30)

    def test_keyframe_gap_tolerance_allows_one_output_frame(self) -> None:
        tolerance = harmonize.keyframe_gap_tolerance_seconds(30)

        self.assertEqual(tolerance, 1.0 / 30.0)

    def test_duration_tolerance_allows_one_second(self) -> None:
        tolerance = harmonize.duration_tolerance_seconds(30)

        self.assertEqual(tolerance, 1.0)
        self.assertLessEqual(abs(10.0 - (10.0 + tolerance)), tolerance)
        self.assertGreater(abs(10.0 - (10.0 + tolerance + 0.001)), tolerance)

    def test_probe_issues_accepts_compliant_profile(self) -> None:
        probe = harmonize.VideoProbe(
            path=Path("sample.mp4"),
            duration_seconds=20.0,
            codec_name="h264",
            profile="High",
            level=42,
            width=1920,
            height=1080,
            pixel_format="yuv420p",
            avg_frame_rate="30/1",
            r_frame_rate="30/1",
            audio_stream_count=0,
            has_faststart=True,
            max_keyframe_gap_seconds=0.5,
        )

        self.assertEqual(harmonize.get_probe_issues(probe, fps=30, gop_duration_seconds=0.6), [])

    def test_probe_issues_report_non_compliance(self) -> None:
        probe = harmonize.VideoProbe(
            path=Path("sample.mp4"),
            duration_seconds=20.0,
            codec_name="hevc",
            profile="Main",
            level=41,
            width=4096,
            height=2304,
            pixel_format="yuv444p",
            avg_frame_rate="75/1",
            r_frame_rate="75/1",
            audio_stream_count=1,
            has_faststart=False,
            max_keyframe_gap_seconds=6.0,
        )

        issues = harmonize.get_probe_issues(probe, fps=30, gop_duration_seconds=0.6)

        self.assertIn("codec=hevc", issues)
        self.assertIn("profile=Main", issues)
        self.assertIn("level=41", issues)
        self.assertIn("pix_fmt=yuv444p", issues)
        self.assertIn("fps=75/1", issues)
        self.assertIn("dimensions=4096x2304", issues)
        self.assertIn("audio_streams=1", issues)
        self.assertIn("faststart=false", issues)
        self.assertIn("max_keyframe_gap=6.000s", issues)

    def test_discovery_skips_symlinks_and_dist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            assets_dir = Path(tmp_dir)
            keep_dir = assets_dir / "cosmos" / "run_001"
            keep_dir.mkdir(parents=True)
            dist_dir = assets_dir / "dist" / "assets"
            dist_dir.mkdir(parents=True)

            keep_file = keep_dir / "view.mp4"
            keep_file.write_bytes(b"video")
            skipped_file = dist_dir / "build.mp4"
            skipped_file.write_bytes(b"video")

            symlink_path = assets_dir / "linked.mp4"
            symlink_path.symlink_to(keep_file)

            result = harmonize.discover_mp4_files(assets_dir)

            self.assertEqual(result.files, [keep_file])
            self.assertEqual(result.symlinks, [symlink_path])

    def test_is_excluded_directory_detects_nested_dist(self) -> None:
        self.assertTrue(harmonize.is_excluded_directory(Path("dist")))
        self.assertTrue(harmonize.is_excluded_directory(Path("cosmos/dist/run")))
        self.assertFalse(harmonize.is_excluded_directory(Path("cosmos/run")))

    def test_build_ffmpeg_command_includes_setpts_when_runtime_set(self) -> None:
        command = harmonize.build_ffmpeg_command(
            Path("input.mp4"),
            Path("output.mp4"),
            fps=30,
            gop_duration_seconds=0.6,
            crf=23,
            preset="slow",
            runtime=15.0,
            source_duration_seconds=30.0,
        )

        vf_index = command.index("-vf")
        filter_str = command[vf_index + 1]
        self.assertIn("setpts=0.5*PTS", filter_str)

    def test_build_ffmpeg_command_omits_setpts_when_runtime_none(self) -> None:
        command = harmonize.build_ffmpeg_command(
            Path("input.mp4"),
            Path("output.mp4"),
            fps=30,
            gop_duration_seconds=0.6,
            crf=23,
            preset="slow",
        )

        vf_index = command.index("-vf")
        filter_str = command[vf_index + 1]
        self.assertNotIn("setpts", filter_str)

    def test_build_ffmpeg_command_slows_down_short_video(self) -> None:
        command = harmonize.build_ffmpeg_command(
            Path("input.mp4"),
            Path("output.mp4"),
            fps=30,
            gop_duration_seconds=0.6,
            crf=23,
            preset="slow",
            runtime=60.0,
            source_duration_seconds=30.0,
        )

        vf_index = command.index("-vf")
        filter_str = command[vf_index + 1]
        self.assertIn("setpts=2.0*PTS", filter_str)


if __name__ == "__main__":
    unittest.main()
