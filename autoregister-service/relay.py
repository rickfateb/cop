#!/usr/bin/env python3
"""Persistent NetSDK relay. Credentials stay in the VPS config and native pipe."""
import datetime as dt
import json
import os
import pathlib
import queue
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from zoneinfo import ZoneInfo

MAX_BYTES = 256 * 1024 * 1024

class RelayError(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RelayError("HTTP_REDIRECT_REFUSED")

def local_time(value):
    date = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if date.tzinfo is None:
        raise RelayError("INVALID_TIME")
    return date.astimezone(ZoneInfo("America/Sao_Paulo")).replace(tzinfo=None)

def segments(start, end):
    duration = (end - start).total_seconds()
    if duration <= 0 or duration > 7200:
        raise RelayError("INVALID_INTERVAL")
    while start < end:
        finish = min(end, start + dt.timedelta(seconds=116))
        yield start, finish
        start = finish

def frame(fields):
    fields = list(fields)
    if len(fields) > 9:
        raise RelayError("INVALID_COMMAND")
    fields += [""] * (9 - len(fields))
    packet = bytearray()
    for field in fields:
        data = str(field).encode("utf-8")
        if len(data) > 4096 or b"\x00" in data:
            raise RelayError("INVALID_COMMAND")
        packet.extend(struct.pack("!I", len(data)))
        packet.extend(data)
    return packet

def run_media(args, timeout=300):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=timeout, check=False)
    except (subprocess.TimeoutExpired, OSError):
        raise RelayError("VIDEO_INVALID") from None
    if result.returncode:
        # Do not include arbitrary process output in portal errors or logs.
        raise RelayError("VIDEO_INVALID")
    return result.stdout

def probe(path):
    try:
        return json.loads(run_media(["ffprobe", "-v", "error", "-show_format", "-show_streams",
                                     "-of", "json", str(path)], 60))
    except (ValueError, TypeError):
        raise RelayError("VIDEO_INVALID") from None

def trim_dav(dav, output, wanted_start, wanted_end):
    info = probe(dav)
    video = next((s for s in info["streams"] if s.get("codec_type") == "video"), None)
    if video is None:
        raise RelayError("VIDEO_INVALID")
    # DAV timestamps encode the DVR calendar as epoch seconds, not an actual UTC instant.
    wanted_epoch = wanted_start.replace(tzinfo=dt.timezone.utc).timestamp()
    origin = float(info["format"]["start_time"])
    offset = wanted_epoch - origin
    duration = (wanted_end - wanted_start).total_seconds()
    available = float(info["format"].get("duration", 0))
    if offset < 0 or available < offset + duration - 0.1:
        raise RelayError("VIDEO_INVALID")
    run_media(["ffmpeg", "-v", "error", "-xerror", "-i", str(dav),
               "-ss", str(offset), "-t", str(duration), "-map", "0:v:0", "-an",
               "-vf", "setpts=PTS-STARTPTS", "-c:v", "libx264", "-preset", "veryfast",
               "-crf", "23", "-movflags", "+faststart", "-n", str(output)])
    measured = float(probe(output)["format"].get("duration", 0))
    if abs(measured - duration) > 0.2 or output.stat().st_size > MAX_BYTES:
        raise RelayError("VIDEO_INVALID")
    return measured

class Native:
    def __init__(self, config, state):
        self.online = set()
        self.lock = threading.Lock()
        self.responses = queue.Queue(maxsize=256)
        self.proc = subprocess.Popen(
            [config["receiver"], config["sdk_so"], config.get("bind", "0.0.0.0"),
             str(config.get("port", 8000)), str(state)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
            env={**os.environ, "LD_LIBRARY_PATH": str(pathlib.Path(config["sdk_so"]).parent)},
            bufsize=0)
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()
        for device in config["devices"]:
            self.send(["config", device["id"], device["username"], device["password"]])
        self.send(["start"])

    def read(self):
        for raw in self.proc.stdout:
            try:
                event = json.loads(raw)
                kind, ident = event["event"], event.get("device_id")
            except (ValueError, KeyError, TypeError):
                continue  # Some vendor builds print their own diagnostics.
            with self.lock:
                if kind == "online":
                    self.online.add(ident)
                elif kind in ("offline", "login_failed"):
                    self.online.discard(ident)
            if kind in ("listening", "online", "offline", "login_failed"):
                print("SDK " + kind + (" id=" + ident if ident else ""), flush=True)
            elif kind in ("download_complete", "download_failed", "fatal"):
                try:
                    self.responses.put_nowait(event)
                except queue.Full:
                    self.proc.terminate()
                    break

    def send(self, fields):
        data = frame(fields)
        try:
            # FileIO can do a short write; finish the entire frame.
            while data:
                sent = self.proc.stdin.write(data)
                if not sent:
                    raise BrokenPipeError
                data = data[sent:]
        except (BrokenPipeError, OSError):
            raise RelayError("NATIVE_EXITED") from None

    def download(self, ident, channel, start, end, output):
        request = uuid.uuid4().hex
        self.send(["download", request, ident, channel, start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds"), str(output)])
        deadline = time.monotonic() + 195
        while time.monotonic() < deadline:
            try:
                event = self.responses.get(timeout=1)
            except queue.Empty:
                if self.proc.poll() is not None:
                    raise RelayError("NATIVE_EXITED")
                continue
            if event.get("event") == "fatal":
                raise RelayError("NATIVE_EXITED")
            if event.get("request_id") != request:
                continue
            if event["event"] == "download_complete":
                return
            raise RelayError(event.get("error") or "DOWNLOAD_INCOMPLETE")
        raise RelayError("NATIVE_EXITED")

    def online_ids(self):
        with self.lock:
            return sorted(self.online)

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.proc.stdin.close()
        self.thread.join(timeout=1)
        self.proc.stdout.close()

def portal_config(config):
    url = urllib.parse.urlsplit(config["cop_url"])
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
        raise RelayError("COP_URL_REQUIRES_HTTPS")
    request = urllib.request.Request(config["cop_url"].rstrip("/")+"/api/sdk/config", data=b"{}",
        headers={"X-Cop-Sdk-Token":config["connector_token"],"Content-Type":"application/json"},method="POST")
    try:
        with urllib.request.build_opener(NoRedirect).open(request,timeout=15) as response:
            return json.loads(response.read(65536))
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None  # Existing connector token and local device configuration remain supported.
        raise

def job_directory(root, name):
    name = name or ""
    if name and (not __import__("re").fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*",name)
                 or any(p in (".","..") for p in name.split("/"))):
        raise RelayError("INVALID_DIRECTORY")
    target = (root / name).resolve()
    if target != root and root not in target.parents:
        raise RelayError("INVALID_DIRECTORY")
    target.mkdir(mode=0o700,parents=True,exist_ok=True)
    return pathlib.Path(tempfile.mkdtemp(prefix="job-",dir=target))

class Relay:
    def __init__(self, config):
        self.config = config
        url = urllib.parse.urlsplit(config["cop_url"])
        if url.scheme != "https" or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise RelayError("COP_URL_REQUIRES_HTTPS")
        if len(config["connector_token"]) < 32:
            raise RelayError("INVALID_CONNECTOR_TOKEN")
        ids = [d["id"] for d in config["devices"]]
        if not ids or len(ids) > 64 or len(set(ids)) != len(ids):
            raise RelayError("INVALID_DEVICE_CONFIG")
        self.state = pathlib.Path(config["state_dir"]).resolve()
        self.state.mkdir(parents=True, exist_ok=True)
        # Interrupted jobs are leased again by the portal. Remove their local fragments.
        for leftover in self.state.rglob("job-*"):
            if leftover.is_dir() and not leftover.is_symlink() and len(leftover.name)==12 and leftover.resolve().is_relative_to(self.state):
                shutil.rmtree(leftover)
        self.stop = threading.Event()
        self.opener = urllib.request.build_opener(NoRedirect)
        self.native = Native(config, self.state)
        self.active = None
        self.active_lock = threading.Lock()
        self.lease_lost = threading.Event()

    def api(self, path, body=None, lease=None, payload=None, duration=None):
        headers = {"X-Cop-Sdk-Token": self.config["connector_token"]}
        if lease:
            headers["X-Cop-Lease-Token"] = lease
        if payload is not None:
            data = payload
            headers.update({"Content-Type": "video/mp4", "X-Video-Duration-Seconds": str(duration)})
        else:
            data = json.dumps(body or {}).encode()
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.config["cop_url"].rstrip("/") + path,
                                          data=data, headers=headers, method="POST")
        with self.opener.open(request, timeout=120 if payload is not None else 15) as response:
            return json.loads(response.read(65536))

    def identity(self):
        return {"connector_name": self.config.get("connector_name", "hostinger"),
                "device_ids": [d["id"] for d in self.config["devices"]]}

    @staticmethod
    def job_path(job, action):
        return "/api/sdk/jobs/{}/{}/{}".format(job["investigation_id"], job["camera_id"], action)

    def heartbeat(self):
        while not self.stop.is_set():
            job = None
            try:
                self.api("/api/sdk/heartbeat", {**self.identity(), "online_ids": self.native.online_ids()})
                with self.active_lock:
                    job = self.active
                if job:
                    self.api(self.job_path(job, "renew"), lease=job["lease_token"])
            except urllib.error.HTTPError as error:
                if error.code == 409:
                    with self.active_lock:
                        if job and self.active is job:
                            self.lease_lost.set()
                print("COP heartbeat HTTP " + str(error.code), flush=True)
            except Exception:
                print("COP heartbeat indisponivel", flush=True)
            self.stop.wait(30)

    def process(self, job):
        self.lease_lost.clear()
        with self.active_lock:
            self.active = job
        directory = None
        try:
            directory = job_directory(self.state,job.get("directory_name"))
            start, end = local_time(job["start"]), local_time(job["end"])
            parts = []
            total = 0
            for index, (begin, finish) in enumerate(segments(start, end)):
                if self.stop.is_set() or self.lease_lost.is_set():
                    raise RelayError("LEASE_LOST")
                dav = directory / ("part-{}.dav".format(index))
                mp4 = directory / ("part-{}.mp4".format(index))
                # Two seconds on both sides supply keyframes and clock rounding margin.
                self.native.download(job["device_id"], job["channel"],
                                     begin - dt.timedelta(seconds=2),
                                     finish + dt.timedelta(seconds=2), dav)
                trim_dav(dav, mp4, begin, finish)
                total += mp4.stat().st_size
                if total > MAX_BYTES:
                    raise RelayError("TOO_LARGE")
                parts.append(mp4)
                dav.unlink()
            listing = directory / "concat.txt"
            listing.write_text("".join("file '{}'\n".format(p.name) for p in parts))
            output = directory / "video.mp4"
            run_media(["ffmpeg", "-v", "error", "-f", "concat", "-safe", "1", "-i", str(listing),
                       "-map", "0:v:0", "-an", "-c:v", "copy", "-movflags", "+faststart", "-n", str(output)])
            duration = float(probe(output)["format"].get("duration", 0))
            expected = (end - start).total_seconds()
            if abs(duration - expected) > 0.5:
                raise RelayError("VIDEO_INVALID")
            if output.stat().st_size > MAX_BYTES:
                raise RelayError("TOO_LARGE")
            if self.lease_lost.is_set():
                raise RelayError("LEASE_LOST")
            # Renew synchronously before upload; retries use the same reservation.
            self.api(self.job_path(job, "renew"), lease=job["lease_token"])
            data = output.read_bytes()
            for attempt in range(3):
                try:
                    self.api(self.job_path(job, "complete"), lease=job["lease_token"],
                             payload=data, duration=duration)
                    break
                except urllib.error.HTTPError as error:
                    if error.code < 500:
                        raise
                    if attempt == 2:
                        raise
                    self.stop.wait(5)
                except (urllib.error.URLError, TimeoutError):
                    if attempt == 2:
                        raise
                    self.stop.wait(5)
            print("COP video pronto investigacao={} canal={} segundos={}".format(
                job["investigation_id"], job["channel"], duration), flush=True)
        except Exception as error:
            code = str(error) if isinstance(error, RelayError) else "RELAY_FAILED"
            print("COP tarefa falhou codigo=" + code, flush=True)
            try:
                self.api(self.job_path(job, "failure"), {"code": code}, lease=job["lease_token"])
            except Exception:
                pass  # Expired reservations are reclaimed by the portal.
            if code == "NATIVE_EXITED":
                raise
        finally:
            with self.active_lock:
                self.active = None
            if directory is not None:
                shutil.rmtree(directory, ignore_errors=True)

    def run(self):
        threading.Thread(target=self.heartbeat, daemon=True).start()
        try:
            next_sync = time.monotonic()+60
            while not self.stop.is_set():
                if self.config.get("portal_managed") and time.monotonic()>=next_sync:
                    next_sync=time.monotonic()+60
                    try:
                        remote=portal_config(self.config)
                        if remote:
                            self.config["connector_name"]=remote["connector_name"]
                        if remote and remote["devices"]!=self.config["devices"]:
                            self.native.close()
                            self.config["devices"]=remote["devices"]
                            self.native=Native(self.config,self.state)
                    except Exception:
                        print("COP sincronizacao indisponivel",flush=True)
                if self.native.proc.poll() is not None:
                    raise RelayError("NATIVE_EXITED")
                try:
                    job = self.api("/api/sdk/claim", {**self.identity(), "device_ids": self.native.online_ids()})["job"]
                    if job:
                        self.process(job)
                        continue
                except RelayError:
                    raise
                except urllib.error.HTTPError as error:
                    print("COP fila HTTP " + str(error.code), flush=True)
                except Exception:
                    print("COP fila indisponivel", flush=True)
                self.stop.wait(5)
        finally:
            self.stop.set()
            self.native.close()

def main():
    os.umask(0o077)
    config = json.loads(pathlib.Path(sys.argv[1]).read_text())
    if config.get("portal_managed"):
        remote=portal_config(config)
        if remote:
            if pathlib.Path(remote["state_dir"]).resolve()!=pathlib.Path(config["state_dir"]).resolve() or remote["port"]!=config["port"]:
                raise RelayError("SERVER_SETTINGS_CHANGED_REINSTALL_REQUIRED")
            config.update({"devices":remote["devices"],"connector_name":remote["connector_name"]})
    relay = Relay(config)
    def shutdown(*_):
        relay.stop.set()
        if relay.native.proc.poll() is None:
            relay.native.proc.terminate()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, shutdown)
    relay.run()

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("SDK relay encerrou: " + (str(error) if isinstance(error, RelayError) else "CONFIG_OR_RUNTIME_ERROR"), flush=True)
        sys.exit(1)
