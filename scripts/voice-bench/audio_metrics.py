"""PCM metrics and the current browser scheduling model. No audio device needed."""
import math
import numpy as np


def summary(values):
    values = [float(v) for v in values if v is not None and math.isfinite(v)]
    return {"n": len(values), "median": float(np.median(values)) if values else None,
            "p95": float(np.percentile(values, 95)) if values else None}


def schedule(chunks, rate, lead=0.020, audible_offset=0.):
    until, first, audible, offset, gaps = None, None, None, 0., []
    for at, size in chunks:
        start = max(at + lead, until or 0)
        if until is not None and start > until + .001:
            gaps.append(start - until)
        first = start if first is None else first
        duration = size / 2 / rate
        if audible is None and offset <= audible_offset < offset+duration:
            audible = start + audible_offset-offset
        offset += duration
        until = start + duration
    return {"firstScheduledS": first, "firstAudibleS": audible, "playEndS": until, "underruns": len(gaps),
            "underrunS": sum(gaps), "gapsS": gaps}


def activity(pcm, rate, threshold=.015):
    x = np.frombuffer(pcm, dtype="<i2").astype(float) / 32768
    hop = max(1, round(rate * .01))
    active = [i for i in range(0, len(x), hop)
              if np.sqrt(np.mean(x[i:i+hop] ** 2)) >= threshold]
    if not active:
        return []
    spans, start, end = [], active[0], active[0] + hop
    for i in active[1:]:
        if i - end > rate * .15:
            spans.append([start / rate, min(end, len(x)) / rate])
            start = i
        end = i + hop
    return spans + [[start / rate, min(end, len(x)) / rate]]


def onset(pcm, rate):
    x = np.frombuffer(pcm, dtype="<i2").astype(float) / 32768
    hop = max(1, round(rate * .01))
    frames = [x[i:i+hop] for i in range(0, len(x)-hop+1, hop)]
    db = np.array([20*np.log10(np.sqrt(np.mean(f*f)) + 1e-9) for f in frames])
    voiced = np.flatnonzero(db > -40)
    if not len(voiced):
        return {"silent": True, "onsetArtifactScore": None}
    first = int(voiced[0])
    a = first * hop
    width = round(rate * .15)

    def centroid(seg):
        spec = abs(np.fft.rfft(seg * np.hanning(len(seg))))
        return float(np.dot(spec, np.fft.rfftfreq(len(seg), 1/rate)) / (sum(spec)+1e-9))

    head = x[a:a+width]
    body = [x[i:i+width] for i in range(a+2*width, len(x)-width, width)
            if np.sqrt(np.mean(x[i:i+width]**2)) > .01]
    hc = centroid(head)
    bc = float(np.median([centroid(f) for f in body])) if body else hc
    level = float(np.mean(db[first:first+15]) - np.median(db[voiced]))
    # A low-energy, low-bandwidth onset matches the reported muffled entrance.
    # This screening index is NOT a perceptual quality or intelligibility score.
    deficit = max(0., -level - 6.) / 12
    bandwidth = max(0., math.log2(max(bc, 1)/max(hc, 1)) - .5)
    click = float(np.max(np.abs(np.diff(head)))) if len(head)>1 else 0.
    clipping = float(np.mean(np.abs(head) >= .999))
    score = min(100., 25*deficit + 25*bandwidth + 25*max(0., click-.2)/.8 + 25*min(1., clipping/.01))
    return {"leadingSilenceMs": first*10, "onsetLevelVsSteadyDb": level,
            "trailingSilenceMs": max(0.,len(x)/rate-(int(voiced[-1])+1)*.01)*1000,
            "onsetCentroidHz": hc, "steadyCentroidHz": bc,
            "onsetMaxSampleJump": click, "onsetClippingFraction": clipping,
            "onsetArtifactScore": score, "clippedSamples": int(sum(abs(x)>=.999))}
