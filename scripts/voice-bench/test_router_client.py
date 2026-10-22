import unittest
from unittest.mock import patch
import router


class LeaseTest(unittest.TestCase):
    def test_failed_measurement_releases_its_lease(self):
        requests=[]
        def request(path, body=None, method=None):
            requests.append((path,method))
            return {"sessionId":"synthetic-lease"}
        with patch.object(router,"idle",return_value={}),patch.object(router,"request",side_effect=request):
            with self.assertRaisesRegex(ValueError,"measurement failed"):
                with router.lease(["synthetic-tenant"]):
                    raise ValueError("measurement failed")
        self.assertEqual(requests[-1],("/v1/voice/sessions/synthetic-lease","DELETE"))

    def test_pending_start_does_not_count_as_idle(self):
        snapshots=[{"speech":{"voiceSessions":0,"starting":True}},
                   {"speech":{"voiceSessions":0,"starting":False}}]
        with patch.object(router,"request",side_effect=snapshots),patch.object(router.time,"sleep") as sleep:
            self.assertFalse(router.idle()["starting"])
        sleep.assert_called_once_with(2)


if __name__=="__main__":
    unittest.main()
