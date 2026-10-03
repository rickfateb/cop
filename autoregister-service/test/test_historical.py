import datetime as dt
import pathlib
import tempfile
import unittest
from unittest.mock import Mock
import historical as h

def job(mode='motion',media='photo'):
    return {'device_id':'101','channel':2,'start':'2026-09-10T03:00:00Z','end':'2026-09-10T03:10:00Z',
        'request_start':'2026-09-10T03:00:00Z','request_end':'2026-09-10T04:00:00Z',
        'capture_mode':mode,'media_type':media,
        'sampling':{'offsets':[0,5,15,30],'frame_interval_seconds':3,'min_motion_seconds':0,'cooldown_seconds':60}}

class HistoricalTests(unittest.TestCase):
    def test_offsets_clipped_to_dvr_events_and_batch(self):
        records=[{'start':'2026-09-10T00:00:02','end':'2026-09-10T00:00:22','type':'motion'}]
        windows=h.intervals(job(),records)
        times=list(h.samples(job(),windows))
        self.assertEqual([t[0].second for t in times],[2,7,17])
        self.assertTrue(all(t[1].second==2 for t in times))

    def test_cross_batch_offsets_keep_original_event_start(self):
        request=job();request['start']='2026-09-10T03:00:10Z'
        records=[{'start':'2026-09-10T00:00:02','end':'2026-09-10T00:00:45','type':'motion'}]
        self.assertEqual([t[0].second for t in h.samples(request,h.intervals(request,records))],[17,32])

    def test_continuous_interval_uses_request_origin(self):
        request=job('continuous');request['start']='2026-09-10T03:00:10Z';request['end']='2026-09-10T03:00:20Z'
        self.assertEqual([t[0].second for t in h.samples(request,h.intervals(request,[]))],[12,15,18])

    def test_photo_pipeline_never_calls_video_downloader(self):
        native=Mock();native.query.return_value=[{'start':'2026-09-10T00:00:02','end':'2026-09-10T00:00:22','type':'motion'}]
        def photo(ident,channel,t,path):
            path.write_bytes(b'\xff\xd8\x00\xff\xd9');return t.isoformat()
        native.photo.side_effect=photo
        video=Mock(side_effect=AssertionError('video download forbidden'));upload=Mock()
        with tempfile.TemporaryDirectory() as directory:
            counters=h.process(job(),native,pathlib.Path(directory),upload,lambda:None,video)
        self.assertEqual(counters,{'media_count':3,'events_found':1})
        video.assert_not_called();self.assertEqual(upload.call_count,3)
        self.assertEqual(upload.call_args.args[1]['acquisition'],'playback_snapshot')

    def test_empty_motion_result_and_wrong_ai_do_not_fallback(self):
        native=Mock();native.query.return_value=[];video=Mock();upload=Mock()
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(h.process(job(),native,pathlib.Path(directory),upload,lambda:None,video)['media_count'],0)
        native.photo.assert_not_called();video.assert_not_called()
        with self.assertRaisesRegex(h.CaptureError,'EVENT_QUERY_FAILED'):
            h.intervals(job('ai'),[{'start':'2026-09-10T00:00:02','end':'2026-09-10T00:00:22','type':'motion'}])

    def test_cooldown_and_minimum_duration(self):
        request=job();request['sampling']['min_motion_seconds']=10
        records=[{'start':a,'end':b,'type':'motion'} for a,b in [
            ('2026-09-10T00:00:00','2026-09-10T00:00:20'),
            ('2026-09-10T00:00:30','2026-09-10T00:00:45'),
            ('2026-09-10T00:01:00','2026-09-10T00:01:03'),
            ('2026-09-10T00:02:00','2026-09-10T00:02:20')]]
        self.assertEqual(len(h.intervals(request,records)),2)
