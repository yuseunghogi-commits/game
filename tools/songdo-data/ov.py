import io, urllib.request, re, sys
BASE='https://overturemaps-us-west-2.s3.amazonaws.com/'
def get(url, rng=None):
    r=urllib.request.Request(url)
    if rng: r.add_header('Range', 'bytes=%d-%d'%rng)
    for i in range(4):
        try:
            with urllib.request.urlopen(r, timeout=120) as f: return f.read()
        except Exception as e:
            err=e
    raise err
def ls(prefix):
    keys=[]; tok=None
    while True:
        u=BASE+'?list-type=2&prefix='+prefix+('&continuation-token='+urllib.parse.quote(tok) if tok else '')
        x=get(u).decode()
        keys+= [(k,int(s)) for k,s in re.findall(r'<Key>([^<]*)</Key>.*?<Size>(\d+)</Size>', x)]
        m=re.search(r'<NextContinuationToken>([^<]*)</NextContinuationToken>', x)
        if not m: return keys
        tok=m.group(1)
class RangeFile(io.RawIOBase):
    def __init__(s,key,size): s.url=BASE+key; s.size=size; s.pos=0
    def readable(s): return True
    def seekable(s): return True
    def tell(s): return s.pos
    def seek(s,o,w=0):
        s.pos = o if w==0 else s.pos+o if w==1 else s.size+o
        return s.pos
    def readinto(s,b):
        n=min(len(b), s.size-s.pos)
        if n<=0: return 0
        d=get(s.url,(s.pos,s.pos+n-1)); b[:len(d)]=d; s.pos+=len(d); return len(d)
import urllib.parse
