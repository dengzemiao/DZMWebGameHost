use local_ip_address::local_ip;

pub fn get_local_ipv4() -> String {
    match local_ip() {
        Ok(ip) => ip.to_string(),
        Err(_) => "127.0.0.1".to_string(),
    }
}
