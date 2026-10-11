// Impede uma janela de console extra no Windows em release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    prova_digital_profamr_lib::run()
}
