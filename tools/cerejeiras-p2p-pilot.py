import asyncio, json, os, sys, signal, tempfile, hashlib
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
import psycopg2
# OpenDahua 1.0.8 uses forward annotations without postponing evaluation.
# Apply the compatibility fix only inside this disposable pilot container.
import importlib.util
package_root=Path(importlib.util.find_spec("opendahua").origin).parent
for source in package_root.rglob("*.py"):
    original=source.read_text()
    if "from __future__ import annotations" not in original:
        source.write_text("from __future__ import annotations\n"+original)
from opendahua import DahuaNVR
from opendahua.logger import Logger
Logger._log = classmethod(lambda cls, *args: None)
signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError("pilot deadline")))
signal.alarm(150)
stage = "database"
sensitive = [os.environ.get("DATABASE_URL", ""), os.environ.get("DVR_PASSWORD", "")]
def emit(status, **fields):
    print(json.dumps(dict(pilot="cerejeiras-opendahua-v1", status=status, stage=stage, **fields), ensure_ascii=False), flush=True)
def safe_error(e):
    value = str(e)
    for secret in sensitive:
        if secret:
            value = value.replace(secret, "[redacted]")
    return value[:700]
async def main():
    global stage
    db = psycopg2.connect(os.environ["DATABASE_URL"], connect_timeout=10)
    db.set_session(readonly=True, autocommit=True)
    with db.cursor() as cur:
        cur.execute("""SELECT d.id,d.unit_id,d.model,d.cloud_serial,d.access_username,d.secret_ref,
          d.remote_connection_mode,d.playback_mode
          FROM cop_dvrs d JOIN cop_units u ON u.id=d.unit_id
          WHERE lower(u.name) LIKE '%cerejeiras%' AND d.active=TRUE ORDER BY d.id""")
        rows = cur.fetchall()
        if len(rows) != 1:
            raise ValueError("Expected exactly one active Cerejeiras DVR; found " + str(len(rows)))
        did,uid,model,serial,user,ref,remote,playback = rows[0]
        cur.execute("SELECT channel FROM cop_cameras WHERE dvr_id=%s AND active=TRUE ORDER BY channel", (did,))
        channels = [r[0] for r in cur.fetchall()]
    db.close()
    if not serial or not user or not os.environ.get("DVR_PASSWORD"):
        raise ValueError("Missing serial, DVR username or password")
    if ref != "COP_DVR_CEREJEIRAS_PASSWORD":
        raise ValueError("Unexpected credential reference; stop before authentication")
    if not channels:
        raise ValueError("No active camera")
    sensitive.extend([serial, user])
    emit("config_verified", dvr_id=did, unit_id=uid, model=model, channels=channels,
         remote_mode=remote, playback_mode=playback, secret_present=True)
    stage="cloud_connect"
    nvr=DahuaNVR(serial, user, os.environ["DVR_PASSWORD"])
    try:
        await asyncio.wait_for(nvr.connect(), timeout=40)
        emit("connected")
        stage="recording_search"
        start=datetime.now(ZoneInfo("America/Sao_Paulo")).replace(tzinfo=None)-timedelta(days=1)
        end=start+timedelta(seconds=30)
        videos=await asyncio.wait_for(nvr.get_videos(channel=channels[0],time_start=start,time_end=end),timeout=25)
        emit("search_complete",channel=channels[0],start=start.isoformat(),end=end.isoformat(),count=len(videos))
        eligible=[v for v in videos if 0 < (v.get_time_end()-v.get_time_start()).total_seconds() <= 120]
        if not eligible:
            emit("download_skipped",reason="No recording file of at most 120 seconds; full-file download avoids pretending an exact clip")
            return
        stage="download"
        with tempfile.TemporaryDirectory() as folder:
            out=Path(folder)/"pilot.dav"
            await asyncio.wait_for(nvr.download_video(eligible[0],out),timeout=45)
            size=out.stat().st_size
            if size <= 0 or size > 32*1024*1024:
                raise ValueError("Downloaded file outside pilot bounds")
            emit("download_verified",bytes=size,sha256=hashlib.sha256(out.read_bytes()).hexdigest(),
                 start=eligible[0].get_time_start().isoformat(),end=eligible[0].get_time_end().isoformat(),
                 note="Temporary file validated; COP production integration remains disabled")
    finally:
        try:
            await asyncio.wait_for(nvr.disconnect(),timeout=5)
        except Exception:
            pass
try:
    asyncio.run(main())
except Exception as e:
    emit("failed",error_type=type(e).__name__,error=safe_error(e))
finally:
    signal.alarm(0)
