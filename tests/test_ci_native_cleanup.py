"""A failed fresh build must not preserve earlier benchmark evidence."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('native_ci', ROOT / 'scripts/native-ci.py')
native_ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native_ci)


class FreshBuildEvidenceTests(unittest.TestCase):
    def test_clears_old_scores_samples_manifest_and_every_lane_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            stale = ['scores.tsv', 'standings.txt', 'samples.json', 'manifest.json']
            for lane in native_ci.LANES:
                stale += [lane + suffix for suffix in ('.txt', '.stderr.txt', '.error.txt')]
                for number in (1, 2):
                    stale += [f'{lane}-pass-{number}.txt', f'{lane}-pass-{number}-stderr.txt']
            for name in stale:
                (output / name).write_text('old successful evidence\n')
            (output / 'operator-notes.md').write_text('retain unrelated notes\n')

            native_ci.clear_shootout(output)

            self.assertEqual(sorted(path.name for path in output.iterdir()),
                             ['operator-notes.md'])
            native_ci.clear_shootout(output)  # Cleanup also works before the first run.


if __name__ == '__main__':
    unittest.main()
