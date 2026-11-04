//! The `scn` binary.

use std::process::ExitCode;

use clap::Parser;
use openscion::{Cli, run};

fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(&cli, &mut std::io::stdout().lock()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("scn: {error}");
            ExitCode::FAILURE
        }
    }
}
