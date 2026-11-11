"""송도 플라이트 지도 자료 받기 (Overture Maps + AWS Terrain Tiles).

필요: pip install pyarrow numpy pillow shapely scipy
네트워크: overturemaps-us-west-2.s3.amazonaws.com, elevation-tiles-prod.s3.amazonaws.com
사용법: python3 fetch.py <작업 폴더>   →  이어서  python3 build.py <작업 폴더> ../../public/songdo
"""
import sys, os, io, json, math, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import pyarrow as pa, pyarrow.parquet as pq, pyarrow.compute as pc
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
import ov  # noqa: E402

RELEASE = 'release/2026-10-21.0/theme='
BB = (126.34, 37.28, 126.80, 37.60)  # 경도·위도 범위
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
THEMES = {'buildings/type=building': 'buildings', 'buildings/type=building_part': 'parts', 'base/type=land': 'land', 'base/type=water': 'water',
          'base/type=land_use': 'landuse', 'transportation/type=segment': 'segments', 'base/type=infrastructure': 'infra'}


def bbox_mask(t):
    b = t.column('bbox')
    f = lambda k: pc.struct_field(b, k)
    return pc.and_(pc.and_(pc.less_equal(f('xmin'), BB[2]), pc.greater_equal(f('xmax'), BB[0])),
                   pc.and_(pc.less_equal(f('ymin'), BB[3]), pc.greater_equal(f('ymax'), BB[1])))


def scan(ks):
    k, s = ks
    f = pq.ParquetFile(io.BufferedReader(ov.RangeFile(k, s), 1 << 20))
    md = f.metadata
    ix = {md.schema.column(i).path: i for i in range(md.num_columns)}
    hits = []
    for r in range(md.num_row_groups):
        rg = md.row_group(r)
        st = lambda n: rg.column(ix[n]).statistics
        a, b, c, d = st('bbox.xmin'), st('bbox.xmax'), st('bbox.ymin'), st('bbox.ymax')
        if a is not None and a.has_min_max and a.min <= BB[2] and b.max >= BB[0] and c.min <= BB[3] and d.max >= BB[1]:
            hits.append(r)
    return k, s, hits


for theme, name in THEMES.items():
    keys = ov.ls(RELEASE + theme + '/')
    with ThreadPoolExecutor(12) as ex:
        hits = [h for h in ex.map(scan, keys) if h[2]]
    tables, srcs = [], []
    for k, s, rgs in hits:
        f = pq.ParquetFile(io.BufferedReader(ov.RangeFile(k, s), 4 << 20))
        cols = [c for c in f.schema_arrow.names if c != 'sources']
        for r in rgs:
            t = f.read_row_group(r, columns=cols + (['sources'] if name == 'buildings' else []))
            t = t.filter(bbox_mask(t))
            if name == 'buildings':
                srcs.append(pa.table({'id': t.column('id'), 'dataset': [(x[0]['dataset'] if x else '') for x in t.column('sources').to_pylist()]}))
                t = t.drop_columns(['sources'])
            if t.num_rows:
                tables.append(t)
    pq.write_table(pa.concat_tables(tables, promote_options='permissive'), os.path.join(OUT, name + '.parquet'))
    if srcs:
        pq.write_table(pa.concat_tables(srcs), os.path.join(OUT, 'bsources.parquet'))
    print(name, sum(t.num_rows for t in tables))

# 고도 타일 (terrarium z13) → dem.npy
Z = 13
tx = lambda lon: (lon + 180) / 360 * 2**Z
ty = lambda lat: (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * 2**Z
x0, x1, y0, y1 = int(tx(126.30)), int(tx(126.84)), int(ty(37.62)), int(ty(37.26))
assert (x0, y0) == (6970, 3170), '자료 모자이크 기준 타일이 build.py와 달라짐'
M = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), np.float32)


def tile(xy):
    x, y = xy
    d = urllib.request.urlopen(f'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{Z}/{x}/{y}.png', timeout=60).read()
    a = np.asarray(Image.open(io.BytesIO(d)).convert('RGB')).astype(np.float32)
    M[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = a[:, :, 0] * 256 + a[:, :, 1] + a[:, :, 2] / 256 - 32768


with ThreadPoolExecutor(8) as ex:
    list(ex.map(tile, [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]))
np.save(os.path.join(OUT, 'dem.npy'), M)
print('dem', M.shape)
