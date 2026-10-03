"""Historical capture planning. Photos never call recording download APIs."""
import datetime as dt
import math
from zoneinfo import ZoneInfo

class CaptureError(Exception):
    pass

def local(value):
    date=dt.datetime.fromisoformat(str(value).replace('Z','+00:00'))
    if date.tzinfo is None:
        raise CaptureError('INVALID_TIME')
    return date.astimezone(ZoneInfo('America/Sao_Paulo')).replace(tzinfo=None)

def instant(date):
    return date.replace(tzinfo=ZoneInfo('America/Sao_Paulo')).isoformat(timespec='seconds')

def intervals(job,records):
    start,end=local(job['start']),local(job['end'])
    if job['capture_mode']=='continuous':
        return [(start,end,None,None)]
    ordered=[]
    for record in records:
        if record.get('type')!=job['capture_mode']:
            raise CaptureError('EVENT_QUERY_FAILED')
        a,b=dt.datetime.fromisoformat(record['start']),dt.datetime.fromisoformat(record['end'])
        if a.tzinfo or b.tzinfo or b<=a:
            raise CaptureError('EVENT_QUERY_FAILED')
        if (b-a).total_seconds()<job['sampling']['min_motion_seconds']:
            continue
        ordered.append((a,b))
    # Duplicate/overlapping record files are one interval, preserving the DVR start.
    merged=[]
    for a,b in sorted(set(ordered)):
        if merged and a<merged[-1][1]:
            merged[-1]=(merged[-1][0],max(b,merged[-1][1]))
        else:
            merged.append((a,b))
    result=[];previous=None
    for a,b in merged:
        if previous is not None and (a-previous).total_seconds()<job['sampling']['cooldown_seconds']:
            continue
        previous=a
        if b>start and a<end:
            result.append((max(a,start),min(b,end),a,b))
    return result

def samples(job,windows):
    if job['capture_mode']=='continuous':
        origin=local(job['request_start']);step=job['sampling']['frame_interval_seconds']
        for a,b,_,_ in windows:
            n=max(0,math.ceil((a-origin).total_seconds()/step))
            t=origin+dt.timedelta(seconds=n*step)
            while t<b:
                yield t,None,None
                t+=dt.timedelta(seconds=step)
    else:
        for a,b,event_start,event_end in windows:
            for offset in job['sampling']['offsets']:
                t=event_start+dt.timedelta(seconds=offset)
                if a<=t<b:
                    yield t,event_start,event_end

def metadata(job,t,actual,kind,a=None,b=None):
    result={'content_type':kind,'sample_at':instant(t),'recorded_at':instant(actual)}
    if a is not None:
        result.update(event_type=job['capture_mode'],event_start=instant(a),event_end=instant(b))
    return result

def process(job,native,directory,upload,check_lease,video):
    start,end=local(job['start']),local(job['end'])
    records=[]
    if job['capture_mode']!='continuous':
        # Include preceding starts to honor cooldown and event offsets across batches.
        context=start-dt.timedelta(seconds=job['sampling']['cooldown_seconds'])
        records=native.query(job['device_id'],job['channel'],context,end,job['capture_mode'])
    windows=intervals(job,records)
    count=0
    if job['media_type'] in ('photo','all'):
        for index,(target,a,b) in enumerate(samples(job,windows)):
            check_lease()
            if count>=1500:
                raise CaptureError('TOO_LARGE')
            path=directory/('snapshot-{}.jpg'.format(index))
            actual=native.photo(job['device_id'],job['channel'],target,path)
            actual=dt.datetime.fromisoformat(actual)
            if actual.tzinfo or not target<=actual<=target+dt.timedelta(seconds=1):
                raise CaptureError('PHOTO_FAILED')
            meta=metadata(job,target,actual,'image/jpeg',a,b)
            meta['acquisition']='playback_snapshot'
            upload(path,meta)
            path.unlink();count+=1
    if job['media_type'] in ('video','all'):
        for a,b,event_start,event_end in windows:
            begin=a
            while begin<b:
                check_lease()
                finish=min(b,begin+dt.timedelta(seconds=116))
                path=directory/('clip-{}.mp4'.format(count))
                duration=video(begin,finish,path)
                meta=metadata(job,begin,begin,'video/mp4',event_start,event_end)
                meta['duration_seconds']=duration
                upload(path,meta)
                path.unlink();count+=1;begin=finish
    events=sum(1 for _,_,a,_ in windows if a is not None and start<=a<end)
    return {'media_count':count,'events_found':events}
