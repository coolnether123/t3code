import unittest
import numpy as np
from audio_metrics import onset, schedule, summary


class AudioMetricsTest(unittest.TestCase):
    def test_scheduler_counts_starvation_and_keeps_contiguous_chunks(self):
        result = schedule([[.1,4800],[.15,4800],[.4,4800]],24000)
        self.assertEqual(result["underruns"],1)
        self.assertAlmostEqual(result["underrunS"],.1)
        self.assertAlmostEqual(result["firstAudibleS"],.12)

    def test_score_rises_for_attenuated_low_bandwidth_onset(self):
        rate=24000
        t=np.arange(rate)/rate
        clean=.25*np.sin(2*np.pi*1200*t)
        rough=clean.copy()
        rough[:3600]=.015*np.sin(2*np.pi*200*t[:3600])
        encode=lambda x:(x*32767).astype("<i2").tobytes()
        self.assertGreater(onset(encode(rough),rate)["onsetArtifactScore"],
                           onset(encode(clean),rate)["onsetArtifactScore"]+30)

    def test_empty_samples_are_unknown(self):
        self.assertEqual(summary([]),{"n":0,"median":None,"p95":None})
        self.assertIsNone(onset(bytes(4800),24000)["onsetArtifactScore"])


if __name__=="__main__":
    unittest.main()
