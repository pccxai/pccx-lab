use pccx_core::pccx_format::{PccxFile, PccxHeader};
use std::fs::File;

#[tauri::command]
fn load_pccx(path: &str) -> Result<PccxHeader, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let pccx = PccxFile::read(&mut file).map_err(|e| e.to_string())?;
    Ok(pccx.header)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![load_pccx])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
