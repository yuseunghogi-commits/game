"""송도 플라이트 지도 자료 만들기.

입력 (fetch.py로 받은 파일, 작업 폴더 기준):
  buildings.parquet, land.parquet, water.parquet, landuse.parquet, segments.parquet, infra.parquet  (Overture Maps)
  dem.npy  (AWS Terrain Tiles, terrarium z13 모자이크, fetch.py가 만듦)
출력: public/songdo/ 아래
  meta.json, terrain.bin.gz, water.bin.gz, buildings.bin.gz, roads.bin.gz, trees.bin.gz, areas.bin.gz, ground.jpg

좌표: 월드 x = 동쪽(m), z = 남쪽(m), 기준 북위 37.39°, 동경 126.65° (국소 등장방형 투영).
사용법: python3 build.py <작업 폴더> <저장소 public/songdo 경로>
"""
import sys, os, json, math, gzip, struct, hashlib
import numpy as np
import pyarrow.parquet as pq
import shapely
from shapely import wkb
from shapely.geometry import Polygon, MultiPolygon, LineString, Point
from scipy import ndimage
from PIL import Image, ImageDraw

SRC = sys.argv[1]
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)

LAT0, LON0 = 37.39, 126.65
R = 6371008.8
MPD_LAT = math.pi / 180 * R
MPD_LON = MPD_LAT * math.cos(math.radians(LAT0))
X0, X1, Z0, Z1 = -27000.0, 13000.0, -23000.0, 12000.0
CELL = 40.0          # 지형 격자
WCELL = 10.0         # 물 마스크·래스터
NX = int((X1 - X0) / CELL) + 1
NZ = int((Z1 - Z0) / CELL) + 1
WX = int((X1 - X0) / WCELL)
WZ = int((Z1 - Z0) / WCELL)


def proj(lon, lat):
    return (np.asarray(lon) - LON0) * MPD_LON, -(np.asarray(lat) - LAT0) * MPD_LAT


def proj_geom(g):
    return shapely.transform(g, lambda c: np.column_stack(proj(c[:, 0], c[:, 1])))


def read(name, cols=None):
    return pq.read_table(os.path.join(SRC, name + '.parquet'), columns=cols).to_pandas()


def pname(n):
    return n['primary'] if n is not None and n.get('primary') else ''


def tags(st):
    return dict(st) if st is not None else {}


def u01(s):
    return int(hashlib.md5(s.encode()).hexdigest()[:8], 16) / 2**32


# 래스터 좌표 (10m)
def to_px(x, z, cell=WCELL):
    return (x - X0) / cell, (z - Z0) / cell


def draw_poly(draw, geom, fill, cell=WCELL, outline=None, width=0):
    if geom.is_empty:
        return
    if isinstance(geom, (MultiPolygon, shapely.GeometryCollection)):
        for g in geom.geoms:
            draw_poly(draw, g, fill, cell, outline, width)
        return
    if not isinstance(geom, Polygon):
        return
    ext = [to_px(x, z, cell) for x, z in geom.exterior.coords]
    if len(ext) >= 3:
        draw.polygon(ext, fill=fill, outline=outline)
    for r in geom.interiors:
        pts = [to_px(x, z, cell) for x, z in r.coords]
        if len(pts) >= 3:
            draw.polygon(pts, fill=0 if isinstance(fill, int) else None)


print('1/8 물·땅 마스크')
water_df = read('water')
ocean = [proj_geom(wkb.loads(g)) for g, c in zip(water_df.geometry, water_df['class']) if c == 'ocean']
sea_img = Image.new('L', (WX, WZ), 0)
d = ImageDraw.Draw(sea_img)
for g in ocean:
    draw_poly(d, g, 255)
# 섬 (land 계층의 island/islet/land) 은 바다 위에 다시 땅으로
land_df = read('land')
for g, c in zip(land_df.geometry, land_df['class']):
    if c in ('island', 'islet'):
        gg = proj_geom(wkb.loads(g))
        if gg.geom_type in ('Polygon', 'MultiPolygon'):
            draw_poly(d, gg, 0)
sea = np.asarray(sea_img) > 127
inland_img = Image.new('L', (WX, WZ), 0)
d = ImageDraw.Draw(inland_img)
water_polys = []
for g, c, st in zip(water_df.geometry, water_df['class'], water_df.subtype):
    if c == 'ocean' or c in ('swimming_pool',):
        continue
    gg = proj_geom(wkb.loads(g))
    if gg.geom_type in ('Polygon', 'MultiPolygon') and gg.area > 300:
        draw_poly(d, gg, 255)
        water_polys.append((gg, c))
inland = (np.asarray(inland_img) > 127) & ~sea
dist_sea = ndimage.distance_transform_edt(~sea) * WCELL   # 땅에서 바다까지
dist_land = ndimage.distance_transform_edt(sea) * WCELL   # 바다에서 땅까지

print('2/8 지형 높이')
dem = np.load(os.path.join(SRC, 'dem.npy'))
DZ = 13; DX0, DY0 = 6970, 3170


def dem_at(x, z):
    lon = LON0 + x / MPD_LON
    lat = LAT0 - z / MPD_LAT
    px = ((lon + 180) / 360 * 2**DZ - DX0) * 256
    r = np.radians(lat)
    py = ((1 - np.log(np.tan(r) + 1 / np.cos(r)) / np.pi) / 2 * 2**DZ - DY0) * 256
    return ndimage.map_coordinates(dem, [py - 0.5, px - 0.5], order=1, mode='nearest')


gx = X0 + np.arange(NX) * CELL
gz = Z0 + np.arange(NZ) * CELL
GX, GZ = np.meshgrid(gx, gz)
H = dem_at(GX.ravel(), GZ.ravel()).reshape(NZ, NX).astype(np.float32)
H = ndimage.gaussian_filter(H, 0.8)
# 격자점의 바다까지 거리 (부호: 땅 +, 바다 −)
wi = np.clip(((GZ - Z0) / WCELL).astype(int), 0, WZ - 1)
wj = np.clip(((GX - X0) / WCELL).astype(int), 0, WX - 1)
sdist = np.where(sea[wi, wj], -dist_land[wi, wj], dist_sea[wi, wj])
sdist = ndimage.gaussian_filter(sdist, 0.6)
land_h = np.maximum(H, 4.0)
land_h = np.where(sdist < 40, np.minimum(land_h, 1.5 + sdist / 40 * 3.0), land_h)
sea_h = -2.0 - np.minimum(-sdist, 1500) / 1500 * 10
height = np.where(sdist >= 0, land_h, sea_h)

# 공항 활주로·계류장 평탄화
infra = read('infra')
runways = []
for g, c, st, n in zip(infra.geometry, infra['class'], infra.source_tags, infra.names):
    if c != 'runway':
        continue
    t = tags(st)
    ref = t.get('ref', '')
    if not ref or '/' not in ref:
        continue
    G = proj_geom(wkb.loads(g))
    if G.length < 2000 or G.coords[0][0] > -5000:
        continue  # 인천공항만 (김포 제외)
    a, b = G.coords[0], G.coords[-1]
    runways.append({'ref': ref, 'name': pname(n), 'a': [round(a[0], 1), round(a[1], 1)], 'b': [round(b[0], 1), round(b[1], 1)], 'width': float(t.get('width', 60)), 'line': G})
ap_flat = Image.new('L', (NX, NZ), 0)
d = ImageDraw.Draw(ap_flat)
for r in runways:
    draw_poly(d, r['line'].buffer(220, cap_style='flat'), 255, CELL)
for g, c in zip(infra.geometry, infra['class']):
    if c in ('apron', 'taxiway', 'taxilane'):
        gg = proj_geom(wkb.loads(g))
        if gg.length > 0 and gg.bounds[0] < -5000:
            draw_poly(d, gg.buffer(60), 255, CELL)
apm = ndimage.gaussian_filter(np.asarray(ap_flat).astype(np.float32) / 255, 3)
AIRPORT_H = 7.0
height = np.where(sdist > 0, height * (1 - apm) + AIRPORT_H * apm, height)
height = height.astype(np.float32)

# 호수·강 수면 높이 정하고 넓은 물은 지형을 파낸다
sea_union = shapely.union_all([g.buffer(0) for g in ocean]) if ocean else None
water_levels = []
carve = Image.new('F', (NX, NZ), 1e4)
dc = ImageDraw.Draw(carve)
for gg, c in water_polys:
    for P in (gg.geoms if gg.geom_type == 'MultiPolygon' else [gg]):
        if P.is_empty or P.area < 300:
            continue
        xs = np.array([p[0] for p in P.exterior.coords]); zs = np.array([p[1] for p in P.exterior.coords])
        fx = np.clip((xs - X0) / CELL, 0, NX - 1.001); fz = np.clip((zs - Z0) / CELL, 0, NZ - 1.001)
        bank = ndimage.map_coordinates(height, [fz, fx], order=1)
        touches_sea = sea_union is not None and P.buffer(40).intersects(sea_union)
        lvl = 0.3 if touches_sea else float(np.percentile(bank, 10)) + 0.15
        water_levels.append((P, lvl))
        inner = P.buffer(-25)
        if not inner.is_empty:
            draw_poly(dc, inner, lvl - 1.8, CELL)
cv = np.asarray(carve)
height = np.minimum(height, cv).astype(np.float32)


def h_at(x, z):
    fx = np.clip((np.asarray(x) - X0) / CELL, 0, NX - 1.001)
    fz = np.clip((np.asarray(z) - Z0) / CELL, 0, NZ - 1.001)
    return ndimage.map_coordinates(height, [fz, fx], order=1, mode='nearest')


def is_water(x, z):
    i = int((z - Z0) / WCELL); j = int((x - X0) / WCELL)
    if i < 0 or j < 0 or i >= WZ or j >= WX:
        return 2
    return 2 if sea[i, j] else 1 if inland[i, j] else 0


with gzip.open(os.path.join(OUT, 'terrain.bin.gz'), 'wb', 9) as f:
    f.write(np.round(height * 10).clip(-32000, 32000).astype('<i2').tobytes())
wmask = np.where(sea, 2, np.where(inland, 1, 0)).astype(np.uint8)
with gzip.open(os.path.join(OUT, 'water.bin.gz'), 'wb', 9) as f:
    f.write(wmask.tobytes())
print('  terrain', NX, NZ, float(height.min()), float(height.max()))

print('3/8 건물')
B = read('buildings', ['id', 'names', 'height', 'min_height', 'num_floors', 'class', 'facade_color', 'roof_shape', 'is_underground', 'geometry'])
# 건물 부분(building:part)이 있으면 본 건물 대신 부분들로 (층별 높이·모양이 정확함)
if os.path.exists(os.path.join(SRC, 'parts.parquet')):
    import pandas as pd
    PT = read('parts', ['id', 'names', 'height', 'min_height', 'num_floors', 'facade_color', 'roof_shape', 'is_underground', 'geometry', 'building_id'])
    parent = B.set_index('id')
    PT = PT[PT.building_id.isin(parent.index)].copy()
    PT['class'] = [parent.at[b, 'class'] for b in PT.building_id]
    PT['names'] = [n if n is not None else parent.at[b, 'names'] for n, b in zip(PT.names, PT.building_id)]
    # 높이 없는 부분은 본 건물 높이
    PT['height'] = [h if h == h and h is not None else parent.at[b, 'height'] for h, b in zip(PT.height, PT.building_id)]
    B = pd.concat([B[~B.id.isin(set(PT.building_id))], PT.drop(columns=['building_id'])], ignore_index=True)
    print('  building parts', len(PT))
NEW_TOWNS = [Polygon([proj(126.595, 37.425), proj(126.705, 37.385), proj(126.69, 37.335), proj(126.585, 37.36)]),  # 송도
             Polygon([proj(126.53, 37.51), proj(126.60, 37.51), proj(126.60, 37.47), proj(126.53, 37.47)]),  # 영종하늘도시
             Polygon([proj(126.62, 37.555), proj(126.69, 37.555), proj(126.69, 37.515), proj(126.62, 37.515)])]  # 청라

NAMED_COLORS = {'white': (240, 240, 236), 'grey': (150, 150, 150), 'gray': (150, 150, 150), 'black': (40, 40, 40), 'red': (170, 70, 60),
                'brown': (130, 90, 60), 'beige': (220, 205, 175), 'yellow': (225, 200, 110), 'blue': (90, 120, 170), 'green': (100, 140, 100),
                'orange': (210, 130, 70), 'silver': (190, 195, 200), 'tan': (200, 180, 140), 'cream': (240, 230, 205)}


def parse_color(s):
    if not isinstance(s, str) or not s:
        return None
    s = s.strip().lower()
    if s.startswith('#') and len(s) in (4, 7):
        if len(s) == 4:
            s = '#' + ''.join(ch * 2 for ch in s[1:])
        try:
            return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))
        except ValueError:
            return None
    return NAMED_COLORS.get(s)


def rgb565(c):
    r, g, b = c
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)


APT = [(242, 239, 232), (236, 230, 218), (232, 236, 239), (244, 241, 234), (220, 216, 207), (233, 226, 211), (217, 225, 230)]
LOWC = [(216, 207, 192), (191, 182, 168), (201, 184, 160), (169, 164, 156), (210, 196, 176), (179, 155, 132), (224, 220, 210), (186, 120, 96)]
GLASS = [(94, 136, 168), (79, 117, 144), (107, 155, 181), (123, 143, 156), (63, 111, 138), (143, 176, 196), (85, 112, 127)]
IND = [(224, 228, 230), (205, 213, 220), (190, 200, 208), (170, 188, 205)]

# 출처: OSM이 아닌 위성영상 추정 외곽선은 공항 이동 구역(활주로·유도로·계류장) 위에서 버린다 (주기 항공기 등 오탐)
src_ds = {}
if os.path.exists(os.path.join(SRC, 'bsources.parquet')):
    st_ = pq.read_table(os.path.join(SRC, 'bsources.parquet')).to_pandas()
    src_ds = dict(zip(st_.id, st_.dataset))
air_zone = []
for g, c in zip(infra.geometry, infra['class']):
    if c in ('runway', 'taxiway', 'taxilane', 'apron'):
        gg = proj_geom(wkb.loads(g))
        if gg.bounds[0] < -5000:
            air_zone.append(gg.buffer(150 if c == 'runway' else 45 if c != 'apron' else 10))
air_zone = shapely.union_all(air_zone) if air_zone else None
if air_zone is not None:
    shapely.prepare(air_zone)
dropped = 0
bld = []  # (cx, cz, h, minh, style, flags, color, ring)
named_bld = {}
for idx, (bid, nm, hgt, minh, nfl, cls, fc, rs, und, g) in enumerate(zip(B.id, B.names, B.height, B.min_height, B.num_floors, B['class'], B.facade_color, B.roof_shape, B.is_underground, B.geometry)):
    if und is True:
        continue
    G = proj_geom(wkb.loads(g))
    polys = list(G.geoms) if G.geom_type == 'MultiPolygon' else [G] if G.geom_type == 'Polygon' else []
    name = pname(nm)
    cls = cls if isinstance(cls, str) else ''
    u = u01(bid)
    if src_ds.get(bid, 'OpenStreetMap') != 'OpenStreetMap' and air_zone is not None and polys and air_zone.intersects(G):
        dropped += 1
        continue
    for P in polys:
        P = P.simplify(0.4, preserve_topology=True)
        if P.is_empty or P.area < 12 or P.geom_type != 'Polygon':
            continue
        area = P.area
        c = P.centroid
        in_new = any(t.contains(c) for t in NEW_TOWNS)
        real = False
        if hgt == hgt and hgt is not None and hgt > 1:
            h = float(hgt); real = True
        elif nfl == nfl and nfl is not None and nfl > 0:
            h = float(nfl) * (2.9 if cls == 'apartments' else 3.6) + 1.5; real = True
        else:
            if cls == 'apartments' or (in_new and cls == '' and 280 < area < 1600 and P.minimum_rotated_rectangle.length > 0):
                if area >= 250:
                    fl = (28 + u * 21) if in_new else (12 + u * 12)
                else:
                    fl = 4 + u * 2
                h = fl * 2.9 + 2
            elif cls in ('house', 'detached', 'residential', 'semidetached_house', 'terrace', 'hut', 'cabin', 'farm'):
                h = (1 + int(u * 2)) * 3.1 + (1.5 if cls == 'house' else 3) if area < 400 else (3 + u * 3) * 3
            elif cls in ('commercial', 'retail', 'office', 'hotel', 'supermarket', 'civic', 'government'):
                h = ((5 + u * 8) if area > 1500 else (3 + u * 4)) * 3.8
            elif cls in ('industrial', 'warehouse', 'manufacture', 'hangar', 'storage_tank', 'service', 'transportation'):
                h = 9 + u * 9
            elif cls in ('school', 'university', 'college', 'kindergarten', 'hospital', 'public'):
                h = (3 + u * 3) * 3.8
            elif cls == 'greenhouse':
                h = 4
            elif cls in ('roof', 'carport'):
                h = 6
            elif cls in ('church', 'temple', 'religious', 'chapel', 'shrine'):
                h = 9 + u * 6
            elif cls in ('garage', 'garages', 'shed', 'toilets', 'kiosk'):
                h = 3.2
            else:
                h = (2 + u * 2) * 3.3 if area < 150 else (3 + u * 3) * 3.6 if area < 900 else (2 + u * 3) * 4.5
        mh = float(minh) if (minh == minh and minh is not None) else (4.0 if cls in ('roof', 'carport') else 0.0)
        if mh >= h:
            mh = 0.0
        # 스타일
        tall = h > 55
        if cls == 'apartments' or (h > 40 and cls in ('', 'residential') and in_new):
            style, col = 0, APT[int(u * len(APT))]
        elif cls in ('industrial', 'warehouse', 'manufacture', 'hangar', 'storage_tank'):
            style, col = 3, IND[int(u * len(IND))]
        elif tall:
            style, col = (5 if u < 0.5 else 1), GLASS[int(u * len(GLASS))]
        elif cls in ('roof', 'carport', 'greenhouse', 'garage', 'garages', 'shed', 'storage_tank'):
            style, col = 4, (200, 200, 196) if cls != 'greenhouse' else (225, 232, 228)
        elif cls in ('house', 'detached', 'semidetached_house', 'hut', 'farm', 'temple', 'religious', 'shrine'):
            style, col = 6, LOWC[int(u * len(LOWC))]
        else:
            style, col = 2, LOWC[int(u * len(LOWC))]
        fcol = parse_color(fc)
        if fcol:
            col = fcol
        flags = (1 if real else 0) | (2 if (style == 6 and area < 600 and h < 12) or rs in ('gabled', 'hipped', 'pyramidal') else 0)
        ring = list(P.exterior.coords)[:-1]
        if not P.exterior.is_ccw:
            ring = ring[::-1]
        bld.append((c.x, c.y, h, mh, style, flags, rgb565(col), [(x - c.x, z - c.y) for x, z in ring]))
        if name and (h > 60 or area > 3000 or name in ('트라이볼',)):
            named_bld.setdefault(name, (c.x, c.y, h))

# 이름 있는 건물 높이 보정 (OSM 높이가 없을 때)
FIX_H = {'인천국제공항 제1여객터미널': 33, '인천국제공항 제2여객터미널': 36}
n = len(bld)
nv = sum(len(b[7]) for b in bld)
buf = bytearray()
buf += b'SDB2' + struct.pack('<II', n, nv)
buf += np.array([[round(b[0] * 10), round(b[1] * 10)] for b in bld], '<i4').tobytes()
buf += np.array([min(65535, round(b[2] * 10)) for b in bld], '<u2').tobytes()
buf += np.array([min(65535, round(b[3] * 10)) for b in bld], '<u2').tobytes()
buf += np.array([len(b[7]) for b in bld], '<u2').tobytes()
buf += np.array([b[6] for b in bld], '<u2').tobytes()
vv = np.array([p for b in bld for p in b[7]], np.float64)
buf += np.round(vv * 4).clip(-32767, 32767).astype('<i2').tobytes()
buf += np.array([b[4] for b in bld], 'u1').tobytes()
buf += np.array([b[5] for b in bld], 'u1').tobytes()
with gzip.open(os.path.join(OUT, 'buildings.bin.gz'), 'wb', 9) as f:
    f.write(bytes(buf))
print('  buildings', n, 'verts', nv, 'real-height', sum(1 for b in bld if b[5] & 1), 'dropped(airport ML)', dropped)

print('4/8 도로·철도')
S = read('segments', ['id', 'names', 'subtype', 'class', 'road_flags', 'level_rules', 'geometry'])
ROAD = {'motorway': (1, 11), 'trunk': (2, 14), 'primary': (3, 15), 'secondary': (4, 12), 'tertiary': (5, 10), 'residential': (6, 7),
        'living_street': (6, 6), 'unclassified': (6, 7), 'service': (7, 5), 'pedestrian': (8, 6), 'footway': (9, 2.5), 'cycleway': (9, 2.5),
        'path': (9, 2), 'steps': (9, 2.5), 'track': (7, 3.5)}
RAIL = {'standard_gauge': (10, 4.5), 'light_rail': (10, 4), 'monorail': (11, 2.5), 'narrow_gauge': (10, 3.5)}
CORE = Polygon([proj(126.58, 37.43), proj(126.72, 37.43), proj(126.72, 37.33), proj(126.58, 37.33)]).union(
    Polygon([proj(126.36, 37.51), proj(126.48, 37.51), proj(126.48, 37.42), proj(126.36, 37.42)]))
CS = None  # 인천대교 사장교 구간 중심
for g, c, st in zip(infra.geometry, infra['class'], infra.source_tags):
    t = tags(st)
    if c == 'bridge' and t.get('bridge:structure') == 'cable-stayed':
        G = proj_geom(wkb.loads(g))
        if G.geom_type == 'LineString' and G.length > 1000 and -14000 < G.centroid.x < -5000:
            CS = G
CS_MID = CS.interpolate(0.5, normalized=True) if CS is not None else None
CS_LEN = CS.length if CS is not None else 0


def ranges(rules, key):
    out = []
    if rules is None:
        return out
    for r in rules:
        vals = r.get('values') if isinstance(r, dict) else None
        if vals is not None and key in list(vals):
            bt = r.get('between')
            out.append((0.0, 1.0) if bt is None else (float(bt[0]), float(bt[1])))
    return out


def level_of(rules):
    if rules is None:
        return 0
    for r in rules:
        if isinstance(r, dict) and r.get('value'):
            return int(r['value'])
    return 0


roads = []  # (cls, width, flags, pts[(x,z,y)])
incheon_bridge_pts = []
for nm, sub, cls, rf, lr, g in zip(S.names, S.subtype, S['class'], S.road_flags, S.level_rules, S.geometry):
    spec = ROAD.get(cls) if sub == 'road' else RAIL.get(cls) if sub == 'rail' else None
    if spec is None:
        continue
    code, width = spec
    G = proj_geom(wkb.loads(g))
    if G.geom_type != 'LineString' or G.length < 1:
        continue
    if code == 9 and not CORE.intersects(G):
        continue
    name = pname(nm)
    br = ranges(rf, 'is_bridge')
    tn = ranges(rf, 'is_tunnel')
    lvl = level_of(lr)
    L = G.length
    # 점 촘촘히 (다리는 25m, 나머지 120m)
    step = 25 if br else 120
    ds = sorted(set([0.0, L] + [G.project(Point(p)) for p in G.coords] + list(np.arange(step, L, step))))
    pts = []
    for s in ds:
        f = s / L
        if any(a - 1e-6 <= f <= b + 1e-6 for a, b in tn):
            if len(pts) >= 2:
                roads.append([code, width, 0, pts])
            pts = []
            continue
        p = G.interpolate(s)
        on_br = any(a - 1e-6 <= f <= b + 1e-6 for a, b in br)
        pts.append([p.x, p.y, on_br])
    if len(pts) < 2:
        continue
    # 높이: 지면 또는 다리 상판
    xs = np.array([p[0] for p in pts]); zs = np.array([p[1] for p in pts])
    gh = h_at(xs, zs)
    ys = gh.copy() + 0.25
    flags = 0
    idx = [i for i, p in enumerate(pts) if p[2]]
    is_ib = '인천대교' in name or (code == 1 and any(dist_land[min(WZ - 1, int((z - Z0) / WCELL)), min(WX - 1, int((x - X0) / WCELL))] > 2000 for x, z in zip(xs, zs)))
    if idx:
        flags |= 1
        # 연속 다리 구간마다
        runs = []
        for i in idx:
            if runs and i == runs[-1][-1] + 1:
                runs[-1].append(i)
            else:
                runs.append([i])
        for run in runs:
            a = max(0, run[0] - 1); b = min(len(pts) - 1, run[-1] + 1)
            ya, yb = gh[a], gh[b]
            seg_len = math.hypot(xs[b] - xs[a], zs[b] - zs[a]) + 1e-6
            for i in run:
                t = math.hypot(xs[i] - xs[a], zs[i] - zs[a]) / seg_len
                y = ya + (yb - ya) * t + max(0, lvl) * 6.5
                wi_ = min(WZ - 1, max(0, int((zs[i] - Z0) / WCELL))); wj_ = min(WX - 1, max(0, int((xs[i] - X0) / WCELL)))
                over = sea[wi_, wj_] or inland[wi_, wj_]
                if over:
                    y = max(y, 9.0 if not sea[wi_, wj_] else 12.0)
                if is_ib:
                    dl = dist_land[wi_, wj_]
                    y = max(y, min(40.0, 8 + dl * 0.03))
                    if CS_MID is not None:
                        dm = Point(xs[i], zs[i]).distance(CS_MID)
                        if dm < CS_LEN * 0.9:
                            k = 1 - dm / (CS_LEN * 0.9)
                            y = max(y, 40 + (74 - 40) * (k * k * (3 - 2 * k)))
                    flags |= 4
                ys[i] = y
        # 다리 끝 매끄럽게 (경사 제한)
        for _ in range(2):
            for i in range(1, len(ys)):
                dd = math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]) + 1e-6
                ys[i] = max(ys[i], ys[i - 1] - dd * 0.06) if pts[i][2] else ys[i]
            for i in range(len(ys) - 2, -1, -1):
                dd = math.hypot(xs[i] - xs[i + 1], zs[i] - zs[i + 1]) + 1e-6
                ys[i] = max(ys[i], ys[i + 1] - dd * 0.06) if pts[i][2] else ys[i]
        if flags & 4:
            incheon_bridge_pts.append(list(zip(xs.tolist(), zs.tolist(), ys.tolist())))
    roads.append([code, width, flags, list(zip(xs.tolist(), zs.tolist(), ys.tolist()))])

# 유도로 (공항)
for g, c in zip(infra.geometry, infra['class']):
    if c in ('taxiway', 'taxilane'):
        G = proj_geom(wkb.loads(g))
        if G.geom_type == 'LineString' and G.bounds[0] < -5000 and G.length > 5:
            xs, zs = zip(*G.coords)
            gh = h_at(np.array(xs), np.array(zs))
            roads.append([12 if c == 'taxiway' else 13, 23 if c == 'taxiway' else 12, 0, list(zip(xs, zs, (gh + 0.12).tolist()))])

buf = bytearray(b'SDR1')
allpts = [p for r in roads for p in r[3]]
buf += struct.pack('<II', len(roads), len(allpts))
buf += np.array([len(r[3]) for r in roads], '<u4').tobytes()
buf += np.array([[round(p[0] * 10), round(p[1] * 10)] for p in allpts], '<i4').tobytes()
buf += np.array([round(p[2] * 10) for p in allpts], '<i2').tobytes()
buf += np.array([r[0] for r in roads], 'u1').tobytes()
buf += np.array([min(255, round(r[1] * 4)) for r in roads], 'u1').tobytes()
buf += np.array([r[2] for r in roads], 'u1').tobytes()
with gzip.open(os.path.join(OUT, 'roads.bin.gz'), 'wb', 9) as f:
    f.write(bytes(buf))
print('  roads', len(roads), 'pts', len(allpts))

print('5/8 땅 쓰임새 그림 (ground.jpg)')
TW, TH = 4096, 3584
SC = (X1 - X0) / TW  # m/px
img = Image.new('RGB', (TW, TH), (146, 158, 112))
dr = ImageDraw.Draw(img)
# 고도에 따른 바탕 (낮은 곳 연두, 산 짙은 녹색)
hh = ndimage.zoom(height, (TH / NZ, TW / NX), order=1)
base = np.zeros((TH, TW, 3), np.float32)
lo = np.array([150, 160, 118], np.float32); hi = np.array([82, 108, 66], np.float32)
t = np.clip((hh - 25) / 80, 0, 1)[..., None]
base = lo * (1 - t) + hi * t
noise = ndimage.gaussian_filter(np.random.RandomState(1).rand(TH, TW).astype(np.float32), 1.2)
base *= (0.92 + 0.16 * noise)[..., None]
img = Image.fromarray(base.clip(0, 255).astype(np.uint8))
dr = ImageDraw.Draw(img)
LU = {'residential': (184, 180, 170), 'commercial': (189, 182, 173), 'retail': (189, 182, 173), 'industrial': (170, 168, 163), 'works': (170, 168, 163),
      'construction': (181, 166, 138), 'farmland': (163, 172, 116), 'meadow': (145, 172, 104), 'grass': (128, 165, 96), 'park': (116, 160, 88),
      'pitch': (104, 160, 84), 'playground': (170, 160, 130), 'golf_course': (122, 168, 86), 'fairway': (136, 186, 92), 'rough': (110, 150, 80),
      'bunker': (221, 211, 168), 'green': (140, 196, 96), 'cemetery': (136, 158, 104), 'school': (196, 184, 166), 'university': (180, 178, 160),
      'college': (180, 178, 160), 'kindergarten': (196, 184, 166), 'military': (150, 158, 124), 'railway': (163, 158, 148), 'pedestrian': (207, 201, 190),
      'garden': (120, 160, 90), 'flowerbed': (150, 150, 90), 'hospital': (196, 186, 176), 'religious': (190, 180, 165), 'recreation_ground': (130, 166, 96),
      'village_green': (130, 166, 96), 'orchard': (140, 160, 96), 'vineyard': (140, 160, 96), 'brownfield': (176, 162, 132), 'landfill': (160, 150, 128),
      'quarry': (175, 168, 155), 'plant_nursery': (130, 160, 96), 'allotments': (150, 166, 108), 'aerodrome': (150, 170, 112), 'airfield': (150, 170, 112),
      'theme_park': (180, 172, 150), 'zoo': (140, 160, 100), 'stadium': (170, 168, 160), 'parking': (160, 160, 158)}
LAND = {'forest': (74, 104, 60), 'wood': (78, 108, 62), 'scrub': (110, 132, 80), 'heath': (120, 136, 88), 'wetland': (122, 136, 106),
        'grassland': (138, 166, 100), 'grass': (128, 165, 96), 'beach': (217, 207, 168), 'sand': (217, 207, 168), 'bare_rock': (154, 149, 140), 'shingle': (170, 165, 150)}


def pix(geom):
    return [((x - X0) / SC, (z - Z0) / SC) for x, z in geom]


def fillg(geom, col):
    if geom.geom_type == 'MultiPolygon' or geom.geom_type == 'GeometryCollection':
        for g in geom.geoms:
            fillg(g, col)
        return
    if geom.geom_type != 'Polygon':
        return
    dr.polygon(pix(geom.exterior.coords), fill=col)


LUd = read('landuse')
order = sorted(zip(LUd.geometry, LUd['class']), key=lambda r: -wkb.loads(r[0]).area)
for g, c in [(g, c) for g, c in zip(land_df.geometry, land_df['class'])] + order:
    col = LU.get(c) or LAND.get(c)
    if not col:
        continue
    G = proj_geom(wkb.loads(g))
    if G.geom_type in ('Polygon', 'MultiPolygon'):
        fillg(G, col)
for g, c in zip(infra.geometry, infra['class']):
    if c == 'apron':
        fillg(proj_geom(wkb.loads(g)), (160, 161, 158))
# 건물 지붕 (멀리서 도시 느낌)
for b in bld:
    ring = [(b[0] + x, b[1] + z) for x, z in b[7]]
    if len(ring) >= 3:
        r5 = b[6]
        col = (((r5 >> 11) & 31) * 8, ((r5 >> 5) & 63) * 4, (r5 & 31) * 8)
        col = tuple(int(v * 0.72) for v in col)
        dr.polygon(pix(ring), fill=col)
# 도로 (멀리서 보이도록)
for code, width, flags, pts in roads:
    if code in (9,):
        continue
    col = (95, 96, 98) if code < 10 else (120, 112, 104) if code < 12 else (110, 111, 112)
    w = max(1, int(round(width / SC)))
    dr.line(pix([(p[0], p[1]) for p in pts]), fill=col, width=w)
for gg, c in water_polys:
    fillg(gg, (61, 111, 134))
arr = np.asarray(img).copy()
up = np.asarray(Image.fromarray(sea.astype(np.uint8) * 255).resize((TW, TH), Image.BILINEAR)) > 127
arr[up] = (44, 90, 112)
Image.fromarray(arr).save(os.path.join(OUT, 'ground.jpg'), quality=84, optimize=True)

print('6/8 나무')
rng = np.random.RandomState(7)
trees = []
dens = {'park': 1 / 160, 'garden': 1 / 140, 'golf_course': 1 / 1200, 'cemetery': 1 / 600, 'forest': 1 / 900, 'wood': 1 / 900, 'scrub': 1 / 2000,
        'university': 1 / 1200, 'school': 1 / 1600, 'residential': 1 / 2500}
for g, c in [(g, c) for g, c in zip(land_df.geometry, land_df['class'])] + list(zip(LUd.geometry, LUd['class'])):
    dd = dens.get(c)
    if not dd:
        continue
    G = proj_geom(wkb.loads(g))
    if G.geom_type not in ('Polygon', 'MultiPolygon'):
        continue
    nn = int(G.area * dd)
    if c in ('forest', 'wood', 'scrub'):
        nn = min(nn, 2500)
    if nn <= 0:
        continue
    bx0, bz0, bx1, bz1 = G.bounds
    shapely.prepare(G)
    got = 0
    for _ in range(6):
        if got >= nn:
            break
        k = min(200000, (nn - got) * 3)
        xs = rng.uniform(bx0, bx1, k); zs = rng.uniform(bz0, bz1, k)
        ok = shapely.contains_xy(G, xs, zs)
        for x, z in zip(xs[ok][: nn - got], zs[ok][: nn - got]):
            trees.append((x, z, 0 if c in ('forest', 'wood', 'scrub') else 1))
        got += int(min(ok.sum(), nn - got))
# 송도 가로수
for code, width, flags, pts in roads:
    if code not in (3, 4, 5, 6) or flags & 1:
        continue
    for i in range(len(pts) - 1):
        (x0, z0, _), (x1, z1, _) = pts[i], pts[i + 1]
        if not CORE.contains(Point(x0, z0)):
            continue
        L = math.hypot(x1 - x0, z1 - z0)
        if L < 1:
            continue
        nx, nz = -(z1 - z0) / L, (x1 - x0) / L
        for s in np.arange(6, L, 14):
            for side in (-1, 1):
                off = width / 2 + 2.5
                trees.append((x0 + (x1 - x0) * s / L + nx * off * side, z0 + (z1 - z0) * s / L + nz * off * side, 2))
# 물 위·건물 위 나무 제거
bpoly = shapely.STRtree([Polygon([(b[0] + x, b[1] + z) for x, z in b[7]]) for b in bld if len(b[7]) >= 3])
keep = []
for x, z, k in trees:
    if is_water(x, z):
        continue
    keep.append((x, z, k))
pts_arr = shapely.points(np.array([[t[0], t[1]] for t in keep]))
hit = bpoly.query(pts_arr, predicate='within')
bad = set(hit[0].tolist())
trees = [t for i, t in enumerate(keep) if i not in bad]
buf = bytearray(b'SDT1') + struct.pack('<I', len(trees))
buf += np.array([[round(t[0] * 10), round(t[1] * 10)] for t in trees], '<i4').tobytes()
buf += np.array([t[2] for t in trees], 'u1').tobytes()
with gzip.open(os.path.join(OUT, 'trees.bin.gz'), 'wb', 9) as f:
    f.write(bytes(buf))
print('  trees', len(trees))

print('7/8 물 면')
# 바다와 이어진 물은 파낸 지형 + 바다 수면으로 보이므로 따로 그리지 않는다. 나머지는 삼각형으로 나눠 저장.
tri_y, tri_xz = [], []
nareas = 0
for P, lvl in water_levels:
    if lvl <= 0.31:
        continue
    P = P.simplify(0.8).buffer(0)
    for Q in (P.geoms if P.geom_type == 'MultiPolygon' else [P]):
        if Q.is_empty or Q.area < 200:
            continue
        T = shapely.constrained_delaunay_triangles(Q)
        for t in T.geoms:
            c = list(t.exterior.coords)[:3]
            # 위를 향하는 감기 (y = uz*vx - ux*vz > 0)
            (ax, az), (bx, bz), (cx, cz) = c
            if (bz - az) * (cx - ax) - (bx - ax) * (cz - az) < 0:
                c = [c[0], c[2], c[1]]
            tri_xz.extend(c)
            tri_y.append(lvl)
        nareas += 1
buf = bytearray(b'SDA3') + struct.pack('<I', len(tri_y))
buf += np.array(tri_y, '<f4').tobytes()
buf += np.array([[round(p[0] * 10), round(p[1] * 10)] for p in tri_xz], '<i4').tobytes()
with gzip.open(os.path.join(OUT, 'areas.bin.gz'), 'wb', 9) as f:
    f.write(bytes(buf))
print('  water areas', nareas, 'triangles', len(tri_y))

print('8/8 메타')
gates = []
for g, c, st in zip(infra.geometry, infra['class'], infra.source_tags):
    if c == 'airport_gate':
        G = proj_geom(wkb.loads(g))
        p = G.centroid
        if p.x < -5000:
            gates.append([round(p.x, 1), round(p.y, 1)])
LM = [
    ('posco', '포스코타워-송도 (옛 동북아무역센터)', 37.3892, 126.6442, 'songdo'),
    ('park', '송도 센트럴파크', 37.3923, 126.6363, 'songdo'),
    ('gtower', 'G타워', 37.3961, 126.6343, 'songdo'),
    ('tribowl', '트라이볼', 37.3942, 126.6349, 'songdo'),
    ('convensia', '송도컨벤시아', 37.3888, 126.6467, 'songdo'),
    ('firstworld', '송도 더샵 퍼스트월드', 37.3911, 126.6482, 'songdo'),
    ('hanok', '송도 한옥마을', 37.3907, 126.6393, 'songdo'),
    ('canal', '송도 커낼워크', 37.4003, 126.6382, 'songdo'),
    ('artcenter', '아트센터 인천', 37.3938, 126.6268, 'songdo'),
    ('moonlight', '송도달빛축제공원', 37.4063, 126.6358, 'songdo'),
    ('inu', '인천대학교 송도캠퍼스', 37.375, 126.6324, 'songdo'),
    ('yonsei', '연세대학교 국제캠퍼스', 37.382, 126.6726, 'songdo'),
    ('igc', '인천글로벌캠퍼스', 37.3756, 126.6665, 'songdo'),
    ('golf', '잭니클라우스 골프클럽', 37.3797, 126.6241, 'songdo'),
    ('outlet', '현대프리미엄아울렛 송도', 37.3815, 126.6579, 'songdo'),
    ('haedoji', '해돋이공원', 37.3877, 126.6543, 'songdo'),
    ('celltrion', '셀트리온 (바이오단지)', 37.3703, 126.6424, 'songdo'),
    ('marina', '더샵 송도마리나베이', 37.4125, 126.6116, 'songdo'),
    ('newport', '인천신항', 37.3447, 126.6193, 'other'),
    ('t1', '인천공항 제1여객터미널', 37.4495, 126.4507, 'airport'),
    ('t2', '인천공항 제2여객터미널', 37.4681, 126.4342, 'airport'),
    ('bridge', '인천대교 주탑', 37.4137, 126.5668, 'other'),
    ('skycity', '영종하늘도시', 37.4964, 126.5687, 'other'),
    ('wolmido', '월미도', 37.473, 126.6028, 'other'),
    ('cheongnyang', '청량산', 37.4192, 126.6611, 'other'),
]
landmarks = []
for i, nm_, lat, lon, kind in LM:
    x, z = proj(lon, lat)
    landmarks.append({'id': i, 'name': nm_, 'x': round(float(x), 1), 'z': round(float(z), 1), 'kind': kind})
pylons = []
if CS is not None:
    for f in (0.5 - 400 / CS_LEN, 0.5 + 400 / CS_LEN):
        p = CS.interpolate(f, normalized=True)
        q = CS.interpolate(min(1, f + 0.01), normalized=True)
        pylons.append({'x': round(p.x, 1), 'z': round(p.y, 1), 'dx': q.x - p.x, 'dz': q.y - p.y})
meta = {
    'version': 2, 'origin': [LAT0, LON0], 'mpdLat': MPD_LAT, 'mpdLon': MPD_LON,
    'bounds': [X0, Z0, X1, Z1], 'cell': CELL, 'nx': NX, 'nz': NZ, 'wcell': WCELL, 'wx': WX, 'wz': WZ,
    'ground': {'w': TW, 'h': TH},
    'runways': [{k: v for k, v in r.items() if k != 'line'} for r in runways],
    'airportH': AIRPORT_H, 'gates': gates, 'landmarks': landmarks, 'pylons': pylons,
    'named': {k: [round(v[0], 1), round(v[1], 1), round(v[2], 1)] for k, v in named_bld.items()},
    'attribution': '지도 자료: © OpenStreetMap 기여자 (ODbL), Overture Maps Foundation. 고도: AWS Terrain Tiles (SRTM 등).',
}
json.dump(meta, open(os.path.join(OUT, 'meta.json'), 'w'), ensure_ascii=False)
for fn in sorted(os.listdir(OUT)):
    print('  ', fn, os.path.getsize(os.path.join(OUT, fn)) // 1024, 'KB')
