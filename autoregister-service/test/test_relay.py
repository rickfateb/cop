import datetime as dt
import importlib.util
import os
import pathlib
import tempfile
import time
import unittest

ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("relay",ROOT/"relay.py")
relay=importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

class NativeTests(unittest.TestCase):
    def native(self,mode="ok"):
        old=os.environ.get("MOCK_MODE")
        os.environ["MOCK_MODE"]=mode
        self.directory=tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state=pathlib.Path(self.directory.name)
        native=relay.Native({"receiver":str(ROOT/"build/cop-sdk-receiver"),
            "sdk_so":str(ROOT/"build/mock-sdk.so"),"port":8000,
            "devices":[{"id":"101","username":"admin","password":"mock-secret"}]},self.state)
        self.addCleanup(native.close)
        if old is None:os.environ.pop("MOCK_MODE",None)
        else:os.environ["MOCK_MODE"]=old
        deadline=time.monotonic()+3
        while not native.online_ids() and time.monotonic()<deadline:time.sleep(.02)
        return native

    def download(self,native,name):
        begin=dt.datetime(2026,9,30,10,41,38)
        output=self.state/name
        native.download("101",1,begin,begin+dt.timedelta(seconds=30),output)
        self.assertEqual(output.read_bytes(),b"MOCK_DAV")

    def test_persistent_multiple_downloads(self):
        native=self.native()
        self.assertEqual(native.online_ids(),["101"])
        self.download(native,"one.dav")
        self.download(native,"two.dav")
        self.assertIsNone(native.proc.poll())

    def test_disconnection_and_reregistration(self):
        native=self.native("reconnect")
        with self.assertRaisesRegex(relay.RelayError,"DOWNLOAD_INCOMPLETE"):
            self.download(native,"first.dav")
        deadline=time.monotonic()+3
        # Main loop consumes the disconnect and logs back in on the next registration.
        time.sleep(.3)
        while not native.online_ids() and time.monotonic()<deadline:time.sleep(.02)
        self.download(native,"second.dav")

    def test_empty_download_rejected(self):
        native=self.native("empty")
        with self.assertRaisesRegex(relay.RelayError,"EMPTY_DOWNLOAD"):
            self.download(native,"empty.dav")

    def test_existing_file_not_overwritten(self):
        native=self.native()
        target=self.state/"existing.dav";target.write_bytes(b"existing")
        with self.assertRaisesRegex(relay.RelayError,"OUTPUT_EXISTS"):
            self.download(native,"existing.dav")
        self.assertEqual(target.read_bytes(),b"existing")

    def test_motion_smart_query_and_snapshot_without_download(self):
        native=self.native();start=dt.datetime(2026,9,30,10,41,38)
        for mode in ('motion','ai'):
            records=native.query('101',1,start,start+dt.timedelta(seconds=30),mode)
            self.assertEqual(records[0]['type'],mode)
            self.assertEqual(records[0]['start'],start.isoformat())
        path=self.state/'photo.jpg'
        self.assertEqual(native.photo('101',1,start,path),start.isoformat())
        self.assertEqual(path.read_bytes(),b'\xff\xd8\x00\xff\xd9')

    def test_query_rejects_continuous_record_in_motion_filter(self):
        native=self.native('wrong-type');start=dt.datetime(2026,9,30,10,41,38)
        with self.assertRaisesRegex(relay.RelayError,'EVENT_QUERY_FAILED'):
            native.query('101',1,start,start+dt.timedelta(seconds=30),'motion')

    def test_empty_event_query_is_not_a_continuous_fallback(self):
        native=self.native('query-empty');start=dt.datetime(2026,9,30,10,41,38)
        self.assertEqual(native.query('101',1,start,start+dt.timedelta(seconds=30),'motion'),[])

class RelayTests(unittest.TestCase):
    def test_timezone_and_segment_limits(self):
        start=relay.local_time("2026-09-30T13:41:38Z")
        self.assertEqual(start,dt.datetime(2026,9,30,10,41,38))
        parts=list(relay.segments(start,start+dt.timedelta(seconds=900)))
        self.assertEqual(sum((b-a).total_seconds() for a,b in parts),900)
        self.assertTrue(all((b-a).total_seconds()+4<=120 for a,b in parts))

    def test_unbounded_protocol_rejected(self):
        with self.assertRaises(relay.RelayError):relay.frame(["config","x"*4097])

if __name__=="__main__":unittest.main()

class DirectoryTests(unittest.TestCase):
    def test_unit_directories_cannot_escape_server_root(self):
        import tempfile
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary).resolve()
            target = relay.job_directory(root,"unidades/cerejeiras")
            self.assertEqual(target.parent,root/"unidades/cerejeiras")
            for invalid in ("../outside","/etc","a/../b"):
                with self.assertRaises(relay.RelayError):
                    relay.job_directory(root,invalid)
            (root/"symlink").symlink_to(root.parent,target_is_directory=True)
            with self.assertRaises(relay.RelayError):
                relay.job_directory(root,"symlink/escape")
