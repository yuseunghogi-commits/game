// 진입점: 간편 모드(기본) 또는 상세 경영 모드를 고른다.
const params = new URLSearchParams(location.search);
let mode = params.get('mode');
if (!mode) { try { mode = localStorage.getItem('planetary-grid.mode'); } catch { mode = null; } }
if (mode === 'deep') void import('./main');
else void import('./idle/app');
