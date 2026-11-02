// 영어 표시 (beta): 화면 HTML의 한국어 구절을 사전으로 바꾼다. 게임 규칙·저장 내용은 언어와 무관하다.
// 순서: ① 지역 이름 → 로마자  ② 숫자가 붙은 패턴(정규식 하나)  ②' 문맥 낱말  ③ 구절 사전(한 번 훑기, 가장 긴 키 우선)
//       ④ 요소 첫머리 대문자.
// 사전 키는 원문 그대로 적고, 모듈 로드 시 ②의 패턴을 키에도 적용해 정규화한다 (예: '30일' → '30 d').
// 정규식은 모두 모듈 로드 때 한 번만 만든다 (50KB HTML 한 번 번역 ≈ 1.5 ms).
import type { GameState } from '../sim/sim';

// ---------- ① 지역 이름 ----------
const FIXED_NAMES: Record<string, string> = {
  아우렐: 'Aurel', 바스티온: 'Bastion', 세룰레아: 'Cerulea', 드라바: 'Drava', 에스커: 'Esker', 펜마크: 'Penmark',
  오린: 'Orin', 카스텔: 'Castel', 루멘: 'Lumen', 베리스: 'Veris', 토르바: 'Torva', 니발: 'Nival',
};
// 개정 로마자 표기에 가깝게 (초성·중성·종성)
const INI = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const MED = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const FIN = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
const isSyl = (c: number) => c >= 0xac00 && c <= 0xd7a3;

export function romanize(name: string): string {
  const fixed = FIXED_NAMES[name];
  if (fixed) return fixed;
  const ch = [...name];
  let out = '';
  for (let i = 0; i < ch.length; i++) {
    const code = ch[i].charCodeAt(0);
    if (!isSyl(code)) { out += ch[i]; continue; }
    const c = code - 0xac00;
    const ini = Math.floor(c / 588), med = Math.floor((c % 588) / 28), fin = c % 28;
    const nc = i + 1 < ch.length ? ch[i + 1].charCodeAt(0) : 0;
    const nextIni = isSyl(nc) ? Math.floor((nc - 0xac00) / 588) : -1;
    const prevFin = i > 0 && isSyl(ch[i - 1].charCodeAt(0)) ? (ch[i - 1].charCodeAt(0) - 0xac00) % 28 : -1;
    let v = MED[med];
    // 외래어식 이름의 덧붙은 'ㅡ'는 떨어뜨린다: 스 → s, 르 → r, 크 → k (모음으로 이어질 때는 유지)
    if (med === 18 && fin === 0 && i > 0 && ini !== 11 && nextIni !== 11) v = '';
    const init = ini === 5 && prevFin === 8 ? 'l' : INI[ini];
    out += init + v + FIN[fin];
  }
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const escRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
interface RegionCache { re: RegExp | null; map: Map<string, string> }
const regionCache = new WeakMap<object, RegionCache>();

function regionsFor(s: GameState): RegionCache {
  const regs = s.regions;
  let c = regionCache.get(regs);
  if (c && c.map.size === regs.length) return c;
  const map = new Map<string, string>();
  for (const r of regs) map.set(r.name, romanize(r.name));
  const names = [...map.keys()].filter((n) => /[\uac00-\ud7a3]/.test(n)).sort((a, b) => b.length - a.length);
  // 단어 안의 우연한 일치(예: '누르세요')를 피한다: 앞은 한글이 아니고, 뒤는 한글이 아니거나 조사 + 비한글
  const re = names.length
    ? new RegExp(`(?<![\\uac00-\\ud7a3])(?:${names.map(escRe).join('|')})(?=$|[^\\uac00-\\ud7a3]|(?:의|은|는|이|가|을|를|에|과|와|로|으로|에서)(?:$|[^\\uac00-\\ud7a3]))`, 'g')
    : null;
  c = { re, map };
  regionCache.set(regs, c);
  return c;
}

/** 문장·요소 첫머리면 첫 글자를 대문자로 */
function atStart(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (src[j] === ' ' || src[j] === '\n')) j--;
  if (j < 0) return true;
  const c = src[j];
  // 문장 속 강조(… <b>…</b> …)는 첫머리로 보지 않는다. 요소 맨 앞의 <b>(제목 등)는 첫머리.
  if (c === '>' && (src.endsWith('</b', j) || (src.endsWith('<b', j) && j >= 3 && src[j - 3] !== '>'))) return false;
  return c === '>' || c === '[' || c === '"' || c === '“' || c === '.' || c === '?' || c === '!';
}
function capAt(v: string, src: string, off: number): string {
  const c = v.charCodeAt(0);
  return c >= 97 && c <= 122 && atStart(src, off) ? v[0].toUpperCase() + v.slice(1) : v;
}

// ---------- ② 숫자 패턴 (순서 중요: 구체적인 것 먼저) ----------
const R = '([A-Z][A-Za-z]*\\d*)'; // 이미 로마자로 바뀐 지역 이름
const LIC = '((?:발전|저장|송전|소매 공급) 사업권)';
const PATTERN_SRC: [string, string][] = [
  ['(\\d+)년 (\\d+)일 (\\d\\d:\\d\\d)', 'Y$1 D$2 $3'],
  ['(\\d+)일 (\\d\\d:\\d\\d)', 'D$1 $2'],
  ['현지 (\\d+)시', 'local $1:00'],
  ['(\\d+)일 (?:내|안에) 고장 예상', 'fails within $1 d'],
  ['(\\d+)일 안에 연체와 음수 현금을 해소하세요', 'clear arrears and negative cash within $1 d'],
  ['만료 (\\d+)일 전', 'expires in $1 d'],
  ['(\\d+)일 후 만료', 'expires in $1 d'],
  ['(\\d+)일 후 시행', 'effective in $1 d'],
  ['(\\d+)일 후', 'in $1 d'],
  ['(\\d+)일 남음', '$1 d left'],
  ['남은 (\\d+)일', '$1 d left'],
  ['(\\d+)일 연장', '+$1 d'],
  ['(\\d+)일마다 새 제안', 'new offers every $1 d'],
  ['(\\d+)일마다', 'every $1 d'],
  ['(\\d+)일 합계', '$1-day totals'],
  ['(\\d+)일차 달성', 'achieved on day $1'],
  ['(\\d+)일차', 'day $1'],
  ['동시 건설은 (\\d+)건까지', 'max $1 concurrent builds'],
  ['동시 연구는 (\\d+)개까지', 'max $1 at a time'],
  ['모듈은 시설당 (\\d+)개까지입니다', 'max $1 modules per facility'],
  ['모듈 (\\d+) 추가', 'add module $1'],
  ['수동 (\\d+)번 칸', 'manual slot $1'],
  ['예산·자금 부족으로 (\\d+)회 실패', 'failed $1× (budget or funds short)'],
  ['(\\d+)회 실패', 'failed $1×'],
  ['(\\d+)/(\\d+)회', '$1/$2 paid'],
  ['버전 (\\d+) 세이브를 변환할 수 없습니다', 'Cannot convert a version $1 save'],
  ['대출 #(\\d+) 조기 상환', 'loan #$1 prepaid'],
  ['대출 #(\\d+) 상환 완료', 'loan #$1 repaid'],
  ['대출 #(\\d+) 상환 실패', 'loan #$1 payment failed'],
  ['지금 이웃 가격이 손실\\(([\\d.]+)%\\)을 빼고도 ([\\d.,]+) CR/MWh 높음', 'neighbor pays $2 CR/MWh more even after $1% loss'],
  [`${R} 변전소 건설`, 'build substation in $1'],
  [`${R} ${LIC} 추가`, 'add $1 $2'],
  [`${R} ${LIC} 갱신 \\(`, '$1 $2 renewed ('],
  [`${R} ${LIC} 취득 \\(`, '$1 $2 acquired ('],
  [`${R} ${LIC} 갱신`, 'renew $1 $2'],
  ['(\\d+)개 지역 진출', 'Operate in $1 regions'],
  ['(\\d+)일 의무 지출', '$1-day obligations'],
  ['(\\d+)시간 평탄', 'flat $1 h'],
  ['(\\d+)개 지역', '$1 regions'],
  ['(\\d+)배속', '$1× speed'],
  ['(\\d+)개월', '$1 mo'],
  ['(\\d+)시간', '$1 h'],
  ['(\\d+)일', '$1 d'],
  ['(\\d+)분', '$1 min'],
  ['(\\d+)건', '$1'],
  ['(\\d+)개', '$1'],
  ['(\\d+)회', '$1'],
  ['(\\d+)년', 'Y$1'],
];

// 모든 패턴을 정규식 하나로 묶는다. '(\d+)'로 시작하는 패턴은 숫자 덩어리 하나 뒤의 갈래로 모아
// 숫자마다 수십 번 시도하지 않게 한다. 각 갈래를 그룹으로 감싸고, 맞은 그룹 번호로 어느 패턴인지 찾는다.
// 같은 위치에서는 목록 순서가 우선이다.
interface Pat { group: number; rep: string; lead: boolean }
const PATS: Pat[] = [];
const groupsIn = (p: string) => new RegExp(`${p}|`).exec('')!.length - 1;
const DIGIT_LEAD = '(\\d+)';
const leadAlts: string[] = [];
const otherAlts: string[] = [];
let gc = 2; // 그룹 1 = 앞 숫자
for (const [p, rep] of PATTERN_SRC) if (p.startsWith(DIGIT_LEAD)) {
  const rest = p.slice(DIGIT_LEAD.length);
  PATS.push({ group: gc, rep, lead: true });
  leadAlts.push(`(${rest})`);
  gc += 1 + groupsIn(rest);
}
for (const [p, rep] of PATTERN_SRC) if (!p.startsWith(DIGIT_LEAD)) {
  PATS.push({ group: gc, rep, lead: false });
  otherAlts.push(`(${p})`);
  gc += 1 + groupsIn(p);
}
const PATTERN_RE = new RegExp([`(?<!\\d)(\\d+)(?:${leadAlts.join('|')})`, ...otherAlts].join('|'), 'g');

function applyPatterns(t: string): string {
  return t.replace(PATTERN_RE, (...a: unknown[]) => {
    let k = 0;
    while (a[PATS[k].group] === undefined) k++;
    const pt = PATS[k];
    // 앞 숫자 패턴: $1 = 앞 숫자, $2.. = 갈래 안의 그룹.  그 밖: $n = 갈래 안의 n번째 그룹
    const g = (n: number) => (pt.lead ? (n === 1 ? a[1] : a[pt.group + n - 1]) : a[pt.group + n]) as string;
    return pt.rep.replace(/\$(\d)/g, (_, n) => g(Number(n)));
  });
}

// 문맥에 따라 뜻이 갈리는 짧은 낱말. 한글로 시작하고 뒤쪽 lookbehind로 앞 문맥을 본다 (빠른 첫 글자 탐색 유지).
const CONTEXT: [string, string][] = [
  ['저장(?<=data-tab="storage" class="(?:on)?">저장)', 'Storage'],
  ['송전선(?<=data-tab="line" class="(?:on)?">송전선)', 'Lines'],
  ['기본(?<=data-overlay="none" class="(?:on)?">기본)', 'Default'],
  ['저장 (?<= · 저장 )(?!사업권)', 'stored '],
  ['연 (?<= · 연 )', 'APR '],
  ['월 (?<="s">월 )', 'monthly '],
  ['송전(?<=→ 송전)', 'out'],
  ['송전선(?<=<h3>송전선)', 'Transmission lines'],
  ['대출(?<=<h3>대출)', 'Loans'],
  ['추천(?<=<h3>추천)', 'Recommendations'],
  ['수전(?<=← 수전)', 'in'],
  ['일(?<=[/·]일)', 'd'],
  ['건설(?<=<span>건설)(?=</span>)', 'Construction'],
];
const CONTEXT_RE = new RegExp(CONTEXT.map(([p]) => `(${p})`).join('|'), 'g');

// ---------- ③ 구절 사전 ----------
// 키는 원문 그대로. HTML 조각을 포함한 키는 같은 단어의 문맥별 번역에 쓴다.
const DICT: Record<string, string> = {
  // --- 맥락별 (HTML 포함) ---
  '가동</button>': 'Start</button>',
  '정지</button>': 'Stop</button>',
  '저장</h3>': 'Storage</h3>',
  '진행</h3>': 'Gameplay</h3>',
  '진행</div>': 'running</div>',
  '제안 <span': 'offers <span',
  '대기</div>': 'queued</div>',
  '일시정지</div>': 'paused</div>',
  '단위': 'unit',
  '숫자 1–4': 'keys 1–4',
  '가 표준 기록': ' = standard record',
  '가격 예측 (수요 예측 연구)': 'price forecast (Demand Forecast research)',
  '진출': 'presence',
  '「': '“',
  '」': '”',

  // --- 공통 상태·단위 ---
  '점검 필요': 'inspection due',
  '점검 중': 'inspecting',
  '고장 · 복구': 'failed · repair',
  '(긴급)': '(rush)',
  '유예 중': 'in grace',
  '유예': 'grace',
  '만료 예정': 'expiring',
  '만료됨': 'expired',
  '만료': 'expired',
  '준비 및 기초': 'site prep',
  '주요 구조': 'main structure',
  '장비 설치': 'equipment',
  '전력망 접속': 'grid hookup',
  '검사': 'testing',
  '시운전': 'commissioning',

  // --- 상단 바 ---
  '지역': 'region',
  '계약': 'contracts',
  '재무': 'finance',
  '연구': 'research',
  '자동화': 'automation',
  '계획': 'plan',
  '목표': 'goals',
  '유동성 경고': 'liquidity warning',
  '연체': 'arrears',
  '구조조정': 'restructuring',
  '회생불능': 'insolvent',
  '청산': 'liquidation',
  '게임 시각': 'game time',
  '일시정지 (Space)': 'pause (Space)',
  '최근 30일 계약 인도량 / 의무량': 'contract delivery / obligation, last 30 d',
  '신뢰도': 'reliability',
  '순자산': 'net worth',
  '현금': 'cash',
  '어제': 'yesterday',
  '빠른 저장': 'quick save',
  '저장': 'save',
  '세이브 슬롯': 'save slots',
  '불러오기': 'load',
  '설정': 'settings',
  '도움말 (F1)': 'help (F1)',
  '도움말': 'help',
  '새 게임': 'new game',

  // --- 지역 목록 ---
  '지역 시장': 'regional markets',
  '사업권 보유': 'license held',
  '주의 필요': 'needs attention',
  '수요': 'demand',
  '내 발전': 'my gen',
  '가격은 지역 수요와 기존 전력망으로 정해지며 내 발전량은 가격을 바꾸지 않습니다.': 'Prices come from regional demand and the existing grid; your output does not move them.',

  // --- 시설·선로 행 ---
  '건설 중': 'building',
  '권리 없음 — 공사 중단': 'no rights — work halted',
  '권리 상실로 정지': 'stopped: rights lost',
  '사업권 또는 토지를 확보하세요': 'secure a license or land',
  '접속 용량': 'connection capacity',
  '충전': 'charge',
  '방전': 'discharge',
  '대기 중': 'waiting',
  '대기': 'idle',
  '저장량': 'stored',
  '수동 고정': 'manual lock',
  '기동 중': 'starting',
  '가동': 'running',
  '정지': 'stopped',
  '모듈 확장 공사': 'module expansion',
  '곧 준공': 'finishing',
  '변전점': 'substation point',
  '토지 소유': 'land owned',
  '임대': 'lease',
  '취소': 'cancel',
  '토지 매입': 'buy land',
  '임대 갱신 (+10%)': 'renew lease (+10%)',
  '임대 갱신': 'renew lease',
  '매각': 'sell',
  '폐기': 'scrap',
  '점검': 'inspect',
  '남은 복구 기간 절반': 'halves remaining repair time',
  '긴급 복구': 'rush repair',
  '시설 상세': 'facility details',
  '송전 사업권 없음 — 정지': 'no transmission license — stopped',
  '흐름 없음': 'no flow',
  '이용률': 'utilization',
  '연결': 'link',
  '손실': 'loss',

  // --- 사업권 ---
  '발전 사업권': 'generation license',
  '저장 사업권': 'storage license',
  '송전 사업권': 'transmission license',
  '소매 공급 사업권': 'retail license',
  '사업권': 'licenses',
  '보유': 'held',
  '없음': 'none',
  '기본 수수료': 'base fee',
  '갱신': 'renew',
  '취득가': 'price',
  '지은 MW당': 'per built MW',
  '지은 MW': 'built MW',
  '기간': 'term',
  '취득': 'acquire',
  '사용 수수료': 'usage fee',
  '발전·저장 사업권은 지을 수 있는 정격 용량 한도를 줍니다. 송전 사업권은 변전소와 송전선(양쪽 지역)에, 소매 공급 사업권은 직접 공급 계약에 필요합니다.':
    'Generation and storage licenses set how much rated capacity you may build. Transmission licenses are needed for substations and lines (both ends); retail licenses for direct supply contracts.',

  // --- 가격 예측·건설 ---
  '발전': 'generation',
  '변전소': 'substation',
  '송전선': 'transmission line',
  '소형': 'small',
  '중형': 'medium',
  '대형': 'large',
  '용량 (송전단)': 'capacity (sending end)',
  '길이 · 손실률': 'length · loss',
  '건설비 · 공사': 'capex · build time',
  '송전선 건설 승인': 'approve line',
  '계획에 추가': 'add to plan',
  '이웃 지역끼리만 연결합니다. 전력은 손실을 빼고도 더 비싸게 팔리는 곳으로 자동 배분됩니다. 지역마다 시간대가 달라 저녁 피크 지역에 팔 수 있습니다.':
    'Only neighbors can be linked. Power flows automatically to wherever it sells for more after losses. Time zones differ, so you can sell into another region’s evening peak.',
  '연구 「핵분열 발전」 필요': 'requires research “Fission Power”',
  '열발전소': 'thermal plant',
  '태양광 발전소': 'solar farm',
  '풍력 발전단지': 'wind farm',
  '핵분열 발전소': 'fission plant',
  '배터리 저장시설': 'battery storage',
  '접속 용량 증설': 'connection capacity added',
  '정격 출력': 'rated output',
  '저장 용량': 'storage capacity',
  '왕복 효율': 'round-trip efficiency',
  '유지비': 'upkeep',
  '연료비': 'fuel cost',
  '출력 특성': 'output profile',
  '기저 출력': 'baseload',
  '최소': 'min',
  '기동': 'start-up',
  '조절 가능': 'dispatchable',
  '낮에만': 'daytime only',
  '바람에 따라': 'wind-dependent',
  '환경 영향 · 폐기': 'env. impact · disposal',
  '환경 영향': 'env. impact',
  '높음 (지표': 'high (index',
  '낮음 · 폐기 비용 건설비의 30%': 'low · disposal cost 30% of capex',
  '승인 시 건설비가 예약되고 6단계마다 청구됩니다. 부지는 자동으로 임대됩니다(보증금 30일분). 시운전 단계부터 출력 50%로 판매합니다.':
    'On approval the capex is reserved and billed over 6 stages. The site is leased automatically (30-day deposit). Sales start at 50% output during commissioning.',
  '가격이 충전 기준 이하일 때 내 발전으로 충전하고, 방전 기준 이상이거나 계약 공급이 부족할 때 방전합니다.':
    'Charges from your own generation when the price is at or below the charge threshold; discharges at or above the discharge threshold or when contract supply runs short.',
  '변전소는 이 지역에 새 접속점(변전점)을 만듭니다. 새 시설은 여유가 있는 접속점에 자동으로 붙고, 변전점이 고장 나면 그 변전점에 붙은 시설만 멈춥니다. 송전 사업권이 필요합니다.':
    'A substation adds a new connection point (substation point) here. New facilities attach to a point with room; if a substation point fails, only facilities on it stop. Requires a transmission license.',
  '핵분열 발전소는 출력이 거의 일정한 기저 전원입니다. 기동에 6시간이 걸리고 출력을 크게 줄일 수 없으며, 고장 복구 기간이 2배입니다.':
    'Fission plants are near-constant baseload. Start-up takes 6 h, output can barely be reduced, and repairs take twice as long.',
  '건설 승인': 'approve build',
  '조건(자금·사업권·접속·동시 건설)이 맞으면 순서대로 자동 승인': 'auto-approved in order once funds, licenses, connection and build slots allow',

  // --- 지역 화면 (선택 전) ---
  '시작하기': 'Getting started',
  '<li>왼쪽 목록이나 행성 위에서 <b>지역</b>을 고릅니다.</li>': '<li>Pick a <b>region</b> from the list on the left or on the planet.</li>',
  '<li><b>발전 사업권</b>(소형)을 취득합니다.</li>': '<li>Acquire a <b>generation license</b> (small).</li>',
  '<li>짧은 공기의 <b>소형 태양광(5일)</b>이나 <b>소형 열발전(10일)</b>을 짓습니다.</li>': '<li>Build something quick: a <b>small solar farm (5 d)</b> or a <b>small thermal plant (10 d)</b>.</li>',
  '<li>계약 화면에서 <b>PPA</b>를 맺으면 안정적인 수익이 생깁니다.</li>': '<li>Sign a <b>PPA</b> on the Contracts screen for steady income.</li>',
  '<li>이웃 지역과 <b>송전선</b>을 이어 저녁 피크에 비싸게 팝니다.</li>': '<li>Link neighbors with <b>transmission lines</b> and sell into evening peaks.</li>',
  '공간: 일시정지 · 숫자 1–4: 배속 · 행성은 끌어서 돌리고 휠로 확대합니다.': 'Space: pause · 1–4: speed · drag to rotate the planet, wheel to zoom.',

  // --- 지역 화면 ---
  '공급 충격': 'supply shock',
  '예고': 'upcoming',
  '규제 예고': 'regulation notice',
  '환경 단가': 'env. price',
  '시장 가격': 'market price',
  '기준가': 'base price',
  '일사': 'sun',
  '풍황': 'wind',
  '토지': 'land',
  '접속 용량 · 수요 허브': 'connection capacity · demand hub',
  '정상': 'OK',
  '허브 기본 접속점': 'hub base point',
  '(건설 중)': '(building)',
  '기본': 'base',
  '여유': 'free',
  '수요 허브 점검': 'inspect demand hub',
  '수요 허브 긴급 복구': 'demand hub rush repair',
  '수요 허브': 'demand hub',
  '이 지역 판매 / 판매 한도 (σ = 1.0)': 'sales here / sales cap (σ = 1.0)',
  '환경 지표 (30일)': 'env. index (30 d)',
  '환경 지표': 'env. index',
  '단가': 'price',
  '내 시설': 'my facilities',
  '아직 시설이 없습니다.': 'No facilities yet.',
  '연결된 송전선이 없습니다.': 'No lines connected.',
  '건설': 'build',

  // --- 계약 ---
  '주간(07–19시)': 'daytime (07–19)',
  '상업 부하(주간 중심)': 'commercial (daytime-heavy)',
  '산업 부하(평탄)': 'industrial (flat)',
  '공급 신뢰도 (30일)': 'supply reliability (30 d)',
  '진행 중인 계약': 'active contracts',
  '진행 중': 'active',
  '완료': 'completed',
  '계약이 없습니다. 아래 제안을 수락하세요.': 'No contracts. Accept an offer below.',
  '직접 공급 · 핵심 부하': 'direct supply · critical load',
  '직접 공급(핵심 부하)': 'direct supply (critical load)',
  '직접 공급': 'direct supply',
  '핵심 부하': 'critical load',
  '이행률': 'fulfilment',
  '지금': 'now',
  '수익': 'revenue',
  '위약금': 'penalty',
  '새 제안': 'new offers',
  '제안': 'offers',
  '전체': 'all',
  '내 지역': 'my regions',
  '해당하는 제안이 없습니다.': 'No matching offers.',
  '(기준가 ×': '(base ×',
  '부족 시 위약금': 'shortfall penalty',
  '제안 만료': 'offer expires',
  '무리한 계약 경고: 이 지역과 연결 지역의 공급 여력': 'Overcommit warning: supply headroom here and in linked regions',
  '무리한 계약 경고': 'overcommit warning',
  '소매 공급 사업권 필요': 'retail license required',
  '수락': 'accept',
  '최근 완료': 'recently completed',
  '계약 물량은 시장 판매보다 먼저 공급됩니다(핵심 부하 → 계약 → 시장). 부족분 위약금 = 부족량 × [max(시장가 − 계약가, 0) + λ × 계약가] 이므로, 계약 물량을 시장에 돌려 팔아도 이득이 없습니다.':
    'Contract volumes are served before market sales (critical load → contracts → market). Shortfall penalty = shortfall × [max(market − contract price, 0) + λ × contract price], so diverting contract volume to the market never pays.',
  '부족량': 'shortfall',
  '시장가': 'market price',
  '계약가': 'contract price',

  // --- 재무 ---
  '시장 판매': 'market sales',
  '계약 수익': 'contract revenue',
  '연료': 'fuel',
  '토지 임대료': 'land rent',
  '이자': 'interest',
  '환경 비용': 'env. costs',
  '수리·점검': 'repairs & inspections',
  '토지·보증금': 'land & deposits',
  '대출 원금': 'loan principal',
  '시설 매각': 'facility sales',
  '취소 환불': 'cancellation refunds',
  '자본': 'equity',
  '구제': 'bailout',
  '부채': 'debt',
  '대출 한도 없음': 'no credit available',
  '대출 한도': 'credit limit',
  '상태': 'status',
  '회생불능입니다. 구제를 신청하면 부채가 60개월 저리 대출로 재조정되고 현금이 0이 됩니다 (기록에 남음).':
    'Insolvent. A bailout reschedules debt into a 60-month low-rate loan and resets cash to 0 (shown in your record).',
  '구제 신청': 'request bailout',
  '구조조정 중': 'restructuring',
  '구조조정 계획 (매각 후보)': 'restructuring plan (sale candidates)',
  '매각할 시설이 없습니다.': 'No facilities to sell.',
  '순자산·현금 추이': 'net worth & cash trend',
  '(최근': '(last',
  '최근 30일 현금 흐름': 'cash flow, last 30 d',
  '대출': 'loan',
  '잔액': 'balance',
  '다음 상환': 'next payment',
  '조기 상환': 'prepay',
  '대출이 없습니다.': 'No loans.',
  '금액': 'amount',
  '월 상환 (원리금 균등)': 'monthly payment (annuity)',
  '연이율 (게임년 120일)': 'annual rate (game year = 120 d)',
  '대출 실행': 'take loan',
  '한도 = 기본 신용': 'Limit = base credit',
  '+ 운영 시설 장부가 50% + 소유 토지 70% − 대출 잔액. 상환에 실패하면 연체 → 30일 후 구조조정으로 넘어가며, 즉시 게임오버는 없습니다.':
    '+ 50% of operating facility book value + 70% of owned land − loan balance. A missed payment means arrears → restructuring after 30 d; there is no instant game over.',

  // --- 연구 ---
  '동시 2개 · 하루 투자는 (비용 ÷ 최소 기간)까지': '2 at a time · daily spend up to cost ÷ min. duration',
  '송전': 'transmission',
  '환경': 'environment',
  '연소 효율': 'Combustion Efficiency',
  '출력 유연성': 'Flexible Output',
  '핵분열 발전': 'Fission Power',
  '저손실 도체': 'Low-loss Conductors',
  '고용량 선로': 'High-capacity Lines',
  '신속 복구': 'Rapid Repair',
  '전력 변환 효율': 'Power Conversion',
  '고밀도 셀': 'High-density Cells',
  '수요 예측': 'Demand Forecast',
  '자동 운영': 'Auto Operations',
  '배출 저감': 'Emission Control',
  '모듈 공법': 'Modular Construction',
  '병행 시공': 'Parallel Building',
  '열발전 램프 ×1.5, 최소 출력 −10%p': 'thermal ramp ×1.5, min output −10 pp',
  '핵분열 발전소 건설 해금 (기저 출력, 저연료비, 긴 건설)': 'unlocks fission plants (baseload, cheap fuel, long build)',
  '신규 송전선 손실': 'new line losses',
  '신규 송전선 용량': 'new line capacity',
  '복구 기간': 'repair time',
  '충·방전 효율 +2%p': 'charge/discharge efficiency +2 pp',
  '신규 저장 용량': 'new storage capacity',
  '지역 24시간 가격 예측 표시': 'shows 24 h regional price forecast',
  '자동 실행: 예방 점검·저장 기준 자동 조정': 'automation: preventive inspections & storage thresholds',
  '건설비': 'capex',
  '공사 기간 ×0.9, 동시 건설 +1': 'build time ×0.9, concurrent builds +1',
  '하루': 'daily',
  '시작 (하루': 'start (daily',
  '효과는 신규 건설에 적용됩니다(연료비·복구 기간·환경 비용·자동화는 즉시 전체 적용). 모든 효과는 상한이 있어 손실률은 0 미만, 효율은 100%를 넘지 않습니다.':
    'Effects apply to new builds (fuel, repair time, env. costs and automation apply everywhere at once). All effects are capped: losses never go below 0 and efficiency never exceeds 100%.',
  '존재하지 않는 연구': 'unknown research',
  '이미 완료': 'already done',
  '이미 진행 중': 'already in progress',
  '선행 연구 필요': 'prerequisite needed',
  '연구 거부': 'research rejected',
  '연구 시작': 'research started',
  '연구 완료': 'research complete',

  // --- 자동화 ---
  '기본은 추천 · 켠 정책만 자동 실행': 'recommends by default · only enabled policies act',
  '사업권·토지 자동 갱신': 'Auto-renew licenses & leases',
  '만료 7일 전(또는 유예 중)에 갱신합니다. 일일 예산 안에서만.': 'Renews 7 d before expiry (or during grace), within the daily budget.',
  '예방 점검 자동 실행': 'Auto preventive inspection',
  '고장 전조(점검 필요)가 보이면 바로 점검합니다.': 'Inspects as soon as a failure warning (inspection due) shows up.',
  '연구 "자동 운영" 필요': 'needs “Auto Operations” research',
  '저장 기준 가격 자동 조정': 'Auto storage thresholds',
  '최근 7일 지역 가격의 하위 30%에서 충전, 상위 25%에서 방전하도록 매일 조정합니다. 수동으로 바꾼 시설은 1일 동안 건드리지 않습니다.':
    'Daily retune: charge in the bottom 30% and discharge in the top 25% of the last 7 days’ regional prices. Facilities you changed by hand are left alone for 1 d.',
  '자동화 일일 예산': 'automation daily budget',
  '오늘 사용 · 행동 수': 'spent today · actions',
  '추천': 'recommendations',
  '지금은 추천할 일이 없습니다.': 'Nothing to recommend right now.',
  '근거': 'reason',
  '효과': 'effect',
  '비용': 'cost',
  '실행': 'run',
  '열기': 'open',
  '직접 판단': 'your call',
  '자동 실행도 직접 내린 명령과 같은 검증을 거칩니다. 같은 대상에 하루 한 번만 실행하고, 같은 이유로 3번 실패하면 멈추고 알립니다.':
    'Automatic actions pass the same checks as your own commands. Each target is handled at most once a day; after 3 failures for the same reason it stops and notifies you.',
  // 추천 항목
  '만료됨 — 유예 중 (신규 건설 불가)': 'expired — in grace (no new builds)',
  '예방 점검': 'preventive inspection',
  '고장 전조 발견': 'failure warning detected',
  '고장 방지 (1일 정지)': 'prevents failure (1 d offline)',
  '고장 방지': 'prevents failure',
  '토지 임대 갱신': 'lease renewal',
  '임대 만료 — 유예 중': 'lease expired — in grace',
  '임대료': 'rent',
  '핵심 부하 지역의 고장 — 위약금이 큼': 'failure in a critical-load region — heavy penalties',
  '고장으로 정지 중': 'down due to failure',
  '허브 고장 — 지역 전체 정지': 'hub failure — whole region down',
  '송전선 점검': 'line inspection',
  '접속점 여유 최대': 'best connection-point headroom',
  '사업권 한도가 거의 찼습니다': 'license quota almost full',
  '건설 한도 확대': 'raises build quota',
  '시간대 차이를 이용한 판매': 'sell across time zones',
  '대출로 유동성 확보': 'Raise liquidity with a loan',
  '연체 상태': 'in arrears',
  '한도': 'limit',
  '자동화 중단': 'automation stopped',
  '직접 처리하세요': 'handle it manually',
  '[자동 갱신]': '[auto-renew]',
  '[자동 점검]': '[auto-inspect]',
  '[저장 자동 조정]': '[auto storage]',
  '[계획]': '[plan]',
  '자동 갱신': 'auto-renew',
  '자동 점검': 'auto-inspect',
  '저장 자동 조정': 'auto storage',

  // --- 목표·기록 ---
  '선택 목표 · 달성해도 게임은 계속됩니다': 'optional · the game continues once achieved',
  '발전 설비 100 MW': '100 MW of generation',
  '송전선 5개 연결': 'Connect 5 transmission lines',
  '계약 5건 완료': 'Complete 5 contracts',
  '공급 신뢰도 99% (30일, 계약 3건 이상)': '99% supply reliability (30 d, 3+ contracts)',
  '연구 분기 하나 완성': 'Complete a research branch',
  '설비 100 MW 이상에서 모든 지역 환경 지표 0.8 미만': 'Env. index below 0.8 in every region with 100+ MW built',
  '대출을 쓴 뒤 부채 비율 0.3 이하': 'Debt ratio ≤ 0.3 after borrowing',
  '기록 분류': 'record class',
  '기록': 'record',
  '표준 규칙': 'standard rules',
  '사용자 지정 규칙': 'custom rules',
  '사용자 지정': 'custom',
  '난이도 · 시작': 'difficulty · start',
  '진행': 'progress',
  '발전 설비': 'generation capacity',
  '시드': 'seed',
  '완화': 'Relaxed',
  '표준': 'Standard',
  '도전': 'Challenge',
  '빈손 창업': 'Bare start-up',
  '사업권·시설 없이 자본만으로 시작': 'Start with capital only — no licenses or facilities',
  '소규모 사업권 보유': 'Small license holder',
  '한 지역의 소형 발전 사업권을 가지고 시작 (현금은 그만큼 적음)': 'Start with a small generation license in one region (less cash)',
  '소형 발전시설 보유': 'Small plant owner',
  '소형 열발전소와 사업권·토지를 가지고 시작 (현금은 그만큼 적음)': 'Start with a small thermal plant, license and land (less cash)',

  // --- 새 게임 ---
  '시작 자금을 직접 정합니다. 기록은 "사용자 지정 규칙"으로 분류됩니다.': 'Set your own starting funds. Recorded under “custom rules”.',
  '작은 전력회사에서 시작해 행성 전체의 에너지 흐름을 설계하고 운영하세요.': 'Grow a small power company into the designer and operator of a whole planet’s energy flows.',
  '시작 시나리오': 'starting scenario',
  '난이도': 'difficulty',
  '회생불능 시': 'on insolvency',
  '구제 허용': 'allow bailout',
  '시작 자금': 'starting funds',
  '경고: 사실상 무제한 자금입니다. 진행은 가능하지만 사업권·접속 용량·연구 기간 같은 제약은 그대로 적용됩니다.':
    'Warning: effectively unlimited funds. You can play, but limits like licenses, connection capacity and research time still apply.',
  '경고: 첫 시설을 짓기 빠듯한 자금입니다.': 'Warning: barely enough to build a first facility.',
  '지도 크기': 'map size',
  '행성 시드': 'planet seed',
  '기본 행성': 'default planet',
  '무작위': 'random',
  '지역이 많을수록 지역 하나가 작아집니다 (수요 ×': 'More regions means smaller regions (demand ×',
  '송전 거리 짧음). 기록은 「사용자 지정 규칙」으로 분류됩니다.': 'shorter lines). Recorded under “custom rules”.',
  '이어하기': 'continue',
  '시작': 'start',

  // --- 시설 상세 ---
  '아직 기록이 없습니다 (하루가 지나면 쌓입니다).': 'No data yet (fills in after a day).',
  '건설 취소': 'cancel build',
  '모듈 확장 공사 중입니다': 'module expansion in progress',
  '이 변전점에 접속한 시설이 있습니다 (먼저 그 시설을 정리하세요)': 'facilities are attached to this substation point (remove them first)',
  '모듈': 'module',
  '권리 상실': 'rights lost',
  '접속 시설': 'attached facilities',
  '정격': 'rated',
  '현재': 'now',
  '토지 임대': 'land lease',
  '가동률': 'availability',
  '순이익': 'net profit',
  '일별 발전량': 'daily generation',
  '최근': 'last',
  '일별 손익': 'daily P&L',
  '수익 − 연료 − 유지비 (CR)': 'revenue − fuel − upkeep (CR)',
  '발전량': 'generation',
  '계약 인도 (계약 단가 기준 귀속)': 'contract delivery (at contract price)',
  '누적': 'lifetime',
  '건설비 회수율': 'capex recovered',
  '토지 임대료·사업권 수수료·환경 비용은 지역 단위로 청구되어 여기 포함되지 않습니다.': 'Land rent, license fees and env. costs are billed per region and not included here.',
  '모듈 확장': 'module expansion',
  '시설당 2개 · 같은 부지·접속점 사용': '2 per facility · same site & connection point',
  '공사 중': 'building',
  '(기존 설비는 계속 운영)': '(existing capacity keeps running)',
  '추가 정격': 'added capacity',
  '비용 · 공사': 'cost · build time',
  '유지비 증가': 'upkeep increase',

  // --- 계획 ---
  '건설 계획': 'build plan',
  '조건이 맞는 순서대로 자동 승인 (Q32)': 'auto-approved in order as conditions allow',
  '예상 건설비': 'est. capex',
  '일시정지': 'pause',
  '비어 있음': 'empty',
  '맨 앞 항목 대기 사유': 'first item waiting on',
  '계획 재개': 'resume plan',
  '계획 일시정지': 'pause plan',
  '모두 비우기': 'clear all',
  '지역 화면의 건설 탭에서 「계획에 추가」로 담습니다. 여러 지역의 시설·송전선을 한 번에 계획해 두면, 자금·사업권·접속 용량·동시 건설 한도가 허락할 때 순서대로 승인됩니다.':
    'Use “add to plan” in a region’s Build tab. Queue facilities and lines across regions; they are approved in order whenever funds, licenses, connection capacity and build slots allow.',
  '지금 승인 가능': 'ready to approve',
  '계획은 자금을 미리 예약하지 않습니다. 순서를 지키기 위해 맨 앞 항목이 막히면 뒤 항목도 기다립니다 — 급한 항목은 ▲로 올리세요.':
    'The plan does not reserve funds. To keep the order, later items wait while the first is blocked — move urgent items up with ▲.',

  // --- 설정 ---
  '닫기': 'close',
  '소리': 'sound',
  '전체 음량': 'master volume',
  '효과음': 'effects',
  '배경음': 'ambience',
  '끔': 'off',
  '화면': 'display',
  '그래픽 품질': 'graphics quality',
  '(바꾸면 행성을 다시 그립니다)': '(changing redraws the planet)',
  '낮음': 'low',
  '보통': 'medium',
  '높음': 'high',
  '언어 · Language': 'Language',
  '긴급 경고 시 자동 일시정지': 'auto-pause on urgent alerts',
  '(핵심 부하 정전·대출 연체·사업권 정지)': '(critical-load outage, loan arrears, license lapse)',
  '자동 저장': 'autosave',
  '튜토리얼': 'tutorial',
  '처음부터 다시 보기': 'restart',

  // --- 세이브 ---
  '빈 칸': 'empty slot',
  '수동': 'manual',
  '자동': 'auto',
  '덮어쓰기': 'overwrite',
  '삭제': 'delete',
  '저장 · 불러오기': 'save · load',
  '수동 저장': 'manual saves',
  '설정한 간격마다 가장 오래된 칸을 덮어씁니다': 'overwrites the oldest slot at the set interval',
  '파일': 'file',
  '파일로 내보내기': 'export to file',
  '파일에서 가져오기': 'import from file',
  '세이브는 이 기기(브라우저·앱)의 저장소에 압축해 보관합니다. 다른 PC로 옮기거나 백업하려면 파일로 내보내세요.':
    'Saves are compressed into this device’s (browser/app) storage. Export to a file to move them to another PC or back them up.',

  // --- 도움말 ---
  '조작': 'controls',
  '행성 회전 · 확대': 'rotate · zoom planet',
  '끌기 · 마우스 휠': 'drag · mouse wheel',
  '지역 선택': 'select region',
  '왼쪽 목록 · 행성 위 지역 이름 · 표식 클릭': 'left list · region name on planet · click a marker',
  '시설 이름 클릭 · 행성 위 시설 모형 클릭': 'click a facility name · click its model on the planet',
  '일시정지 · 배속': 'pause · speed',
  '돈을 버는 흐름': 'how you make money',
  '사업권(발전) → 발전소 건설 → 지역 시장에 자동 판매 (가격은 지역 수요·기존 공급으로 정해짐)':
    'License (generation) → build a plant → sells automatically to the regional market (price set by regional demand and existing supply)',
  '계약(PPA·직접 공급)은 시장보다 먼저 공급되며, 부족하면 위약금이 생깁니다.': 'Contracts (PPA, direct supply) are served before the market; shortfalls incur penalties.',
  '송전선으로 이웃 지역과 이으면, 손실을 빼고도 비싼 곳으로 전력이 흘러갑니다.': 'Link neighbors with lines and power flows to wherever it is worth more after losses.',
  '저장시설은 쌀 때 충전, 비쌀 때 방전합니다.': 'Storage charges when power is cheap and discharges when it is expensive.',
  '접속 용량이 차면 변전소를, 한 시설을 키우려면 모듈 확장을 씁니다.': 'When connection capacity is full, build a substation; to grow one facility, use module expansion.',
  '위험': 'risks',
  '고장 전조(점검 필요) → 예방 점검이 가장 쌉니다. 고장 나면 자동 복구되며, 급하면 긴급 복구로 기간을 절반으로 줄입니다.':
    'Failure warning (inspection due) → a preventive inspection is cheapest. Failures repair automatically; rush repair halves the time if it is urgent.',
  '사업권·토지 임대는 만료 후 30일 유예 뒤 시설이 멈춥니다 — 자동 갱신을 켜 두세요.': 'Licenses and leases get 30 d of grace after expiry, then facilities stop — keep auto-renew on.',
  '대출 상환에 실패하면 연체 → 구조조정 → 회생불능으로 넘어가지만 즉시 게임오버는 없습니다.': 'Missed loan payments lead to arrears → restructuring → insolvency, but never an instant game over.',

  // --- 튜토리얼 ---
  '지역 고르기': 'Pick a region',
  '왼쪽 목록이나 행성 위 지역 이름을 눌러 사업할 지역을 고르세요. 가격(CR/MWh)이 높고 일사·풍황이 좋은 곳이 유리합니다.':
    'Click a region in the left list or its name on the planet. High prices (CR/MWh) and good sun or wind are best.',
  '지역 화면의 「사업권」에서 발전 사업권 <b>소형</b>을 취득하세요. 사업권이 있어야 발전소를 지을 수 있습니다.':
    'In the region’s “Licenses” section, acquire a <b>small</b> generation license. You need a license to build plants.',
  '첫 발전소': 'First plant',
  '「건설」에서 <b>태양광 · 소형</b>(공사 5일)을 고르고 <b>건설 승인</b>을 누르세요. 부지는 자동으로 임대됩니다.':
    'Under “Build”, pick <b>solar · small</b> (5 d to build) and press <b>approve build</b>. The site is leased automatically.',
  '시간 빨리 감기': 'Fast forward',
  '위쪽 배속 버튼(또는 숫자 키 <b>4</b>)으로 8배속을 켜고 공사가 끝나기를 기다리세요. 시운전 단계부터 전기를 팝니다.':
    'Use the speed buttons at the top (or key <b>4</b>) for 8× speed and wait for construction. Sales start during commissioning.',
  '계약 화면': 'Contracts screen',
  '위쪽 <b>계약</b> 탭을 여세요. 계약은 시장 가격이 흔들려도 정해진 값에 팝니다.': 'Open the <b>Contracts</b> tab at the top. Contracts sell at a fixed price however the market moves.',
  'PPA 수락': 'Accept a PPA',
  '「내 지역」 필터를 누르고, <b>공급 여력 안의 작은 PPA</b>를 수락하세요. 경고가 뜨는 큰 계약은 공급이 부족하면 위약금이 쌓입니다.':
    'Press the “my regions” filter and accept a <b>small PPA within your supply headroom</b>. Large contracts flagged with a warning rack up penalties if supply falls short.',
  '첫 수익': 'First income',
  '하루가 지나면 판매·계약 수익이 장부에 기록됩니다. <b>재무</b> 탭에서 30일 현금 흐름을 확인하세요.':
    'After a day, sales and contract revenue hit the ledger. Check the 30-day cash flow in the <b>Finance</b> tab.',
  '기본 흐름 완료': 'Basics done',
  '다음 목표: 이웃 지역과 <b>송전선</b>을 이어 시간대 차이로 팔기, <b>자동화</b>로 사업권 갱신 맡기기, <b>계획</b>으로 여러 건설을 한 번에 예약하기. 도움말은 위쪽 <b>?</b> 버튼.':
    'Next: link neighbors with <b>transmission lines</b> to sell across time zones, let <b>automation</b> renew licenses, and queue several builds with the <b>plan</b>. Help is the <b>?</b> button at the top.',
  '건너뛰기': 'skip',

  // --- 확인 창 (main.ts confirm) ---
  '이 시설을 매각할까요? 기존 계약 의무는 그대로 남습니다.': 'Sell this facility? Existing contract obligations remain.',
  '이 시설을 폐기할까요? 폐기 비용이 듭니다.': 'Scrap this facility? Scrapping has a cost.',
  '공급 여력보다 큰 계약입니다. 공급하지 못하면 위약금이 쌓입니다. 그래도 수락할까요?': 'This contract exceeds your supply headroom. Shortfalls accrue penalties. Accept anyway?',
  '계획을 모두 비울까요?': 'Clear the whole plan?',
  '이 세이브를 지울까요?': 'Delete this save?',

  // --- main.ts 알림·오버레이·say ---
  '알림': 'notices',
  '지도': 'map',
  '가격': 'price',
  '내 설비': 'my assets',
  '긴급': 'urgent',
  '확인': 'OK',
  '— 자동 일시정지': '— auto-paused',
  '저장했습니다': 'Saved',
  '저장 실패: 저장소 용량이 부족하거나 쓸 수 없습니다. 오래된 칸을 지우거나 파일로 내보내세요.': 'Save failed: storage is full or not writable. Delete an old slot or export to a file.',
  '불러왔습니다': 'Loaded',
  '일시정지 상태입니다.': 'Game is paused.',
  '불러오기 실패.': 'Load failed.',
  '계획에 추가했습니다 — 계획 탭에서 순서를 바꿀 수 있습니다.': 'Added to plan — reorder it in the Plan tab.',
  '파일에서 불러왔습니다. 일시정지 상태입니다.': 'Loaded from file. Game is paused.',
  '가져오기 실패.': 'Import failed.',
  '자동 저장 실패 (저장소 용량 부족). 오래된 세이브를 지우세요.': 'Autosave failed (storage full). Delete old saves.',
  '세이브 파일을 읽을 수 없습니다 (형식 오류).': 'Cannot read the save file (format error).',
  '더 새로운 버전에서 만든 세이브입니다. 파일은 그대로 보존됩니다.': 'This save is from a newer version. The file is left untouched.',
  '세이브 무결성 검사 실패 (해시 불일치).': 'Save integrity check failed (hash mismatch).',
  '개발용 자본': 'dev capital',

  // --- 시뮬레이션 알림 (sim/*.ts) ---
  '회사 설립. 지역을 골라 사업권을 얻고 첫 발전소를 지으세요.': 'Company founded. Pick a region, get a license and build your first plant.',
  '준공': 'completed',
  '목표 달성': 'goal achieved',
  // 건설·명령
  '건설 거부: 존재하지 않는 지역': 'build rejected: unknown region',
  '건설 거부': 'build rejected',
  '건설 승인:': 'build approved:',
  '대출 실행:': 'loan taken:',
  '시설 매각:': 'facility sold:',
  '권리 상실로 정지:': 'stopped (rights lost):',
  '송전선 거부': 'line rejected',
  '취소 거부: 건설 중인 대상이 아님': 'cancel rejected: not under construction',
  '건설 취소: 환불': 'build cancelled: refund',
  '명령 거부: 시설 없음': 'command rejected: no such facility',
  '명령 거부: 저장시설 없음': 'command rejected: no such storage',
  '거부: 충전 기준 가격은 방전 기준 가격보다 낮아야 합니다': 'rejected: charge threshold must be below discharge threshold',
  '점검 거부: 점검이 필요한 상태가 아님': 'inspection rejected: none needed',
  '예방 점검 시작': 'preventive inspection started',
  '취득 거부': 'acquisition rejected',
  '갱신 거부: 사업권 없음': 'renewal rejected: no such license',
  '갱신 거부: 시설 없음': 'renewal rejected: no such facility',
  '갱신 거부: 자금 부족': 'renewal rejected: insufficient funds',
  '토지 매입 거부': 'land purchase rejected',
  '시설 없음': 'no such facility',
  '확장 거부: 시설 없음': 'expansion rejected: no such facility',
  '계획은 30건까지 담을 수 있습니다': 'the plan holds up to 30 items',
  '(연구로 늘릴 수 있음)': '(research can raise this)',
  '연구 필요: 핵분열 발전 (발전 분기 3단계)': 'research required: Fission Power (generation tier 3)',
  '환경 규제: 이 지역은 환경 지표가 1.0을 넘어 신규 열발전이 금지됩니다': 'environmental rule: this region’s env. index is above 1.0, so new thermal plants are banned',
  '접속 용량 부족 — 변전소를 지으세요 (한 접속점에 들어가야 합니다)': 'not enough connection capacity — build a substation (must fit one connection point)',
  '사용 가능 자금 부족': 'insufficient available funds',
  '자금 부족': 'insufficient funds',
  '이웃 지역끼리만 연결할 수 있습니다': 'only neighboring regions can be linked',
  '같은 구간 선로가 이미 건설 중입니다': 'a line on this route is already being built',
  '양쪽 지역 모두 송전 사업권이 필요합니다': 'both regions need a transmission license',
  // 사업권·토지
  '이 없습니다 (유예 중인 사업권으로는 신규 건설 불가)': ' missing (a license in grace cannot build)',
  '한도 부족 (남은 한도': 'quota short (remaining',
  '은 지역당 하나면 충분합니다': ': one per region is enough',
  '만료된 사업권은 갱신할 수 없습니다 (재취득 필요)': 'expired licenses cannot be renewed (acquire again)',
  '갱신은 만료 30일 전부터 가능합니다': 'renewal opens 30 d before expiry',
  '소유한 토지입니다': 'land already owned',
  '이미 소유한 토지입니다': 'land already owned',
  '소유한 토지가 아닙니다': 'land is not owned',
  '만료된 임대는 갱신할 수 없습니다 (시설을 매각·폐기하거나 토지를 매입하세요)': 'expired leases cannot be renewed (sell or scrap the facility, or buy the land)',
  '임대 갱신은 만료 30일 전부터 가능합니다': 'lease renewal opens 30 d before expiry',
  '토지 매입: 시설': 'land bought: facility',
  '이후 임대료 없음)': 'no more rent)',
  '토지 매각 후 재임대: 시설': 'sale-leaseback: facility',
  '시설': 'facility',
  '만료 — 유예': 'expired — grace',
  '(신규 건설 불가)': '(no new builds)',
  '유예 종료 — 관련 시설이 정지됩니다 (시설은 삭제되지 않음)': 'grace ended — related facilities stop (they are not deleted)',
  '송전 사업권 상실로 선로 정지': 'line stopped (transmission license lost)',
  '사업권 갱신': 'license renewal',
  '사업권 취득': 'license acquired',
  // 계약
  '계약 거부: 제안이 만료되었습니다': 'contract rejected: offer expired',
  '직접 공급 계약에는 이 지역의 소매 공급 사업권이 필요합니다': 'direct supply contracts need a retail license in this region',
  '의 공급 여력이 계약 물량보다 적습니다': '’s supply headroom is below the contracted volume',
  '계약 체결': 'contract signed',
  '계약 종료': 'contract ended',
  '핵심 부하 정전': 'critical-load outage',
  '직접 공급 — 이행': 'direct supply — delivered',
  '(위약금 큼)': '(heavy penalty)',
  // 환경·시장
  '— 1.0을 넘으면 신규 열발전이 금지되고 환경 비용이 오릅니다': '— above 1.0, new thermal is banned and env. costs rise',
  '규제 시행': 'regulation in force',
  '규제 변경 예고': 'regulation change notice',
  '연료 가격 조정': 'fuel price adjusted',
  '다음 달 예상': 'next month est.',
  '수요 정상화': 'demand back to normal',
  '공급 정상화': 'supply back to normal',
  '수요 급변 예상': 'demand swing expected',
  '기존 전력망 공급 충격 예고 (내일부터, 공급': 'grid supply shock ahead (from tomorrow, supply',
  '가격 급등 예상': 'price spike expected',
  // 고장
  '고장': 'failure',
  '자동 복구': 'auto repair',
  '복구 완료': 'repaired',
  '점검 완료': 'inspection done',
  '접속점': 'connection point',
  // 재무
  '대출 거부: 구조조정·회생불능 중에는 신규 대출을 받을 수 없습니다': 'loan rejected: no new loans during restructuring or insolvency',
  '대출 거부: 지원하지 않는 기간': 'loan rejected: unsupported term',
  '대출 거부: 한도 초과': 'loan rejected: over the limit',
  '상환 거부: 대출 없음': 'repayment rejected: no such loan',
  '조기 상환 거부: 현금 부족': 'prepayment rejected: not enough cash',
  ', 월': ', monthly',
  '연체 이자': 'late interest',
  '연체분 상환': 'arrears repayment',
  '대출 이자': 'loan interest',
  '원금 상환': 'principal repayment',
  '조기 상환 수수료': 'prepayment fee',
  '구조조정 완료 — 정상 경영으로 복귀': 'restructuring complete — back to normal operations',
  '회생불능 — 구제를 신청할 수 있습니다': 'insolvent — you can request a bailout',
  '회생불능 — 회사가 청산되었습니다': 'insolvent — the company has been liquidated',
  '연체 상태 — 신규 투자가 막힙니다. 시설 매각·정지나 대출로 회복하세요': 'in arrears — new investment is blocked. Recover by selling or stopping facilities, or with a loan',
  '구조조정 시작': 'restructuring started',
  '(재무 화면의 매각 후보 참고)': '(see sale candidates on the Finance screen)',
  '유동성 경고: 앞으로 7일 의무 지출이 현금보다 많습니다': 'liquidity warning: the next 7 d of obligations exceed cash',
  '구제는 회생불능 상태에서만 신청할 수 있습니다': 'a bailout is only available when insolvent',
  '구제 완료 — 부채': 'bailout done — debt',
  '를 60개월 저리 대출로 재조정 (기록에 표시됨)': ' rescheduled into a 60-month low-rate loan (noted in your record)',
  '구제: 대출': 'bailout: loan',
  '인수': 'taken over',
  '구제: 음수 현금 보전': 'bailout: negative cash covered',
  '구제 대출 (60개월)': 'bailout loan (60 mo)',
  '매각 거부: 운영 중인 시설만 매각할 수 있습니다': 'sale rejected: only operating facilities can be sold',
  '매각 거부': 'sale rejected',
  '기존 계약 의무는 유지됩니다': 'existing contract obligations remain',
  '폐기 거부: 건설 중인 시설은 취소하세요': 'scrap rejected: cancel facilities under construction instead',
  '폐기 거부': 'scrap rejected',
  '시설 폐기': 'facility scrapped',
  '연체 중에는 신규 투자를 할 수 없습니다': 'no new investment while in arrears',
  '구조조정 중에는 신규 투자를 할 수 없습니다': 'no new investment during restructuring',
  '회생불능 상태입니다': 'company is insolvent',
  // 모듈·긴급 복구
  '변전소는 확장할 수 없습니다': 'substations cannot be expanded',
  '운영 중인 시설만 확장할 수 있습니다': 'only operating facilities can be expanded',
  '이미 확장 공사 중입니다': 'expansion already underway',
  '이 시설의 접속점 용량이 부족합니다': 'not enough room at this facility’s connection point',
  '모듈 확장 거부': 'module expansion rejected',
  '모듈 확장 시작': 'module expansion started',
  '모듈 확장 준공': 'module expansion completed',
  '대상 없음': 'no such target',
  '고장 상태가 아닙니다': 'not in a failed state',
  '이미 긴급 복구 중입니다': 'rush repair already underway',
  '곧 복구됩니다': 'repair almost done',
  '긴급 복구 거부': 'rush repair rejected',
  '긴급 복구 투입: 남은 기간': 'rush repair: remaining',
  // 장부 메모 (표시될 경우 대비)
  '초기 자본': 'initial capital',
  '자본 투입': 'capital injection',
  '시작 시설 취득': 'starting facility',
  '토지 임대 보증금': 'land lease deposit',
  '임대 보증금 반환': 'lease deposit returned',
  '임대 보증금': 'lease deposit',
  '건설 취소 환불': 'build cancellation refund',
  '토지 매각(재임대)': 'land sale (leaseback)',
  '토지 매각': 'land sale',
  '사업권 기본 수수료': 'license base fee',
  '계약 위약금': 'contract penalty',
  '선로 유지비': 'line upkeep',
  '월 합계 (압축)': 'monthly total (compacted)',
  '고장 복구': 'failure repair',
  '육지가 없는 시드': 'seed has no land',
  '저장소 없음: 이번 실행 동안만 유지': 'no storage: kept for this session only',
  '행성 생성 중…': 'Generating planet…',
};

// 정규화된 키 → 값, 그리고 키 전체를 하나로 묶은 정규식 (가장 긴 키 우선)
const PHRASES = new Map<string, string>();
for (const [k, v] of Object.entries(DICT)) {
  let nk = applyPatterns(k), nv = v;
  // 흔한 ASCII 글자로 시작하는 키는 정규식의 빠른 첫 글자 탐색을 망친다: 값과 같은 첫 글자면 둘 다에서 뗀다
  while (nk.length > 1 && nk.charCodeAt(0) < 128 && nk[0] === nv[0]) { nk = nk.slice(1); nv = nv.slice(1); }
  if (/[\uac00-\ud7a3「」]/.test(nk)) PHRASES.set(nk, nv);
}
// 한 번 훑기로 가장 긴 키를 찾는다 (정렬된 키를 '|'로 이은 정규식과 같은 결과: 왼쪽부터, 같은 위치에서는 가장 긴 키).
// 정규식으로는 첫 글자 갈래가 수백 개라 한글 글자마다 느렸다 (50KB 기준 정규식 ~1.3 ms → 트라이 ~0.3 ms).
interface Node { val?: string; next: Map<number, Node> }
const ROOT: Node = { next: new Map() };
const FIRST = new Uint8Array(65536);
for (const [k, v] of PHRASES) {
  FIRST[k.charCodeAt(0)] = 1;
  let n = ROOT;
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    let m = n.next.get(c);
    if (!m) n.next.set(c, (m = { next: new Map() }));
    n = m;
  }
  n.val = v;
}

function applyPhrases(t: string): string {
  let out = '';
  let last = 0;
  const len = t.length;
  for (let i = 0; i < len; i++) {
    const c = t.charCodeAt(i);
    if (!FIRST[c]) continue;
    let n = ROOT.next.get(c)!;
    let end = -1, val = '';
    let j = i + 1;
    for (;;) {
      if (n.val !== undefined) { end = j; val = n.val; }
      if (j >= len) break;
      const m: Node | undefined = n.next.get(t.charCodeAt(j));
      if (!m) break;
      n = m;
      j++;
    }
    if (end < 0) continue;
    out += t.slice(last, i) + capAt(val, t, i);
    last = end;
    i = end - 1;
  }
  return last === 0 ? t : out + t.slice(last);
}
const HANGUL = /[\uac00-\ud7a3]/;
const START_LOWER = /(?:^|(?<!<\/b|[^>]<b)>\s*|title=")[a-z]/g;


export function translate(html: string, s: GameState): string {
  if (!HANGUL.test(html)) return html;
  let t = html;
  const rc = regionsFor(s);
  if (rc.re) t = t.replace(rc.re, (m) => rc.map.get(m) ?? m);
  t = applyPatterns(t);
  t = t.replace(CONTEXT_RE, (...a: unknown[]) => {
    let k = 0;
    while (a[k + 1] === undefined) k++;
    return CONTEXT[k][1];
  });
  t = applyPhrases(t);
  // 요소·title 첫머리의 영어는 대문자로 시작 (숫자 패턴이 만든 'expires in…' 등)
  return t.replace(START_LOWER, (m) => m.slice(0, -1) + m[m.length - 1].toUpperCase());
}
