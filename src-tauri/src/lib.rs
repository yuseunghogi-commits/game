// PLANETARY GRID 데스크톱 셸. 게임 로직은 모두 웹 프런트엔드(TypeScript SimCore)에 있다.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("PLANETARY GRID 실행 중 오류");
}
