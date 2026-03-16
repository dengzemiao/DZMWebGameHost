pub mod sqlite;

use std::path::Path;

pub fn init(data_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("Failed to create data dir: {}", e))?;

    let db_path = data_dir.join("game.db");
    sqlite::init_database(&db_path).map_err(|e| format!("Failed to init database: {}", e))?;

    let logs_dir = data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir)
        .map_err(|e| format!("Failed to create logs dir: {}", e))?;

    Ok(())
}
