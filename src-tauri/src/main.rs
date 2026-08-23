// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--computer-helper") {
        std::process::exit(pid_desktop_lib::run_computer_helper());
    }
    pid_desktop_lib::run()
}
