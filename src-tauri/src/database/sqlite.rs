use rusqlite::{Connection, Result, params};
use std::path::Path;

pub fn init_database(db_path: &Path) -> Result<()> {
    let conn = Connection::open(db_path)?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            ip_address TEXT UNIQUE,
            connected_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            last_active TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );

        CREATE TABLE IF NOT EXISTS game_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_name TEXT NOT NULL,
            player_id INTEGER,
            score INTEGER DEFAULT 0,
            data TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (player_id) REFERENCES players(id)
        );

        CREATE TABLE IF NOT EXISTS server_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        ",
    )?;

    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DbPlayer {
    pub id: i64,
    pub name: String,
    pub ip_address: String,
}

pub fn find_or_create_player(db_path: &Path, ip: &str) -> Result<DbPlayer> {
    let conn = Connection::open(db_path)?;

    let existing: Option<DbPlayer> = conn
        .query_row(
            "SELECT id, name, ip_address FROM players WHERE ip_address = ?1",
            params![ip],
            |row| {
                Ok(DbPlayer {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    ip_address: row.get(2)?,
                })
            },
        )
        .ok();

    if let Some(mut player) = existing {
        conn.execute(
            "UPDATE players SET last_active = datetime('now', 'localtime') WHERE id = ?1",
            params![player.id],
        )?;
        if player.name.is_empty() {
            let name = generate_chinese_name();
            conn.execute(
                "UPDATE players SET name = ?1 WHERE id = ?2",
                params![name, player.id],
            )?;
            player.name = name;
        }
        Ok(player)
    } else {
        let name = generate_chinese_name();
        conn.execute(
            "INSERT INTO players (name, ip_address) VALUES (?1, ?2)",
            params![name, ip],
        )?;
        let id = conn.last_insert_rowid();
        Ok(DbPlayer {
            id,
            name,
            ip_address: ip.to_string(),
        })
    }
}

pub fn update_player_name(db_path: &Path, player_id: i64, name: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE players SET name = ?1 WHERE id = ?2",
        params![name, player_id],
    )?;
    Ok(())
}

fn generate_chinese_name() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let adjectives = [
        "快乐", "勇敢", "聪明", "可爱", "神秘",
        "飞翔", "闪亮", "酷炫", "无敌", "超级",
        "暴走", "狂野", "沉稳", "机智", "灵动",
        "威武", "潇洒", "呆萌", "霸气", "优雅",
        "淡定", "热血", "逍遥", "傲娇", "元气",
    ];

    let nouns = [
        "小龙", "战士", "法师", "猎人", "骑士",
        "忍者", "海盗", "剑客", "大侠", "少年",
        "玩家", "高手", "英雄", "精灵", "旅人",
        "小虎", "大熊", "飞鹰", "白狼", "青龙",
        "火狐", "冰鸟", "雷豹", "风鹤", "星辰",
    ];

    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    let adj = adjectives[(seed as usize) % adjectives.len()];
    let noun = nouns[((seed / 7) as usize) % nouns.len()];
    let num = (seed % 100) as u32;

    format!("{}{}{:02}", adj, noun, num)
}
