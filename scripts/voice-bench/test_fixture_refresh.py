import contextlib
import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import fixtures


class TranscriptRefreshTest(unittest.TestCase):
    def test_new_observations_do_not_replace_fixed_inputs_or_prior_results(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            pcm=bytes(3200)
            (root/"input.pcm").write_bytes(pcm)
            original={"fixtures":[{"id":"test","file":"input.pcm","sampleRate":16000,
                       "synthetic":True,"sha256":"fixed-hash","trueEndS":.1,
                       "segments":[{"startS":0,"endS":.1,"expectedText":"Yes"}],
                       "whisper":{"text":"Old result","finalizationS":9.}}]}
            before=copy.deepcopy(original)
            with patch.object(fixtures,"lease",return_value=contextlib.nullcontext(("lease",{"acquireS":1.}))),patch.object(fixtures,"transcribe",return_value={"text":"Yes","finalizationS":.2}) as transcribe:
                refreshed=fixtures.refresh_transcripts(root,original)
            self.assertEqual(original,before)
            self.assertEqual((root/"input.pcm").read_bytes(),pcm)
            self.assertEqual(refreshed["fixtures"][0]["whisper"]["finalizationS"],.2)
            self.assertEqual(refreshed["fixtures"][0]["sha256"],"fixed-hash")
            self.assertEqual(refreshed["fixtures"][0]["trueEndS"],.1)
            self.assertEqual(transcribe.call_count,2)


if __name__=="__main__":
    unittest.main()
